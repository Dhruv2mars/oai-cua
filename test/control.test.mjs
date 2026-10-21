// User control, safety and reliability: per-app approval, stop/takeover,
// turn lifecycle, error diagnostics, focus restore. Real shim + engine
// processes against the fake cua-repl; focus and approval logic also in-process.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Approver, parseRequest } from "../src/approval.mjs";
import { handleRpc } from "../src/bridge-service.mjs";
import { diagnose, explain } from "../src/diagnose.mjs";
import { FocusGuard, isApp } from "../src/focus.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const FAKE = path.join(ROOT, "test/fake-cua-repl.mjs");
const NODE = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-ctl-"));
  const manifest = path.join(dir, "mcp.json");
  fs.writeFileSync(manifest, JSON.stringify({ mcpServers: { cua_repl: { command: NODE, args: [FAKE], env: {} } } }));
  const log = path.join(dir, "fake.log");
  fs.writeFileSync(log, "");
  return {
    dir, log, state: path.join(dir, "state"),
    env: { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, ".codex"), OAI_CUA_APP: path.join(dir, "ChatGPT.app"), OAI_CUA_STATE_DIR: path.join(dir, "state"), OAI_CUA_MCP_JSON: manifest, FAKE_LOG: log, FAKE_DOCS: "",
      OAI_CUA_RESTORE_FOCUS: "0", OAI_CUA_APPROVAL: "", CLAUDE_CODE_ENTRYPOINT: "cli", ...env },
    events: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// A client that can answer the shim's own requests (elicitation) via onRequest.
function startShim(sb) {
  const p = spawn(NODE, [path.join(ROOT, "src/shim.mjs")], { env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => { try { p.kill("SIGKILL"); } catch {} });
  let buf = "", id = 0;
  const waiters = new Map();
  const self = {
    p, received: [],
    onRequest: () => ({ action: "cancel" }),
    rpc: (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); }),
    init: (capabilities = {}) => self.rpc("initialize", { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "test", version: "0" } }),
    call: async (name, args = {}) => (await self.rpc("tools/call", { name, arguments: args })).result,
  };
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (!m.method) { waiters.get(m.id)?.(m); continue; }
      self.received.push(m);
      if (m.id != null) Promise.resolve(self.onRequest(m)).then((result) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n"));
    }
  });
  return self;
}
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const elicitations = (s) => s.received.filter((m) => m.method === "elicitation/create");
// Turn ids of bridge tool cells (not the turn-end cells).
const toolTurns = (sb) => sb.events().filter((e) => e.ev === "cell" && e.turn && !e.code.startsWith("await nodeRepl.rpc(")).map((e) => e.turn.turn_id);

