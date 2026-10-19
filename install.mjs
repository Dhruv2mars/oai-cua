#!/usr/bin/env node
// Installer. Preflights everything (including a live engine call) before
// changing any configuration, then:
//   1. registers the shim with Claude Code (user scope of $CLAUDE_CONFIG_DIR);
//   2. denies Claude's built-in "computer-use" server so GUI work routes here;
//   3. removes the legacy v0.1 Codex worker registration and its processes.
// Flags: --keep-native (skip step 2), --skip-live (skip the live preflight).
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
const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
const PERSIST = ["CODEX_HOME", "OPENAI_CUA_APP", "OPENAI_CUA_MCP_JSON", "OPENAI_CUA_IDLE_MS", "OPENAI_CUA_CALL_TIMEOUT_MS", "OPENAI_CUA_STATE_DIR"];
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

console.log(`\nDone. New Claude Code sessions get the "${NAME}" tools; the ChatGPT app does not need to be running.`);
