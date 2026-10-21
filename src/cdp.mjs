// Helium's DevTools endpoints and a minimal CDP client. Only Helium is
// accepted: every endpoint is traced to the process listening on it, and
// anything that is not Helium (above all Google Chrome) is refused before
// connecting. Uses Node's built-in WebSocket (Node 22+).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HELIUM_BUNDLE_ID = "net.imput.helium";
export const HELIUM_DATA_DIR = path.join(os.homedir(), "Library/Application Support/net.imput.helium");
const CHROME = /com\.google\.chrome|google chrome/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Where Helium may be listening. The default is the user's own Helium profile,
// which only listens after they enable "Allow remote debugging for this
// browser instance" at chrome://inspect/#remote-debugging (no relaunch).
export function discoverEndpoints(env = process.env) {
  const out = [];
  const spec = env.OAI_CUA_HELIUM_CDP?.trim();
  if (spec) {
    const m = /^(?:(ws|http)s?:\/\/)?(\[[^\]]+\]|[^:/]+)?:?(\d+)(\/.*)?$/.exec(spec.includes(":") || !/^\d+$/.test(spec) ? spec : `:${spec}`);
    if (!m) throw new Error(`OAI_CUA_HELIUM_CDP is not a port or ws/http URL: ${spec}`);
    out.push({ host: m[2] || "127.0.0.1", port: Number(m[3]), path: m[1] === "ws" ? m[4] : undefined, source: "OAI_CUA_HELIUM_CDP" });
  }
  const dirs = env.OAI_CUA_HELIUM_USER_DATA_DIR != null ? env.OAI_CUA_HELIUM_USER_DATA_DIR.split(":").filter(Boolean) : [HELIUM_DATA_DIR];
  for (const dir of dirs) {
    try {
      const [port, p] = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n");
      if (/^\d+$/.test(port)) out.push({ host: "127.0.0.1", port: Number(port), path: p?.startsWith("/devtools/") ? p : undefined, source: dir });
    } catch {}
  }
  return out;
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();

// The process listening on a local TCP port, with its app bundle id.
export function portOwner(port) {
  let pids;
  try { pids = run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]).split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1))); }
  catch { return null; }
  const owners = [...new Set(pids)].map((pid) => {
    let exe = "", bundleId = "";
    try { exe = run("/bin/ps", ["-o", "comm=", "-p", String(pid)]); } catch {}
    const app = /^(.*?\.app)\/Contents\/MacOS\//.exec(exe)?.[1];
    if (app) try { bundleId = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(app, "Contents/Info.plist")]); } catch {}
    return { pid, exe, bundleId };
  });
  return owners.length ? owners : null;
}

// Returns an error string unless every listener is Helium. Chrome is refused
// by bundle id and by executable path, whatever else is configured.
export function checkOwners(owners) {
  if (!owners?.length) return "nothing listening on that port";
  for (const o of owners) {
    if (CHROME.test(o.exe) || CHROME.test(o.bundleId)) return `refusing ${o.exe || o.bundleId}: Google Chrome is blocked by the user`;
    if (o.bundleId !== HELIUM_BUNDLE_ID) return `refusing ${o.exe || `pid ${o.pid}`} (${o.bundleId || "no bundle id"}): only Helium is allowed`;
  }
  return null;
}

export function verifyEndpoint(ep) {
  if (!LOOPBACK.has(ep.host)) return `refusing ${ep.host}:${ep.port}: only a local Helium is allowed`;
  return checkOwners(portOwner(ep.port));
}

// The frontmost app's bundle id, and a way to give the front back to it.
// Browser actions must not raise Helium; when a page does (e.g. a click that
// opens a tab), the app the user was in is re-activated.
export function frontApp() {
  try { return /"CFBundleIdentifier"="([^"]+)"/.exec(run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", run("/usr/bin/lsappinfo", ["front"])]))?.[1] ?? null; }
  catch { return null; }
}

export function activateApp(bundleId) {
  try { run("/usr/bin/osascript", ["-e", "on run argv", "-e", "tell application id (item 1 of argv) to activate", "-e", "end run", bundleId]); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------- CDP

export class CdpError extends Error {}

export class Cdp {
  static open(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new CdpError("timeout")); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(new Cdp(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new CdpError("refused")); };
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8")); } catch { return; }
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new CdpError(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result ?? {});
      } else for (const fn of this.listeners) try { fn(m); } catch {}
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CdpError("Helium closed the DevTools connection")); }
      this.pending.clear();
      for (const fn of this.listeners) try { fn({ method: "__closed" }); } catch {}
    };
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CdpError("Helium closed the DevTools connection"));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}
