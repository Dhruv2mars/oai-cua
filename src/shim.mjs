#!/usr/bin/env node
// oai-cua: a stdio MCP server for Claude Code that drives OpenAI's
// installed computer-use engine (ChatGPT.app's cua-repl → SkyComputerUseService).
// No OpenAI model is called and the ChatGPT app does not need to be running.
//   node src/shim.mjs            MCP server (what Claude Code launches)
//   node src/shim.mjs --doctor   live health check
import { randomUUID } from "node:crypto";
import { Approver, promptText } from "./approval.mjs";
import { BROWSER_TOOLS, HeliumBrowser, discoverEndpoints, isBrowserTool, verifyEndpoint } from "./browser.mjs";
import { diagnose, explain } from "./diagnose.mjs";
import { Engine, EngineError } from "./engine.mjs";
import { FocusGuard } from "./focus.mjs";
import { FIRST_USE_URI, FirstUse, GUIDE_URI, PROMPTS, bootstrapText, buildInstructions, discover, getPrompt, guideText, listResources, readResource } from "./guidance.mjs";
import { STATE_DIR, findRuntime, logger, makeLineReader, writeLine } from "./lib.mjs";
import { Observations, limitOutput } from "./observe.mjs";
import { createService, isServiceTool, serviceTools } from "./service.mjs";
import { BATCHABLE, TOOL_NAMES, batchSteps, buildCell, extractOutput, isReadOnly, isUiAction, publicTools, targetApps, validate } from "./tools.mjs";

const VERSION = "0.2.1";
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
// OpenAI's guidance, read once at startup from the installed app (see guidance.mjs).
const DOCS = discover();
const INSTRUCTIONS = buildInstructions(DOCS, { tools: TOOL_NAMES });
const firstUse = new FirstUse(DOCS, [...TOOL_NAMES]);

const log = logger("shim.log");
const approver = new Approver({ log }); // per-app approval (approval.mjs)
const focus = new FocusGuard({ log });  // undoes focus theft by the target app (focus.mjs)

// Turns. SkyComputerUseService scopes user stops to a turn and refuses late
// calls from an ended turn. MCP has no turn boundary, so a turn ends when
// Claude goes quiet (OAI_CUA_TURN_IDLE_MS, default 60s), when a call is
// cancelled (the user interrupted Claude), or after stop_app.
const TURN_IDLE_MS = Number(process.env.OAI_CUA_TURN_IDLE_MS ?? 60000);
const turn = { thread: randomUUID(), n: 1, used: false, timer: null, active: 0 };
async function endTurn(why) {
  clearTimeout(turn.timer);
  if (!turn.used) return;
  const ended = { thread: turn.thread, turn: String(turn.n) };
  turn.n++;
  turn.used = false;
  log(`turn ${ended.turn} ends: ${why}`);
  try { await engine.endTurn(ended); } catch (e) { log(`turn end failed: ${e.message}`); }
}

// Stops made by stop_app last for the turn they happened in; the service
// clears them when that turn ends, but sometimes keeps them until the engine's
// connection closes. The user can only stop an app that has an active session,
// and stop_app leaves none, so if the first use of that app in a later turn
// still reports a stop, it is ours outliving its turn: the engine is replaced
// once and the call retried. Stops the user makes are always honoured.
const ownStops = new Map(); // app name or bundle id → turn of its stop_app
const appKey = (a) => String(a).trim().toLowerCase();
// "stopped" when the call failed on a stop before doing anything, "" otherwise.
function stopFailure(name, r) {
  if (r.isError) return diagnose(r.content[0]?.text)?.kind === "user-stopped" ? "stopped" : "";
  let fail;
  try { fail = JSON.parse(extractOutput(r.content, MARK)?.[0]?.text ?? "").fail; } catch {}
  if (diagnose(fail?.error)?.kind !== "user-stopped") return "";
  return name === "batch" && fail.step > 1 ? "partial" : "stopped"; // earlier batch steps ran: never re-run them
}

const engine = new Engine({
  log,
  idleMs: Number(process.env.OAI_CUA_IDLE_MS ?? 300000),
  callTimeoutMs: Number(process.env.OAI_CUA_CALL_TIMEOUT_MS ?? 60000),
  audio: process.env.OAI_CUA_AUDIO !== "0",
  approve: (params, signal) => approver.decide(params, signal),
  // session_id is what the service keys turns (and their stops) on.
  turnMeta: () => { turn.used = true; return { session_id: turn.thread, thread_id: turn.thread, turn_id: String(turn.n) }; },
});
const browser = new HeliumBrowser({ log });
const browserTools = () => BROWSER_TOOLS.map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly, openWorldHint: true } }));
const MARK = `⟦oai-cua:${randomUUID()}⟧`;
const START = `⟦oai-cua-start:${randomUUID()}⟧`; // anything before it is REPL bootstrap output

