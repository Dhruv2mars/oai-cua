#!/usr/bin/env node
// Test double for OpenAI's cua-repl MCP server. Runs the bridge's generated
// cells against a fake `cua` API and records every call in $FAKE_LOG.
// Knobs (env): FAKE_INIT_DELAY_MS, FAKE_INIT_ERROR, FAKE_AUTH_FAIL,
// FAKE_SPLIT (byte-by-byte stdout), FAKE_CRASH_ONCE (file path),
// FAKE_SLOW_EXIT_MS, FAKE_ELICIT, FAKE_HANG, FAKE_CELL_DELAY_MS,
// FAKE_IGNORE_TERM (ignores SIGTERM/EOF and spawns a grandchild).
import fs from "node:fs";
import { spawn } from "node:child_process";

const E = process.env;
const record = (ev) => fs.appendFileSync(E.FAKE_LOG, JSON.stringify({ pid: process.pid, ...ev }) + "\n");
const grandchild = E.FAKE_IGNORE_TERM ? spawn("/bin/sleep", ["60"], { stdio: "ignore" }).pid : undefined;
record({ ev: "spawn", surfaces: E.CUA_REPL_ENABLED_SURFACES, backends: E.BROWSER_USE_AVAILABLE_BACKENDS, grandchild });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  if (!E.FAKE_SPLIT) return process.stdout.write(buf);
  for (const b of buf) process.stdout.write(Buffer.from([b])); // splits multibyte chars
}

let nextServerId = 1000;
const waiting = new Map();
function elicit(message) {
  return new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    const bundle = /browser-link/.test(message) ? "com.google.Chrome" : "com.example.app"; // service resolves identity
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message, _meta: { tool_params: { app: bundle } }, requestedSchema: { type: "object", properties: {} } } });
  });
}

let out = [];
const app = (name) => {
  const rec = (method) => async (...args) => { record({ ev: "action", app: name, method, args }); };
  return {
    click: rec("click"), typeText: rec("typeText"), paste: rec("paste"), pressKey: rec("pressKey"), scroll: rec("scroll"),
    drag: rec("drag"), setValue: rec("setValue"), selectText: rec("selectText"), performSecondaryAction: rec("performSecondaryAction"),
    async getAXState() { return `state of ${name} é日`; },
    async getAXStateAndScreenshot() { return { state: `tree of ${name} é日`, screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }; },
  };
};
globalThis.nodeRepl = {
  write: (t) => out.push({ type: "text", text: String(t) }),
  emitImage: async (img) => out.push({ type: "image", mimeType: "image/jpeg", data: Buffer.from(img).toString("base64") }),
};
globalThis.cua = {
  async getState() { return E.FAKE_AUTH_FAIL ? { apps: [], errors: ["Native apps: Error: Sky Computer Use native pipe startup failed"] } : { apps: [] }; },
  async listApps() { return [{ id: "com.apple.TextEdit", displayName: "TextEdit", isRunning: true, windows: [{ title: "fixture" }] }]; },
  async getApp(name) {
    if (E.FAKE_ELICIT) { const r = await elicit(`Allow Computer Use to use "${name}"?`); record({ ev: "elicit", action: r.action }); if (r.action !== "accept") throw new Error("not approved"); }
    nodeRepl.write(`auto-emitted state for ${name}`); // real getApp emits state too
    return app(name);
  },
};
const AsyncFunction = (async () => {}).constructor;

let initialized = false;
async function handle(m) {
  if (m.method === "tools/call" && !initialized) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "not initialized" } });
  if (m.method === "initialize") {
    await sleep(Number(E.FAKE_INIT_DELAY_MS || 0));
    if (E.FAKE_INIT_ERROR) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "init refused" } });
    initialized = true;
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "0" } } });
  }
  if (m.method === "tools/call" && m.params?.name === "js") {
    const { code, timeout_ms } = m.params.arguments;
    record({ ev: "cell", timeout_ms, code: code.slice(0, 120) });
    if (E.FAKE_CRASH_ONCE && code.includes("__cb") && !fs.existsSync(E.FAKE_CRASH_ONCE)) { fs.writeFileSync(E.FAKE_CRASH_ONCE, ""); process.exit(3); }
    if (E.FAKE_HANG && code.includes("__cb")) return; // never answers
    if (code.includes("__cb")) await sleep(Number(E.FAKE_CELL_DELAY_MS || 0));
    out = [];
    try {
      await new AsyncFunction(code)();
      send({ jsonrpc: "2.0", id: m.id, result: { content: out } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: e.message }, ...out], isError: true } });
    }
    return;
  }
  if (m.id != null && !m.method && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  if (m.id != null && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
process.stdin.on("end", () => { record({ ev: "eof" }); if (!E.FAKE_IGNORE_TERM) setTimeout(() => process.exit(0), Number(E.FAKE_SLOW_EXIT_MS || 0)); });
process.on("SIGTERM", () => {
  record({ ev: "sigterm" });
  if (!E.FAKE_IGNORE_TERM) setTimeout(() => process.exit(0), Number(E.FAKE_SLOW_EXIT_MS || 0));
});
