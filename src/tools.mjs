// Claude-facing tool schemas and their translation into cua-repl JavaScript.
// Arguments are embedded as JSON literals, never spliced as code.

const APP = { type: "string", description: "App display name, full app path, or bundle identifier (e.g. \"TextEdit\", \"com.apple.TextEdit\"). If a display name fails, retry with the bundle id from list_apps" };
const INDEX = { type: "integer", description: "Element index from the latest accessibility tree (get_app_state or an action's diff). Indices go stale after the UI changes" };
const AFTER = " Returns the accessibility state afterwards, labelled as a full tree, a diff since your last observation of the app (\"-\" removed, \"+\" added or changed; elements not shown are unchanged and keep their indices) or no change; pass screenshot (or call get_app_state) to see the result.";
const MODES = ["auto", "full", "text", "diff", "screenshot"];
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
    description: "Observe an app's key window, starting an app session if needed. No need to open apps first: a non-running app is launched in the background. mode \"auto\" (default): the first observation of an app in this session returns a screenshot plus the full numbered accessibility tree; later ones return only what changed since your last observation of that app (a diff; unchanged elements keep their indices). Other modes: \"full\" (full tree + screenshot), \"text\" (full tree, no screenshot), \"diff\" (changes only), \"screenshot\" (image only; the next tree is sent in full before you rely on indices again). Use \"full\" or \"screenshot\" when you need to see the window, e.g. for x/y coordinates or when the tree is incomplete. Call it before acting on an app and whenever an action did not behave as expected. The engine waits for the UI to settle before capturing, so do not sleep first.",
    inputSchema: obj({ app: APP, mode: { type: "string", enum: MODES, description: "Observation mode. Defaults to auto" } }, ["app"]) },
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
  { name: "stop_app", control: true,
    description: "Stop using an app, like the menu-bar \"Stop\" in ChatGPT: ends its computer-use session and releases it. Without app, stops every app used in this session. Call it when you are done with an app or the user asks you to stop.",
    inputSchema: obj({ app: APP }, []) },
  { name: "start_audio_recording", audio: true,
    description: "Start recording the computer's audio output (system loopback, not the microphone) while other actions continue, e.g. to capture a video's or call's sound. Recording stops by itself after max_duration_ms. Call stop_audio_recording to get the WAV.",
    inputSchema: obj({ max_duration_ms: { type: "integer", minimum: 100, maximum: 300000, description: "Stop automatically after this many milliseconds. Defaults to 60000 (max 300000)" } }, []) },
  { name: "stop_audio_recording", audio: true,
    description: "Stop the active computer audio recording and return the path of the saved 24 kHz stereo WAV file, with its duration and size. With include_audio, the WAV is also returned as MCP audio content (up to 10 MB).",
    inputSchema: obj({ include_audio: { type: "boolean", description: "Also return the recording as MCP audio content. Defaults to false" } }, []) },
];

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
const prep = (args) => ({ ...args, ...(args.key != null ? { key: normalizeChord(args.key) } : {}), ...(args.modifiers != null ? { modifiers: normalizeChord(args.modifiers) } : {}) });

// Typed as keystrokes only when it is one line of printable ASCII; anything
// else is pasted, so "\n" can never turn into a Return press.
export const TYPEABLE = /^[\x20-\x7e]*$/;
const WAV_INLINE_MAX = 10 * 1024 * 1024;

