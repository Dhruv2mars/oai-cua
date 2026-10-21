// Plugin packaging: manifests stay in sync with package.json and the shim.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { changelogSection } from "../scripts/release.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const market = json(".claude-plugin/marketplace.json");
const mcp = json(".mcp.json");

describe("plugin", () => {
  test("plugin.json version matches package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  test("CHANGELOG.md has a section for this version (the release notes)", () => {
    expect(changelogSection(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), pkg.version)).toBeTruthy();
    expect(changelogSection("## 1.0.0 (x)\nA\n## 1.0.1\nB", "1.0.1")).toBe("B");
    expect(changelogSection("## 1.0.10\nA", "1.0.1")).toBe(null);
  });

  test("the repo is its own marketplace with one entry at ./", () => {
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: "./" })]);
  });

  test("one MCP server, the shim, with state in the plugin data dir", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(["computer-use"]);
    const s = mcp.mcpServers["computer-use"];
    expect(s.command).toBe("node");
    expect(s.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/src/shim.mjs"]);
    expect(fs.existsSync(path.join(ROOT, "src/shim.mjs"))).toBe(true);
    expect(s.env.OAI_CUA_STATE_DIR).toBe("${CLAUDE_PLUGIN_DATA}");
  });

  test("every userConfig option is passed to the shim, and only declared ones are referenced", () => {
    const env = JSON.stringify(mcp.mcpServers["computer-use"].env);
    const used = [...env.matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1]).sort();
    expect(used).toEqual(Object.keys(plugin.userConfig ?? {}).sort());
  });

  test("ships no agents, hooks, skills, commands or settings", () => {
    for (const d of ["agents", "hooks", "skills", "commands", "output-styles", "monitors", "bin", "settings.json", "SKILL.md"])
      expect(fs.existsSync(path.join(ROOT, d))).toBe(false);
    for (const k of ["agents", "hooks", "skills", "commands", "settings", "outputStyles", "mcpServers"]) expect(plugin[k]).toBeUndefined();
  });
});
