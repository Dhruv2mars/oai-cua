// Accessibility snapshots of a page: CDP AX nodes as an indented outline
// with element refs, and the line changes between two snapshots.

const SKIP = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
const TRANSPARENT = new Set(["generic", "none", "presentation", "LabelText", "strong", "emphasis", "Section", "MenuListPopup", "paragraph", "group", "code", "mark", "time", "superscript", "subscript", "Abbr", "Ruby", "insertion", "deletion"]);
const PROPS = ["checked", "selected", "expanded", "pressed", "disabled", "required", "readonly", "invalid", "level", "focused", "modal"];
export const quote = (s, n = 200) => JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s);

export function formatAXTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const lines = [];
  const walk = (n, depth, parentName) => {
    if (!n) return;
    const role = n.role?.value ?? "";
    const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
    const kids = (next, pn) => { for (const c of n.childIds ?? []) walk(byId.get(c), next, pn); };
    if (SKIP.has(role)) return;
    if (role === "StaticText") {
      if (name && !(parentName && parentName.includes(name))) lines.push(`${"  ".repeat(depth)}- text: ${quote(name, 500)}`);
      return;
    }
    if (n.ignored || role === "RootWebArea" || (TRANSPARENT.has(role) && !name)) return kids(depth, parentName);
    const props = [];
    for (const p of n.properties ?? []) {
      if (!PROPS.includes(p.name)) continue;
      const v = p.value?.value;
      if (v === false || v === "false" || v == null) continue;
      props.push(v === true || v === "true" ? p.name : `${p.name}=${v}`);
    }
    const url = role === "link" && n.properties?.find((p) => p.name === "url")?.value?.value;
    const value = n.value?.value;
    let line = `${"  ".repeat(depth)}- ${role}${name ? ` ${quote(name)}` : ""}`;
    if (value != null && value !== "" && String(value) !== name) line += ` value=${quote(String(value), 120)}`;
    if (props.length) line += ` [${props.join(", ")}]`;
    if (url) line += ` [url=${quote(url, 120)}]`;
    if (n.backendDOMNodeId != null) line += ` [ref=e${n.backendDOMNodeId}]`;
    lines.push(line);
    kids(depth + 1, name || parentName);
  };
  walk(root, 0, "");
  return lines;
}

// Removed and added lines (as a multiset: moved lines count as unchanged).
export function snapshotChanges(prev, next) {
  const count = new Map();
  for (const l of prev) count.set(l, (count.get(l) ?? 0) + 1);
  const added = [];
  for (const l of next) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1); else added.push(`+ ${l.trimStart().replace(/^- /, "")}`);
  }
  const removed = [];
  for (const [l, c] of count) for (let i = 0; i < c; i++) removed.push(`- ${l.trimStart().replace(/^- /, "")}`);
  return [...removed, ...added];
}