// MCP audio content exists from protocol 2025-03-26 on.
let clientProtocol = "2025-06-18";
const audioContentOk = () => clientProtocol >= "2025-03-26";

// Server → client requests (elicitation), answered by the human in Claude Code.
let clientCaps = {};
const toClient = new Map();
let toClientId = 0;
function askClient(method, params, signal) {
  return new Promise((resolve, reject) => {
    const id = `oai-cua-${++toClientId}`;
    toClient.set(id, { resolve, reject });
    signal?.addEventListener("abort", () => { // the call that needed the answer is gone
      if (!toClient.delete(id)) return;
      writeLine(process.stdout, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "computer-use call cancelled" } });
      reject(new Error("cancelled"));
    }, { once: true });
    if (!writeLine(process.stdout, { jsonrpc: "2.0", id, method, params })) { toClient.delete(id); reject(new Error("client unavailable")); }
  });
}
const elicitApproval = (r, signal) => askClient("elicitation/create", {
  message: promptText(r),
  requestedSchema: { type: "object", properties: r.canPersist
    ? { always: { type: "boolean", title: `Always allow ${r.name}`, description: "Remember this for future sessions", default: false } } : {} },
}, signal);
const service = createService({
  log,
  idleMs: Number(process.env.OAI_CUA_IDLE_MS ?? 300000),
  callTimeoutMs: Number(process.env.OAI_CUA_CALL_TIMEOUT_MS ?? 60000),
  canElicit: () => !!clientCaps?.elicitation,
  elicit: (p) => askClient("elicitation/create", { message: String(p.message ?? ""), requestedSchema: p.requestedSchema ?? { type: "object", properties: {} } }),
});

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const observations = new Observations(); // what Claude has seen of each app, for diffs

// Tool → how its cell captures state, and how the cell's JSON payload is rendered.
const ACTION_RESULT = new Set(BATCHABLE);
const stateText = (s) => (s.tree != null ? observations.render(s.app, s.tree) : `(State of ${s.app} unavailable: ${s.error})`);
const missingShot = (p) => p.states?.some((s) => s.tree != null && !s.shot) ? "\n(screenshot unavailable)" : "";
function plan(name, args) {
  if (name === "get_app_state") {
    const mode = !args.mode || args.mode === "auto" ? (observations.has(args.app) ? "diff" : "full") : args.mode;
    const capture = mode === "full" ? "tree+shot" : mode === "screenshot" ? "shot" : "tree";
    return { capture, render: (p) => {
      if (mode === "screenshot") {
        observations.forget(args.app); // indices may have moved unseen; the next tree must be full
        return `Screenshot of ${args.app}. No accessibility tree was read: get one (any other mode) before relying on element indices; it will be a full tree.`;
      }
      const t = observations.render(args.app, p.tree, { full: mode !== "diff" });
      return mode === "full" && !p.shot ? `${t}\n(No screenshot is available for this window.)` : t;
    } };
  }
  if (name === "batch") {
    const steps = batchSteps(args);
    return { steps, timeoutMs: args.timeout_ms, isError: (p) => !!p.fail, render: (p) => {
      const n = steps.length;
      const head = p.fail
        ? `Batch stopped at step ${p.fail.step} of ${n} (${p.fail.tool}): ${explain(p.fail.error)}\n${p.fail.step > 1 ? `Steps 1-${p.fail.step - 1} completed` : "No step completed"}; ${p.fail.step < n ? `steps ${p.fail.step + 1}-${n} were not run` : "it was the last step"}.`
        : `Batch completed: all ${n} steps ran.`;
      return [head, ...p.states.map(stateText)].join("\n\n") + (args.screenshot ? missingShot(p) : "");
    } };
  }
  if (ACTION_RESULT.has(name)) return { isError: (p) => !!p.fail, render: (p) => p.fail // e.g. the user took over: guidance plus fresh state
    ? `${explain(p.fail.error)}\n\nFresh state (old element indices may be stale): ${stateText(p.states[0])}`
    : `Done. ${p.note ? `${p.note} ` : ""}${stateText(p.states[0])}${args.screenshot ? missingShot(p) : ""}` };
  return { timeoutMs: args.timeout_ms };
}

