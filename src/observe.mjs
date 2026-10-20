// Observation rendering: per-session accessibility diffs and output limits.
// The engine can diff trees itself, but its baseline is shared by every
// session using the service (one session's observation silently becomes
// another's "no change"; see VERIFICATION.md). So the bridge always captures
// the full tree and diffs it against the last tree *this* session returned.

const MAX_TEXT = 100_000; // ≈25k tokens at 4 chars/token, like Codex's tool output cap
const MAX_IMAGES = 8;
const MAX_LCS = 4_000_000; // cells; larger middles count as fully replaced

const indent = (l) => l.match(/^\t*/)[0].length;

// Line ops between two texts: [" ", line] | ["-", line] | ["+", line].
export function diffLines(a, b) {
  let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const x = a.slice(p, a.length - s), y = b.slice(p, b.length - s);
  const mid = [];
  if (x.length * y.length > MAX_LCS) {
    for (const l of x) mid.push(["-", l]);
    for (const l of y) mid.push(["+", l]);
  } else {
    // LCS table, filled from the end so the walk below goes forwards.
    const w = y.length + 1, t = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { mid.push([" ", x[i]]); i++; j++; }
      else if (i < x.length && (j === y.length || t[(i + 1) * w + j] >= t[i * w + j + 1])) mid.push(["-", x[i++]]);
      else mid.push(["+", y[j++]]);
    }
  }
  return [...a.slice(0, p).map((l) => [" ", l]), ...mid, ...b.slice(b.length - s).map((l) => [" ", l])];
}

// Split a tree into entries: an element line plus any continuation lines of a
// multi-line value, so a changed value is shown with the element it belongs to.
const ENTRY = /^(\t*\d+ |Window: |The focused UI element )/;
export function entries(tree) {
  const out = [];
  for (const l of tree.split("\n")) if (!out.length || ENTRY.test(l)) out.push(l); else out[out.length - 1] += "\n" + l;
  return out;
}

// A compact diff of two accessibility trees, or null when a full tree is the
// better answer (different window, or the diff is not much smaller).
const key = (e) => e.match(/^\t*(\d+) |^(Window: |The focused UI element )/)?.[0] ?? e;
const mark = (o, e) => e.split("\n").map((l) => `${o} ${l}`).join("\n");

// One element whose entry changed: its first line, then only the changed
// lines of a multi-line value ("  …" stands for unchanged value lines).
function changed(a, b) {
  const [ha, ...ra] = a.split("\n"), [hb, ...rb] = b.split("\n");
  if (!ra.length && !rb.length) return `- ${ha}\n+ ${hb}`;
  const out = [ha === hb ? `  ${hb}` : `- ${ha}\n+ ${hb}`];
  for (const [o, l] of diffLines(ra, rb)) {
    if (o !== " ") out.push(`${o} ${l}`);
    else if (out.at(-1) !== "  …") out.push("  …");
  }
  return out.join("\n");
}

export function diffTree(prev, next) {
  const a = entries(prev), b = entries(next);
  const win = (es) => es.find((e) => e.startsWith("Window: "));
  if (win(a) !== win(b)) return null;
  const ops = diffLines(a, b);
  if (!ops.some(([o]) => o !== " ")) return "";
  // Print each run of changes under its unchanged ancestors (taken from the new tree).
  const out = [], shown = new Set();
  let j = 0; // position in b
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === " ") { j++; k++; continue; }
    let end = k;
    while (end < ops.length && ops[end][0] !== " ") end++;
    const depth = Math.min(...ops.slice(k, end).map(([, e]) => indent(e)));
    const ctx = [];
    for (let i = j - 1, d = depth; i >= 0 && d > 0; i--)
      if (b[i].trim() && indent(b[i]) < d) { d = indent(b[i]); if (!shown.has(i)) { shown.add(i); ctx.unshift(mark(" ", b[i].split("\n")[0])); } }
    if (!out.length && b[0]?.startsWith("Window: ") && !shown.has(0)) { shown.add(0); ctx.unshift(mark(" ", b[0])); }
    out.push(...ctx);
    const del = ops.slice(k, end).filter(([o]) => o === "-").map(([, e]) => e);
    const add = ops.slice(k, end).filter(([o]) => o === "+").map(([, e]) => e);
    if (del.length === add.length && del.every((e, i) => key(e) === key(add[i]))) out.push(...del.map((e, i) => changed(e, add[i])));
    else for (let i = k; i < end; i++) out.push(mark(ops[i][0], ops[i][1]));
    for (const _ of add) shown.add(j++);
    k = end;
  }
  const d = out.join("\n");
  return d.length > next.length * 0.6 ? null : d;
}

// What this session has last seen of each app's accessibility tree.
export class Observations {
  constructor() { this.seen = new Map(); }
  has(app) { return this.seen.has(app); }
  forget(app) { if (app == null) this.seen.clear(); else this.seen.delete(app); }
  // Label and return a fresh full tree, as a diff when allowed and smaller.
  render(app, tree, { full = false } = {}) {
    const prev = this.seen.get(app);
    this.seen.set(app, tree);
    if (!full && prev != null) {
      const d = diffTree(prev, tree);
      if (d === "") return `No change in the accessibility tree since your last observation of ${app}; all element indices are still valid.`;
      if (d != null)
        return `Accessibility diff since your last observation of ${app} ("-" removed, "+" added or changed, indented lines are unchanged context). Elements not shown are unchanged and keep their indices:\n${d}`;
    }
    return `Full accessibility tree of ${app}:\n${tree}`;
  }
}

// Cap text (keeping head and tail) and image count, like Codex's output limit.
export function limitOutput(content, maxText = MAX_TEXT, maxImages = MAX_IMAGES) {
  let budget = maxText, images = 0, droppedImages = 0, droppedText = 0, tailText = "";
  const out = [];
  for (const c of content) {
    if (c.type === "image") { if (images++ < maxImages) out.push(c); else droppedImages++; continue; }
    if (c.type !== "text") { out.push(c); continue; }
    const t = String(c.text ?? "");
    if (t.length <= budget) { budget -= t.length; out.push(c); continue; }
    if (budget === 0) { droppedText += t.length; continue; }
    const head = Math.floor(budget * 0.8), tail = budget - head;
    out.push({ type: "text", text: t.slice(0, head) });
    tailText = tail ? t.slice(-tail) : "";
    droppedText += t.length - head - tail;
    budget = 0;
  }
  if (droppedText) out.push({ type: "text", text: `…[${droppedText} characters truncated: tool output is limited to about 25k tokens]…${tailText ? "\n" + tailText : ""}` });
  if (droppedImages) out.push({ type: "text", text: `[${droppedImages} more image(s) dropped: at most ${maxImages} images per call]` });
  return out;
}
