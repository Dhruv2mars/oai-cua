// Tools backed by the MCP servers inside OpenAI's SkyComputerUseClient:
// Record & Replay (`event-stream mcp`) and, only when the user opts in with
// OAI_CUA_COMPUTER_HISTORY=1, Computer History (`computer-history mcp`).
// Consent prompts from the service are forwarded to the human through the
// Claude client's elicitation support and are never answered by the bridge.
import { NativeServer } from "./native.mjs";
import { writeSkill, skillsDir } from "./skill.mjs";

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const RULE = obj({
  scope: { type: "string", enum: ["app", "url"] },
  bundleID: { type: "string", description: "App bundle identifier (app rules only)" },
  urlDomain: { type: "string", description: "Bare domain such as example.com (url rules only)" },
}, ["scope"]);

const RECORD_TOOLS = [
  { name: "record_start", native: "event_stream_start", timeoutMs: 15 * 60000,
    description: "Start a Record & Replay recording of the user's own actions on this Mac (clicks, typed text and the content of windows they use), for up to 30 minutes, so the demonstration can become a reusable skill. Only call this when the user asks to be recorded and is ready. OpenAI's service asks the user to confirm first. Once it has started, end your turn and ask the user to tell you when they are done; do not poll.",
    inputSchema: obj({}) },
  { name: "record_status", native: "event_stream_status", readOnly: true,
    description: "Report whether a Record & Replay recording is running, with the paths of its metadata and events files.",
    inputSchema: obj({}) },
  { name: "record_stop", native: "event_stream_stop",
    description: "Stop the active Record & Replay recording and return the paths of the captured files. Next, call recording_to_skill to turn it into a skill. If the user cancelled the recording from the on-screen controls, do not build a skill from it.",
    inputSchema: obj({}) },
  { name: "recording_to_skill",
    description: `Convert a Record & Replay recording into a Claude Code skill. Writes <output_dir>/<name>/SKILL.md (default ${skillsDir()}) and returns its content. Secure-input events are dropped and secret-looking text is redacted. Then review the draft with the user: settle ambiguous steps and which typed values are inputs, and edit the file so it captures the goal, not raw clicks.`,
    inputSchema: obj({
      name: { type: "string", description: "Skill name (lowercase letters, digits and hyphens)" },
      description: { type: "string", description: "When Claude should use the skill. Defaults to a generic description" },
      events_path: { type: "string", description: "events.jsonl or its recording directory. Defaults to the last recording" },
      output_dir: { type: "string", description: "Skills directory to write into. Defaults to the user's Claude skills directory" },
      overwrite: { type: "boolean", description: "Replace an existing SKILL.md. Defaults to false" },
    }, ["name"]) },
];

const HISTORY_TOOLS = [
  { name: "computer_history_status", native: "computer_history_status", readOnly: true,
    description: "Report whether OpenAI's Computer History is running, paused or stopped, with the paths of its recent activity files. Turning it on is only possible in ChatGPT's settings.",
    inputSchema: obj({}) },
  { name: "computer_history_get_settings", native: "computer_history_get_settings", readOnly: true,
    description: "Read Computer History's observation rules: default behaviour for apps and URLs, plus allow and block lists.",
    inputSchema: obj({}) },
  { name: "computer_history_update_settings", native: "computer_history_update_settings",
    description: "Replace all Computer History observation rules. Read them first with computer_history_get_settings and keep every rule the user did not ask to change. Only call this when the user asks.",
    inputSchema: obj({ observation: obj({
      defaultApplicationBehavior: { type: "string", enum: ["observe", "do_not_observe"] },
      defaultURLBehavior: { type: "string", enum: ["observe", "do_not_observe"] },
      allowlist: { type: "array", items: RULE },
      blocklist: { type: "array", items: RULE },
    }, ["defaultApplicationBehavior", "defaultURLBehavior", "allowlist", "blocklist"]) }, ["observation"]) },
  { name: "computer_history_pause", native: "computer_history_pause",
    description: "Pause Computer History without turning it off.",
    inputSchema: obj({}) },
  { name: "computer_history_resume", native: "computer_history_resume",
    description: "Resume a paused Computer History recorder. This restarts recording of the user's activity, so only call it when the user asks.",
    inputSchema: obj({}) },
];

