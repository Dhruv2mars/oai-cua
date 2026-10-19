// Claude-facing tool schemas and their translation into cua-repl JavaScript.
// Arguments are embedded as JSON literals, never spliced as code.

const APP = { type: "string", description: "App name, full app path, or unambiguous bundle identifier" };
const INDEX = { type: "integer", description: "Element index from the accessibility tree returned by get_app_state" };
const obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = [
  { name: "list_apps", readOnly: true,
    description: "List the apps on this Mac: currently running apps plus apps used in the last 14 days, with window titles.",
    inputSchema: obj({}, []) },
  { name: "get_app_state", readOnly: true,
    description: "Start an app use session if needed (launching the app in the background if it is not running), then return a screenshot and numbered accessibility tree of the app's key window. Call this before interacting with an app and whenever you need fresh element indices.",
    inputSchema: obj({ app: APP }, ["app"]) },
  { name: "click",
    description: "Click an element by index, or by x/y in screenshot pixel coordinates. Does not move the user's cursor or bring the app to the front.",
    inputSchema: obj({ app: APP, element_index: INDEX, x: { type: "number", description: "X in screenshot pixels" }, y: { type: "number", description: "Y in screenshot pixels" },
      click_count: { type: "integer", description: "Number of clicks. Defaults to 1" }, mouse_button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left" } }, ["app"]) },
  { name: "type_text",
    description: "Type literal text into the app's focused element. Non-ASCII text (accents, CJK, emoji) is inserted via paste; the clipboard is restored by the engine.",
    inputSchema: obj({ app: APP, text: { type: "string", description: "Literal text to type" } }, ["app", "text"]) },
  { name: "press_key",
    description: "Press a key or key combination in xdotool syntax, e.g. \"Return\", \"Tab\", \"Escape\", \"super+c\", \"super+Down\", \"Up\".",
    inputSchema: obj({ app: APP, key: { type: "string", description: "Key or key combination" } }, ["app", "key"]) },
  { name: "scroll",
    description: "Scroll an element (by index) or a point (x/y) in a direction by a number of pages.",
    inputSchema: obj({ app: APP, element_index: INDEX, x: { type: "number" }, y: { type: "number" },
      direction: { type: "string", enum: ["up", "down", "left", "right"] }, pages: { type: "number", description: "Fractional pages allowed. Defaults to 1" } }, ["app", "direction"]) },
  { name: "drag",
    description: "Drag from one point to another in screenshot pixel coordinates.",
    inputSchema: obj({ app: APP, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, ["app", "from_x", "from_y", "to_x", "to_y"]) },
  { name: "set_value",
    description: "Set the value of a settable accessibility element (text fields, sliders, checkboxes). Replaces the whole value.",
    inputSchema: obj({ app: APP, element_index: INDEX, value: { type: "string" } }, ["app", "element_index", "value"]) },
  { name: "select_text",
    description: "Select text inside a text element, or place the cursor before/after it. Give the text exactly as shown in the accessibility tree; use prefix/suffix to disambiguate repeats.",
    inputSchema: obj({ app: APP, element_index: INDEX, text: { type: "string" }, prefix: { type: "string" }, suffix: { type: "string" },
      selection: { type: "string", enum: ["text", "cursor_before", "cursor_after"], description: "Defaults to text" } }, ["app", "element_index", "text"]) },
  { name: "perform_secondary_action",
    description: "Invoke a secondary accessibility action listed for an element (e.g. Raise, Expand, Scroll Down).",
    inputSchema: obj({ app: APP, element_index: INDEX, action: { type: "string" } }, ["app", "element_index", "action"]) },
];

// The user never wants Google Chrome opened or driven, in any form.
export const BLOCKED_APP = /chrome/i;

export const TOOL_NAMES =new Set(TOOLS.map((t) => t.name));
export const isReadOnly = (name) => !!TOOLS.find((t) => t.name === name)?.readOnly;
export const publicTools = () => TOOLS.map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly, openWorldHint: false } }));

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
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(", ")}`;
  }
  if (args.app != null && BLOCKED_APP.test(args.app)) return `refusing to use ${args.app}: Google Chrome is blocked by the user`;
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

// Output before MARK (e.g. state auto-emitted by cua.getApp) is discarded.
export function buildCell(name, args, mark) {
  const A = JSON.stringify(args);
  const M = JSON.stringify(mark);
  const n = (k) => `Number(A.${k})`;
  const target = `(A.element_index != null ? ${n("element_index")} : [${n("x")}, ${n("y")}])`;
  const action = {
    click: `await a.click(${target}, { mouseButton: A.mouse_button ?? "left", clickCount: A.click_count != null ? ${n("click_count")} : 1 });`,
    type_text: `if (/^[\\x20-\\x7e\\t\\n]*$/.test(A.text)) await a.typeText(A.text); else await a.paste(A.text);`,
    press_key: `await a.pressKey(A.key);`,
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
  return head + `const a = await __cb.app(A.app);
nodeRepl.write(${M});
${action[name]}
let s; try { s = await a.getAXState({ emit: false }); } catch (e) { s = "(state unavailable: " + e.message + ")"; }
nodeRepl.write("Done. Updated accessibility state:\\n" + s);`;
}

// Keep only what the cell wrote after MARK.
export function extractOutput(content, mark) {
  const i = content.findIndex((c) => c.type === "text" && c.text?.includes(mark));
  if (i < 0) return null;
  const first = content[i].text.slice(content[i].text.indexOf(mark) + mark.length);
  return [...(first ? [{ type: "text", text: first }] : []), ...content.slice(i + 1)];
}
