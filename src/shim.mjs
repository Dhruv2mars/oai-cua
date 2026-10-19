#!/usr/bin/env node
// SHIM — a stdio MCP server that Claude Code launches. It carries no trust of
// its own; it forwards JSON-RPC to the app-spawned worker over a Unix socket.
// initialize/tools/list are answered locally (with cached schemas) so Claude
// always sees the toolset; tools/call is proxied live to the worker. When the
// worker isn't up (ChatGPT app closed / no Codex session has spawned it), calls
// return a clear, actionable error instead of hanging.
import net from "node:net";
import fs from "node:fs";
import { SOCK, TOOLS_CACHE, FALLBACK_TOOLS, makeLineReader, writeLine } from "./lib.mjs";

const HINT =
  "OpenAI computer-use worker is not running. Open the ChatGPT desktop app " +
  "(it is the trust anchor) and start or resume any Codex conversation once so " +
  "the app spawns the bridge worker, then retry.";

const out = process.stdout;
const reply = (id, result) => writeLine(out, { jsonrpc: "2.0", id, result });
const replyErr = (id, message) => writeLine(out, { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: message }] } });

function loadTools() {
  try { return JSON.parse(fs.readFileSync(TOOLS_CACHE, "utf8")); } catch { return FALLBACK_TOOLS; }
}

// One short-lived socket round-trip per request keeps the proxy stateless and
// resilient to the worker being recycled between calls.
function proxy(req, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const c = net.connect(SOCK);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { c.destroy(); } catch {}; resolve(v); };
    const onLine = makeLineReader((m) => finish(m));
    c.on("connect", () => writeLine(c, req));
    c.on("data", onLine);
    c.on("error", () => finish(null));
    setTimeout(() => finish(null), timeoutMs);
  });
}

process.stdin.on(
  "data",
  makeLineReader(async (m) => {
    if (m.method === "initialize") {
      reply(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "openai-computer-use", version: "0.1.0" } });
      return;
    }
    if (m.method === "notifications/initialized") return;
    if (m.method === "ping") { reply(m.id, {}); return; }
    if (m.method === "tools/list") {
      const r = await proxy({ jsonrpc: "2.0", id: m.id, method: "tools/list" }, 10000);
      if (r?.result?.tools?.length) reply(m.id, { tools: r.result.tools });
      else reply(m.id, { tools: loadTools() }); // worker down → cached/fallback schemas
      return;
    }
    if (m.method === "tools/call") {
      const r = await proxy({ jsonrpc: "2.0", id: m.id, method: "tools/call", params: m.params });
      if (!r) return replyErr(m.id, HINT);
      if (r.error) return replyErr(m.id, r.error.message || HINT);
      writeLine(out, { jsonrpc: "2.0", id: m.id, result: r.result });
      return;
    }
    if (m.id != null) reply(m.id, {});
  }),
);