export async function callTool(name, args = {}, signal) {
  if (isServiceTool(name)) return service.call(name, args, signal);
  if (isBrowserTool(name)) return browser.call(name, args);
  const bad = validate(name, args);
  if (bad) return text(bad, true);
  if (name === "get_app_state") focus.warm(); // helper ready before the first action
  if (name === "stop_app" && !engine.running) return text(args.app != null ? `No active session for ${args.app}.` : "No app sessions to stop.");
  clearTimeout(turn.timer);
  turn.active++;
  try {
    const r = await execute(name, args, signal);
    if (name === "stop_app") { // released without leaving the app blocked; new session, new indices
      observations.forget(args.app);
      const names = [args.app, ...[...String(r.content?.[0]?.text ?? "").matchAll(/^Stopped (.+?)(?: \((.+?)\))?\.$/gm)].flatMap((m) => [m[1], m[2]])];
      for (const a of names.filter(Boolean)) ownStops.set(appKey(a), turn.n);
      await endTurn("stop_app");
    }
    return r;
  } finally {
    if (--turn.active === 0 && TURN_IDLE_MS > 0) {
      turn.timer = setTimeout(() => turn.active === 0 && endTurn("idle"), TURN_IDLE_MS);
      turn.timer.unref?.();
    }
  }
}

async function execute(name, args, signal) {
  if (name === "reset_repl") {
    observations.forget();
    try {
      return text(await engine.reset(signal)
        ? "REPL reset: all JavaScript bindings were discarded. Apps, windows and documents were not changed."
        : "The REPL is not running, so there was nothing to reset; the next call starts a fresh one.");
    } catch (e) { return text(`reset failed: ${e.message}`, true); }
  }
  // Scripts can observe and act on anything, so later diffs restart from a full tree.
  if (name === "run_cua_js") observations.forget();
  const inlineAudio = name === "stop_audio_recording" && args.include_audio === true;
  const p = plan(name, args);
  const code = `nodeRepl.write(${JSON.stringify(START)});\n` + buildCell(name, inlineAudio && !audioContentOk() ? { ...args, include_audio: false } : args, MARK, p);
  const apps = targetApps(name, args);
  for (let attempt = 0, recycled = false; ; attempt++) {
    try {
      const run = () => engine.run(code, p.timeoutMs, signal, { allowAudio: name === "start_audio_recording" });
      const r = await (isUiAction(name) ? focus.around(apps, run) : run());
      firstUse.add([...engine.takeFirstUse(), ...bootstrapText(r.content, START)]);
      if (apps.length && name !== "stop_app" && name !== "run_cua_js") {
        const keys = apps.map(appKey), stop = stopFailure(name, r);
        if (!stop) keys.forEach((k) => ownStops.delete(k));
        else if (stop === "stopped" && !recycled && keys.some((k) => ownStops.get(k) < turn.n) && !engine.recording) {
          keys.forEach((k) => ownStops.delete(k)); // once per stop_app
          log(`${apps.join(", ")} still stopped by an earlier turn's stop_app; restarting the engine`);
          recycled = true;
          observations.forget();
          await engine.recycle("stale stop");
          continue;
        }
      }
      if (name === "run_cua_js") { // the script's own output and errors, as the REPL returned them
        if (!r.isError) return withDocs(extractOutput(r.content, MARK) ?? []);
        const out = extractOutput(r.content.slice(1), MARK) ?? [];
        return { content: limitOutput([r.content[0] ?? { type: "text", text: "script failed" }, ...out]), isError: true };
      }
      const out = extractOutput(r.content, MARK);
      if (name === "start_audio_recording" && !r.isError) engine.keepAliveUntil(Date.now() + Number(args.max_duration_ms ?? 60000) + 5000);
      if (name === "stop_audio_recording") engine.keepAliveUntil(0);
      if (inlineAudio && !audioContentOk() && out) out.push({ type: "text", text: `\n(audio content needs MCP protocol 2025-03-26 or later; this client negotiated ${clientProtocol})` });
      if (r.isError || !out) {
        const msg = String((r.isError ? r.content[0]?.text : "no output from engine") ?? "").slice(0, 1000).trim(); // REPL errors come first
        return text(explain(msg || "computer-use action failed"), true);
      }
      if (!p.render) return withDocs(out);
      const [first, ...rest] = out;
      const payload = JSON.parse(first?.text ?? "");
      return withDocs([{ type: "text", text: p.render(payload) }, ...rest], p.isError?.(payload));
    } catch (e) {
      // A crashed engine restarts on the next cell; only reads are retried.
      if (signal?.aborted) return text("cancelled", true);
      if (e instanceof EngineError && e.code === "ENGINE_EXIT" && attempt === 0 && isReadOnly(name)) continue;
      log(`call ${name} failed: ${e.message}`);
      if (!(e instanceof EngineError)) return text(`unexpected engine output: ${e.message}`, true);
      return text(`${explain(e.message)}\nDiagnostics: node ${new URL(import.meta.url).pathname} --doctor (log: ${STATE_DIR}/shim.log)`, true);
    }
  }
}

// A successful result, capped like Codex's tool output (about 25k tokens), with
// OpenAI's first-use docs ahead of it once per session.
function withDocs(out, isError = false) {
  const docs = firstUse.take();
  return { content: [...(docs ? [docs] : []), ...limitOutput(out.length ? out : [{ type: "text", text: "Done." }])], ...(isError ? { isError: true } : {}) };
}

