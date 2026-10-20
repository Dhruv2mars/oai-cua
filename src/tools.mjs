// Claude-facing tool schemas and their translation into cua-repl JavaScript.
// Arguments are embedded as JSON literals, never spliced as code.

const APP = { type: "string", description: "App display name, full app path, or bundle identifier (e.g. \"TextEdit\", \"com.apple.TextEdit\"). If a display name fails, retry with the bundle id from list_apps" };
const INDEX = { type: "integer", description: "Element index from the latest accessibility tree (get_app_state or an action's diff). Indices go stale after the UI changes" };
const AFTER = " Returns the updated accessibility state, as a diff from the previous state when possible (only removed, added or changed elements); call get_app_state (or pass screenshot) to see the result.";
const obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const SHOT = { type: "boolean", description: "Also return a screenshot taken after the action, so the result (e.g. of a coordinate click) can be checked in the same call. Defaults to false" };
const HOLD = (what) => ({ type: "integer", minimum: 0, maximum: 30000, description: `Milliseconds to hold ${what} before releasing it (0-30000)` });
const CHORD = "Key names are xdotool-style and case-sensitive (Return, Tab, Escape, BackSpace, Delete, space, Up, Page_Down, F5, a, comma); modifiers are super (⌘), ctrl, alt (⌥), shift, and the aliases cmd, command, control, option, opt are accepted in any case";
const action = (props, required) => obj({ ...props, screenshot: SHOT }, required);

