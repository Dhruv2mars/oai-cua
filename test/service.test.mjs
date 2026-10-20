// Regression tests for the native SkyComputerUseClient tools (Record & Replay,
// opt-in Computer History) against a fake client, launched through the real
// disclaimed-spawn chain (python3 → parent node → client).
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const NODE = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
const FAKE_NATIVE = path.join(ROOT, "test/fake-native-client.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-svc-test-"));
  const log = path.join(dir, "fake.log");
  fs.writeFileSync(log, "");
  const client = path.join(dir, "SkyComputerUseClient");
  fs.writeFileSync(client, `#!/bin/sh\nexec ${JSON.stringify(NODE)} ${JSON.stringify(FAKE_NATIVE)} "$@"\n`, { mode: 0o755 });
  return {
    dir, log,
    env: {
      ...process.env, HOME: dir, OAI_CUA_STATE_DIR: path.join(dir, "state"), OAI_CUA_MCP_JSON: "/nonexistent/mcp.json",
      OAI_CUA_NATIVE_CLIENT: client, OAI_CUA_NATIVE_PARENT: NODE, CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      FAKE_LOG: log, FAKE_EVENTS_DIR: path.join(dir, "rec"), ...env,
    },
    events: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// onRequest(m) answers server → client requests (elicitation) like Claude Code would.
function startShim(sb, { caps = {}, onRequest = () => ({ action: "decline" }) } = {}) {
  const p = spawn(NODE, [path.join(ROOT, "src/shim.mjs")], { env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => { try { p.kill("SIGKILL"); } catch {} });
  let buf = "", id = 0;
  const waiters = new Map(), asked = [];
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method && m.id != null) { asked.push(m); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: onRequest(m) }) + "\n"); }
      else waiters.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  return {
    p, rpc, asked, exited: new Promise((r) => p.on("exit", r)),
    init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: caps, clientInfo: { name: "test", version: "0" } }),
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
  };
}
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const names = async (s) => (await s.rpc("tools/list", {})).result.tools.map((t) => t.name);

describe("record & replay", () => {
  test("tools are listed without spawning anything; Computer History is hidden unless opted in", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const n = await names(s);
    expect(n).toEqual(expect.arrayContaining(["record_start", "record_status", "record_stop", "recording_to_skill"]));
    expect(n.some((x) => x.startsWith("computer_history"))).toBe(false);
    expect(textOf(await s.call("computer_history_status"))).toContain("unknown tool");
    expect(sb.events().length).toBe(0);
  });

  test("start forwards the consent prompt to the user, stop + recording_to_skill writes a redacted SKILL.md", async () => {
    const sb = sandbox(), s = startShim(sb, { caps: { elicitation: {} }, onRequest: () => ({ action: "accept", content: {} }) });
    await s.init();
    expect(JSON.parse(textOf(await s.call("record_status"))).isRecording).toBe(false);
    const started = JSON.parse(textOf(await s.call("record_start")));
    expect(started.isRecording).toBe(true);
    expect(s.asked.map((m) => [m.method, m.params.message])).toEqual([["elicitation/create", "Allow ChatGPT to record your actions on your Mac?"]]);
    expect(s.asked[0].params._meta).toBeUndefined();
    expect(sb.events().find((e) => e.ev === "native-init").caps).toEqual({ elicitation: {} });
    // launched via python3 → parent node → client, never directly by the shim
    const spawnEv = sb.events().find((e) => e.ev === "native-spawn");
    expect(spawnEv.sub).toBe("event-stream mcp");
    expect(spawnEv.ppid).not.toBe(s.p.pid);

    const stopped = await s.call("record_stop");
    expect(JSON.parse(stopped.content[0].text).eventsPath).toContain("events.jsonl");
    expect(textOf(stopped)).toContain("recording_to_skill");

    const r = await s.call("recording_to_skill", { name: "Write Note!" });
    expect(r.isError).toBeUndefined();
    const file = path.join(sb.dir, "claude/skills/write-note/SKILL.md");
    const md = fs.readFileSync(file, "utf8");
    expect(textOf(r)).toContain(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(md).toStartWith("---\nname: write-note\ndescription: ");
    expect(md).toContain("Switch to **TextEdit** (window “Notes”)");
    expect(md).toContain("Click Button “New Document” in TextEdit.");
    expect(md).toContain("Type {{input_1}} (recorded: “Hello world”)");
    expect(md).toContain("`command+s`");
    expect(md).toContain("[redacted]");
    expect(md).not.toContain("hunter2");
    expect(md).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(md).toContain("1 secure-input events dropped");
    expect(textOf(r)).toContain("1 unreadable lines");

    const again = await s.call("recording_to_skill", { name: "write-note" });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("already exists");
    expect((await s.call("recording_to_skill", { name: "write-note", overwrite: true })).isError).toBeUndefined();
  });

  test("declined consent, or a client without elicitation, never starts a recording", async () => {
    const sb = sandbox(), s = startShim(sb, { caps: { elicitation: {} }, onRequest: () => ({ action: "decline" }) });
    await s.init();
    const r = await s.call("record_start");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("denied");
    expect(JSON.parse(textOf(await s.call("record_status"))).isRecording).toBe(false);

    const sb2 = sandbox(), s2 = startShim(sb2); // no elicitation capability
    await s2.init();
    const r2 = await s2.call("record_start");
    expect(r2.isError).toBe(true);
    expect(s2.asked.length).toBe(0);
    expect(sb2.events().find((e) => e.ev === "native-init").caps).toEqual({});
  });

  test("argument validation and missing recordings fail cleanly", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("recording_to_skill", {}))).toContain("missing required argument: name");
    expect(textOf(await s.call("recording_to_skill", { name: "x", overwrite: "yes" }))).toContain("overwrite must be a boolean");
    expect(textOf(await s.call("record_start", { now: true }))).toContain("unknown argument: now");
    expect(textOf(await s.call("recording_to_skill", { name: "x" }))).toContain("no recording found");
    expect(textOf(await s.call("recording_to_skill", { name: "x", events_path: "/nonexistent" }))).toContain("recording not found");
  });

  test("a missing native client is reported, and the shim stays up", async () => {
    const sb = sandbox({ OAI_CUA_NATIVE_CLIENT: "/nonexistent/SkyComputerUseClient" }), s = startShim(sb);
    await s.init();
    const r = await s.call("record_status");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("SkyComputerUseClient");
    expect((await s.rpc("ping", {})).result).toEqual({});
  });

  test("shim exit stops the native client", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("record_status");
    s.p.stdin.end();
    await s.exited;
    await sleep(300);
    expect(sb.events().some((e) => e.ev === "native-eof" || e.ev === "native-sigterm")).toBe(true);
  });
});