export const historyEnabled = () => process.env.OAI_CUA_COMPUTER_HISTORY === "1";
const tools = () => [...RECORD_TOOLS, ...(historyEnabled() ? HISTORY_TOOLS : [])];
export const isServiceTool = (name) => tools().some((t) => t.name === name);
export const serviceTools = () => tools().map(({ native, readOnly, timeoutMs, ...t }) => ({
  ...t, annotations: { readOnlyHint: !!readOnly, openWorldHint: false },
}));

const TYPES = { string: "string", boolean: "boolean", object: "object", array: "object" };
function check(schema, v, at) {
  if (schema.type && (typeof v !== TYPES[schema.type] || v === null || (schema.type === "array") !== Array.isArray(v))) return `${at} must be ${schema.type === "array" ? "an array" : `a ${schema.type}`}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at} must be one of ${schema.enum.join(", ")}`;
  if (schema.type === "array") for (let i = 0; i < v.length; i++) { const e = check(schema.items, v[i], `${at}[${i}]`); if (e) return e; }
  if (schema.type === "object" && schema.properties) {
    for (const k of schema.required ?? []) if (v[k] == null) return `missing required argument: ${at ? `${at}.` : ""}${k}`;
    for (const [k, x] of Object.entries(v)) {
      if (!schema.properties[k]) return `unknown argument: ${at ? `${at}.` : ""}${k}`;
      const e = check(schema.properties[k], x, at ? `${at}.${k}` : k);
      if (e) return e;
    }
  }
  return null;
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const parse = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === "text")?.text ?? ""); } catch { return null; } };

export function createService({ log, idleMs, callTimeoutMs, canElicit, elicit }) {
  const opts = { log, idleMs, callTimeoutMs, canElicit, onElicit: elicit };
  const servers = { record: new NativeServer({ ...opts, sub: ["event-stream", "mcp"] }), history: new NativeServer({ ...opts, sub: ["computer-history", "mcp"] }) };
  let lastEvents = null;

  // Keep the recorder's client alive while a recording runs.
  function track(status) {
    if (!status || typeof status !== "object") return;
    if (status.eventsPath) lastEvents = status.eventsPath;
    if (typeof status.isRecording === "boolean") servers.record.hold = status.isRecording;
  }

  async function call(name, args = {}, signal) {
    const tool = tools().find((t) => t.name === name);
    if (!tool) return text(`unknown tool: ${name}`, true);
    if (args == null || typeof args !== "object" || Array.isArray(args)) return text("arguments must be an object", true);
    const bad = check(tool.inputSchema, args, "");
    if (bad) return text(bad, true);
    try {
      if (name === "recording_to_skill") {
        let eventsPath = args.events_path ?? lastEvents;
        if (!eventsPath) {
          const st = parse(await servers.record.call("event_stream_status", {}, signal));
          track(st);
          if (st?.isRecording) return text("A recording is still running. Ask the user to finish, then call record_stop first.", true);
          eventsPath = st?.eventsPath;
        }
        const r = writeSkill({ name: args.name, description: args.description, eventsPath, outputDir: args.output_dir, overwrite: args.overwrite === true });
        return text(`Wrote ${r.path} (${r.steps} steps, ${r.inputs} inputs from ${r.stats.events} events${r.bad ? `, ${r.bad} unreadable lines` : ""}).\nReview it with the user and edit the file to capture the goal.\n\n${r.md}`);
      }
      const server = name.startsWith("record_") ? servers.record : servers.history;
      const args2 = name === "computer_history_update_settings" ? args : {};
      const r = await server.call(tool.native, args2, signal, tool.timeoutMs);
      if (server === servers.record) track(parse(r));
      const out = { content: Array.isArray(r?.content) && r.content.length ? r.content : [{ type: "text", text: "Done." }], ...(r?.isError ? { isError: true } : {}) };
      if (name === "record_stop" && !r?.isError) out.content = [...out.content, { type: "text", text: "Next: recording_to_skill with a short name for the workflow." }];
      return out;
    } catch (e) {
      if (signal?.aborted) return text("cancelled", true);
      log(`service ${name} failed: ${e.message}`);
      return text(e.message, true);
    }
  }

  return {
    call,
    stop: (why) => { for (const s of Object.values(servers)) { s.hold = false; s.stop(why); } },
  };
}
