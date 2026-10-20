#!/usr/bin/env node
// Test double for OpenAI's cua-repl MCP server. Runs the bridge's generated
// cells against a fake `cua` API and records every call in $FAKE_LOG.
// Knobs (env): FAKE_INIT_DELAY_MS, FAKE_INIT_ERROR, FAKE_AUTH_FAIL,
// FAKE_SPLIT (byte-by-byte stdout), FAKE_CRASH_ONCE (file path),
// FAKE_SLOW_EXIT_MS, FAKE_ELICIT, FAKE_HANG, FAKE_CELL_DELAY_MS,
// FAKE_IGNORE_TERM (ignores SIGTERM/EOF and spawns a grandchild),
// FAKE_AUDIO_ELICIT_ON_CLICK (a click also asks to record audio), FAKE_WAV_BYTES,
// FAKE_DOCS (first-use docs text; "" disables), FAKE_REPL_RESET (file path:
// the REPL restarts once before the first bridge cell, printing FAKE_RESET_DOCS),
// FAKE_TREE_FILE (JSON {app: tree} read on every capture), FAKE_NO_SHOT.
// FAKE_TAKEOVER (first N actions fail with the service's "user changed" error),
// FAKE_BY_ID (getApp only accepts bundle ids), FAKE_ERROR (getApp throws it).
// FAKE_STICKY_STOP: a stopped app stays stopped until this process exits (turn
// ends don't clear it), as SkyComputerUseService sometimes does;
// FAKE_USER_STOP: comma-separated apps the user stopped; only the first fake
// process started for this FAKE_LOG sees them (a new engine is clean).
// Actions whose first argument is "FAIL" throw. js_reset drops globals.
import fs from "node:fs";
import { spawn } from "node:child_process";

const E = process.env;
const record = (ev) => fs.appendFileSync(E.FAKE_LOG, JSON.stringify({ pid: process.pid, ...ev }) + "\n");
const grandchild = E.FAKE_IGNORE_TERM ? spawn("/bin/sleep", ["60"], { stdio: "ignore" }).pid : undefined;
record({ ev: "spawn", surfaces: E.CUA_REPL_ENABLED_SURFACES, backends: E.BROWSER_USE_AVAILABLE_BACKENDS, audio: [E.SKY_ENABLE_AUDIO, E.NODE_REPL_ENABLE_AUDIO], grandchild });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  if (!E.FAKE_SPLIT) return process.stdout.write(buf);
  for (const b of buf) process.stdout.write(Buffer.from([b])); // splits multibyte chars
}

let nextServerId = 1000;
const waiting = new Map();
function elicit(message, meta) {
  return new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    const bundle = /browser-link/.test(message) ? "com.google.Chrome" : "com.example.app"; // service resolves identity
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message, _meta: meta ?? {
      riskLevel: "high", subtitle: "Can read your documents", persist: ["session", "always"],
      tool_params: { app: bundle }, tool_params_display: [{ name: "app", display_name: "App", value: "Example" }] }, requestedSchema: { type: "object", properties: {} } } });
  });
}
// Same shape as the real policy's audio approval request.
const audioApproval = async () => {
  const r = await elicit("Allow Computer Use to record computer audio?", { riskLevel: "high", tool_name: "start_audio_recording", tool_params: {} });
  record({ ev: "audio-elicit", action: r.action });
  if (r.action !== "accept") throw new Error("Computer Use was not approved to record computer audio");
};
function wav(dataBytes) { // 24 kHz stereo 16-bit
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataBytes, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(b);
}