function serve() {
  const out = process.stdout;
  const reply = (id, result) => writeLine(out, { jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => writeLine(out, { jsonrpc: "2.0", id, error: { code, message } });
  log(`shim ${VERSION} up (ppid ${process.ppid})`);

  const inflight = new Map(); // request id → AbortController
  process.stdin.on("data", makeLineReader(async (m) => {
    if (m.method === "notifications/cancelled") {
      const ac = inflight.get(m.params?.requestId);
      if (ac) { ac.abort(); endTurn("cancelled"); } // the user interrupted Claude
      return;
    }
    if (m.method == null && toClient.has(m.id)) { // a response to askClient
      const w = toClient.get(m.id);
      toClient.delete(m.id);
      return m.error ? w.reject(new Error(m.error.message || "client error")) : w.resolve(m.result);
    }
    if (m.id == null) return; // other notifications
    try {
      switch (m.method) {
        case "initialize": {
          const v = m.params?.protocolVersion;
          clientProtocol = PROTOCOLS.includes(v) ? v : "2025-06-18";
          clientCaps = m.params?.capabilities ?? {};
          const el = clientCaps.elicitation;
          approver.elicit = el && typeof el === "object" && (!Object.keys(el).length || el.form) ? elicitApproval : null;
          log(`client ${JSON.stringify(m.params?.clientInfo ?? {})} elicitation=${!!approver.elicit} approval fallback=${approver.policy}`);
          return reply(m.id, {
            protocolVersion: clientProtocol,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: "oai-cua", version: VERSION },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping": return reply(m.id, {});
        case "tools/list": return reply(m.id, { tools: [...publicTools(), ...serviceTools(), ...browserTools()] });
        case "resources/list": return reply(m.id, { resources: listResources(DOCS) });
        case "resources/templates/list": return reply(m.id, { resourceTemplates: [] });
        case "resources/read": {
          const uri = m.params?.uri;
          let text;
          try {
            if (uri === GUIDE_URI) text = guideText(DOCS, [...TOOL_NAMES]);
            else if (uri === FIRST_USE_URI) text = firstUse.text();
            else if (DOCS.has(uri)) text = readResource(DOCS.get(uri));
            else return fail(m.id, -32002, `resource not found: ${uri}`);
          } catch (e) { return fail(m.id, -32002, `resource unavailable: ${uri} (${e.message})`); }
          const mimeType = listResources(DOCS).find((r) => r.uri === uri)?.mimeType || "text/plain";
          return reply(m.id, { contents: [{ uri, mimeType, text }] });
        }
        case "prompts/list": return reply(m.id, { prompts: PROMPTS });
        case "prompts/get":
          try { return reply(m.id, getPrompt(m.params?.name, m.params?.arguments, { docs: DOCS, firstUse, toolNames: [...TOOL_NAMES] })); }
          catch (e) { return fail(m.id, -32602, e.message); }
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
    service.stop(why);
    focus.stop();
    await Promise.all([engine.stop(why), browser.close()]);
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
  const step = async (label, fn, optional = false) => {
    try { console.log(`✓ ${label}: ${await fn()}`); }
    catch (e) { ok &&= optional; console.log(`${optional ? "–" : "✗"} ${label}: ${e.message}`); }
  };
  await step("runtime", async () => { const r = findRuntime(); return `${r.command} via ${r.source}`; });
  await step("guidance", async () => `${DOCS.size} OpenAI docs found, instructions ${INSTRUCTIONS.length} chars`);
  await step("engine + list_apps", async () => {
    const t = Date.now();
    const r = await callTool("list_apps");
    if (r.isError) throw new Error(r.content[0].text);
    const running = r.content.map((c) => c.text ?? "").join("\n").split("\n").filter((l) => l.includes("[running]")).length;
    return `${running} running apps, ${Date.now() - t}ms`;
  });
  await step("native client (Record & Replay status, read-only)", async () => {
    const r = await callTool("record_status");
    if (r.isError) throw new Error(r.content[0].text);
    return r.content[0].text.replace(/\s+/g, " ");
  }, true); // optional: only Record & Replay needs it
  service.stop("doctor done");
  // Informational only: browser_* tools are optional, and connecting would
  // make Helium ask the user to allow remote debugging.
  const eps = discoverEndpoints();
  console.log(`· helium browser: ${eps.length ? eps.map((ep) => `${ep.source} port ${ep.port}: ${verifyEndpoint(ep) ?? "Helium listening"}`).join("; ") : "remote debugging off (enable at chrome://inspect/#remote-debugging in Helium)"}`);
  await engine.stop("doctor done");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv.includes("--doctor")) doctor();
else serve();