export const TOOLS = [
  { name: "list_apps", readOnly: true,
    description: "List the apps on this Mac (running apps plus recently used ones) with their bundle ids. Use it when the task does not name an app, or to get a bundle id after a display name failed; do not call it just to resolve an app you can name, call get_app_state with the name instead.",
    inputSchema: obj({}, []) },
  { name: "get_app_state", readOnly: true,
    description: "Return a screenshot plus the full numbered accessibility tree of an app's key window, starting an app session if needed. No need to open apps first: a non-running app is launched in the background. Call it before acting on an app and whenever indices may be stale or an action did not behave as expected. Prefer the accessibility text; use the screenshot when the tree is incomplete. The engine waits for the UI to settle before capturing, so do not sleep first.",
    inputSchema: obj({ app: APP }, ["app"]) },
  { name: "click",
    description: "Click an element by element_index (preferred), or by x/y in the latest screenshot's pixel coordinates when accessibility actions fail. Can hold modifier keys (shift-click, ⌘-click) and hold the mouse button down (long press). Does not move the user's cursor or bring the app to the front." + AFTER,
    inputSchema: action({ app: APP, element_index: INDEX, x: { type: "number", description: "X in screenshot pixels" }, y: { type: "number", description: "Y in screenshot pixels" },
      click_count: { type: "integer", description: "Number of clicks. Defaults to 1" }, mouse_button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left" },
      modifiers: { type: "string", description: `Modifier chord held across the whole click, joined with +, e.g. "shift", "super", "super+shift", "cmd+alt". ${CHORD}` },
      hold_ms: HOLD("each mouse-down") }, ["app"]) },
  { name: "type_text",
    description: "Type literal text into the app's focused element (focus it first, e.g. with click). Reaches only the target app, so it cannot trigger global shortcuts. Single-line printable ASCII is typed as keystrokes. Text containing a newline, carriage return or tab, or any non-ASCII character (accents, CJK, emoji), is inserted with one paste instead, so newlines never become Return key presses (which could submit a form or send a message). The engine restores the clipboard. To press Return or Tab as keys, use press_key." + AFTER,
    inputSchema: action({ app: APP, text: { type: "string", description: "Literal text to type" } }, ["app", "text"]) },
  { name: "paste",
    description: "Paste content into the app's focused element in one step, as plain text, or as rich text rendered from Markdown or HTML (headings, bold, links, lists) for apps that accept rich text. The engine restores the user's clipboard afterwards. On macOS the paste goes to the current focus: click or select the target first (there is no element_index)." + AFTER,
    inputSchema: action({ app: APP, text: { type: "string", description: "Content to paste" },
      format: { type: "string", enum: ["text", "md", "html"], description: "text (default), md (Markdown) or html" } }, ["app", "text"]) },
  { name: "press_key",
    description: `Press a key or key combination, e.g. "Return", "Tab", "Escape", "super+c", "cmd+shift+z", "super+Down", "Up", "KP_0" (numpad 0). ${CHORD}. A chord needs at least one non-modifier key. Sent to the target app only, so global (system-wide) shortcuts do not work.` + AFTER,
    inputSchema: action({ app: APP, key: { type: "string", description: "Key or key combination" }, hold_ms: HOLD("the key") }, ["app", "key"]) },
  { name: "scroll",
    description: "Scroll an element (by element_index, preferred) or a point (x/y in screenshot pixels) in a direction by a number of pages." + AFTER,
    inputSchema: action({ app: APP, element_index: INDEX, x: { type: "number" }, y: { type: "number" },
      direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", description: "Fractional pages allowed. Defaults to 1" } }, ["app", "direction"]) },
  { name: "drag",
    description: "Drag from one point to another in the latest screenshot's pixel coordinates." + AFTER,
    inputSchema: action({ app: APP, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, ["app", "from_x", "from_y", "to_x", "to_y"]) },
  { name: "set_value",
    description: "Set the value of a settable accessibility element (text fields, sliders, checkboxes), replacing the whole value." + AFTER,
    inputSchema: action({ app: APP, element_index: INDEX, value: { type: "string" } }, ["app", "element_index", "value"]) },
  { name: "select_text",
    description: "Select matching text inside an editable text element, or place the cursor before/after it. Give the text exactly as shown in the accessibility tree; use prefix/suffix to disambiguate repeated matches." + AFTER,
    inputSchema: action({ app: APP, element_index: INDEX, text: { type: "string" }, prefix: { type: "string" }, suffix: { type: "string" },
      selection: { type: "string", enum: ["text", "cursor_before", "cursor_after"], description: "Defaults to text" } }, ["app", "element_index", "text"]) },
  { name: "perform_secondary_action",
    description: "Invoke an accessibility action an element exposes besides a normal click (e.g. expand a disclosure row, show a menu, increment a control, cancel). Use only an action name listed for that element in the accessibility tree; do not guess names." + AFTER,
    inputSchema: action({ app: APP, element_index: INDEX, action: { type: "string" } }, ["app", "element_index", "action"]) },
  { name: "start_audio_recording", audio: true,
    description: "Start recording the computer's audio output (system loopback, not the microphone) while other actions continue, e.g. to capture a video's or call's sound. Recording stops by itself after max_duration_ms. Call stop_audio_recording to get the WAV.",
    inputSchema: obj({ max_duration_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Stop automatically after this many milliseconds. Defaults to 60000 (max 300000)" } }, []) },
  { name: "stop_audio_recording", audio: true,
    description: "Stop the active computer audio recording and return the path of the saved 24 kHz stereo WAV file, with its duration and size. With include_audio, the WAV is also returned as MCP audio content (up to 10 MB).",
    inputSchema: obj({ include_audio: { type: "boolean", description: "Also return the recording as MCP audio content. Defaults to false" } }, []) },
];

// The user never wants Google Chrome opened or driven, in any form.
export const BLOCKED_APP = /chrome/i;

export const TOOL_NAMES =new Set(TOOLS.map((t) => t.name));
export const isReadOnly = (name) => !!TOOLS.find((t) => t.name === name)?.readOnly;
export const publicTools = () => TOOLS.map(({ readOnly, audio, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly, openWorldHint: false } }));

// Validates args; returns an error string or null.
export function validate(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `unknown tool: ${name}`;
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const { properties, required } = tool.inputSchema;
  for (const k of required) if (args[k] == null || args[k] === "") return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    if (!p) return `unknown argument: ${k}`;
    if (p.type === "integer" && !Number.isInteger(Number(v))) return `${k} must be an integer`;
    if (p.type === "number" && !Number.isFinite(Number(v))) return `${k} must be a number`;
    if (p.type === "string" && typeof v !== "string") return `${k} must be a string`;
    if (p.type === "boolean" && typeof v !== "boolean") return `${k} must be true or false`;
    if ((p.minimum != null && Number(v) < p.minimum) || (p.maximum != null && Number(v) > p.maximum)) return `${k} must be from ${p.minimum} to ${p.maximum}`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(", ")}`;
  }
  if (args.app != null && BLOCKED_APP.test(args.app)) return `refusing to use ${args.app}: Google Chrome is blocked by the user`;
  if (name === "click" && args.modifiers === "") return "modifiers must not be empty";
  if (name === "click" && args.element_index == null && (args.x == null || args.y == null)) return "click needs element_index or both x and y";
  if (name === "scroll" && args.element_index == null && (args.x == null || args.y == null)) return "scroll needs element_index or both x and y";
  return null;
}

// Shared REPL helpers, defined idempotently in every cell (survives REPL resets).
const PRELUDE = `
globalThis.__cb ??= {
  apps: new Map(),
  async app(name, fresh) {
    let a = fresh ? null : this.apps.get(name);
    if (!a) { a = await cua.getApp(name); this.apps.set(name, a); }
    return a;
  },
};`;

// The engine's key names are case-sensitive and know only some modifier
// spellings (live: "control", "option", "Cmd" are keyNotFound). Map the common
// ones to names it accepts; every other token is passed through untouched.
const MODIFIERS = { super: "super", cmd: "super", command: "super", "⌘": "super", ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
  alt: "alt", option: "alt", opt: "alt", "⌥": "alt", shift: "shift", "⇧": "shift" };
export function normalizeChord(chord) {
  const keys = String(chord).split("+").map((k) => k.trim());
  if (keys.some((k) => !k)) return chord; // e.g. "+" or "super++": leave for the engine to judge
  return keys.map((k) => (Object.hasOwn(MODIFIERS, k.toLowerCase()) ? MODIFIERS[k.toLowerCase()] : k)).join("+");
}

// Typed as keystrokes only when it is one line of printable ASCII; anything
// else is pasted, so "\n" can never turn into a Return press.
export const TYPEABLE = /^[\x20-\x7e]*$/;
const WAV_INLINE_MAX = 10 * 1024 * 1024;

// Output before MARK (e.g. state auto-emitted by cua.getApp) is discarded.
export function buildCell(name, args, mark) {
  args = { ...args };
  if (args.key != null) args.key = normalizeChord(args.key);
  if (args.modifiers != null) args.modifiers = normalizeChord(args.modifiers);
  const A = JSON.stringify(args);
  const M = JSON.stringify(mark);
  const n = (k) => `Number(A.${k})`;
  const target = `(A.element_index != null ? ${n("element_index")} : [${n("x")}, ${n("y")}])`;
  const hold = `...(A.hold_ms != null ? { durationMs: ${n("hold_ms")} } : {})`;
  const action = {
    click: `await a.click(${target}, { mouseButton: A.mouse_button ?? "left", clickCount: A.click_count != null ? ${n("click_count")} : 1, ...(A.modifiers != null ? { key: A.modifiers } : {}), ${hold} });`,
    type_text: `if (${TYPEABLE}.test(A.text)) await a.typeText(A.text); else await a.paste(A.text);`,
    paste: `await a.paste(A.text, { format: A.format ?? "text" });`,
    press_key: `if (A.hold_ms != null) await a.pressKey(A.key, { ${hold} }); else await a.pressKey(A.key);`,
    scroll: `await a.scroll(${target}, A.direction, A.pages != null ? Number(A.pages) : 1);`,
    drag: `await a.drag([${n("from_x")}, ${n("from_y")}], [${n("to_x")}, ${n("to_y")}]);`,
    set_value: `await a.setValue(${n("element_index")}, A.value);`,
    select_text: `await a.selectText(${n("element_index")}, A.text, { prefix: A.prefix, suffix: A.suffix, selectionType: A.selection ?? "text" });`,
    perform_secondary_action: `await a.performSecondaryAction(${n("element_index")}, A.action);`,
  };
  const head = `const A = ${A};${PRELUDE}\n`;
  if (name === "list_apps")
    return head + `const apps = await cua.listApps({ emit: false });
nodeRepl.write(${M} + apps.map((x) => [x.displayName ?? x.id, "—", x.id, x.isRunning ? "[running]" : "",
  x.windows?.length ? "windows: " + x.windows.map((w) => JSON.stringify(w.title ?? "")).join(", ") : ""].filter(Boolean).join(" ")).join("\\n"));`;
  if (name === "get_app_state")
    return head + `let a = await __cb.app(A.app), r;
try { r = await a.getAXStateAndScreenshot({ emit: false, disableDiffing: true }); }
catch { a = await __cb.app(A.app, true); r = await a.getAXStateAndScreenshot({ emit: false, disableDiffing: true }); }
nodeRepl.write(${M} + r.state);
if (r.screenshot) await nodeRepl.emitImage(r.screenshot);`;
  const audio = `const C = cua.computer;
if (typeof C?.start_audio_recording !== "function") throw new Error("computer audio recording is not enabled in this engine (it needs SKY_ENABLE_AUDIO=1; the bridge sets it unless OPENAI_CUA_AUDIO=0)");
nodeRepl.write(${M});\n`;
  if (name === "start_audio_recording")
    return head + audio + `const ms = A.max_duration_ms != null ? ${n("max_duration_ms")} : 60000;
await C.start_audio_recording({ max_duration_ms: ms });
nodeRepl.write("Recording computer audio (stops by itself after " + ms + " ms). Call stop_audio_recording to get the WAV.");`;
  if (name === "stop_audio_recording")
    return head + audio + `const au = await C.stop_audio_recording();
const b = au.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
let rate = 0, data = 0; // RIFF chunks: fmt (byte rate) and data (size)
for (let o = 12; o + 8 <= b.length; o += 8 + dv.getUint32(o + 4, true) + (dv.getUint32(o + 4, true) & 1)) {
  const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (id === "fmt ") rate = dv.getUint32(o + 16, true);
  if (id === "data") { data = dv.getUint32(o + 4, true); break; }
}
nodeRepl.write("Saved computer audio: " + au.filepath + "\\n" + (rate ? (data / rate).toFixed(2) + " s, " : "") + b.length + " bytes, WAV (24 kHz stereo)");
if (A.include_audio) {
  if (b.length <= ${WAV_INLINE_MAX}) await nodeRepl.emitAudio(au.data_url);
  else nodeRepl.write("\\n(too large to return inline; read the file instead)");
}`;
  return head + `const a = await __cb.app(A.app);
nodeRepl.write(${M});
${action[name]}
let s, shot;
try {
  if (A.screenshot) ({ state: s, screenshot: shot } = await a.getAXStateAndScreenshot({ emit: false }));
  else s = await a.getAXState({ emit: false });
} catch (e) { s = "(state unavailable: " + e.message + ")"; }
nodeRepl.write("Done. Updated accessibility state:\\n" + s);
if (A.screenshot) { if (shot) await nodeRepl.emitImage(shot); else nodeRepl.write("\\n(screenshot unavailable)"); }`;
}

// Keep only what the cell wrote after MARK.
export function extractOutput(content, mark) {
  const i = content.findIndex((c) => c.type === "text" && c.text?.includes(mark));
  if (i < 0) return null;
  const first = content[i].text.slice(content[i].text.indexOf(mark) + mark.length);
  return [...(first ? [{ type: "text", text: first }] : []), ...content.slice(i + 1)];
}
