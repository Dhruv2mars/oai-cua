#!/usr/bin/env node
// Installer. Preflights everything (including a live engine call) before
// changing any configuration, then:
//   1. registers the shim with Claude Code (user scope of $CLAUDE_CONFIG_DIR);
//   2. denies Claude's built-in "computer-use" server so GUI work routes here;
//   3. removes the legacy v0.1 Codex worker registration and its processes;
//   4. links the repo's Claude Code skill into $CLAUDE_CONFIG_DIR/skills.
// Flags: --keep-native (skip step 2), --skip-live (skip the live preflight),
// --skip-skill (skip step 4), --enable-js / --disable-js (opt in/out of
// run_cua_js + reset_repl; without either, the current registration's choice is kept).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, findRuntime } from "./src/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "src/shim.mjs");
const NAME = "openai-computer-use";
const LEGACY = "openai-cua-worker";
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || os.homedir();
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const SETTINGS = path.join(CLAUDE_HOME, "settings.json");
const SKILL = "openai-computer-use";
const PERSIST = ["CODEX_HOME", "OPENAI_CUA_APP", "OPENAI_CUA_MCP_JSON", "OPENAI_CUA_IDLE_MS", "OPENAI_CUA_CALL_TIMEOUT_MS", "OPENAI_CUA_STATE_DIR", "OPENAI_CUA_ENABLE_JS"];
const flag = (f) => process.argv.includes(f);
const ok = (m) => console.log("✓ " + m);
const die = (m) => { console.error("✗ " + m + "\nNo configuration was changed."); process.exit(1); };
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: process.env });
const which = (cmd) => { const r = run("/usr/bin/which", [cmd]); return r.status === 0 ? r.stdout.trim() : null; };

// ---------- preflight (read-only) ----------
if (process.platform !== "darwin") die("macOS only");
const node = which("node") || (!process.versions.bun && process.execPath);
if (!node) die("node not found on PATH");
const major = Number(execFileSync(node, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }));
if (!(major >= 18)) die(`Node 18+ required (${node} is ${major})`);
ok(`node ${node} (v${major})`);
let runtime;
try { runtime = findRuntime(); } catch (e) { die(e.message); }
ok(`OpenAI runtime: ${runtime.source}`);
const claude = which("claude");
if (!claude) die("Claude Code CLI (claude) not found on PATH");
ok(`claude: ${claude}`);
const env = Object.fromEntries(PERSIST.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
// Settings must parse to a plain object before anything is written.
let settings = {}, settingsMode = 0o600;
if (!flag("--keep-native")) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    settingsMode = fs.statSync(SETTINGS).mode & 0o777;
  } catch (e) { if (e.code !== "ENOENT") die(`cannot parse ${SETTINGS}: ${e.message}`); }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) die(`${SETTINGS} is not a JSON object`);
  if (settings.deniedMcpServers != null && !Array.isArray(settings.deniedMcpServers)) die(`${SETTINGS}: deniedMcpServers is not an array`);
}
// Current registration, restored if replacing it fails.
let previous = null;
try { previous = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, ".claude.json"), "utf8"))?.mcpServers?.[NAME] ?? null; }
catch (e) { if (e.code !== "ENOENT") die(`cannot parse ${path.join(CLAUDE_DIR, ".claude.json")}: ${e.message}`); }
// run_cua_js is opt-in; without a flag, keep the current registration's choice.
if (flag("--enable-js") && flag("--disable-js")) die("--enable-js and --disable-js conflict");
if (flag("--enable-js") || (!flag("--disable-js") && !env.OPENAI_CUA_ENABLE_JS && previous?.env?.OPENAI_CUA_ENABLE_JS === "1")) env.OPENAI_CUA_ENABLE_JS = "1";
if (flag("--disable-js")) delete env.OPENAI_CUA_ENABLE_JS;
ok(`run_cua_js: ${env.OPENAI_CUA_ENABLE_JS === "1" ? "enabled" : "disabled (enable with --enable-js)"}`);
if (!flag("--skip-live")) {
  const r = run(node, [SHIM, "--doctor"]);
  if (r.status !== 0) die(`live engine check failed:\n${r.stdout}${r.stderr}`);
  ok("live engine check: " + r.stdout.trim().split("\n").pop().replace(/^✓ /, ""));
}

