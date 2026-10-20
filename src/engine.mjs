// Engine: owns one OpenAI cua-repl child (an MCP server shipped in ChatGPT.app
// that drives SkyComputerUseService) and runs JavaScript cells in it. Started
// lazily, released when idle, restarted after a crash. All state for a child
// lives on its own instance object, so callbacks from a retired child can never
// touch its replacement.
import { spawn } from "node:child_process";
import os from "node:os";
import { findRuntime, makeLineReader, writeLine } from "./lib.mjs";
import { BLOCKED_APP } from "./tools.mjs";

const PROTOCOL = "2025-06-18";

export class EngineError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export class Engine {
  constructor({ log = () => {}, idleMs = 300000, startTimeoutMs = 45000, callTimeoutMs = 60000, runtime = findRuntime, audio = true } = {}) {
    Object.assign(this, { log, idleMs, startTimeoutMs, callTimeoutMs, runtime, audio });
    this.keepUntil = 0;         // no idle release before this time (an audio recording is running)
    this.cur = null;            // live instance
    this.queue = Promise.resolve(); // cells run one at a time per engine
    this.busy = 0;              // queued + running cells
    this.idleTimer = null;
    this.starts = 0;
  }

  // Run a JavaScript cell. Resolves { content, isError }; rejects EngineError.
  // A cancelled cell is skipped if still queued; if running, its engine is
  // stopped so the action cannot complete later. allowAudio lets this cell's
  // audio-recording approval through; every other cell's is declined.
  run(code, timeoutMs = this.callTimeoutMs, signal, { allowAudio = false } = {}) {
    this.busy++;
    clearTimeout(this.idleTimer);
    const job = this.queue.then(() => {
      if (signal?.aborted) throw new EngineError("cancelled", "CANCELLED");
      return this.#exec(code, timeoutMs, signal, allowAudio);
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

  async #exec(code, timeoutMs, signal, allowAudio) {
    const inst = await this.#ensure();
    if (signal?.aborted) throw new EngineError("cancelled", "CANCELLED");
    const onAbort = () => this.#retire(inst, "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    inst.allowAudio = allowAudio;
    const r = await this.#request(inst, "tools/call", { name: "js", arguments: { code, timeout_ms: timeoutMs } }, timeoutMs + Math.min(10000, timeoutMs), true)
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
    const inst = { id: ++this.starts, dead: false, pending: new Map(), nextId: 1, proc: null, approved: new Set() };
    this.log(`engine#${inst.id} start ${rt.command} (${rt.source})`);
    const proc = spawn(rt.command, rt.args, {
      cwd: os.homedir(),
      // Desktop apps only: no browser surface, no Chrome backend. The audio
      // flags only register cua.computer.start/stop_audio_recording and
      // nodeRepl.emitAudio; starting a recording still needs approval below.
      env: { ...process.env, ...rt.env, CUA_REPL_ENABLED_SURFACES: "computer", BROWSER_USE_AVAILABLE_BACKENDS: "",
        SKY_ENABLE_AUDIO: this.audio ? "1" : "0", NODE_REPL_ENABLE_AUDIO: this.audio ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so node_repl descendants are killed with it
    });
    inst.proc = proc;
    inst.exited = new Promise((r) => proc.on("exit", r).on("error", r));
    const die = (why) => {
      if (inst.dead) return;
      inst.dead = true;
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
      clientInfo: { name: "openai-cua-bridge", version: "0.2.0" },
    }, t);
    if (init.error || typeof init.result?.protocolVersion !== "string" || !init.result.capabilities?.tools)
      throw new EngineError(`engine rejected initialize: ${JSON.stringify(init.error || init.result).slice(0, 300)}`, "ENGINE_START");
    writeLine(inst.proc.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    // First cell loads the cua runtime and reaches SkyComputerUseService.
    // getState reports service failures in `errors` rather than throwing.
    const code = "const s = await cua.getState({ emit: false }); if (s?.errors?.length) throw new Error(s.errors.join('; '));";
    const r = await this.#request(inst, "tools/call", { name: "js", arguments: { code, timeout_ms: t } }, t + 5000);
    if (r.error || r.result?.isError) {
      const text = r.error?.message || String(r.result.content?.[0]?.text ?? "").slice(0, 500); // the REPL puts the error first
      throw new EngineError(`OpenAI computer-use engine is not authorized/ready: ${text}`, "ENGINE_START");
    }
    this.log(`engine#${inst.id} ready`);
    return inst;
  }

  #request(inst, method, params, timeoutMs, killOnTimeout = false) {
    return new Promise((resolve, reject) => {
      if (inst.dead) return reject(new EngineError("OpenAI computer-use engine exited", "ENGINE_EXIT"));
      const id = inst.nextId++;
      const timer = setTimeout(() => {
        inst.pending.delete(id);
        reject(new EngineError(`OpenAI computer-use ${method} timed out after ${timeoutMs}ms`, "ENGINE_TIMEOUT"));
        if (killOnTimeout || method === "initialize") this.#retire(inst, "timeout");
      }, timeoutMs);
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
      // Server→client requests. App-access approval is granted automatically;
      // OpenAI's service still enforces its own denied/forbidden app policy.
      let reply;
      if (m.method === "elicitation/create") {
        const what = m.params?.message || "elicitation";
        const target = `${what} ${JSON.stringify(m.params?._meta?.tool_params ?? {})}`;
        const audio = m.params?._meta?.tool_name === "start_audio_recording" || /record computer audio/i.test(what);
        if (BLOCKED_APP.test(target) || (audio && !inst.allowAudio)) { // canonical bundle id from the service
          this.log(`engine#${inst.id} declined: ${what}`);
          reply = { result: { action: "decline" } };
        } else {
          if (!inst.approved.has(what)) { inst.approved.add(what); this.log(`engine#${inst.id} approved: ${what}`); }
          reply = { result: { action: "accept", content: {} } };
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

  // Stops the current engine; resolves once its whole process group is gone.
  stop(why = "stop") {
    clearTimeout(this.idleTimer);
    this.keepUntil = 0;
    return this.cur ? this.#retire(this.cur, why) : Promise.resolve();
  }

  get running() { return !!this.cur && !this.cur.dead; }
  get pid() { return this.cur?.proc?.pid; }
}
