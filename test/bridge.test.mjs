// Regression tests: real shim + engine processes against a fake cua-repl.
// Run with `bun run check` (bun test runner; the shim itself runs on Node).
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const FAKE = path.join(ROOT, "test/fake-cua-repl.mjs");
const NODE = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
  const manifest = path.join(dir, "mcp.json");
  fs.writeFileSync(manifest, JSON.stringify({ mcpServers: { cua_repl: { command: NODE, args: [FAKE], env: { BROWSER_USE_AVAILABLE_BACKENDS: "chrome" } } } }));
  const log = path.join(dir, "fake.log");
  fs.writeFileSync(log, "");
  return {
    dir, log,
    env: { ...process.env, HOME: dir, OPENAI_CUA_STATE_DIR: path.join(dir, "state"), OPENAI_CUA_MCP_JSON: manifest, FAKE_LOG: log, ...env },
    events: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

function startShim(sb) {
  const p = spawn(NODE, [path.join(ROOT, "src/shim.mjs")], { env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => { try { p.kill("SIGKILL"); } catch {} });
  let buf = "", id = 0;
  const waiters = new Map();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  return {
    p, rpc, exited,
    init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
  };
}
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const spawns = (sb) => sb.events().filter((e) => e.ev === "spawn");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("protocol", () => {
  test("initialize, instructions and full tool schemas without starting the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    const init = (await s.init()).result;
    expect(init.protocolVersion).toBe("2025-06-18");
    expect(init.instructions).toContain("get_app_state");
    const tools = (await s.rpc("tools/list", {})).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["click", "drag", "get_app_state", "list_apps", "perform_secondary_action", "press_key", "scroll", "select_text", "set_value", "type_text"]);
    for (const t of tools) expect(t.inputSchema.properties).toBeDefined();
    expect(tools.find((t) => t.name === "type_text").inputSchema.required).toEqual(["app", "text"]);
    expect(spawns(sb).length).toBe(0);
    expect((await s.rpc("bogus/method", {})).error.code).toBe(-32601);
  });

  test("stdin EOF exits promptly and stops the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    const pid = spawns(sb)[0].pid;
    const t = Date.now();
    s.p.stdin.end();
    expect(await s.exited).toBe(0);
    expect(Date.now() - t).toBeLessThan(1000);
    await sleep(200);
    expect(alive(pid)).toBe(false);
  });
});

describe("tools", () => {
  test("get_app_state returns AX tree + screenshot, dropping getApp's auto-emitted output", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe("tree of TextEdit é日");
    expect(r.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "/9j/4A==" });
    const ev = spawns(sb)[0];
    expect(ev.surfaces).toBe("computer");
    expect(ev.backends).toBe("");
  });

  test("actions translate to the cua API; non-ASCII text is pasted", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("click", { app: "TextEdit", element_index: "2" });
    await s.call("click", { app: "TextEdit", x: 10, y: 20, click_count: 2, mouse_button: "right" });
    await s.call("type_text", { app: "TextEdit", text: "plain" });
    const r = await s.call("type_text", { app: "TextEdit", text: "é日 \"quote\" ${x} `t`" });
    expect(textOf(r)).toContain("state of TextEdit é日");
    await s.call("scroll", { app: "TextEdit", element_index: 1, direction: "down", pages: 0.5 });
    await s.call("select_text", { app: "TextEdit", element_index: 2, text: "a", selection: "cursor_after" });
    const acts = sb.events().filter((e) => e.ev === "action").map((e) => [e.method, e.args]);
    expect(acts).toEqual([
      ["click", [2, { mouseButton: "left", clickCount: 1 }]],
      ["click", [[10, 20], { mouseButton: "right", clickCount: 2 }]],
      ["typeText", ["plain"]],
      ["paste", ["é日 \"quote\" ${x} `t`"]],
      ["scroll", [1, "down", 0.5]],
      ["selectText", [2, "a", { selectionType: "cursor_after" }]],
    ]);
  });

  test("validation errors and Chrome block never reach the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "Google Chrome" }))).toContain("blocked");
    expect(textOf(await s.call("click", { app: "com.google.Chrome", element_index: 1 }))).toContain("blocked");
    expect(textOf(await s.call("click", { app: "TextEdit" }))).toContain("element_index or both x and y");
    expect(textOf(await s.call("type_text", { app: "TextEdit" }))).toContain("missing required argument: text");
    expect(textOf(await s.call("nope", {}))).toContain("unknown tool");
    expect(spawns(sb).length).toBe(0);
  });

  test("app-access elicitation is accepted, but Chrome is declined by its resolved identity", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1" }), s = startShim(sb);
    await s.init();
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    const r = await s.call("get_app_state", { app: "/tmp/browser-link" }); // name hides Chrome
    expect(r.isError).toBe(true);
    expect(sb.events().filter((e) => e.ev === "elicit").map((e) => e.action)).toEqual(["accept", "decline"]);
  });

  test("UTF-8 split across stream chunks is decoded intact", async () => {
    const sb = sandbox({ FAKE_SPLIT: "1" }), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toBe("tree of TextEdit é日");
  });
});