// Action tools as cua-repl JavaScript over `A` (the arguments) and `a` (the bound app).
const n = (k) => `Number(A.${k})`;
const target = `(A.element_index != null ? ${n("element_index")} : [${n("x")}, ${n("y")}])`;
const hold = `...(A.hold_ms != null ? { durationMs: ${n("hold_ms")} } : {})`;
const ACTIONS = {
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
export const BATCHABLE = TOOLS.filter((t) => ACTIONS[t.name]).map((t) => t.name);
// Keyboard actions do not depend on element indices, so they survive a
// refresh-and-retry after the user changed the app.
const KEYBOARD = new Set(["press_key", "type_text", "paste"]);
const TAKEOVER = `/The user changed '|still interacting with|-10016|userIntervened/i`;
// Tools that drive app UI (for the focus guard), and the apps they target.
export const isUiAction = (name) => !!ACTIONS[name] || name === "batch";
export const targetApps = (name, args) => name === "batch"
  ? [...new Set(args.steps.map((s) => s?.args?.app ?? args.app).filter(Boolean))] : [args.app].filter(Boolean);
const MAX_STEPS = 50;
const TIMEOUT = { type: "integer", minimum: 1000, maximum: 600000, description: "Timeout in milliseconds (1000-600000). Defaults to the server's call timeout (60000). On timeout the engine and its JavaScript state are discarded" };

TOOLS.push(
  { name: "batch",
    description: `Run several actions in order in one engine call, then read the accessibility state once at the end (per app touched; a diff since your last observation, like get_app_state's auto mode). Use it for deterministic sequences such as click a field, type, press Return. Every step is validated before anything runs. Execution stops at the first failing step, and the result says which step failed and includes the state at that point. Steps: ${BATCHABLE.join(", ")}.`,
    inputSchema: obj({
      app: { ...APP, description: "Default app for steps whose args omit it" },
      steps: { type: "array", minItems: 1, maxItems: MAX_STEPS, description: "Ordered steps",
        items: obj({ tool: { type: "string", enum: BATCHABLE }, args: { type: "object", description: "That tool's arguments (without screenshot)" } }, ["tool"]) },
      screenshot: { ...SHOT, description: "Also return a screenshot of each app touched, taken after the last step. Defaults to false" },
      timeout_ms: TIMEOUT,
    }, ["steps"]) },
  { name: "run_cua_js", js: true,
    description: "Run JavaScript in the computer-use engine's persistent REPL (top-level await; top-level bindings persist across calls until reset_repl or engine restart). The `cua` API is available: e.g. `const app = await cua.getApp(\"TextEdit\")` (displays its tree), `await app.click(12)`, `await app.typeText(\"hi\")`, `await app.getAXState({ disableDiffing: true })` (full tree), `await app.getScreenshot()`, `await cua.listApps()`. Write output with `nodeRepl.write(value)` and images with `await nodeRepl.emitImage(bytes)`. Output is limited to about 25k tokens. Google Chrome is blocked. Use the dedicated tools when they suffice; use this for loops, branching on UI state, or waits.",
    inputSchema: obj({ code: { type: "string", description: "JavaScript to run" }, timeout_ms: TIMEOUT }, ["code"]) },
  { name: "reset_repl", js: true,
    description: "Reset the persistent JavaScript REPL used by run_cua_js: all bindings are discarded. Apps, windows and documents are not changed.",
    inputSchema: obj({}, []) },
);

// The user never wants Google Chrome opened or driven, in any form.
export const BLOCKED_APP = /chrome/i;

export const jsEnabled = () => process.env.OAI_CUA_ENABLE_JS === "1";
const tool = (name) => TOOLS.find((t) => t.name === name && (!t.js || jsEnabled()));
export const TOOL_NAMES = new Set(TOOLS.filter((t) => tool(t.name)).map((t) => t.name));
export const isReadOnly = (name) => !!tool(name)?.readOnly;
export const publicTools = () => TOOLS.filter((t) => tool(t.name)).map(({ readOnly, audio, js, control, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly, openWorldHint: !!js } }));

