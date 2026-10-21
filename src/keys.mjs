// xdotool-style key specs ("super+a", "Return") as CDP key events.

const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, super: 4, cmd: 4, command: 4, meta: 4, shift: 8 };
const NAMED = {
  return: ["Enter", "Enter", 13, "\r"], enter: ["Enter", "Enter", 13, "\r"], kp_enter: ["Enter", "NumpadEnter", 13, "\r"],
  tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32, " "],
  up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40], left: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36], end: ["End", "End", 35], prior: ["PageUp", "PageUp", 33], page_up: ["PageUp", "PageUp", 33],
  next: ["PageDown", "PageDown", 34], page_down: ["PageDown", "PageDown", 34], insert: ["Insert", "Insert", 45],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];
// macOS editing shortcuts are browser commands, not key handlers.
const MAC_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

export function parseKey(spec) {
  const parts = spec.split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`invalid key: ${spec}`);
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}" in ${spec}`);
    modifiers |= bit;
  }
  const k = parts.at(-1);
  let key, code, keyCode, text;
  if (NAMED[k.toLowerCase()]) [key, code, keyCode, text] = NAMED[k.toLowerCase()];
  else if ([...k].length === 1) {
    key = modifiers & 8 && /[a-z]/.test(k) ? k.toUpperCase() : k;
    const up = k.toUpperCase();
    code = /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(k) ? `Digit${k}` : undefined;
    keyCode = /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : undefined;
    text = key;
  } else throw new Error(`unknown key "${k}"`);
  if (modifiers & (1 | 2 | 4)) text = undefined; // chords insert no text
  const command = modifiers === 4 ? MAC_COMMANDS[k.toLowerCase()] : modifiers === 12 && k.toLowerCase() === "z" ? "redo" : undefined;
  return { key, code, keyCode, text, modifiers, command };
}
