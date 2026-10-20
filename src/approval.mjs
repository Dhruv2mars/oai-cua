// Per-app approval. The engine asks "Allow Computer Use to use X?" before
// every action on an app; ChatGPT's host turns that into a one-time user
// prompt (session or always) and remembers the answer. This module does the
// same for Claude:
//   Chrome → always declined (by the bundle id the service resolved)
//   approved earlier this session, or always-allowed on disk → accepted
//   otherwise → the user is asked through MCP elicitation, if the client
//   supports it, else the fallback policy OAI_CUA_APPROVAL decides:
//     auto (default)  accept, as before this feature existed
//     prompt          ask with a native macOS dialog
//     deny-unknown    decline apps that are not already approved
// Clients that advertise elicitation but cannot show it answer within
// milliseconds; no person answers that fast, so they use the fallback. An
// instant `cancel` (headless Claude Code) always means that. An instant
// `decline` is also what a deliberate rule sends (e.g. an Elicitation hook),
// so it counts only under an Agent SDK host such as T3 Code, whose Claude Code
// declines every prompt it cannot show; elsewhere it stays a refusal.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./lib.mjs";
import { BLOCKED_APP } from "./tools.mjs";

export const POLICIES = ["auto", "prompt", "deny-unknown"];
const AUTO_ANSWER_MS = 250; // no human answers a prompt this fast

// Normalizes the engine's elicitation request.
export function parseRequest(params = {}) {
  const meta = params._meta ?? {};
  const app = typeof meta.tool_params?.app === "string" ? meta.tool_params.app : null;
  const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.find((d) => d?.name === "app")?.value : null;
  const message = String(params.message ?? "Computer Use approval");
  return {
    message,
    app,
    key: app ?? (meta.tool_name ? `tool:${meta.tool_name}` : `message:${message}`),
    name: shown ?? app ?? meta.tool_name ?? message,
    risk: typeof meta.riskLevel === "string" ? meta.riskLevel : "unknown",
    subtitle: typeof meta.subtitle === "string" ? meta.subtitle : null,
    canPersist: Array.isArray(meta.persist) && meta.persist.includes("always"),
    blocked: BLOCKED_APP.test(`${message} ${JSON.stringify(meta.tool_params ?? {})}`),
  };
}

export function promptText(r) {
  const what = r.app ? `"${r.name}" (${r.app})` : `"${r.name}"`;
  return `Allow Claude to use ${what} with computer use?\nRisk: ${r.risk}${r.subtitle ? ` — ${r.subtitle}` : ""}`;
}

export class Approver {
  constructor({ policy = process.env.OAI_CUA_APPROVAL, file = path.join(STATE_DIR, "approvals.json"), log = () => {}, dialog = nativeDialog, now = Date.now, sdkHost = /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT ?? "") } = {}) {
    this.policy = POLICIES.includes(policy) ? policy : "auto";
    if (policy && policy !== this.policy) log(`unknown OAI_CUA_APPROVAL=${policy}; using auto`);
    Object.assign(this, { file, log, dialog, now, sdkHost });
    this.session = new Set();   // keys approved in this Claude session
    this.elicit = null;         // (request, signal) → Promise<{action, content}>, set when the client can elicit
    this.clientCannotAsk = false;
  }

  get always() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8"))?.always ?? {}; } catch { return {}; }
  }

  remember(r) {
    const always = { ...this.always, [r.key]: { name: r.name, at: new Date().toISOString() } };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, always }, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (e) { this.log(`could not save approval for ${r.key}: ${e.message}`); }
  }

  // Resolves the reply for the engine's elicitation/create request.
  async decide(params, signal) {
    const r = parseRequest(params);
    if (r.blocked) { this.log(`approval declined (Chrome is blocked): ${r.message}`); return { action: "decline" }; }
    if (this.session.has(r.key) || Object.hasOwn(this.always, r.key))
      return { action: "accept", content: { source: "computer-use-persisted-state" } };
    const ans = await this.#ask(r, signal);
    this.log(`approval ${r.key} (risk ${r.risk}): ${ans.action}${ans.always ? " always" : ""} via ${ans.via}`);
    if (ans.action !== "accept") return { action: ans.action === "cancel" ? "cancel" : "decline" };
    this.session.add(r.key);
    if (ans.always && r.canPersist) this.remember(r);
    return { action: "accept", content: {} };
  }

  async #ask(r, signal) {
    if (this.elicit && !this.clientCannotAsk) {
      const t = this.now();
      try {
        const res = await this.elicit(r, signal);
        const ms = this.now() - t;
        if ((res?.action === "cancel" || (res?.action === "decline" && this.sdkHost)) && ms < AUTO_ANSWER_MS) {
          this.clientCannotAsk = true; // answered by software, not a person
          this.log(`client answered the approval prompt with ${res.action} in ${ms}ms; using the fallback policy from now on`);
        } else if (res?.action === "accept" || res?.action === "decline" || res?.action === "cancel")
          return { action: res.action, always: res.content?.always === true, via: "elicitation" };
      } catch (e) {
        if (signal?.aborted) return { action: "cancel", via: "cancelled" };
        this.clientCannotAsk = true;
        this.log(`client elicitation failed (${e.message}); using the fallback policy`);
      }
    }
    if (this.policy === "auto") return { action: "accept", via: "policy auto" };
    if (this.policy === "deny-unknown") return { action: "decline", via: "policy deny-unknown" };
    return { ...(await this.dialog(r, signal)), via: "native dialog" };
  }
}

// Native macOS prompt for clients that cannot show MCP elicitation.
export function nativeDialog(r, signal) {
  const buttons = r.canPersist ? ["Deny", "Allow", "Always Allow"] : ["Deny", "Allow"];
  const script = `on run argv
display dialog (item 1 of argv) with title "Claude computer use" buttons {${buttons.map((b) => JSON.stringify(b)).join(", ")}} default button "Deny" cancel button "Deny" with icon caution giving up after 120
return button returned of result
end run`;
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script, promptText(r)], { signal, timeout: 130000 }, (err, stdout) => {
      const b = String(stdout || "").trim();
      if (err || !b) return resolve({ action: "decline" });
      resolve({ action: b === "Deny" ? "decline" : "accept", always: b === "Always Allow" });
    });
  });
}