// Validates args; returns an error string or null.
export function validate(name, args) {
  const t = tool(name);
  if (!t) return TOOLS.some((x) => x.name === name)
    ? `${name} is disabled. It runs arbitrary JavaScript, so it must be enabled explicitly: set OAI_CUA_ENABLE_JS=1 in the server's env (node install.mjs --enable-js) and reconnect.`
    : `unknown tool: ${name}`;
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const { properties, required } = t.inputSchema;
  for (const k of required) if (args[k] == null || args[k] === "") return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    if (!p) return `unknown argument: ${k}`;
    if (p.type === "integer" && !Number.isInteger(Number(v))) return `${k} must be an integer`;
    if (p.type === "number" && !Number.isFinite(Number(v))) return `${k} must be a number`;
    if (p.type === "string" && typeof v !== "string") return `${k} must be a string`;
    if (p.type === "boolean" && typeof v !== "boolean") return `${k} must be true or false`;
    if (p.type === "array" && !Array.isArray(v)) return `${k} must be an array`;
    if ((p.minimum != null && Number(v) < p.minimum) || (p.maximum != null && Number(v) > p.maximum)) return `${k} must be from ${p.minimum} to ${p.maximum}`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(", ")}`;
  }
  if (args.app != null && BLOCKED_APP.test(args.app)) return `refusing to use ${args.app}: Google Chrome is blocked by the user`;
  if (name === "click" && args.modifiers === "") return "modifiers must not be empty";
  if (name === "click" && args.element_index == null && (args.x == null || args.y == null)) return "click needs element_index or both x and y";
  if (name === "scroll" && args.element_index == null && (args.x == null || args.y == null)) return "scroll needs element_index or both x and y";
  // Defense in depth only: the engine runs with no browser surface or Chrome
  // backend, and app-access approval for Chrome is declined outside the REPL.
  if (name === "run_cua_js" && BLOCKED_APP.test(args.code)) return "refusing to run a script that mentions Chrome: Google Chrome is blocked by the user";
  if (name === "batch") {
    const steps = batchSteps(args);
    if (typeof steps === "string") return steps;
  }
  return null;
}

// Normalized batch steps ({ tool, args } with the default app applied), or an error string.
export function batchSteps({ app, steps }) {
  if (steps.length < 1 || steps.length > MAX_STEPS) return `steps must have 1-${MAX_STEPS} entries`;
  const out = [];
  for (const [i, s] of steps.entries()) {
    const where = `step ${i + 1}${s?.tool ? ` (${s.tool})` : ""}`;
    if (s == null || typeof s !== "object" || Array.isArray(s)) return `${where}: must be an object with tool and args`;
    for (const k of Object.keys(s)) if (k !== "tool" && k !== "args") return `${where}: unknown key: ${k}`;
    if (!BATCHABLE.includes(s.tool)) return `${where}: tool must be one of ${BATCHABLE.join(", ")}`;
    if (s.args != null && (typeof s.args !== "object" || Array.isArray(s.args))) return `${where}: args must be an object`;
    if (s.args?.screenshot != null) return `${where}: screenshot is a batch option, not a step argument`;
    const a = { ...s.args };
    if (a.app == null && app != null) a.app = app;
    const bad = validate(s.tool, a);
    if (bad) return `${where}: ${bad}`;
    out.push({ tool: s.tool, args: prep(a) });
  }
  return out;
}

// Shared REPL helper, defined idempotently in every cell (survives REPL
// resets). It only touches globalThis, so no bindings leak into run_cua_js.
// There is deliberately no Chrome guard inside the REPL: the engine freezes
// cua.computer behind a Proxy on first use, so patching its methods breaks the
// API (see VERIFICATION.md). Chrome is refused by validate() and, by resolved
// bundle id, at app-access approval, which the bridge answers outside the REPL.
// A display name the engine cannot resolve is retried once by the bundle id
// that list_apps reports for it.
const PRELUDE = `
globalThis.__cb ??= {
  apps: new Map(),
  ids: new Map(), // name → bundle id, when the name needed a lookup
  async app(name, fresh) {
    let a = fresh ? null : this.apps.get(name);
    if (!a) {
      try { a = await cua.getApp(name); }
      catch (e) {
        const id = /invalid app|not found|ambiguous|-10010|-10018/i.test(e.message) ? await this.lookup(name) : null;
        if (!id) throw e;
        a = await cua.getApp(id);
        this.ids.set(name, id);
      }
      this.apps.set(name, a);
    }
    return a;
  },
  async lookup(name) {
    const norm = (s) => String(s ?? "").toLowerCase().trim().replace(/\\.app$/, "").replace(/\\s*\\([^)]*\\)$/, "").replace(/\\s+/g, "");
    const apps = await cua.listApps({ emit: false });
    let hits = apps.filter((x) => norm(x.displayName) === norm(name));
    if (hits.length > 1) hits = hits.filter((x) => x.isRunning);
    return hits.length === 1 && hits[0].id !== name ? hits[0].id : null;
  },
};`;
// Bridge captures are always full trees: the engine's own diff baseline is
// shared by every session, so the bridge diffs per session (observe.mjs).
const tree = (a) => `await ${a}.getAXState({ emit: false, disableDiffing: true })`;
const treeShot = (a) => `(({ state, screenshot }) => ({ tree: state, shot: screenshot }))(await ${a}.getAXStateAndScreenshot({ emit: false, disableDiffing: true }))`;

// Builds the cell for a tool call. Everything a cell writes before MARK (e.g.
// state auto-emitted by cua.getApp) is discarded. Observation and action cells
// write MARK + one JSON payload, then any images. Bridge cells run inside a
// block so their bindings stay out of the REPL's top level.
//   get_app_state: opts.capture is "tree" | "tree+shot" | "shot"
//   batch: opts.steps from batchSteps()
export function buildCell(name, args, mark, opts = {}) {
  const M = JSON.stringify(mark);
  if (name === "run_cua_js") return `{${PRELUDE}\n}\nnodeRepl.write(${M});\n${args.code}`;
  const head = `{\nconst A = ${JSON.stringify(prep(args))};${PRELUDE}\n`;
  if (name === "list_apps")
    return head + `const apps = await cua.listApps({ emit: false });
nodeRepl.write(${M} + apps.map((x) => [x.displayName ?? x.id, "—", x.id, x.isRunning ? "[running]" : "",
  x.windows?.length ? "windows: " + x.windows.map((w) => JSON.stringify(w.title ?? "")).join(", ") : ""].filter(Boolean).join(" ")).join("\\n"));
}`;
  if (name === "get_app_state")
    return head + `const C = ${JSON.stringify(opts.capture ?? "tree+shot")};
