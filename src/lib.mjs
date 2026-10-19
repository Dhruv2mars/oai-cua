// Shared helpers: paths, private logging, NDJSON framing, runtime discovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const STATE_DIR = process.env.OPENAI_CUA_STATE_DIR || path.join(os.homedir(), ".openai-cua-bridge");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const CHATGPT_APP = process.env.OPENAI_CUA_APP || "/Applications/ChatGPT.app";

export function logger(name) {
  const file = path.join(STATE_DIR, name);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STATE_DIR, 0o700);
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > 1 << 20) fs.truncateSync(file, 0);
  } catch {}
  return (m) => {
    try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${process.pid} ${m}\n`, { mode: 0o600 }); } catch {}
  };
}

// Newline-delimited JSON. Decodes UTF-8 across chunk boundaries.
export function makeLineReader(onMsg, onBad = () => {}) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : dec.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { onBad(line); continue; }
      onMsg(obj);
    }
  };
}

export function writeLine(stream, obj) {
  if (!stream || stream.destroyed || stream.writableEnded) return false;
  try { stream.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
}

// Locate OpenAI's installed cua-repl MCP server (ChatGPT.app → Codex
// "unified-computer-use" plugin). Prefers the plugin manifest the app wrote,
// so app updates carry their own paths/env; falls back to the app bundle.
export function findRuntime() {
  const override = process.env.OPENAI_CUA_MCP_JSON;
  const candidates = override ? [override] : pluginManifests();
  for (const file of candidates) {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers?.cua_repl;
      if (s?.command && Array.isArray(s.args) && fs.existsSync(s.command) && s.args.every((a) => !a.endsWith(".mjs") || fs.existsSync(a)))
        return { command: s.command, args: s.args, env: { ...(s.env || {}) }, source: file };
    } catch {}
  }
  const res = path.join(CHATGPT_APP, "Contents/Resources/cua_node");
  const command = path.join(res, "bin/node");
  const script = path.join(res, "lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs");
  if (!override && fs.existsSync(command) && fs.existsSync(script))
    return {
      command,
      args: [script],
      env: {
        NODE_REPL_NODE_PATH: command,
        NODE_REPL_NODE_MODULE_DIRS: path.join(res, "lib/node_modules"),
        NODE_REPL_TRUSTED_CODE_PATHS: `${CODEX_HOME}:${path.join(res, "lib/node_modules")}`,
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
        CUA_REPL_NODE_REPL_PATH: path.join(res, "bin/node_repl"),
        SKY_CUA_SERVICE_PATH: path.join(CODEX_HOME, "computer-use/Codex Computer Use.app"),
        CODEX_HOME,
      },
      source: CHATGPT_APP,
    };
  throw new Error(
    `OpenAI computer-use runtime not found (looked in ${override || path.join(CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use")} and ${res}). ` +
      "Install the ChatGPT desktop app and enable its Computer Use plugin once.",
  );
}

function pluginManifests() {
  const dir = path.join(CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use");
  let versions = [];
  try { versions = fs.readdirSync(dir); } catch { return []; }
  const num = (v) => v.split(".").map((n) => Number(n) || 0);
  versions.sort((a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  return versions.map((v) => path.join(dir, v, ".mcp.json"));
}
