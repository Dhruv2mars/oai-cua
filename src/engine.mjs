// Engine: owns one OpenAI cua-repl child (an MCP server shipped in ChatGPT.app
// that drives SkyComputerUseService) and runs JavaScript cells in it. Started
// lazily, released when idle, restarted after a crash. All state for a child
// lives on its own instance object, so callbacks from a retired child can never
// touch its replacement.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRuntime, makeLineReader, writeLine } from "./lib.mjs";
import { BLOCKED_APP } from "./tools.mjs";

const PROTOCOL = "2025-06-18";

// Our trusted node_repl service (stop app, end turn); see bridge-service.mjs.
const SERVICE = fileURLToPath(new URL("./bridge-service.mjs", import.meta.url));
export function serviceEnv(env) {
  let services = {};
  try { services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES || "{}"); } catch {}
  return {
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ ...services, cuabridge: SERVICE }),
    NODE_REPL_TRUSTED_CODE_PATHS: [env.NODE_REPL_TRUSTED_CODE_PATHS, path.dirname(SERVICE)].filter(Boolean).join(":"),
  };
}

// Without an approver: accept, except Chrome (by the bundle id the service resolved).
const defaultApprove = (params) => BLOCKED_APP.test(`${params?.message} ${JSON.stringify(params?._meta?.tool_params ?? {})}`)
  ? { action: "decline" } : { action: "accept", content: {} };

export class EngineError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export class Engine {
  // approve(params, signal) answers the engine's approval elicitations;
  // turnMeta() is attached to every js cell as x-codex-turn-metadata.
  constructor({ log = () => {}, idleMs = 300000, startTimeoutMs = 45000, callTimeoutMs = 60000, runtime = findRuntime, audio = true, approve = defaultApprove, turnMeta = () => null } = {}) {
    Object.assign(this, { log, idleMs, startTimeoutMs, callTimeoutMs, runtime, audio, approve, turnMeta });
    this.keepUntil = 0;         // no idle release before this time (an audio recording is running)
    this.cur = null;            // live instance
    this.queue = Promise.resolve(); // cells run one at a time per engine
    this.busy = 0;              // queued + running cells
    this.idleTimer = null;
    this.starts = 0;
    this.firstUse = [];         // first-use docs printed by fresh engines, until taken
  }

  // Run a JavaScript cell. Resolves { content, isError }; rejects EngineError.
  // A cancelled cell is skipped if still queued; if running, its engine is
  // stopped so the action cannot complete later. allowAudio lets this cell's
  // audio-recording approval through; every other cell's is declined. meta
  // overrides the turn metadata (used to send a turn's own end).
  run(code, timeoutMs = this.callTimeoutMs, signal, { allowAudio = false, meta } = {}) {
    return this.#enqueue("js", { code, timeout_ms: timeoutMs }, timeoutMs, signal, allowAudio, meta);
  }

  // Discard the REPL's JavaScript bindings (cua-repl's js_reset). Resolves
  // false when no engine is running, i.e. the next cell starts fresh anyway.
  reset(signal) {
    if (!this.running) return Promise.resolve(false);
    return this.#enqueue("js_reset", {}, this.callTimeoutMs, signal, false).then(() => true);
  }