let out = [];
const treeOf = (name) => {
  if (E.FAKE_TREE_FILE && fs.existsSync(E.FAKE_TREE_FILE)) { const t = JSON.parse(fs.readFileSync(E.FAKE_TREE_FILE, "utf8"))[name]; if (t != null) return t; }
  return `tree of ${name} é日`;
};
const shot = () => { if (E.FAKE_NO_SHOT) throw new Error("Screenshot unavailable for fake."); return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); };
// Without disableDiffing the real engine answers with its own (shared-baseline) diff.
const capture = (name, o, kind) => { record({ ev: "observe", app: name, kind, disableDiffing: !!o?.disableDiffing, emit: o?.emit }); return o?.disableDiffing ? treeOf(name) : "ENGINE DIFF (must not be used)"; };
let takeovers = Number(E.FAKE_TAKEOVER || 0);
const firstProcess = (() => { try { fs.writeFileSync(`${E.FAKE_LOG}.started`, "", { flag: "wx" }); return true; } catch { return false; } })();
const stopped = new Set(firstProcess ? (E.FAKE_USER_STOP || "").split(",").filter(Boolean) : []);
const app = (name) => {
  const rec = (method) => async (...args) => {
    record({ ev: "action", app: name, method, args });
    if (args[0] === "FAIL") throw new Error(`fake ${method} failure`);
    if (takeovers > 0) { takeovers--; throw new Error(`The user changed '${name}'. Re-query the latest state with \`get_app_state\` before sending more actions.`); }
    if (method === "click" && E.FAKE_AUDIO_ELICIT_ON_CLICK) await audioApproval().catch(() => {});
  };
  return {
    click: rec("click"), typeText: rec("typeText"), paste: rec("paste"), pressKey: rec("pressKey"), scroll: rec("scroll"),
    drag: rec("drag"), setValue: rec("setValue"), selectText: rec("selectText"), performSecondaryAction: rec("performSecondaryAction"),
    async getAXState(o) { return capture(name, o, "tree"); },
    async getScreenshot(o) { record({ ev: "observe", app: name, kind: "shot", emit: o?.emit }); return shot(); },
    async getAXStateAndScreenshot(o) { const state = capture(name, o, "tree+shot"); return E.FAKE_NO_SHOT ? { state } : { state, screenshot: shot() }; },
  };
};
globalThis.nodeRepl = {
  write: (t) => out.push({ type: "text", text: String(t) }),
  emitImage: async (img) => out.push({ type: "image", mimeType: "image/jpeg", data: Buffer.from(img).toString("base64") }),
  async rpc(service, msg) { // the bridge's trusted service
    record({ ev: "rpc", service, msg });
    if (msg.type === "stopApp" && E.FAKE_STICKY_STOP) stopped.add(msg.app);
    if (msg.type === "stopApp") return { bundleIdentifier: `com.example.${msg.app}`, displayName: msg.app, active: false };
    if (msg.type === "turnEnded") return {};
    throw new Error(`unsupported cuabridge request: ${msg.type}`);
  },
  ...(E.NODE_REPL_ENABLE_AUDIO === "1" ? { emitAudio: async (url) => out.push({ type: "audio", mimeType: "audio/wav", data: url.slice(url.indexOf(",") + 1) }) } : {}),
};
let recording = null;
const audioComputer = E.SKY_ENABLE_AUDIO === "1" ? {
  async start_audio_recording(input = {}) {
    record({ ev: "audio", method: "start", input });
    await audioApproval();
    recording = input;
  },
  async stop_audio_recording() {
    record({ ev: "audio", method: "stop" });
    if (!recording) throw new Error("Computer Use server error -10005: no active audio recording");
    recording = null;
    const bytes = wav(Number(E.FAKE_WAV_BYTES || 48000));
    return { filepath: "/tmp/fake-computer-audio.wav", bytes, data_url: "data:audio/wav;base64," + Buffer.from(bytes).toString("base64") };
  },
} : {};
const resolve = (app) => (/browser-link/.test(app) ? "com.google.Chrome" : app); // service resolves identity
// Like the real service, every app use goes through app-access approval.
const makeComputer = () => {
  const c = { target: "mac", ...audioComputer };
  for (const m of ["get_app_state", "click", "press_key", "type_text"])
    c[m] = async (input) => {
      if (E.FAKE_ELICIT && m === "get_app_state") { const r = await elicit(`Allow Computer Use to use "${input.app}"?`); record({ ev: "elicit", action: r.action }); if (r.action !== "accept") throw new Error("not approved"); }
      record({ ev: "computer", method: m, input }); return m === "get_app_state" ? { app: resolve(input.app), text: treeOf(input.app), screenshot: null } : undefined;
    };
  return c;
};
let computer;
const makeCua = () => ({
  computer: (computer = makeComputer()),
  async getState() { return E.FAKE_AUTH_FAIL ? { apps: [], errors: ["Native apps: Error: Sky Computer Use native pipe startup failed"] } : { apps: [] }; },
  async listApps() { return [{ id: "com.apple.TextEdit", displayName: "TextEdit", isRunning: true, windows: [{ title: "fixture" }] }, { id: "net.imput.helium", displayName: "Helium", isRunning: true }]; },
  async getApp(name) {
    record({ ev: "getApp", name });
    if (E.FAKE_ERROR) throw new Error(E.FAKE_ERROR);
    if (stopped.has(name)) throw new Error("This application session has been explicitly stopped by the user for this turn. Stop your work and send a final message noting they stopped the session and you're ready to continue if they want you to. Computer Use can be used again in the next assistant turn.");
    if (E.FAKE_BY_ID && !/^[a-z]+\.[a-z]+\./.test(name)) throw new Error("Computer Use server error -10010: Invalid app");
    await computer.get_app_state({ app: name, disableDiff: true });
    nodeRepl.write(`auto-emitted state for ${name}`); // real getApp emits state too
    return app(name);
  },
});
globalThis.cua = makeCua();
const initialGlobals = new Set(Object.keys(globalThis));
const AsyncFunction = (async () => {}).constructor;