describe("per-app approval", () => {
  test("forwarded to an elicitation-capable client with app, risk and always-allow; always persists 0600", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1" });
    let s = startShim(sb);
    s.onRequest = async () => { await sleep(300); return { action: "accept", content: { always: true } }; }; // a person answering
    await s.init({ elicitation: {} });
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    expect((await s.call("click", { app: "TextEdit", element_index: 1 })).isError).toBeUndefined();
    const asks = elicitations(s);
    expect(asks.length).toBe(1); // asked once, remembered for the session
    expect(asks[0].params.message).toContain('"Example" (com.example.app)');
    expect(asks[0].params.message).toContain("Risk: high — Can read your documents");
    expect(asks[0].params.requestedSchema.properties.always.type).toBe("boolean");
    const file = path.join(sb.state, "approvals.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).always)).toEqual(["com.example.app"]);

    s.p.kill("SIGKILL"); // a new Claude session: always-allowed, no prompt
    s = startShim(sb);
    await s.init({ elicitation: {} });
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    expect(elicitations(s).length).toBe(0);
  });

  test("a declined prompt blocks the app with an actionable message", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1" }), s = startShim(sb);
    s.onRequest = async () => { await sleep(300); return { action: "decline" }; };
    await s.init({ elicitation: {} });
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("The user declined access");
    expect(sb.events().filter((e) => e.ev === "elicit").map((e) => e.action)).toEqual(["decline"]);
  });

  test("an instant cancel (headless client) falls back to the policy, default auto", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1" }), s = startShim(sb);
    await s.init({ elicitation: {} }); // onRequest answers cancel immediately
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    expect((await s.call("get_app_state", { app: "Notes" })).isError).toBeUndefined();
    expect(elicitations(s).length).toBe(1); // not asked again once detected
  });

  test("an instant decline under an Agent SDK host (T3 Code) also falls back to the policy", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }), s = startShim(sb);
    s.onRequest = () => ({ action: "decline" }); // answered by the client within milliseconds
    await s.init({ elicitation: {} });
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    expect((await s.call("get_app_state", { app: "Notes" })).isError).toBeUndefined();
    expect(elicitations(s).length).toBe(1);
    expect(fs.readFileSync(path.join(sb.state, "shim.log"), "utf8")).toMatch(/answered the approval prompt with decline in \d+ms/);
  });

  test("an instant decline from the interactive CLI (e.g. an Elicitation hook) stays a refusal", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1", CLAUDE_CODE_ENTRYPOINT: "cli" }), s = startShim(sb);
    s.onRequest = () => ({ action: "decline" });
    await s.init({ elicitation: {} });
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toContain("The user declined access");
    expect(textOf(await s.call("get_app_state", { app: "Notes" }))).toContain("The user declined access");
    expect(elicitations(s).length).toBe(2); // still asked every time
  });

  test("deny-unknown declines unapproved apps but honours always-allowed ones; Chrome never asks", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1", OAI_CUA_APPROVAL: "deny-unknown" });
    let s = startShim(sb);
    await s.init();
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBe(true);
    fs.writeFileSync(path.join(sb.state, "approvals.json"), JSON.stringify({ version: 1, always: { "com.example.app": {} } }));
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    s.onRequest = () => ({ action: "accept", content: {} });
    s.p.kill("SIGKILL");
    s = startShim(sb);
    s.onRequest = () => ({ action: "accept", content: {} });
    await s.init({ elicitation: {} });
    expect((await s.call("get_app_state", { app: "/tmp/browser-link" })).isError).toBe(true); // resolves to Chrome
    expect(elicitations(s).length).toBe(0);
  });

  test("the call timeout pauses while the user answers", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1", OAI_CUA_CALL_TIMEOUT_MS: "300" }), s = startShim(sb);
    s.onRequest = async () => { await sleep(1200); return { action: "accept", content: {} }; };
    await s.init({ elicitation: {} });
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("tree of TextEdit é日");
  });

  test("Approver: request parsing, unknown policy → auto, native prompt policy", async () => {
    const r = parseRequest({ message: "m", _meta: { riskLevel: "low", persist: ["session"], tool_params: { app: "com.x.y" } } });
    expect(r).toMatchObject({ key: "com.x.y", risk: "low", canPersist: false, blocked: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-appr-"));
    expect(new Approver({ policy: "bogus", file: path.join(dir, "a.json") }).policy).toBe("auto");
    const asked = [];
    const a = new Approver({ policy: "prompt", file: path.join(dir, "a.json"), dialog: async (req) => { asked.push(req.key); return { action: "accept", always: true }; } });
    const params = { message: "m", _meta: { persist: ["session", "always"], tool_params: { app: "com.x.y" } } };
    expect((await a.decide(params)).action).toBe("accept");
    expect((await a.decide(params)).action).toBe("accept");
    expect(asked).toEqual(["com.x.y"]);
    expect(Object.keys(a.always)).toEqual(["com.x.y"]);
  });
});