describe("lifecycle", () => {
  test("slow initialize is awaited", async () => {
    const sb = sandbox({ FAKE_INIT_DELAY_MS: "300" }), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("list_apps"))).toContain("com.apple.TextEdit [running]");
  });

  test("rejected initialize / failed authorization are reported, shim stays up and retries", async () => {
    for (const [knob, msg] of [["FAKE_INIT_ERROR", "rejected initialize"], ["FAKE_AUTH_FAIL", "not authorized/ready: Native apps: Error: Sky Computer Use native pipe startup failed"]]) {
      const sb = sandbox({ [knob]: "1" }), s = startShim(sb);
      await s.init();
      const r = await s.call("list_apps");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(msg);
      expect(textOf(r)).toContain("--doctor");
      expect((await s.rpc("ping", {})).result).toEqual({});
      await s.call("list_apps");
      expect(spawns(sb).length).toBe(2);
    }
  });

  test("missing runtime gives a clear error without crashing", async () => {
    const sb = sandbox({ OPENAI_CUA_MCP_JSON: "/nonexistent/mcp.json" }), s = startShim(sb);
    await s.init();
    const r = await s.call("list_apps");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("runtime not found");
    expect((await s.rpc("ping", {})).result).toEqual({});
  });

  test("idle release never interrupts an active call; next call restarts", async () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "150", FAKE_CELL_DELAY_MS: "450" }), s = startShim(sb);
    await s.init();
    expect((await s.call("list_apps")).isError).toBeUndefined();
    await sleep(400);
    expect(sb.events().some((e) => e.ev === "eof" || e.ev === "sigterm")).toBe(true);
    expect((await s.call("list_apps")).isError).toBeUndefined();
    expect(spawns(sb).length).toBe(2);
  });

  test("a retired engine's late exit cannot affect its in-flight replacement", async () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "100", FAKE_SLOW_EXIT_MS: "300", FAKE_CELL_DELAY_MS: "500" }), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    await sleep(200); // idle fired at ~100ms; old engine exits ~300ms later
    const old = spawns(sb)[0].pid;
    expect(alive(old)).toBe(true);
    const r = await s.call("get_app_state", { app: "TextEdit" }); // old exits mid-call
    expect(alive(old)).toBe(false);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe("tree of TextEdit é日");
    expect((await s.call("list_apps")).isError).toBeUndefined(); // still served by the replacement
    expect(spawns(sb).length).toBe(2);
  });

  test("engine crash: reads retry transparently, actions report and recover", async () => {
    const sb = sandbox({ FAKE_CRASH_ONCE: path.join(os.tmpdir(), `crash-${process.pid}-${Date.now()}`) });
    const s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toBe("tree of TextEdit é日");
    const sb2 = sandbox({ FAKE_CRASH_ONCE: path.join(os.tmpdir(), `crash2-${process.pid}-${Date.now()}`) });
    const s2 = startShim(sb2);
    await s2.init();
    const r = await s2.call("press_key", { app: "TextEdit", key: "Return" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("exited");
    expect((await s2.call("press_key", { app: "TextEdit", key: "Return" })).isError).toBeUndefined();
  });

  test("hung engine times out and is replaced", async () => {
    const sb = sandbox({ FAKE_HANG: "1", OPENAI_CUA_CALL_TIMEOUT_MS: "200" }), s = startShim(sb);
    await s.init();
    const t = Date.now();
    const r = await s.call("list_apps");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("timed out");
    expect(Date.now() - t).toBeLessThan(3000);
    expect(sb.events().find((e) => e.ev === "cell" && e.code.includes("__cb")).timeout_ms).toBe(200);
    const hung = spawns(sb)[0].pid;
    await sleep(300);
    expect(alive(hung)).toBe(false);
    await s.call("list_apps");
    expect(spawns(sb).length).toBe(2); // replaced
  });

  test("cancelled calls: queued ones never run, running ones are stopped, no response sent", async () => {
    const sb = sandbox({ FAKE_CELL_DELAY_MS: "400" }), s = startShim(sb);
    await s.init();
    let answered = 0;
    const a = s.rpc("tools/call", { name: "press_key", arguments: { app: "TextEdit", key: "a" } }); // id 2, runs
    s.rpc("tools/call", { name: "type_text", arguments: { app: "TextEdit", text: "never" } }).then(() => answered++); // id 3, queued
    await sleep(100);
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
    expect((await a).result.isError).toBeUndefined();
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
    const c = s.rpc("tools/call", { name: "press_key", arguments: { app: "TextEdit", key: "b" } }); // id 4, cancel mid-run
    c.then(() => answered++);
    await sleep(150);
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } }) + "\n");
    await sleep(600);
    expect(sb.events().filter((e) => e.ev === "action").map((e) => e.args[0])).toEqual(["a"]);
    expect(sb.events().some((e) => e.ev === "sigterm" || e.ev === "eof")).toBe(true);
    expect(answered).toBe(0);
    expect((await s.call("list_apps")).isError).toBeUndefined(); // recovers
  });

  test("shutdown kills an engine that ignores SIGTERM, and its descendants", async () => {
    const sb = sandbox({ FAKE_IGNORE_TERM: "1" }), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    const { pid, grandchild } = spawns(sb)[0];
    s.p.stdin.end();
    expect(await s.exited).toBe(0);
    await sleep(100);
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  test("40 concurrent calls share one engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => s.call(i % 2 ? "list_apps" : "get_app_state", { ...(i % 2 ? {} : { app: "TextEdit" }) })));
    expect(rs.every((r) => !r.isError)).toBe(true);
    expect(spawns(sb).length).toBe(1);
  });
});

