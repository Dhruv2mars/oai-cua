// Shared helpers for the OpenAI computer-use bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, ".openai-cua-bridge");
export const SOCK = path.join(STATE_DIR, "worker.sock");
export const PID = path.join(STATE_DIR, "worker.pid");
export const TOOLS_CACHE = path.join(STATE_DIR, "tools.json");

export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
export const CLIENT_PATH =
  process.env.OPENAI_CUA_CLIENT_PATH ||
  path.join(
    CODEX_HOME,
    "computer-use",
    "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  );
export const CLIENT_CWD = path.join(CODEX_HOME, "computer-use");

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function logger(file) {
  return (m) => {
    try {
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${m}\n`);
    } catch {}
  };
}

// Newline-delimited JSON framing over a stream. Calls onMsg(obj) per line.
export function makeLineReader(onMsg) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      onMsg(obj);
    }
  };
}

export function writeLine(stream, obj) {
  try {
    stream.write(JSON.stringify(obj) + "\n");
  } catch {}
}

// The computer-use tool names (used only as a last-resort fallback for
// tools/list when the live client has never been reached).
export const FALLBACK_TOOLS = [
  "list_apps",
  "get_app_state",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
  "set_value",
  "select_text",
  "perform_secondary_action",
].map((name) => ({
  name,
  description: `OpenAI computer-use: ${name} (schema loads live once the worker reaches the client).`,
  inputSchema: { type: "object", additionalProperties: true },
}));
