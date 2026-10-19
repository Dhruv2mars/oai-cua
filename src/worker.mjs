#!/usr/bin/env node
// WORKER — spawned by the ChatGPT/Codex desktop app as an MCP server (via a
// ~/.codex/config.toml mcp_servers entry). Because the app launches it, its
// responsible process is the app (com.openai.codex), which is the trust +
// Automation-TCC anchor SkyComputerUseService requires. The worker:
//   1. behaves as a healthy MCP server toward codex so codex keeps it alive;
//   2. owns one authorized SkyComputerUseClient child and auto-accepts its
//      elicitation (app-access) prompts;
//   3. serves a Unix-domain socket that the Claude Code shim proxies to.
// Only one worker owns the client+socket; extra spawns become keep-alive stubs.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import {
  STATE_DIR, SOCK, PID, TOOLS_CACHE, CLIENT_PATH, CLIENT_CWD,
  ensureStateDir, logger, makeLineReader, writeLine,
} from "./lib.mjs";

ensureStateDir();
const LOG = `${STATE_DIR}/worker.log`;
const log = logger(LOG);
const IDLE_MS = Number(process.env.OPENAI_CUA_IDLE_MS ?? 120000); // release apps after idle

// ---- keep codex happy on our stdio (codex is our parent/spawner) ----
process.stdin.on(
  "data",
  makeLineReader((m) => {
    if (m.method === "initialize")
      writeLine(process.stdout, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openai-cua-worker", version: "0.1.0" } } });
    else if (m.method === "tools/list")
      writeLine(process.stdout, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "status", description: "OpenAI computer-use bridge worker health", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    else if (m.method === "ping") writeLine(process.stdout, { jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === "tools/call") writeLine(process.stdout, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: owner ? "bridge-up" : "keepalive-stub" }] } });
    else if (m.id != null) writeLine(process.stdout, { jsonrpc: "2.0", id: m.id, result: {} });
  }),
);
process.on("SIGTERM", () => { log("SIGTERM"); shutdown(0); });
process.on("SIGINT", () => shutdown(0));

let owner = false; // did this instance bind the socket + own the client?

// Decide ownership: if an existing worker answers on the socket, stay a stub.
(async function init() {
  if (fs.existsSync(SOCK)) {
    const alive = await probe(SOCK);
    if (alive) { log("another worker owns socket; running as keep-alive stub"); return; }
    try { fs.unlinkSync(SOCK); } catch {}
  }
  startServer();
})();

function probe(sock) {
  return new Promise((res) => {
    const c = net.connect(sock);
    const done = (v) => { try { c.destroy(); } catch {}; res(v); };
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

// ---------- client (SkyComputerUseClient) management with id-remap proxy ----------
let client = null;            // child process
let clientReady = null;       // Promise resolving when handshake + tools list done
let nextId = 100;             // ids we originate toward the client
const pending = new Map();    // clientReqId -> (responseObj) => void
let idleTimer = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (IDLE_MS > 0) idleTimer = setTimeout(() => { log("idle: releasing client"); killClient(); }, IDLE_MS);
}
function killClient() {
  if (client) { try { client.kill("SIGTERM"); } catch {}; client = null; clientReady = null; }
  for (const [, resolve] of pending) resolve({ error: { code: -32000, message: "client released" } });
  pending.clear();
}

function ensureClient() {
  if (client && clientReady) return clientReady;
  log("launching SkyComputerUseClient");
  client = spawn(CLIENT_PATH, ["mcp"], { cwd: CLIENT_CWD, stdio: ["pipe", "pipe", "pipe"] });
  client.stderr.on("data", (d) => log("client stderr: " + d.toString().slice(0, 200)));
  client.on("exit", (c) => { log(`client exit ${c}`); killClient(); });
  const toClient = (o) => writeLine(client.stdin, o);
  client.stdout.on(
    "data",
    makeLineReader((m) => {
      if (m.method) {
        // server-initiated request from the client: auto-approve app access.
        if (m.method === "elicitation/create") toClient({ jsonrpc: "2.0", id: m.id, result: { action: "accept", content: {} } });
        else if (m.id != null) toClient({ jsonrpc: "2.0", id: m.id, result: {} });
        return;
      }
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); cb(m); }
    }),
  );
  // MCP handshake; advertise elicitation so the client routes app-access to us.
  toClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "openai-cua-worker", version: "0.1.0" } } });
  toClient({ jsonrpc: "2.0", method: "notifications/initialized" });
  clientReady = callClient("tools/list", {})
    .then((r) => { if (r?.result?.tools) { try { fs.writeFileSync(TOOLS_CACHE, JSON.stringify(r.result.tools)); } catch {} } return true; })
    .catch(() => true);
  touchIdle();
  return clientReady;
}

function callClient(method, params) {
  return new Promise((resolve) => {
    if (!client) return resolve({ error: { code: -32000, message: "no client" } });
    const id = nextId++;
    pending.set(id, resolve);
    writeLine(client.stdin, { jsonrpc: "2.0", id, method, params });
    touchIdle();
  });
}

// ---------- socket server for the shim ----------
function startServer() {
  const server = net.createServer((conn) => {
    conn.on(
      "data",
      makeLineReader(async (req) => {
        // initialize / tools/list handled fast; everything else proxied live.
        if (req.method === "initialize") {
          writeLine(conn, { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openai-computer-use", version: "0.1.0" } } });
          return;
        }
        if (req.method === "notifications/initialized") return;
        if (req.method === "ping") { writeLine(conn, { jsonrpc: "2.0", id: req.id, result: {} }); return; }
        if (req.method === "tools/list") {
          await ensureClient();
          let tools;
          try { tools = JSON.parse(fs.readFileSync(TOOLS_CACHE, "utf8")); } catch { tools = null; }
          writeLine(conn, { jsonrpc: "2.0", id: req.id, result: { tools: tools || [] } });
          return;
        }
        if (req.method === "tools/call") {
          await ensureClient();
          const r = await callClient("tools/call", req.params);
          if (r.error) writeLine(conn, { jsonrpc: "2.0", id: req.id, error: r.error });
          else writeLine(conn, { jsonrpc: "2.0", id: req.id, result: r.result });
          return;
        }
        if (req.id != null) writeLine(conn, { jsonrpc: "2.0", id: req.id, result: {} });
      }),
    );
    conn.on("error", () => {});
  });
  server.on("error", (e) => { log("server error " + e.message); process.exit(1); });
  server.listen(SOCK, () => { owner = true; try { fs.writeFileSync(PID, String(process.pid)); } catch {}; log(`worker listening pid=${process.pid} responsible-via=app`); });
}

function shutdown(code) {
  killClient();
  if (owner) { try { fs.unlinkSync(SOCK); } catch {}; try { fs.unlinkSync(PID); } catch {} }
  process.exit(code);
}
