// Tool schemas and argument checks shared by the desktop, browser and
// service tools, plus the plain-text tool result.

export const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const range = (min, max) => min != null && max != null ? `from ${min} to ${max}` : min != null ? `at least ${min}` : `at most ${max}`;

// Checks args against a flat object schema; returns an error string or null.
// A null value counts as absent. numericStrings: integers and numbers may
// come as numeric strings (the desktop tools accept "2"). emptyOk: required
// string arguments that may be "".
export function checkArgs({ properties, required }, args, { numericStrings = false, emptyOk = [] } = {}) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  for (const k of required) if (args[k] == null || (args[k] === "" && !emptyOk.includes(k))) return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    if (!p) return `unknown argument: ${k}`;
    if (v == null) continue;
    const num = numericStrings && typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (p.type === "integer" && !Number.isInteger(num)) return `${k} must be an integer`;
    if (p.type === "number" && !Number.isFinite(num)) return `${k} must be a number`;
    if (p.type === "string" && typeof v !== "string") return `${k} must be a string`;
    if (p.type === "boolean" && typeof v !== "boolean") return `${k} must be true or false`;
    if (p.type === "array") {
      if (!Array.isArray(v)) return `${k} must be an array`;
      if (p.items?.type === "string" && v.some((x) => typeof x !== "string")) return `${k} must be an array of strings`;
      if (v.length < (p.minItems ?? 0) || v.length > (p.maxItems ?? Infinity)) return p.maxItems != null ? `${k} must have ${p.minItems ?? 0}-${p.maxItems} entries` : `${k} must have at least ${p.minItems} entr${p.minItems === 1 ? "y" : "ies"}`;
    }
    if ((p.minimum != null && num < p.minimum) || (p.maximum != null && num > p.maximum)) return `${k} must be ${range(p.minimum, p.maximum)}`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(", ")}`;
  }
  return null;
}
