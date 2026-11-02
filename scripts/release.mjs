#!/usr/bin/env node
// Release steps. The version lives in package.json and .claude-plugin/plugin.json;
// installed plugins update only when it changes.
//   node scripts/release.mjs bump <version>   set both versions (then open a PR)
//   node scripts/release.mjs publish          on an up-to-date main, logged in to npm:
//                                             tag v<version>, push it, and npm publish
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const FILES = ["package.json", ".claude-plugin/plugin.json"];
const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts }) ?? "").trim();
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

async function publish() {
  const version = JSON.parse(read("package.json")).version;
  if (JSON.parse(read(".claude-plugin/plugin.json")).version !== version) die("package.json and plugin.json versions differ");
  const notes = changelogSection(read("CHANGELOG.md"), version);
  if (!notes) die(`CHANGELOG.md has no "## ${version}" section`);
  if (sh("git", ["status", "--porcelain", "--untracked-files=no"])) die("the working tree has uncommitted changes");
  if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("not on main");
  sh("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  if (sh("git", ["rev-parse", "HEAD"]) !== sh("git", ["rev-parse", "origin/main"])) die("main is not the same as origin/main");
  const tag = `v${version}`;
  if (sh("git", ["tag", "--list", tag])) die(`${tag} already exists`);
  try { sh("npm", ["whoami"]); } catch { die("not logged in to npm (run npm login)"); }
  sh("bun", ["run", "check"], { stdio: "inherit" });
  sh("git", ["tag", "-a", tag, "-m", `${tag}\n\n${notes}`]);
  sh("git", ["push", "origin", tag]);
  // npm asks for 2FA in the browser (web login). On a terminal it offers to open
  // its config "browser"; without one it prints the URL to open and waits.
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY); // npm needs both for its 2FA prompt
  if (!tty) console.log("npm will print an authentication URL: open it in your browser and approve; npm then finishes.");
  const code = await run(...publishCommand(tty), tty);
  if (code !== 0) die(`npm publish exited with ${code}; tag ${tag} is pushed, so rerun just: npm publish`);
  console.log(`Released ${tag}: npm ${JSON.parse(read("package.json")).name}@${version}.`);
}

// npm only offers its browser 2FA flow on a terminal; without one (an agent,
// a pipe) it fails with EOTP. So it runs under script(1), which gives it one,
// with --browser=false so it prints the URL and polls instead of reading stdin.
export const publishCommand = (tty) => (tty ? ["npm", ["publish"]] : ["script", ["-q", "/dev/null", "npm", "publish", "--browser=false"]]);

// Signals reach the publisher too, so a cancelled release can't still publish
// once the browser approval goes through.
export const run = (cmd, args, tty) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: [tty ? "inherit" : "ignore", "inherit", "inherit"] });
  const forward = (sig) => p.kill(sig);
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of sigs) process.on(sig, forward);
  const done = (code) => { for (const sig of sigs) process.off(sig, forward); resolve(code); };
  p.on("exit", (c, sig) => done(c ?? (sig ? 1 : 0)));
  p.on("error", (e) => { console.error(e.message); done(1); });
});

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "bump") bump(arg);
  else if (cmd === "publish") await publish();
  else die("usage: release.mjs bump <version> | publish");
}