// ---------- changes ----------
const BACKUPS = path.join(STATE_DIR, "backups");
fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = (file) => {
  if (!fs.existsSync(file)) return;
  const dest = path.join(BACKUPS, `${path.basename(path.dirname(file))}-${path.basename(file)}.${stamp}`);
  fs.copyFileSync(file, dest);
  fs.chmodSync(dest, 0o600);
};

// 1. Claude registration (argv only; no shell).
backup(path.join(CLAUDE_DIR, ".claude.json"));
run(claude, ["mcp", "remove", "--scope", "user", NAME]);
const spec = JSON.stringify({ type: "stdio", command: node, args: [SHIM], env });
const add = run(claude, ["mcp", "add-json", "--scope", "user", NAME, spec]);
if (add.status !== 0) {
  const restored = previous && run(claude, ["mcp", "add-json", "--scope", "user", NAME, JSON.stringify(previous)]).status === 0;
  console.error(`✗ claude mcp add-json failed: ${add.stderr || add.stdout}\n${restored ? "Previous registration restored." : `Backup: ${BACKUPS}`} Nothing else was changed.`);
  process.exit(1);
}
const got = run(claude, ["mcp", "get", NAME]);
if (got.status !== 0 || !got.stdout.includes(SHIM)) { console.error(got.stdout + got.stderr); process.exit(1); }
ok(`registered ${NAME} in ${path.join(CLAUDE_DIR, ".claude.json")}${/connected/i.test(got.stdout) ? " (connected)" : ""}`);

// 2. Deny Claude's built-in computer-use server (supported user-level denylist).
if (!flag("--keep-native")) {
  const denied = settings.deniedMcpServers ?? [];
  if (!denied.some((d) => d?.serverName === "computer-use")) {
    backup(SETTINGS);
    settings.deniedMcpServers = [...denied, { serverName: "computer-use" }];
    const tmp = `${SETTINGS}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, settingsMode); // keep the original (possibly stricter) mode
    JSON.parse(fs.readFileSync(tmp, "utf8"));
    fs.renameSync(tmp, SETTINGS);
  }
  ok(`built-in computer-use denied in ${SETTINGS}`);
}

// 3. Legacy v0.1 worker: Codex config entry, processes, socket state.
const codex = which("codex");
if (codex && run(codex, ["mcp", "get", LEGACY]).status === 0) {
  backup(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"));
  const rm = run(codex, ["mcp", "remove", LEGACY]);
  if (rm.status !== 0 || run(codex, ["mcp", "get", LEGACY]).status === 0) console.error(`! could not remove ${LEGACY} from Codex config: ${rm.stderr}`);
  else ok(`removed legacy ${LEGACY} from Codex config`);
} else if (!codex) console.log(`  (codex CLI not found; if ~/.codex/config.toml has [mcp_servers.${LEGACY}], remove it with \`codex mcp remove ${LEGACY}\`)`);
const ps = run("/bin/ps", ["-axo", "pid=,command="]).stdout.split("\n");
const legacyPids = ps.filter((l) => l.includes(path.join(HERE, "src/worker.mjs"))).map((l) => Number(l.trim().split(/\s+/)[0]));
for (const pid of legacyPids) try { process.kill(pid, "SIGTERM"); } catch {}
for (const f of ["worker.sock", "worker.pid", "tools.json"]) fs.rmSync(path.join(STATE_DIR, f), { force: true });
if (legacyPids.length) ok(`stopped ${legacyPids.length} legacy worker process(es)`);

// 4. Skill: a symlink, so it follows the repo like the registered shim does.
// Anything already at the target is backed up first, then replaced.
if (!flag("--skip-skill")) {
  const src = path.join(HERE, "skills", SKILL);
  const dest = path.join(CLAUDE_HOME, "skills", SKILL);
  const cur = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!fs.existsSync(path.join(src, "SKILL.md"))) console.error(`! skill source missing: ${src}`);
  else if (cur?.isSymbolicLink() && fs.readlinkSync(dest) === src) ok(`skill ${SKILL} already linked`);
  else {
    if (cur) {
      const saved = path.join(BACKUPS, `skills-${SKILL}.${stamp}`);
      if (cur.isSymbolicLink()) fs.writeFileSync(saved, `symlink -> ${fs.readlinkSync(dest)}\n`, { mode: 0o600 });
      else fs.cpSync(dest, saved, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest);
    ok(`skill ${SKILL} linked at ${dest}${cur ? " (previous one backed up)" : ""}`);
  }
}

console.log(`\nDone. New Claude Code sessions get the "${NAME}" tools; the ChatGPT app does not need to be running.`);