// Like cua-repl, a fresh REPL prints first-use docs ahead of a cell's output.
let fresh = true, seen = 0;
const DOCS = E.FAKE_DOCS ?? "## Computer Use\nFAKE FIRST-USE DOCS";

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
    record({ ev: "cell", timeout_ms, code: code.slice(0, 120), turn: m.params._meta?.["x-codex-turn-metadata"] });
    if (E.FAKE_CRASH_ONCE && code.includes("__cb") && !fs.existsSync(E.FAKE_CRASH_ONCE)) { fs.writeFileSync(E.FAKE_CRASH_ONCE, ""); process.exit(3); }
    if (E.FAKE_HANG && code.includes("__cb")) return; // never answers
    if (code.includes("__cb")) await sleep(Number(E.FAKE_CELL_DELAY_MS || 0));
    out = [];
    let docs = fresh ? DOCS : "";
    fresh = false;
    if (E.FAKE_REPL_RESET && code.includes("__cb") && !fs.existsSync(E.FAKE_REPL_RESET)) { fs.writeFileSync(E.FAKE_REPL_RESET, ""); docs = E.FAKE_RESET_DOCS ?? DOCS; }
    const boot = docs ? [{ type: "text", text: docs }] : [];
    if (!fresh && /^nodeRepl\.write\([^\n]*\);\nconst A = /.test(code) && seen++) boot.push({ type: "text", text: "Warning: A was declared with const; use let for reassignable variables.\n" }); // real REPL redeclaration noise
    try {
      await new AsyncFunction(code)();
      send({ jsonrpc: "2.0", id: m.id, result: { content: [...boot, ...out] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: e.message }, ...out], isError: true } });
    }
    return;
  }
  if (m.method === "tools/call" && m.params?.name === "turn_ended") {
    record({ ev: "turn_ended", args: m.params.arguments });
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "{}" }] } });
  }
  if (m.method === "tools/call" && m.params?.name === "js_reset") {
    record({ ev: "js_reset" });
    for (const k of Object.keys(globalThis)) if (!initialGlobals.has(k)) delete globalThis[k];
    globalThis.cua = makeCua(); // fresh runtime
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [] } });
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