const obs = async (a) => C === "shot" ? { shot: await a.getScreenshot({ emit: false }) } : C === "tree" ? { tree: ${tree("a")} } : ${treeShot("a")};
let a = await __cb.app(A.app), r;
try { r = await obs(a); } catch { a = await __cb.app(A.app, true); r = await obs(a); }
nodeRepl.write(${M} + JSON.stringify({ tree: r.tree ?? null, shot: !!r.shot }));
if (r.shot) await nodeRepl.emitImage(r.shot);
}`;
  const audio = `const C = cua.computer;
if (typeof C?.start_audio_recording !== "function") throw new Error("computer audio recording is not enabled in this engine (it needs SKY_ENABLE_AUDIO=1; the bridge sets it unless OAI_CUA_AUDIO=0)");
nodeRepl.write(${M});\n`;
  if (name === "start_audio_recording")
    return head + audio + `const ms = A.max_duration_ms != null ? ${n("max_duration_ms")} : 60000;
await C.start_audio_recording({ max_duration_ms: ms });
nodeRepl.write("Recording computer audio (stops by itself after " + ms + " ms). Call stop_audio_recording to get the WAV.");
}`;
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
}
}`;
  // After the action(s): one full capture per app, as JSON { app, tree, shot, error }.
  const after = `const after = async (app) => {
  let tree = null, shot = null, error = null;
  try {
    const a = await __cb.app(app);
    if (A.screenshot) ({ tree, shot } = ${treeShot("a")}); else tree = ${tree("a")};
  } catch (e) { error = String(e?.message ?? e); }
  return { app, tree, shot, error };
};
const emit = async (states) => {
  nodeRepl.write(${M} + JSON.stringify({ ran, fail, note, states: states.map(({ shot, ...s }) => ({ ...s, shot: !!shot })) }));
  for (const s of states) if (s.shot) await nodeRepl.emitImage(s.shot);
};\n`;
  if (name === "batch")
    return `{\nconst A = ${JSON.stringify({ screenshot: !!args.screenshot })};
const STEPS = ${JSON.stringify(opts.steps)};${PRELUDE}
let ran = 0, fail = null, note = null;
const touched = [];
for (let i = 0; i < STEPS.length; i++) {
  const { tool, args: A } = STEPS[i];
  try {
    const a = await __cb.app(A.app);
    if (!touched.includes(A.app)) touched.push(A.app);
    switch (tool) {
${[...new Set(opts.steps.map((s) => s.tool))].map((t) => `      case ${JSON.stringify(t)}: { ${ACTIONS[t]} break; }`).join("\n")}
    }
    ran++;
  } catch (e) { fail = { step: i + 1, tool, error: String(e?.message ?? e) }; break; }
}
${after}const states = [];
for (const app of touched) states.push(await after(app));
await emit(states);
}`;
  if (name === "stop_app")
    return head + `const targets = A.app != null ? [A.app] : [...__cb.apps.keys()];
const lines = [];
for (const t of targets) {
  try {
    const stop = (app) => nodeRepl.rpc("cuabridge", { type: "stopApp", app });
    let r;
    try { r = await stop(__cb.ids?.get(t) ?? t); }
    catch (e) { const id = /invalid app|not found|ambiguous/i.test(e.message) ? await __cb.lookup(t) : null; if (!id) throw e; r = await stop(id); }
    lines.push("Stopped " + (r.displayName ?? t) + (r.bundleIdentifier ? " (" + r.bundleIdentifier + ")" : "") + ".");
  } catch (e) { lines.push("Could not stop " + t + ": " + e.message); }
  __cb.apps.delete(t);
}
nodeRepl.write(${M} + (lines.join("\\n") || "No app sessions to stop."));
}`;
  // If the user changed the app under the action: keyboard actions refresh the
  // state and retry once; others report it (fail) along with the fresh state.
  return head + `const a = await __cb.app(A.app);
let ran = 0, fail = null, note = null;
const act = async () => { ${ACTIONS[name]} };
try { await act(); ran = 1; }
catch (e) {
  const msg = String(e?.message ?? e);
  if (!${TAKEOVER}.test(msg)) throw e;
  if (${KEYBOARD.has(name)} && !/still interacting with/i.test(msg)) {
    try { await a.getAXState({ emit: false, disableDiffing: true }); } catch {}
    await act();
    ran = 1;
    note = "The user changed the app during this action; its state was refreshed and the action retried once.";
  } else fail = { step: 1, tool: ${JSON.stringify(name)}, error: msg };
}
${after}await emit([await after(A.app)]);
}`;
}

// Keep only what the cell wrote after MARK.
export function extractOutput(content, mark) {
  const i = content.findIndex((c) => c.type === "text" && c.text?.includes(mark));
  if (i < 0) return null;
  const first = content[i].text.slice(content[i].text.indexOf(mark) + mark.length);
  return [...(first ? [{ type: "text", text: first }] : []), ...content.slice(i + 1)];
}
