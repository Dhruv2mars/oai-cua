// Plugin packaging: manifests stay in sync with package.json and the shim.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { changelogSection, publishCommand } from "../scripts/release.mjs";

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

  test("release publish gives npm a terminal when it has none, so its browser 2FA works", () => {
    expect(publishCommand(true)).toEqual(["npm", ["publish"]]);
    expect(publishCommand(false)).toEqual(["script", ["-q", "/dev/null", "npm", "publish", "--browser=false"]]);
  });

  test("CHANGELOG.md has a section for this version (the release notes)", () => {
    expect(changelogSection(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), pkg.version)).toBeTruthy();
    expect(changelogSection("## 1.0.0 (x)\nA\n## 1.0.1\nB", "1.0.1")).toBe("B");
    expect(changelogSection("## 1.0.10\nA", "1.0.1")).toBe(null);
  });

  test("the marketplace installs the plugin from this npm package", () => {
    expect(market.name).toBe(plugin.name);
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: { source: "npm", package: pkg.name } })]);
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });

  test("the npm package ships the plugin, the marketplace file and the shim's runtime files", () => {
    for (const f of [".claude-plugin", ".mcp.json", "src"]) expect(pkg.files).toContain(f);
    for (const f of fs.readdirSync(path.join(ROOT, "src"))) expect(fs.statSync(path.join(ROOT, "src", f)).isFile()).toBe(true);
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
