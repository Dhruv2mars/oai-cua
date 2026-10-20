#!/usr/bin/env node
// openai-computer-use: a stdio MCP server for Claude Code that drives OpenAI's
// installed computer-use engine (ChatGPT.app's cua-repl → SkyComputerUseService).
// No OpenAI model is called and the ChatGPT app does not need to be running.
//   node src/shim.mjs            MCP server (what Claude Code launches)
//   node src/shim.mjs --doctor   live health check
import { randomUUID } from "node:crypto";
import { Engine, EngineError } from "./engine.mjs";
import { STATE_DIR, findRuntime, logger, makeLineReader, writeLine } from "./lib.mjs";
import { buildCell, extractOutput, isReadOnly, publicTools, validate } from "./tools.mjs";

const VERSION = "0.2.0";
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const INSTRUCTIONS = `Use these tools for any task that needs to see or operate macOS desktop apps (OpenAI's computer-use engine). They work in the background: the user's cursor and frontmost app are not touched, and different apps can be used concurrently.
Workflow: call get_app_state(app) first to get a screenshot plus a numbered accessibility tree, then act by element_index (preferred) or screenshot x/y; actions return the updated accessibility state. Call get_app_state again for a fresh screenshot or when indices may be stale.
Prefer purpose-built tools, CLIs or APIs when they can do the job. Never open or operate Google Chrome. Do not send messages, make purchases, or change user documents without the user's explicit request.`;

const log = logger("shim.log");
const engine = new Engine({
  log,
  idleMs: Number(process.env.OPENAI_CUA_IDLE_MS ?? 300000),
  callTimeoutMs: Number(process.env.OPENAI_CUA_CALL_TIMEOUT_MS ?? 60000),
  audio: process.env.OPENAI_CUA_AUDIO !== "0",
});
const MARK = `⟦cua-bridge:${randomUUID()}⟧`;

// MCP audio content exists from protocol 2025-03-26 on.
let clientProtocol = "2025-06-18";
const audioContentOk = () => clientProtocol >= "2025-03-26";

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export async function callTool(name, args = {}, signal) {
  const bad = validate(name, args);
  if (bad) return text(bad, true);
  const inlineAudio = name === "stop_audio_recording" && args.include_audio === true;
  const code = buildCell(name, inlineAudio && !audioContentOk() ? { ...args, include_audio: false } : args, MARK);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await engine.run(code, undefined, signal, { allowAudio: name === "start_audio_recording" });
      const out = extractOutput(r.content, MARK);
      if (name === "start_audio_recording" && !r.isError) engine.keepAliveUntil(Date.now() + Number(args.max_duration_ms ?? 60000) + 5000);
      if (name === "stop_audio_recording") engine.keepAliveUntil(0);
      if (inlineAudio && !audioContentOk() && out) out.push({ type: "text", text: `\n(audio content needs MCP protocol 2025-03-26 or later; this client negotiated ${clientProtocol})` });
      if (r.isError || !out) {
        const msg = String((r.isError ? r.content[0]?.text : "no output from engine") ?? "").slice(0, 1000).trim(); // REPL errors come first
        return text(msg || "computer-use action failed", true);
      }
      return { content: out.length ? out : [{ type: "text", text: "Done." }] };
    } catch (e) {
      // A crashed engine restarts on the next cell; only reads are retried.
      if (signal?.aborted) return text("cancelled", true);
      if (e instanceof EngineError && e.code === "ENGINE_EXIT" && attempt === 0 && isReadOnly(name)) continue;
      log(`call ${name} failed: ${e.message}`);
      return text(`${e.message}\nDiagnostics: node ${new URL(import.meta.url).pathname} --doctor (log: ${STATE_DIR}/shim.log)`, true);
    }
  }
}

function serve() {
  const out = process.stdout;
  const reply = (id, result) => writeLine(out, { jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => writeLine(out, { jsonrpc: "2.0", id, error: { code, message } });
  log(`shim ${VERSION} up (ppid ${process.ppid})`);

  const inflight = new Map(); // request id → AbortController
  process.stdin.on("data", makeLineReader(async (m) => {
    if (m.method === "notifications/cancelled") return inflight.get(m.params?.requestId)?.abort();
    if (m.id == null) return; // other notifications
    try {
      switch (m.method) {
        case "initialize": {
          const v = m.params?.protocolVersion;
          clientProtocol = PROTOCOLS.includes(v) ? v : "2025-06-18";
          return reply(m.id, {
            protocolVersion: clientProtocol,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "openai-computer-use", version: VERSION },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping": return reply(m.id, {});
        case "tools/list": return reply(m.id, { tools: publicTools() });
        case "tools/call": {
          const ac = new AbortController();
          inflight.set(m.id, ac);
          const r = await callTool(m.params?.name, m.params?.arguments ?? {}, ac.signal).finally(() => inflight.delete(m.id));
          return ac.signal.aborted ? undefined : reply(m.id, r); // no response after cancellation
        }
        default: return fail(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) {
      log(`handler error: ${e.stack || e}`);
      fail(m.id, -32603, String(e.message || e));
    }
  }, () => fail(null, -32700, "parse error")));

  let quitting = false;
  const quit = async (why) => {
    if (quitting) return;
    quitting = true;
    log(`shim exit: ${why}`);
    await engine.stop(why);
    process.exit(0);
  };
  process.stdin.on("end", () => quit("stdin closed"));
  process.stdin.on("error", () => quit("stdin error"));
  out.on("error", () => quit("stdout closed"));
  process.on("SIGTERM", () => quit("SIGTERM"));
  process.on("SIGINT", () => quit("SIGINT"));
  process.on("uncaughtException", (e) => log(`uncaught: ${e.stack || e}`));
}

async function doctor() {
  let ok = true;
  const step = async (label, fn) => {
    try { console.log(`✓ ${label}: ${await fn()}`); }
    catch (e) { ok = false; console.log(`✗ ${label}: ${e.message}`); }
  };
  await step("runtime", async () => { const r = findRuntime(); return `${r.command} via ${r.source}`; });
  await step("engine + list_apps", async () => {
    const t = Date.now();
    const r = await callTool("list_apps");
    if (r.isError) throw new Error(r.content[0].text);
    const running = r.content[0].text.split("\n").filter((l) => l.includes("[running]")).length;
    return `${running} running apps, ${Date.now() - t}ms`;
  });
  await engine.stop("doctor done");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv.includes("--doctor")) doctor();
else serve();