  #enqueue(tool, args, timeoutMs, signal, allowAudio, meta) {
    this.busy++;
    clearTimeout(this.idleTimer);
    const job = this.queue.then(() => {
      if (signal?.aborted) throw new EngineError("cancelled", "CANCELLED");
      return this.#exec(tool, args, timeoutMs, signal, allowAudio, meta);
    });
    this.queue = job.catch(() => {});
    return job.finally(() => { this.busy--; this.#armIdle(); });
  }

  #armIdle() {
    if (this.busy > 0 || !this.cur || this.idleMs <= 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy) return;
      if (Date.now() < this.keepUntil) return this.#armIdle();
      this.stop("idle");
    }, Math.max(this.idleMs, this.keepUntil - Date.now()));
    this.idleTimer.unref?.();
  }

  // Keep the current engine (and so its audio recording) from idle release until `until`.
  keepAliveUntil(until) {
    this.keepUntil = until;
    this.#armIdle();
  }

  async #exec(tool, args, timeoutMs, signal, allowAudio, meta) {
    const inst = await this.#ensure();
    if (signal?.aborted) throw new EngineError("cancelled", "CANCELLED");
    const onAbort = () => this.#retire(inst, "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    inst.allowAudio = allowAudio;
    const turn = tool === "js" ? meta ?? this.turnMeta() : null;
    const r = await this.#request(inst, "tools/call", { name: tool, arguments: args, ...(turn ? { _meta: { "x-codex-turn-metadata": turn } } : {}) }, timeoutMs + Math.min(10000, timeoutMs), true)
      .finally(() => { inst.allowAudio = false; signal?.removeEventListener("abort", onAbort); });
    if (r.error) throw new EngineError(`engine error: ${r.error.message || JSON.stringify(r.error)}`, "ENGINE_RPC");
    return { content: r.result?.content || [], isError: !!r.result?.isError };
  }

  #ensure() {
    if (this.cur && !this.cur.dead) return this.cur.ready;
    let inst;
    try { inst = this.#spawn(); } catch (e) { return Promise.reject(new EngineError(e.message, "ENGINE_MISSING")); }
    this.cur = inst;
    inst.ready = this.#handshake(inst).catch((e) => {
      this.#retire(inst, "start failed");
      throw e instanceof EngineError ? e : new EngineError(e.message, "ENGINE_START");
    });
    return inst.ready;
  }

  #spawn() {
    const rt = this.runtime();
    const inst = { id: ++this.starts, dead: false, pending: new Map(), nextId: 1, proc: null, asking: 0, askedAt: 0, abort: new AbortController() };
    this.log(`engine#${inst.id} start ${rt.command} (${rt.source})`);
    const proc = spawn(rt.command, rt.args, {
      cwd: os.homedir(),
      // Desktop apps only: no browser surface, no Chrome backend. The audio
      // flags only register cua.computer.start/stop_audio_recording and
      // nodeRepl.emitAudio; starting a recording still needs approval below.
      env: { ...process.env, ...rt.env, ...serviceEnv(rt.env), CUA_REPL_ENABLED_SURFACES: "computer", BROWSER_USE_AVAILABLE_BACKENDS: "",
        SKY_ENABLE_AUDIO: this.audio ? "1" : "0", NODE_REPL_ENABLE_AUDIO: this.audio ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so node_repl descendants are killed with it
    });
    inst.proc = proc;
    inst.exited = new Promise((r) => proc.on("exit", r).on("error", r));
    const die = (why) => {
      if (inst.dead) return;
      inst.dead = true;
      inst.abort.abort();
      this.log(`engine#${inst.id} exited: ${why}`);
      for (const p of inst.pending.values()) p.reject(new EngineError(`OpenAI computer-use engine exited (${why})`, "ENGINE_EXIT"));
      inst.pending.clear();
      if (this.cur === inst) this.cur = null;
    };
    proc.on("error", (e) => die(e.code || e.message));
    proc.on("exit", (code, sig) => die(sig || `code ${code}`));
    proc.stdin.on("error", () => {});
    proc.stdout.on("error", () => {});
    proc.stderr.on("error", () => {});
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => this.log(`engine#${inst.id} stderr: ${d.trim().slice(0, 500)}`));
    proc.stdout.on("data", makeLineReader((m) => this.#onMessage(inst, m), (l) => this.log(`engine#${inst.id} bad line: ${l.slice(0, 200)}`)));
    return inst;
  }

  async #handshake(inst) {
    const t = this.startTimeoutMs;
    const init = await this.#request(inst, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: { elicitation: {} },
      clientInfo: { name: "oai-cua", version: "0.2.0" },
    }, t);
    if (init.error || typeof init.result?.protocolVersion !== "string" || !init.result.capabilities?.tools)
      throw new EngineError(`engine rejected initialize: ${JSON.stringify(init.error || init.result).slice(0, 300)}`, "ENGINE_START");
    writeLine(inst.proc.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    // First cell loads the cua runtime and reaches SkyComputerUseService.
    // getState reports service failures in `errors` rather than throwing.
    const code = "{ const s = await cua.getState({ emit: false }); if (s?.errors?.length) throw new Error(s.errors.join('; ')); }"; // no top-level bindings
    const r = await this.#request(inst, "tools/call", { name: "js", arguments: { code, timeout_ms: t } }, t + 5000);
    if (r.error || r.result?.isError) {
      const text = r.error?.message || String(r.result.content?.[0]?.text ?? "").slice(0, 500); // the REPL puts the error first
      throw new EngineError(`OpenAI computer-use engine is not authorized/ready: ${text}`, "ENGINE_START");
    }
    // A fresh REPL prints OpenAI's first-use documentation before any output.
    const docs = (r.result.content || []).filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text);
    if (docs.length) this.firstUse.push(...docs);
    this.log(`engine#${inst.id} ready${docs.length ? ` (first-use docs: ${docs.join("").length} chars)` : ""}`);
    return inst;
  }

  #request(inst, method, params, timeoutMs, killOnTimeout = false) {
    return new Promise((resolve, reject) => {
      if (inst.dead) return reject(new EngineError("OpenAI computer-use engine exited", "ENGINE_EXIT"));
      const id = inst.nextId++;
      // The clock stops while the user is answering an approval prompt (the
      // engine suspends its own cell timeout then, too).
      const fire = () => {
        const since = Date.now() - inst.askedAt;
        if (inst.asking > 0) return (timer = setTimeout(fire, timeoutMs));
        if (since < timeoutMs) return (timer = setTimeout(fire, timeoutMs - since));
        inst.pending.delete(id);
        reject(new EngineError(`OpenAI computer-use ${method} timed out after ${timeoutMs}ms`, "ENGINE_TIMEOUT"));
        if (killOnTimeout || method === "initialize") this.#retire(inst, "timeout");
      };
      let timer = setTimeout(fire, timeoutMs);
      inst.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (!writeLine(inst.proc.stdin, { jsonrpc: "2.0", id, method, params })) {
        inst.pending.get(id)?.reject(new EngineError("engine stdin closed", "ENGINE_EXIT"));
        inst.pending.delete(id);
      }
    });
  }

  #onMessage(inst, m) {
    if (m.method) {
      if (m.id == null) return; // notifications
      // Server→client requests. Approval requests go to the approver (which
      // may ask the user); OpenAI's service still enforces its own
      // denied/forbidden app policy.
      let reply;
      if (m.method === "elicitation/create") {
        const what = m.params?.message || "elicitation";
        const audio = m.params?._meta?.tool_name === "start_audio_recording" || /record computer audio/i.test(what);
        if (audio && !inst.allowAudio) { // only start_audio_recording's own cell may record
          this.log(`engine#${inst.id} declined: ${what}`);
          reply = { result: { action: "decline" } };
        } else {
          inst.asking++;
          Promise.resolve()
            .then(() => this.approve(m.params ?? {}, inst.abort.signal))
            .catch((e) => { this.log(`engine#${inst.id} approval failed: ${e.message}`); return { action: "decline" }; })
            .then((result) => {
              inst.asking--;
              inst.askedAt = Date.now();
              writeLine(inst.proc.stdin, { jsonrpc: "2.0", id: m.id, result });
            });
          return;
        }
      } else if (m.method === "ping") reply = { result: {} };
      else if (m.method === "roots/list") reply = { result: { roots: [] } };
      else reply = { error: { code: -32601, message: `unsupported: ${m.method}` } };
      writeLine(inst.proc.stdin, { jsonrpc: "2.0", id: m.id, ...reply });
      return;
    }
    const p = inst.pending.get(m.id);
    if (p) { inst.pending.delete(m.id); p.resolve(m); }
  }

  #retire(inst, why) {
    if (this.cur === inst) this.cur = null;
    if (inst.retired) return inst.gone;
    inst.retired = true;
    this.log(`engine#${inst.id} stopping: ${why}`);
    const group = (sig) => { try { process.kill(-inst.proc.pid, sig); } catch {} };
    try { inst.proc.stdin.end(); } catch {}
    group("SIGTERM");
    // Bounded: give the group 1.5s, then SIGKILL whatever is left of it.
    inst.gone = Promise.race([inst.exited, new Promise((r) => setTimeout(r, 1500))]).then(() => group("SIGKILL"));
    return inst.gone;
  }

  // Tells the live engine that a turn ended (no-op when none runs), as that
  // turn: SkyComputerUseService then clears per-turn stops and refuses late
  // calls carrying it; trusted libraries also get cua-repl's turn_ended.
  async endTurn({ thread, turn }) {
    const inst = this.cur;
    if (!inst || inst.dead || inst.retired) return false;
    const code = `await nodeRepl.rpc("cuabridge", ${JSON.stringify({ type: "turnEnded", threadID: thread, turnID: turn })});`;
    const results = await Promise.allSettled([
      this.run(code, 10000, undefined, { meta: { session_id: thread, thread_id: thread, turn_id: turn } }).then((r) => ({ result: r })),
      inst.ready.then(() => this.#request(inst, "tools/call", { name: "turn_ended", arguments: { hook_event_name: "Stop", session_id: thread, turn_id: turn } }, 10000)),
    ]);
    const bad = results.map((r) => r.status === "rejected" ? r.reason.message : r.value.error?.message || (r.value.result?.isError && r.value.result.content?.[0]?.text)).filter(Boolean);
    this.log(`engine#${inst.id} turn ${turn} ended${bad.length ? ` (${bad.join("; ").slice(0, 300)})` : ""}`);
    return !bad.length;
  }

  // Stops the current engine; resolves once its whole process group is gone.
  stop(why = "stop") {
    clearTimeout(this.idleTimer);
    this.keepUntil = 0;
    return this.cur ? this.#retire(this.cur, why) : Promise.resolve();
  }

  // First-use documentation captured at engine start since the last call.
  takeFirstUse() { return this.firstUse.splice(0); }

  get running() { return !!this.cur && !this.cur.dead; }
  get pid() { return this.cur?.proc?.pid; }
}