describe("installer", () => {
  function fakeBin(sb) {
    const bin = path.join(sb.dir, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(sb.dir, "calls.jsonl");
    const script = (body) => `#!${NODE}\nconst fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({cmd:require("path").basename(process.argv[1]),a})+"\\n");${body}`;
    fs.writeFileSync(path.join(bin, "claude"), script(`const st=${JSON.stringify(path.join(sb.dir, "claude-state"))};
if(a[1]==="add-json"){const f=st+".failed";if(process.env.FAKE_ADD_FAIL_ONCE&&!fs.existsSync(f)){fs.writeFileSync(f,"");process.exit(1);}fs.writeFileSync(st,a[5]);}
if(a[1]==="get"){if(!fs.existsSync(st))process.exit(1);console.log(fs.readFileSync(st,"utf8"));}`), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "codex"), script(`const st=${JSON.stringify(path.join(sb.dir, "codex-removed"))};
if(a[1]==="get")process.exit(fs.existsSync(st)?1:0);
if(a[1]==="remove")fs.writeFileSync(st,"");`), { mode: 0o755 });
    fs.symlinkSync(NODE, path.join(bin, "node"));
    return { bin, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
  }
  function repoCopy(sb, name) {
    const dest = path.join(sb.dir, name);
    fs.mkdirSync(path.join(dest, "src"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "install.mjs"), path.join(dest, "install.mjs"));
    for (const f of fs.readdirSync(path.join(ROOT, "src"))) fs.copyFileSync(path.join(ROOT, "src", f), path.join(dest, "src", f));
    return dest;
  }

  test("installs with argv only (no shell expansion), persists env, denies native CU, removes legacy worker", () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "1234" });
    const { bin, calls } = fakeBin(sb);
    const repo = repoCopy(sb, "repo-$(touch INJECTED)");
    const cfg = path.join(sb.dir, "claude-cfg");
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ switchModelsOnFlag: false, deniedMcpServers: [{ serverName: "x" }] }), { mode: 0o600 });
    const r = spawnSync(NODE, [path.join(repo, "install.mjs")], { cwd: sb.dir, encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(sb.dir, "INJECTED"))).toBe(false);
    const add = calls().find((c) => c.cmd === "claude" && c.a[1] === "add-json");
    const spec = JSON.parse(add.a[5]);
    expect(spec.args).toEqual([path.join(fs.realpathSync(repo), "src/shim.mjs")]);
    expect(spec.env.OPENAI_CUA_IDLE_MS).toBe("1234");
    expect(spec.env.OPENAI_CUA_MCP_JSON).toBe(sb.env.OPENAI_CUA_MCP_JSON);
    expect(fs.statSync(path.join(cfg, "settings.json")).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
    expect(settings).toEqual({ switchModelsOnFlag: false, deniedMcpServers: [{ serverName: "x" }, { serverName: "computer-use" }] });
    expect(calls().some((c) => c.cmd === "codex" && c.a[1] === "remove" && c.a[2] === "openai-cua-worker")).toBe(true);
    expect(fs.readdirSync(path.join(sb.dir, "state/backups")).length).toBeGreaterThan(0);
  });

  test("failed preflight (missing runtime, bad settings) changes nothing", () => {
    for (const [env, settings] of [[{ OPENAI_CUA_MCP_JSON: "/nonexistent/mcp.json" }, "{}"], [{}, "null"], [{}, "{oops"], [{}, '{"deniedMcpServers":{}}']]) {
      const sb = sandbox(env);
      const { bin, calls } = fakeBin(sb);
      const cfg = path.join(sb.dir, "claude-cfg");
      fs.mkdirSync(cfg);
      fs.writeFileSync(path.join(cfg, "settings.json"), settings);
      const r = spawnSync(NODE, [path.join(ROOT, "install.mjs")], { encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("No configuration was changed");
      expect(calls().filter((c) => c.a[0] === "mcp")).toEqual([]);
      expect(fs.readFileSync(path.join(cfg, "settings.json"), "utf8")).toBe(settings);
    }
  });

  test("failed registration restores the previous one and leaves settings alone", () => {
    const sb = sandbox({ FAKE_ADD_FAIL_ONCE: "1" });
    const { bin, calls } = fakeBin(sb);
    const cfg = path.join(sb.dir, "claude-cfg");
    fs.mkdirSync(cfg);
    const old = { type: "stdio", command: "/old/node", args: ["/old/shim.mjs"], env: {} };
    fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ mcpServers: { "openai-computer-use": old } }));
    fs.writeFileSync(path.join(cfg, "settings.json"), "{}");
    const r = spawnSync(NODE, [path.join(ROOT, "install.mjs"), "--skip-live"], { encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Previous registration restored");
    const adds = calls().filter((c) => c.a[1] === "add-json");
    expect(JSON.parse(adds.at(-1).a[5])).toEqual(old);
    expect(fs.readFileSync(path.join(cfg, "settings.json"), "utf8")).toBe("{}");
  });
});