test("an idle release is logged as a stop, not an exit", async () => {
  const sb = sandbox({ OAI_CUA_IDLE_MS: "300" }), s = startShim(sb);
  await s.init();
  await s.call("record_status");
  await sleep(1500);
  const log = fs.readFileSync(path.join(sb.dir, "state/shim.log"), "utf8");
  expect(log).toMatch(/native .*: stopping \(idle\)\n.*native .*: stopped\n/);
  expect(log).not.toMatch(/native .*: exit /);
});

describe("computer history (opt-in)", () => {
  test("OAI_CUA_COMPUTER_HISTORY=1 exposes status, settings, pause and resume; schema is enforced", async () => {
    const sb = sandbox({ OAI_CUA_COMPUTER_HISTORY: "1", FAKE_HISTORY_STATE: "running" }), s = startShim(sb);
    await s.init();
    expect(await names(s)).toEqual(expect.arrayContaining(["computer_history_status", "computer_history_get_settings", "computer_history_update_settings", "computer_history_pause", "computer_history_resume"]));
    expect(JSON.parse(textOf(await s.call("computer_history_status"))).state).toBe("running");
    const cur = JSON.parse(textOf(await s.call("computer_history_get_settings")));
    expect(cur.observation.defaultURLBehavior).toBe("observe");
    const bad = await s.call("computer_history_update_settings", { observation: { ...cur.observation, defaultURLBehavior: "maybe" } });
    expect(textOf(bad)).toContain("observation.defaultURLBehavior must be one of");
    const next = { observation: { ...cur.observation, blocklist: [{ scope: "url", urlDomain: "bank.example" }] } };
    expect((await s.call("computer_history_update_settings", next)).isError).toBeUndefined();
    expect(JSON.parse(textOf(await s.call("computer_history_pause"))).state).toBe("paused");
    expect(JSON.parse(textOf(await s.call("computer_history_resume"))).state).toBe("running");
    const calls = sb.events().filter((e) => e.ev === "native-call");
    expect(calls.find((e) => e.name === "computer_history_update_settings").args).toEqual(next);
    expect(calls.every((e) => e.sub === "computer-history mcp")).toBe(true);
  });
});