describe("stop, takeover and turns", () => {
  test("every cell carries this session's turn; stop_app stops the app, ends the turn and replaces the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("stop_app", {}))).toBe("No app sessions to stop."); // engine not started for this
    await s.call("get_app_state", { app: "TextEdit" });
    const r = await s.call("stop_app", { app: "TextEdit" });
    expect(textOf(r)).toBe("Stopped TextEdit (com.example.TextEdit).");
    await s.call("list_apps");
    const ev = sb.events();
    expect(toolTurns(sb)).toEqual(["1", "1", "2"]);
    // never the service's TurnEnded: it would block every other client
    expect(ev.filter((e) => e.ev === "rpc").map((e) => e.msg)).toEqual([{ type: "stopApp", app: "TextEdit" }]);
    expect(ev.filter((e) => e.ev === "turn_ended").length).toBe(0); // the replaced engine's turn ends with it, no turn_ended racing its shutdown
    expect(fs.readFileSync(path.join(sb.state, "shim.log"), "utf8")).not.toMatch(/turn 1 ended \(/);
    expect(new Set(ev.map((e) => e.pid)).size).toBe(2); // list_apps ran on a fresh engine
  });

  test("stop_app without app stops every app used this session", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("get_app_state", { app: "TextEdit" });
    await s.call("get_app_state", { app: "Notes" });
    expect(textOf(await s.call("stop_app", {}))).toBe("Stopped TextEdit (com.example.TextEdit).\nStopped Notes (com.example.Notes).");
  });

  test("a stop that the service keeps is gone after stop_app: the next call runs on a fresh engine", async () => {
    const sb = sandbox({ FAKE_STICKY_STOP: "1" }), s = startShim(sb);
    await s.init();
    await s.call("get_app_state", { app: "TextEdit" });
    await s.call("stop_app", { app: "TextEdit" });
    expect((await s.call("get_app_state", { app: "com.example.TextEdit" })).isError).toBeUndefined();
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(2);
  });

  test("a user stop is honoured for the rest of the turn and cleared when it ends; nothing is retried", async () => {
    const sb = sandbox({ FAKE_USER_STOP: "TextEdit", OAI_CUA_TURN_IDLE_MS: "200" }), s = startShim(sb);
    await s.init();
    for (let i = 0; i < 2; i++) expect(textOf(await s.call("press_key", { app: "TextEdit", key: "a" }))).toContain("The user stopped Computer Use");
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(1); // no restart within the turn
    await sleep(500); // the turn ends
    expect((await s.call("press_key", { app: "TextEdit", key: "a" })).isError).toBeUndefined();
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(2);
    expect(sb.events().filter((e) => e.ev === "action" && e.method === "pressKey").length).toBe(1); // only the allowed one ran
  });

  test("a turn without a user stop keeps its engine", async () => {
    const sb = sandbox({ OAI_CUA_TURN_IDLE_MS: "200" }), s = startShim(sb);
    await s.init();
    await s.call("get_app_state", { app: "TextEdit" });
    await sleep(500);
    await s.call("get_app_state", { app: "TextEdit" });
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(1);
  });

  test("an audio recording keeps its engine; the stop is cleared once it ends", async () => {
    const sb = sandbox({ FAKE_STICKY_STOP: "1" }), s = startShim(sb);
    await s.init();
    await s.call("get_app_state", { app: "TextEdit" });
    expect((await s.call("start_audio_recording", { max_duration_ms: 5000 })).isError).toBeUndefined();
    await s.call("stop_app", { app: "TextEdit" });
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toContain("The user stopped Computer Use"); // engine kept
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(1);
    await s.call("stop_audio_recording"); // the deferred replacement happens now
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    expect(new Set(sb.events().map((e) => e.pid)).size).toBe(2);
  });

  test("the trusted bridge service refuses TurnEnded (it would block every other client)", async () => {
    await expect(handleRpc({ type: "turnEnded", threadID: "t", turnID: "1" })).rejects.toThrow("unsupported cuabridge request: turnEnded");
  });

  test("the turn ends after Claude goes quiet", async () => {
    const sb = sandbox({ OAI_CUA_TURN_IDLE_MS: "200" }), s = startShim(sb);
    await s.init();
    await s.call("get_app_state", { app: "TextEdit" });
    await sleep(500);
    const thread = sb.events().find((e) => e.ev === "cell" && e.turn).turn.thread_id;
    expect(sb.events().filter((e) => e.ev === "turn_ended").map((e) => e.args)).toEqual([{ hook_event_name: "Stop", session_id: thread, turn_id: "1" }]);
    expect(sb.events().filter((e) => e.ev === "rpc").length).toBe(0); // no service TurnEnded
    await s.call("get_app_state", { app: "TextEdit" });
    expect(toolTurns(sb)).toEqual(["1", "2"]);
  });

  test("a cancelled call (user interrupted Claude) ends the turn", async () => {
    const sb = sandbox({ FAKE_CELL_DELAY_MS: "400" }), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    s.rpc("tools/call", { name: "click", arguments: { app: "TextEdit", element_index: 1 } }); // request id 3, never answered
    await sleep(150);
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
    await sleep(100);
    await s.call("list_apps");
    expect(toolTurns(sb)).toEqual(["1", "1", "2"]);
    expect(sb.events().filter((e) => e.ev === "action").length).toBe(0); // the cancelled click never ran
  });

  test("takeover: keyboard actions refresh and retry once; index actions return fresh state and hand-back guidance", async () => {
    const sb = sandbox({ FAKE_TAKEOVER: "1" }), s = startShim(sb);
    await s.init();
    const k = await s.call("press_key", { app: "TextEdit", key: "Return" });
    expect(k.isError).toBeUndefined();
    expect(textOf(k)).toContain("state was refreshed and the action retried once");
    expect(sb.events().filter((e) => e.ev === "action").map((e) => e.method)).toEqual(["pressKey", "pressKey"]);

    const sb2 = sandbox({ FAKE_TAKEOVER: "1" }), s2 = startShim(sb2);
    await s2.init();
    const c = await s2.call("click", { app: "TextEdit", element_index: 3 });
    expect(c.isError).toBe(true);
    expect(textOf(c)).toContain("The user changed 'TextEdit'");
    expect(textOf(c)).toContain("If the user is acting in it, stop and hand back");
    expect(textOf(c)).toContain("Fresh state (old element indices may be stale): Full accessibility tree of TextEdit:\ntree of TextEdit é日");
    expect(sb2.events().filter((e) => e.ev === "action").length).toBe(1); // not retried
  });
});

