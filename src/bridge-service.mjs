// Trusted node_repl service for bridge cells (registered as "cuabridge" in
// NODE_REPL_TRUSTED_SERVICES). OpenAI's public `cua` API has no way to stop an
// app session or end a turn; SkyComputerUseService does, through requests on
// its native pipe that only trusted services can reach. This exposes a fixed
// allowlist of them. OpenAI's IPC client is loaded at runtime from the
// installed ChatGPT.app, never copied here.
import fs from "node:fs";
import path from "node:path";

const CLIENT = "@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js";
let client;

async function sky() {
  if (client) return client;
  const dirs = [process.env.OPENAI_CUA_NODE_MODULES, ...(process.env.NODE_REPL_NODE_MODULE_DIRS ?? "").split(":")].filter(Boolean);
  const file = dirs.map((d) => path.join(d, CLIENT)).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`computer-use IPC client not found under ${dirs.join(", ") || "(no module dirs)"}`);
  client = (await import(file)).client;
  return client;
}

const text = (v, name) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must be a non-empty string`);
  return v;
};

export async function handleRpc(msg) {
  const c = await sky();
  switch (msg?.type) {
    case "resolve": { // app name/path/bundle id → the service's identity for it
      const p = await c.getAppPolicy(text(msg.app, "app"));
      const t = p?.target ?? {};
      return { decision: p?.decision, bundleIdentifier: t.bundleIdentifier, appPath: t.appPath, displayName: t.displayName, risk: t.risk };
    }
    case "stopApp": { // like the menu-bar "Stop": ends the app's session
      const p = await c.getAppPolicy(text(msg.app, "app"));
      const appPath = p?.target?.appPath;
      if (!appPath) throw new Error(`no app path for ${msg.app}`);
      const r = await c.request("ComputerUseIPCAppStopRequest", { app: appPath }, { timeoutSeconds: 10 });
      return { bundleIdentifier: p.target.bundleIdentifier, displayName: p.target.displayName, active: r?.active ?? null };
    }
    case "turnEnded": // ends the turn: clears per-turn stops and fences late calls from it
      await c.request("ComputerUseIPCCodexTurnEndedRequest", { threadID: text(msg.threadID, "threadID"), turnID: text(msg.turnID, "turnID") }, { timeoutSeconds: 10 });
      return {};
    default:
      throw new Error(`unsupported cuabridge request: ${msg?.type}`);
  }
}
