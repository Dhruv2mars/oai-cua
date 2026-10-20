// Turns a Record & Replay event stream (events.jsonl written by OpenAI's
// SkyComputerUseService) into a Claude Code skill (SKILL.md).
// The event schema is not documented, so every field is looked up tolerantly;
// secure-input events are dropped and secret-looking text is redacted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_STEPS = 80;
const MAX_TEXT = 160;
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|(?:\d[ -]?){13,19})\b/g;

export const skillsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills");

// Depth-first search for the first non-empty value under any of `keys`.
function pick(obj, keys, depth = 0) {
  if (obj == null || typeof obj !== "object" || depth > 5) return undefined;
  for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const r = pick(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

const clean = (s) => {
  if (s == null) return "";
  const t = String(s).replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + "…" : t;
};
const quote = (s) => `“${s.replace(/”/g, "\"")}”`;

function describeTarget(t) {
  if (t == null) return "";
  if (typeof t !== "object") return clean(t);
  const role = clean(pick(t, ["roleDescription", "role", "subrole"]))?.replace(/^AX/, "");
  const label = clean(pick(t, ["title", "label", "name", "description", "help", "placeholder", "identifier", "value"]));
  return [role, label && quote(label)].filter(Boolean).join(" ");
}

function modifiers(m) {
  if (m == null) return [];
  if (Array.isArray(m)) return m.map(String);
  if (typeof m === "string") return m.split(/[+, ]+/).filter(Boolean);
  if (typeof m === "object") return Object.entries(m).filter(([, v]) => v).map(([k]) => k);
  return [];
}

export function parseEvents(text) {
  const events = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { bad++; }
  }
  return { events, bad };
}

// Returns { steps, apps, inputs, stats }.
export function summarize(events) {
  const steps = [], apps = new Map(), inputs = [];
  const stats = { events: events.length, skipped: 0, secure: 0, terminal: 0 };
  let lastWin = "", typing = null;
  const push = (s) => { typing = null; steps.push(s); };
  for (const e of events) {
    const type = String(pick(e, ["type", "kind", "eventType", "event"]) ?? "").toLowerCase();
    if (pick(e, ["secureInput", "isSecure", "secure"]) === true) { stats.secure++; continue; }
    const appName = clean(pick(e, ["applicationName", "appName", "localizedName", "processName"]));
    const bundle = clean(pick(e, ["bundleIdentifier", "bundleID", "bundleId"]));
    const app = appName || bundle;
    if (app && !/chrome/i.test(app + bundle)) apps.set(app, bundle);
    const win = clean(pick(e, ["windowTitle", "title"]));
    const url = clean(pick(e, ["url", "URL"]));
    const target = describeTarget(pick(e, ["target", "element", "axElement"]));
    if (type.startsWith("session.") || type.startsWith("debug.")) { stats.skipped++; continue; }
    if (type === "window.changed") {
      const key = `${app}|${win}|${url}`;
      if (key === lastWin) continue;
      lastWin = key;
      push(`Switch to ${app ? `**${app}**` : "the app"}${win ? ` (window ${quote(win)})` : ""}${url ? ` at ${url}` : ""}.`);
    } else if (type === "mouse.click") {
      const count = Number(pick(e, ["clickCount"]) ?? 1);
      const button = String(pick(e, ["button", "mouseButton"]) ?? "left").toLowerCase();
      const how = `${count === 2 ? "Double-click" : count > 2 ? `Click ${count}×` : "Click"}${button.includes("right") ? " (right button)" : ""}`;
      push(`${how} ${target || "the target element"}${app ? ` in ${app}` : ""}.`);
    } else if (type === "mouse.context_menu") {
      push(`Open the context menu on ${target || "the target element"} and choose the needed item.`);
    } else if (type === "mouse.drag") {
      const from = describeTarget(pick(e, ["origin", "from", "source"])), to = describeTarget(pick(e, ["destination", "to"]));
      push(`Drag ${from || "the item"} to ${to || "its destination"}.`);
    } else if (type === "keyboard.text_input") {
      const raw = pick(e, ["text", "characters", "string", "value"]);
      if (raw == null || raw === "") continue;
      if (typing && typing.target === target) typing.raw += String(raw);
      else {
        typing = { target, raw: String(raw), at: steps.length, input: inputs.length };
        inputs.push({ id: `input_${inputs.length + 1}`, where: target });
        steps.push("");
      }
      typing.text = clean(typing.raw);
      inputs[typing.input].example = typing.text;
      steps[typing.at] = `Type {{${inputs[typing.input].id}}} (recorded: ${quote(typing.text)})${target ? ` into ${target}` : ""}.`;
      continue;
    } else if (type === "keyboard.submit") {
      push(`Press Return to submit${target ? ` ${target}` : ""}.`);
    } else if (type === "keyboard.shortcut") {
      const key = clean(pick(e, ["keyEquivalent", "key", "characters"]));
      const combo = [...modifiers(pick(e, ["modifiers", "modifierFlags"])), key].filter(Boolean).join("+");
      push(`Press ${combo ? `\`${combo}\`` : "the shortcut"}.`);
    } else if (type === "selection.changed") {
      const sel = clean(pick(e, ["selectedText", "text"])) || clean(pick(e, ["selectedItems"]));
      if (sel) push(`Select ${quote(sel)}${target ? ` in ${target}` : ""}.`);
      else continue;
    } else if (type === "terminal.value_changed") {
      stats.terminal++;
      continue;
    } else {
      stats.skipped++;
      continue;
    }
    if (steps.length >= MAX_STEPS) break;
  }
  return { steps, apps, inputs, stats };
}


export function slug(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function renderSkill({ name, description, summary, source }) {
  const { steps, apps, inputs, stats } = summary;
  const desc = clean(description || `Replay the workflow the user demonstrated with Record & Replay (${[...apps.keys()].slice(0, 3).join(", ") || "macOS apps"}).`).replace(/\n/g, " ");
  const L = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(desc)}`,
    "---",
    "",
    `# ${name}`,
    "",
    `Generated from a Record & Replay demonstration (${stats.events} events${stats.secure ? `, ${stats.secure} secure-input events dropped` : ""}). The steps describe what the user did, not a script to repeat blindly: aim for the same outcome, and refine this file once the intent is clear.`,
    "",
  ];
  if (inputs.length) {
    L.push("## Inputs", "", "Ask the user for these unless the request already gives them; the recorded values are only examples.", "");
    for (const i of inputs) L.push(`- \`${i.id}\`${i.where ? ` (${i.where})` : ""}: e.g. ${quote(i.example)}`);
    L.push("");
  }
  L.push("## Before you start", "");
  if (apps.size) for (const [a, b] of apps) L.push(`- ${a}${b && b !== a ? ` (\`${b}\`)` : ""} must be available.`);
  L.push("- Prefer a dedicated tool, CLI or API for a step when one exists; use the `openai-computer-use` tools for UI-only steps.", "");
  L.push("## Steps", "");
  if (steps.length) steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  else L.push("The recording had no replayable actions. Ask the user to describe the workflow.");
  if (steps.length >= MAX_STEPS) L.push("", `(Truncated at ${MAX_STEPS} steps.)`);
  L.push(
    "",
    "## How to replay",
    "",
    "- Call `get_app_state` for an app before acting in it, and target elements by their accessibility labels from the fresh tree, not by recorded positions.",
    "- After each step, check the returned state; stop and ask the user if the UI differs from what the step expects.",
    "- Do not send messages, submit forms or purchase anything without the user's go-ahead.",
    "",
    "## Verify",
    "",
    "Confirm with `get_app_state` that the final window shows the expected result, then tell the user what was done.",
    "",
    `<!-- source: ${source} -->`,
    "",
  );
  return L.join("\n");
}

// Resolves an events.jsonl path from a file, a recording directory, or a status object.
export function resolveEvents(p) {
  if (!p) throw new Error("no recording found: pass events_path, or call record_stop first");
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) throw new Error(`recording not found: ${p}`);
  if (st.isFile()) return p;
  const f = path.join(p, "events.jsonl");
  if (fs.existsSync(f)) return f;
  throw new Error(`no events.jsonl in ${p}`);
}

export function writeSkill({ name, description, eventsPath, outputDir, overwrite }) {
  const id = slug(name);
  if (!id) throw new Error("name must contain letters or digits");
  const file = resolveEvents(eventsPath);
  const { events, bad } = parseEvents(fs.readFileSync(file, "utf8"));
  const summary = summarize(events);
  const dir = path.join(outputDir || skillsDir(), id);
  const out = path.join(dir, "SKILL.md");
  if (fs.existsSync(out) && !overwrite) throw new Error(`${out} already exists (pass overwrite: true to replace it)`);
  const md = renderSkill({ name: id, description, summary, source: file });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, md, { mode: 0o600 });
  return { path: out, md, steps: summary.steps.length, inputs: summary.inputs.length, bad, stats: summary.stats };
}