describe("state dir and log", () => {
  const run = (env, code) => spawnSync(NODE, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
  test("a relative or unsubstituted state dir falls back to ~/.oai-cua", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cua-home-"));
    for (const v of ["${CLAUDE_PLUGIN_DATA}", "rel/dir"])
      expect(run({ HOME: home, OAI_CUA_STATE_DIR: v }, `import { STATE_DIR } from "./src/lib.mjs"; console.log(STATE_DIR)`).stdout.trim()).toBe(path.join(home, ".oai-cua"));
    expect(run({ HOME: home, OAI_CUA_STATE_DIR: "/tmp/x" }, `import { STATE_DIR } from "./src/lib.mjs"; console.log(STATE_DIR)`).stdout.trim()).toBe("/tmp/x");
  });

  test("the log rotates at about 1 MB while running, keeping one previous file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-log-"));
    const r = run({ OAI_CUA_STATE_DIR: dir }, `import { logger } from "./src/lib.mjs"; const log = logger("t.log"); for (let i = 0; i < 40; i++) log("x".repeat(64 << 10));`);
    expect(r.status).toBe(0);
    const size = (f) => fs.statSync(path.join(dir, f)).size;
    expect(size("t.log")).toBeLessThan((1 << 20) * 1.1);
    expect(size("t.log.1")).toBeGreaterThan(1 << 20);
    expect(size("t.log.1")).toBeLessThan((1 << 20) * 1.1);
  });
});

