// Focus guard. Input is delivered in the background, but some apps activate
// themselves when they receive it (Chromium browsers such as Helium do when a
// tab is created). Around each mutating action the shim records the frontmost
// app; if the target app took the front during the action, the previous app
// is re-activated. OAI_CUA_RESTORE_FOCUS=0 turns this off.
//
// The frontmost-app reads and re-activation go through a tiny resident Swift
// helper (src/focus-helper.swift, compiled once into the state dir). It also
// reports every app activation as it happens, so a steal is undone while the
// action is still running. A read takes ~1 ms and re-activation lands in
// ~20 ms. Without swiftc it falls back to osascript checks after the action.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR, makeLineReader } from "./lib.mjs";

const SOURCE = fileURLToPath(new URL("./focus-helper.swift", import.meta.url));
const SETTLE_MS = 300; // keep guarding briefly after the action for late self-activation
const MAX_RESTORES = 3;  // per action; never fight an app (or the user) indefinitely
const HELPER_TIMEOUT_MS = 2000; // a helper that stops answering is dropped for osascript

const JXA = `ObjC.import("AppKit");
function run(argv) {
  if (argv[0] === "activate") {
    const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[1]));
    return JSON.stringify({ ok: !!(a && a.activateWithOptions(2)) });
  }
  const a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify(a ? { pid: a.processIdentifier, bundle: ObjC.unwrap(a.bundleIdentifier) || "", name: ObjC.unwrap(a.localizedName) || "", path: ObjC.unwrap(a.bundleURL.path) || "" } : { pid: -1 });
}`;

// Does the frontmost app `f` match what the caller called the app?
export function isApp(f, app) {
  if (!f || f.pid < 0 || !app) return false;
  const a = String(app).toLowerCase().replace(/\/+$/, "");
  const names = [f.bundle, f.name, f.path, f.path && path.basename(f.path, ".app")].filter(Boolean).map((s) => s.toLowerCase().replace(/\/+$/, ""));
  return names.includes(a) || names.includes(a.replace(/\.app$/, ""));
}

const isAnyOf = (f, apps) => [].concat(apps).some((a) => isApp(f, a));

export class FocusGuard {
  // `ops` ({ front, activate }) replaces the helper, for tests.
  constructor({ log = () => {}, enabled = process.env.OAI_CUA_RESTORE_FOCUS !== "0", binDir = path.join(STATE_DIR, "bin"), ops = null } = {}) {
    Object.assign(this, { log, enabled, binDir, ops });
    this.proc = null;
    this.waiters = [];
    this.guard = null; // the action being guarded
    this.ready = null;
  }

  // Starts compiling/launching the helper ahead of the first action.
  warm() { if (this.enabled && !this.ops) this.ready ??= this.#start(); }

  async #start() {
    try {
      const src = fs.readFileSync(SOURCE);
      const bin = path.join(this.binDir, `focus-helper-${crypto.createHash("sha256").update(src).digest("hex").slice(0, 12)}`);
      if (!fs.existsSync(bin)) {
        // /usr/bin/swiftc is a stub that offers to install the Command Line Tools
        // (a dialog, every session) when no developer directory is set up.
        await new Promise((res, rej) => execFile("/usr/bin/xcode-select", ["-p"], (e, out) => (e || !fs.existsSync(out.trim()) ? rej(new Error("no Xcode or Command Line Tools")) : res())));
        fs.mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
        const tmp = `${bin}.${process.pid}.tmp`;
        await new Promise((res, rej) => execFile("/usr/bin/swiftc", ["-O", SOURCE, "-o", tmp], { timeout: 120000 }, (e) => (e ? rej(e) : res())));
        fs.renameSync(tmp, bin);
        for (const f of fs.readdirSync(this.binDir)) // helpers built from older sources
          if (f.startsWith("focus-helper-") && f !== path.basename(bin)) fs.rmSync(path.join(this.binDir, f), { force: true });
      }
      const p = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
      p.on("error", () => {}).on("exit", () => { if (this.proc === p) this.proc = null; for (const w of this.waiters.splice(0)) w(null); });
      p.stdin.on("error", () => {});
      p.stdout.on("data", makeLineReader((m) => (m.event === "activated" ? this.activated(m) : this.waiters.shift()?.(m))));
      p.unref();
      p.stdout.unref?.();
      this.proc = p;
      this.mode = "helper";
    } catch (e) {
      this.mode = "osascript";
      this.log(`focus helper unavailable (${String(e.message).split("\n")[0]}); using osascript`);
    }
  }

  async #cmd(...argv) {
    if (this.ready) await this.ready;
    const p = this.proc;
    if (p) return new Promise((r) => {
      const t = setTimeout(() => {
        this.log("focus helper stopped answering; using osascript");
        this.proc = null;
        this.mode = "osascript";
        try { p.kill(); } catch {}
        for (const w of this.waiters.splice(0)) w(null);
      }, HELPER_TIMEOUT_MS);
      t.unref?.();
      this.waiters.push((m) => { clearTimeout(t); r(m); });
      p.stdin.write(argv.join(" ") + "\n");
    });
    return new Promise((r) => execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA, ...argv.map(String)], { timeout: 5000 }, (e, out) => {
      try { r(e ? null : JSON.parse(out)); } catch { r(null); }
    }));
  }

  front() { return this.ops ? this.ops.front() : this.#cmd("front"); }
  activate(pid) { return this.ops ? this.ops.activate(pid) : this.#cmd("activate", pid); }

  // Runs fn (a mutating action on `app`, one app or several) and undoes focus theft by it:
  // live, from activation events, and by a look after the action and again
  // SETTLE_MS later (the only mechanism in osascript mode).
  async around(app, fn) {
    if (!this.enabled) return fn();
    this.warm();
    const before = await this.front().catch(() => null);
    if (!before || before.pid < 0 || isAnyOf(before, app)) return fn();
    const guard = { before, app, restores: 0, busy: false };
    this.guard = guard;
    try { return await fn(); }
    finally {
      await this.#restoreIfStolen(guard, await this.front().catch(() => null));
      const t = setTimeout(async () => {
        if (this.guard !== guard) return; // another action took over
        await this.#restoreIfStolen(guard, await this.front().catch(() => null));
        if (this.guard === guard) this.guard = null;
      }, SETTLE_MS);
      t.unref?.();
    }
  }

  // Activation event from the helper.
  activated(f) { if (this.guard) this.#restoreIfStolen(this.guard, f); }

  async #restoreIfStolen(guard, now) {
    const { before, app } = guard;
    if (!now || now.pid === before.pid || !isAnyOf(now, app) || guard.busy || guard.restores >= MAX_RESTORES) return false;
    guard.restores++;
    guard.busy = true;
    const t = Date.now();
    const r = await this.activate(before.pid).catch(() => null);
    guard.busy = false;
    this.log(`focus: ${now.bundle || now.name} took the front; re-activated ${before.bundle || before.name} (${r?.ok ? "ok" : "failed"}, ${Date.now() - t}ms)`);
    return !!r?.ok;
  }

  stop() { try { this.proc?.kill(); } catch {} }
}
