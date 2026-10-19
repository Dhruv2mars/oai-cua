#!/usr/bin/env node
// Installer. Wires both ends of the bridge:
//   1. registers the WORKER in ~/.codex/config.toml so the ChatGPT/Codex app
//      spawns it with app-trust;
//   2. registers the SHIM as an MCP server in Claude Code (user scope);
//   3. prints how to disable Claude Code's native computer-use so GUI tasks
//      route through this OpenAI-engine bridge instead.
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_HOME, CLIENT_PATH } from "./src/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const WORKER = path.join(HERE, "src/worker.mjs");
const SHIM = path.join(HERE, "src/shim.mjs");
const CONFIG = path.join(CODEX_HOME, "config.toml");
const WORKER_KEY = "openai-cua-worker";
const SHIM_NAME = "openai-computer-use";

function fail(m) { console.error("✗ " + m); process.exitCode = 1; }
function ok(m) { console.log("✓ " + m); }

// --- preflight ---
if (!fs.existsSync(CLIENT_PATH)) fail(`SkyComputerUseClient not found at ${CLIENT_PATH} — install/open the ChatGPT desktop app with Computer Use first.`);
else ok("found OpenAI computer-use client");

// --- 1. register worker in codex config.toml ---
if (!fs.existsSync(CONFIG)) {
  fail(`${CONFIG} not found — is the Codex/ChatGPT app installed?`);
} else {
  const cur = fs.readFileSync(CONFIG, "utf8");
  if (cur.includes(`[mcp_servers.${WORKER_KEY}]`)) {
    ok("worker already registered in codex config.toml");
  } else {
    fs.copyFileSync(CONFIG, `${CONFIG}.bak.${Date.now()}`);
    const block = `\n[mcp_servers.${WORKER_KEY}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(WORKER)}]\n`;
    fs.appendFileSync(CONFIG, block);
    ok("registered worker in codex config.toml (backup written)");
  }
}

// --- 2. register shim in Claude Code ---
let claudeOk = false;
try {
  execSync("command -v claude", { stdio: "ignore", shell: "/bin/bash" });
  claudeOk = true;
} catch {}
if (claudeOk) {
  try {
    execSync(`claude mcp remove --scope user ${SHIM_NAME} 2>/dev/null; claude mcp add --scope user ${SHIM_NAME} -- ${JSON.stringify(NODE)} ${JSON.stringify(SHIM)}`, { stdio: "inherit", shell: "/bin/bash" });
    ok(`registered shim with Claude Code as "${SHIM_NAME}" (user scope)`);
  } catch {
    claudeOk = false;
  }
}
if (!claudeOk) {
  console.log("\n  Claude Code CLI not auto-detected. Add the shim manually:");
  console.log(`    claude mcp add --scope user ${SHIM_NAME} -- ${NODE} ${SHIM}`);
  console.log("  …or add to your MCP config (e.g. .mcp.json):");
  console.log(JSON.stringify({ mcpServers: { [SHIM_NAME]: { command: NODE, args: [SHIM] } } }, null, 2).replace(/^/gm, "    "));
}

// --- 3. disable native computer-use (instructions) ---
console.log("\nTo route GUI tasks through this bridge instead of Claude's native engine:");
console.log("  • In an interactive Claude Code session run /mcp, DISABLE the built-in");
console.log(`    "computer-use" server, and ENABLE "${SHIM_NAME}". (Per-project, persists.)`);
console.log("\nNext: keep the ChatGPT app running; start/resume one Codex conversation so the");
console.log("app spawns the worker. Then computer-use tools are live in Claude Code.");