describe("diagnostics", () => {
  test("engine errors gain actionable guidance", async () => {
    const sb = sandbox({ FAKE_ERROR: "Computer Use server error -10005: cgWindowNotFound" }), s = startShim(sb);
    await s.init();
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("cgWindowNotFound\nWhat to do: The app has no capturable window");
  });

  test("error table", () => {
    const kinds = {
      "Computer Use server error -10005: 9999 is an invalid element ID": "bad-element",
      "Invalid app": "app-not-found",
      "Computer Use server error -10018: ambiguousApp": "app-not-found",
      "Computer Use was not approved to use TextEdit": "approval-denied",
      "Computer Use server error -10009: permissionsNotGranted": "permissions",
      "The Mac is locked and automatic unlock could not unlock it.": "locked",
      "This application session has been explicitly stopped by the user for this turn.": "user-stopped",
      "Computer Use is unavailable because the current turn ended.": "turn-ended",
      "Running application not found: 123": "not-running",
    };
    for (const [msg, kind] of Object.entries(kinds)) expect(diagnose(msg)?.kind).toBe(kind);
    expect(explain("something else")).toBe("something else");
  });

  test("a display name the engine rejects is retried by bundle id", async () => {
    const sb = sandbox({ FAKE_BY_ID: "1" }), s = startShim(sb);
    await s.init();
    const r = await s.call("get_app_state", { app: "helium" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("tree of net.imput.helium é日");
    expect(sb.events().filter((e) => e.ev === "getApp").map((e) => e.name)).toEqual(["helium", "net.imput.helium"]);
    const bad = await s.call("get_app_state", { app: "NoSuchApp" });
    expect(textOf(bad)).toContain("Use list_apps and pass its exact bundle id");
  });
});

describe("focus restore", () => {
  const T3 = { pid: 10, bundle: "com.t3tools.t3code", name: "T3 Code", path: "/Applications/T3 Code.app" };
  const HELIUM = { pid: 20, bundle: "net.imput.helium", name: "Helium", path: "/Applications/Helium.app" };
  const guard = (frontSeq, enabled = true) => {
    let front = frontSeq[0];
    const activated = [];
    const g = new FocusGuard({ enabled, ops: { front: async () => front, activate: async (pid) => { activated.push(pid); front = [T3, HELIUM].find((a) => a.pid === pid); return { ok: true }; } } });
    return { g, activated, set: (f) => { front = f; } };
  };

  test("re-activates the previous app when the target stole the front", async () => {
    const { g, activated, set } = guard([T3]);
    await g.around("Helium", async () => set(HELIUM));
    expect(activated).toEqual([10]);
  });

  test("undoes a steal as soon as the activation event arrives, mid-action", async () => {
    const { g, activated, set } = guard([T3]);
    await g.around("Helium", async () => {
      set(HELIUM);
      g.activated(HELIUM);
      await sleep(20);
      expect(activated).toEqual([10]); // before the action returned
    });
    await sleep(400);
    expect(activated).toEqual([10]);
  });

  test("catches a late self-activation", async () => {
    const { g, activated, set } = guard([T3]);
    await g.around("net.imput.helium", async () => { setTimeout(() => set(HELIUM), 50); });
    expect(activated).toEqual([]);
    await sleep(400);
    expect(activated).toEqual([10]);
  });

  test("leaves focus alone when unchanged, changed to another app, the target was already front, or disabled", async () => {
    const other = { pid: 30, bundle: "com.apple.finder", name: "Finder", path: "/System/Library/CoreServices/Finder.app" };
    for (const [start, during, enabled] of [[T3, T3, true], [T3, other, true], [HELIUM, HELIUM, true], [T3, HELIUM, false]]) {
      const { g, activated, set } = guard([start], enabled);
      await g.around("Helium", async () => set(during));
      await sleep(350);
      expect(activated).toEqual([]);
    }
  });

  test("a helper that stops answering is dropped for osascript", async () => {
    const g = new FocusGuard({ enabled: true });
    let killed = false;
    g.ready = Promise.resolve();
    g.proc = { stdin: { write() {} }, kill() { killed = true; } };
    const t = Date.now();
    expect(await g.front()).toBe(null);
    expect(Date.now() - t).toBeLessThan(4000);
    expect([killed, g.proc, g.mode]).toEqual([true, null, "osascript"]);
  });

  test("app matching by name, bundle id or path", () => {
    expect(isApp(HELIUM, "helium")).toBe(true);
    expect(isApp(HELIUM, "Helium.app")).toBe(true);
    expect(isApp(HELIUM, "/Applications/Helium.app/")).toBe(true);
    expect(isApp(HELIUM, "NET.IMPUT.HELIUM")).toBe(true);
    expect(isApp(HELIUM, "TextEdit")).toBe(false);
  });
});
