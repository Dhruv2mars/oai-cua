#!/usr/bin/env node
// Release steps. The version lives in package.json and .claude-plugin/plugin.json;
// installed plugins update only when it changes.
//   node scripts/release.mjs bump <version>   set both versions (then open a PR)
//   node scripts/release.mjs publish          on an up-to-date main: tag v<version>
//                                             and create the GitHub release from CHANGELOG.md
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const FILES = ["package.json", ".claude-plugin/plugin.json"];
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
const die = (m) => { console.error(`release: ${m}`); process.exit(1); };
const read = (f) => fs.readFileSync(new URL(f, ROOT), "utf8");

// The "## <version>" section of CHANGELOG.md, without its heading.
export function changelogSection(changelog, version) {
  const m = changelog.split(/^## /m).find((s) => s.split(/[\s(]/, 1)[0] === version);
  return m?.slice(m.indexOf("\n") + 1).trim() || null;
}

function bump(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) die("usage: bump <major.minor.patch>");
  for (const f of FILES) {
    const s = read(f);
    if (!/"version": "[^"]*"/.test(s)) die(`no version in ${f}`);
    fs.writeFileSync(new URL(f, ROOT), s.replace(/"version": "[^"]*"/, `"version": "${version}"`));
  }
  if (!changelogSection(read("CHANGELOG.md"), version)) console.log(`Now add a "## ${version}" section to CHANGELOG.md.`);
  console.log(`Set ${FILES.join(" and ")} to ${version}.`);
}

function publish() {
  const version = JSON.parse(read("package.json")).version;
  if (JSON.parse(read(".claude-plugin/plugin.json")).version !== version) die("package.json and plugin.json versions differ");
  const notes = changelogSection(read("CHANGELOG.md"), version);
  if (!notes) die(`CHANGELOG.md has no "## ${version}" section`);
  if (sh("git", ["status", "--porcelain"])) die("the working tree is not clean");
  if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("not on main");
  sh("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  if (sh("git", ["rev-parse", "HEAD"]) !== sh("git", ["rev-parse", "origin/main"])) die("main is not the same as origin/main");
  const tag = `v${version}`;
  if (sh("git", ["tag", "--list", tag])) die(`${tag} already exists`);
  sh("bun", ["run", "check"], { stdio: "inherit" });
  sh("git", ["tag", "-a", tag, "-m", tag]);
  sh("git", ["push", "origin", tag]);
  sh("gh", ["release", "create", tag, "--title", tag, "--notes", notes, "--verify-tag"]);
  console.log(`Released ${tag}.`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "bump") bump(arg);
  else if (cmd === "publish") publish();
  else die("usage: release.mjs bump <version> | publish");
}
