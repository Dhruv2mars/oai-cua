// Client for the MCP servers built into OpenAI's installed SkyComputerUseClient
// (`event-stream mcp` = Record & Replay, `computer-history mcp`).
//
// The service only answers a client whose parent is an OpenAI-signed process
// and whose *responsible* process may send it Apple Events. We therefore spawn
//   python3 spawn-disclaimed.py → ChatGPT's signed cua_node → SkyComputerUseClient
// where the python step uses posix_spawn with responsibility disclaimed, so the
// signed node (not the terminal / IDE that launched Claude Code) is responsible.
// Nothing is vendored: both binaries are loaded from the user's installation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CHATGPT_APP, CODEX_HOME, makeLineReader, writeLine } from "./lib.mjs";

const DISCLAIM = new URL("./spawn-disclaimed.py", import.meta.url).pathname;
const PYTHONS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/Library/Developer/CommandLineTools/usr/bin/python3", "/Applications/Xcode.app/Contents/Developer/usr/bin/python3"];

export class NativeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Returns { command, args } for `SkyComputerUseClient <sub...>`, or throws NativeError.
export function findNativeLaunch(sub) {
  const client = process.env.OPENAI_CUA_NATIVE_CLIENT ||
    path.join(CODEX_HOME, "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");
  const parent = process.env.OPENAI_CUA_NATIVE_PARENT || path.join(CHATGPT_APP, "Contents/Resources/cua_node/bin/node");
  const python = process.env.OPENAI_CUA_PYTHON || PYTHONS.find((p) => fs.existsSync(p));
  const missing = [[client, "SkyComputerUseClient (enable Computer Use in ChatGPT once)"], [parent, "ChatGPT.app's cua_node"]].find(([p]) => !fs.existsSync(p));
  if (missing) throw new NativeError(`${missing[1]} not found at ${missing[0]}`, "NATIVE_MISSING");
  if (!python) throw new NativeError(`python3 not found (looked in ${PYTHONS.join(", ")}); install Xcode Command Line Tools or set OPENAI_CUA_PYTHON`, "NATIVE_MISSING");
  // The signed node's only job is to be the client's parent; argv is embedded as JSON literals.
  const inner = `const c = require("child_process").spawn(${JSON.stringify(client)}, ${JSON.stringify(sub)}, { stdio: "inherit" });
process.on("SIGTERM", () => c.kill("SIGTERM")); c.on("exit", (x, s) => process.exit(x ?? 1)); c.on("error", () => process.exit(127));`;
  return { command: python, args: ["-I", DISCLAIM, parent, "-e", inner] };
}

// One lazily started native MCP server. Calls are serialised; the process is
// released after `idleMs` unless `hold` is set (e.g. while recording).
export class NativeServer {
  #p = null; #ready = null; #pending = new Map(); #id = 0; #idle = null; #queue = Promise.resolve();
  hold = false;

  // canElicit(): whether consent prompts can be forwarded to a human. When it
  // is false we do not advertise elicitation, so the service never gets an
  // automatic answer from us.
  constructor({ sub, log = () => {}, idleMs = 300000, callTimeoutMs = 60000, canElicit = () => false, onElicit = async () => ({ action: "decline" }) }) {
    Object.assign(this, { sub, log, idleMs, callTimeoutMs, canElicit, onElicit });
  }

  get running() { return !!this.#p; }

  call(name, args = {}, signal, timeoutMs = this.callTimeoutMs) {
    const run = this.#queue.then(() => this.#call(name, args, signal, timeoutMs));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #call(name, args, signal, timeoutMs) {
    if (signal?.aborted) throw new NativeError("cancelled", "CANCELLED");
    clearTimeout(this.#idle);
    try {
      await this.#start();
      const r = await this.#request("tools/call", { name, arguments: args }, timeoutMs, signal);
      if (r.error) throw new NativeError(r.error.message || "native call failed", "NATIVE_RPC");
      return r.result;
    } catch (e) {
      if (e.code === "TIMEOUT" || e.code === "CANCELLED") this.stop(e.code);
      throw e;
    } finally {
      if (this.idleMs > 0) this.#idle = setTimeout(() => !this.hold && this.stop("idle"), this.idleMs).unref();
    }
  }

  #start() {
    if (this.#ready) return this.#ready;
    const { command, args } = findNativeLaunch(this.sub);
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, cwd: "/" });
    this.#p = p;
    this.log(`native ${this.sub.join(" ")}: spawned pid ${p.pid}`);
    let stderr = "";
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.stdout.on("data", makeLineReader((m) => this.#onMessage(m)));
    p.stdin.on("error", () => {});
    const exited = new Promise((_, rej) => p.on("exit", (code, sig) => {
      this.log(`native ${this.sub.join(" ")}: exit ${code ?? sig}${stderr ? `: ${stderr.trim()}` : ""}`);
      if (this.#p === p) { this.#p = null; this.#ready = null; }
      const err = new NativeError(`native ${this.sub[0]} server exited (${code ?? sig})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`, "NATIVE_EXIT");
      for (const w of this.#pending.values()) w.reject(err);
      this.#pending.clear();
      rej(err);
    }));
    exited.catch(() => {});
    p.on("error", (e) => this.log(`native spawn error: ${e.message}`));
    this.#ready = Promise.race([exited, (async () => {
      const r = await this.#request("initialize", { protocolVersion: "2025-06-18", capabilities: this.canElicit() ? { elicitation: {} } : {}, clientInfo: { name: "openai-cua-bridge", version: "0" } }, 20000);
      if (r.error) throw new NativeError(`native initialize failed: ${r.error.message}`, "NATIVE_INIT");
      writeLine(p.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    })()]).catch((e) => { this.stop("init failed"); throw e; });
    return this.#ready;
  }

  #request(method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const done = (fn) => (v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); this.#pending.delete(id); fn(v); };
      const onAbort = () => done(reject)(new NativeError("cancelled", "CANCELLED"));
      const t = setTimeout(() => done(reject)(new NativeError(`native ${method} timed out after ${timeoutMs}ms`, "TIMEOUT")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (!writeLine(this.#p?.stdin, { jsonrpc: "2.0", id, method, params })) done(reject)(new NativeError("native server is not running", "NATIVE_EXIT"));
    });
  }

  async #onMessage(m) {
    if (m.method == null) return this.#pending.get(m.id)?.resolve(m);
    if (m.id == null) return; // notifications
    let result = {};
    if (m.method === "elicitation/create") {
      // Consent prompts (recording, app access) are the user's call, never ours.
      try { result = await this.onElicit(m.params ?? {}); } catch { result = { action: "decline" }; }
      this.log(`native elicitation "${String(m.params?.message ?? "").slice(0, 80)}" → ${result.action}`);
    }
    writeLine(this.#p?.stdin, { jsonrpc: "2.0", id: m.id, result });
  }

  stop(why = "stop") {
    clearTimeout(this.#idle);
    const p = this.#p;
    this.#p = null; this.#ready = null;
    if (!p) return;
    this.log(`native ${this.sub.join(" ")}: stopping (${why})`);
    try { p.stdin.end(); } catch {}
    try { process.kill(-p.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 1500).unref();
  }
}
