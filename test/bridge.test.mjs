// Regression tests: real shim + engine processes against a fake cua-repl.
// Run with `bun run check` (bun test runner; the shim itself runs on Node).
import { afterEach, describe, expect, test } from "bun:test";
import { diffTree, limitOutput } from "../src/observe.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const FAKE = path.join(ROOT, "test/fake-cua-repl.mjs");
const NODE = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
  const manifest = path.join(dir, "mcp.json");
  fs.writeFileSync(manifest, JSON.stringify({ mcpServers: { cua_repl: { command: NODE, args: [FAKE], env: { BROWSER_USE_AVAILABLE_BACKENDS: "chrome" } } } }));
  const log = path.join(dir, "fake.log");
  fs.writeFileSync(log, "");
  return {
    dir, log,
    env: { ...process.env, HOME: dir, CODEX_HOME: path.join(dir, ".codex"), OPENAI_CUA_APP: path.join(dir, "ChatGPT.app"), OPENAI_CUA_STATE_DIR: path.join(dir, "state"), OPENAI_CUA_MCP_JSON: manifest, FAKE_LOG: log, FAKE_DOCS: "", ...env },
    events: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

function startShim(sb) {
  const p = spawn(NODE, [path.join(ROOT, "src/shim.mjs")], { env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => { try { p.kill("SIGKILL"); } catch {} });
  let buf = "", id = 0;
  const waiters = new Map();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  const exited = new Promise((r) => p.on("exit", (code) => r(code)));
  return {
    p, rpc, exited,
    init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
  };
}
// A fake installed ChatGPT.app + Codex plugin cache with OpenAI-shaped docs.
function fakeInstall(sb) {
  const put = (rel, body) => { const f = path.join(sb.dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  const nm = "ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai";
  const filler = (n) => Array.from({ length: n }, (_, i) => `## Filler ${i}\n${"policy prose ".repeat(40)}`).join("\n\n");
  put(`${nm}/cua/docs/tinysky-alt-confirmations.md`, `# Policy\n\n## Scope\nSCOPE-RULE\n\n## Always Confirm\nALWAYS-CONFIRM-RULE\n\n## Hand-off\nHAND-OFF-RULE\n\n${filler(12)}`);
  put(`${nm}/cua/docs/tinysky-alt-core-cua-repl.md`, "# Core\nCORE-DOC uses js and node_repl");
  put(`${nm}/sky/docs/sky-window-api.md`, "SKY-WINDOW");
  put(`${nm}/sky/docs/skills/linux/x.md`, "LINUX-ONLY");
  put(`${nm}/sky/docs/skills/win.md`, 'target: "windows";\nWINDOWS-ONLY');
  put(".codex/plugins/cache/openai-bundled/computer-use/1.9.0/skills/computer-use/SKILL.md", "OLD-SKILL");
  put(".codex/plugins/cache/openai-bundled/computer-use/1.10.0/skills/computer-use/SKILL.md", "CODEX-SKILL");
  put(".codex/plugins/cache/openai-bundled/computer-use/1.10.0/.codex-plugin/plugin.json", '{"name":"computer-use"}');
}
const FULL = "Full accessibility tree of TextEdit:\ntree of TextEdit é日";
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const spawns = (sb) => sb.events().filter((e) => e.ev === "spawn");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("protocol", () => {
  test("initialize, instructions and full tool schemas without starting the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    const init = (await s.init()).result;
    expect(init.protocolVersion).toBe("2025-06-18");
    expect(init.instructions).toContain("get_app_state");
    const tools = (await s.rpc("tools/list", {})).result.tools;
    expect(tools.map((t) => t.name).filter((n) => !n.startsWith("browser_")).sort()).toEqual(["batch", "click", "drag", "get_app_state", "list_apps", "paste", "perform_secondary_action", "press_key", "record_start", "record_status", "record_stop", "recording_to_skill", "scroll", "select_text", "set_value", "start_audio_recording", "stop_audio_recording", "type_text"]);
    for (const t of tools) expect(t.inputSchema.properties).toBeDefined();
    for (const t of tools) expect(Object.keys(t).sort()).toEqual(["annotations", "description", "inputSchema", "name"]);
    for (const n of ["click", "type_text", "paste", "press_key", "scroll", "drag", "set_value", "select_text", "perform_secondary_action"])
      expect(tools.find((t) => t.name === n).inputSchema.properties.screenshot.type).toBe("boolean");
    expect(tools.find((t) => t.name === "click").inputSchema.properties.hold_ms).toMatchObject({ type: "integer", minimum: 0, maximum: 30000 });
    expect(tools.find((t) => t.name === "type_text").inputSchema.required).toEqual(["app", "text"]);
    expect(spawns(sb).length).toBe(0);
    expect((await s.rpc("bogus/method", {})).error.code).toBe(-32601);
  });

  test("stdin EOF exits promptly and stops the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    const pid = spawns(sb)[0].pid;
    const t = Date.now();
    s.p.stdin.end();
    expect(await s.exited).toBe(0);
    expect(Date.now() - t).toBeLessThan(1000);
    await sleep(200);
    expect(alive(pid)).toBe(false);
  });
});

describe("tools", () => {
  test("get_app_state returns AX tree + screenshot, dropping getApp's auto-emitted output", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe(FULL);
    expect(r.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "/9j/4A==" });
    const ev = spawns(sb)[0];
    expect(ev.surfaces).toBe("computer");
    expect(ev.backends).toBe("");
  });

  test("actions translate to the cua API; non-ASCII text is pasted", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    await s.call("click", { app: "TextEdit", element_index: "2" });
    await s.call("click", { app: "TextEdit", x: 10, y: 20, click_count: 2, mouse_button: "right" });
    await s.call("type_text", { app: "TextEdit", text: "plain" });
    const r = await s.call("type_text", { app: "TextEdit", text: "é日 \"quote\" ${x} `t`" });
    expect(textOf(r)).toBe(`Done. ${"No change in the accessibility tree since your last observation of TextEdit; all element indices are still valid."}`);
    await s.call("scroll", { app: "TextEdit", element_index: 1, direction: "down", pages: 0.5 });
    await s.call("select_text", { app: "TextEdit", element_index: 2, text: "a", selection: "cursor_after" });
    const acts = sb.events().filter((e) => e.ev === "action").map((e) => [e.method, e.args]);
    expect(acts).toEqual([
      ["click", [2, { mouseButton: "left", clickCount: 1 }]],
      ["click", [[10, 20], { mouseButton: "right", clickCount: 2 }]],
      ["typeText", ["plain"]],
      ["paste", ["é日 \"quote\" ${x} `t`"]],
      ["scroll", [1, "down", 0.5]],
      ["selectText", [2, "a", { selectionType: "cursor_after" }]],
    ]);
  });

  test("click modifiers + hold, press_key hold, modifier aliases, paste formats, multi-line text pasted", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    for (const [tool, args] of [
      ["click", { element_index: 3, modifiers: "Cmd + Shift", hold_ms: 1200 }],
      ["click", { x: 5, y: 6, modifiers: "option", hold_ms: "0" }],
      ["press_key", { key: "control+Option+Left", hold_ms: 750 }],
      ["press_key", { key: "COMMAND+z" }],
      ["press_key", { key: "Control_L+super+plus" }],
      ["type_text", { text: "line one\nline two" }],
      ["type_text", { text: "a\tb" }],
      ["type_text", { text: "carriage\r" }],
      ["type_text", { text: "single line ~!@#" }],
      ["paste", { text: "# Title\n\n**bold**", format: "md" }],
      ["paste", { text: "<b>hi</b>", format: "html" }],
      ["paste", { text: "plain" }],
    ]) expect((await s.call(tool, { app: "TextEdit", ...args })).isError).toBeUndefined();
    expect(sb.events().filter((e) => e.ev === "action").map((e) => [e.method, e.args])).toEqual([
      ["click", [3, { mouseButton: "left", clickCount: 1, key: "super+shift", durationMs: 1200 }]],
      ["click", [[5, 6], { mouseButton: "left", clickCount: 1, key: "alt", durationMs: 0 }]],
      ["pressKey", ["ctrl+alt+Left", { durationMs: 750 }]],
      ["pressKey", ["super+z"]],
      ["pressKey", ["Control_L+super+plus"]],
      ["paste", ["line one\nline two"]],
      ["paste", ["a\tb"]],
      ["paste", ["carriage\r"]],
      ["typeText", ["single line ~!@#"]],
      ["paste", ["# Title\n\n**bold**", { format: "md" }]],
      ["paste", ["<b>hi</b>", { format: "html" }]],
      ["paste", ["plain", { format: "text" }]],
    ]);
  });

  test("screenshot: true returns the post-action screenshot with the state", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const plain = await s.call("click", { app: "TextEdit", x: 1, y: 2 });
    expect(plain.content.map((c) => c.type)).toEqual(["text"]);
    for (const [tool, args] of [["click", { x: 1, y: 2 }], ["press_key", { key: "Tab" }], ["paste", { text: "x" }], ["scroll", { element_index: 1, direction: "up" }]]) {
      const r = await s.call(tool, { app: "TextEdit", ...args, screenshot: true });
      expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(textOf(r)).toMatch(/^Done\. (Full accessibility tree of TextEdit:\ntree of TextEdit é日|No change in the accessibility tree)/);
      expect(r.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "/9j/4A==" });
    }
  });

  test("audio: start/stop return the WAV path, duration and optional MCP audio; approval only for start", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("stop_audio_recording"))).toContain("no active audio recording");
    const start = await s.call("start_audio_recording", { max_duration_ms: 2000 });
    expect(textOf(start)).toContain("stops by itself after 2000 ms");
    const stop = await s.call("stop_audio_recording", { include_audio: true });
    expect(textOf(stop)).toContain("Saved computer audio: /tmp/fake-computer-audio.wav\n0.50 s, 48044 bytes");
    expect(stop.content.at(-1).type).toBe("audio");
    expect(stop.content.at(-1).mimeType).toBe("audio/wav");
    expect(Buffer.from(stop.content.at(-1).data, "base64").subarray(0, 4).toString()).toBe("RIFF");
    await s.call("start_audio_recording", {});
    expect((await s.call("stop_audio_recording")).content.map((c) => c.type)).toEqual(["text"]);
    expect(sb.events().filter((e) => e.ev === "audio" && e.method === "start").map((e) => e.input)).toEqual([{ max_duration_ms: 2000 }, { max_duration_ms: 60000 }]);
    expect(sb.events().filter((e) => e.ev === "audio-elicit").map((e) => e.action)).toEqual(["accept", "accept"]);
    expect(spawns(sb)[0].audio).toEqual(["1", "1"]);
  });

  test("audio approval requested by any other cell is declined", async () => {
    const sb = sandbox({ FAKE_AUDIO_ELICIT_ON_CLICK: "1" }), s = startShim(sb);
    await s.init();
    await s.call("click", { app: "TextEdit", element_index: 1 });
    await s.call("start_audio_recording", {});
    await s.call("click", { app: "TextEdit", element_index: 1 });
    expect(sb.events().filter((e) => e.ev === "audio-elicit").map((e) => e.action)).toEqual(["decline", "accept", "decline"]);
  });

  test("audio: OPENAI_CUA_AUDIO=0 disables it; oversize WAV and old protocols skip inline audio", async () => {
    const off = sandbox({ OPENAI_CUA_AUDIO: "0" }), s = startShim(off);
    await s.init();
    const r = await s.call("start_audio_recording", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not enabled");
    expect(spawns(off)[0].audio).toEqual(["0", "0"]);

    const big = sandbox({ FAKE_WAV_BYTES: String(11 * 1024 * 1024) }), b = startShim(big);
    await b.init();
    await b.call("start_audio_recording", {});
    const rb = await b.call("stop_audio_recording", { include_audio: true });
    expect(rb.content.map((c) => c.type)).toEqual(["text", "text"]);
    expect(textOf(rb)).toContain("too large to return inline");

    const old = sandbox(), o = startShim(old);
    await o.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    await o.call("start_audio_recording", {});
    const ro = await o.call("stop_audio_recording", { include_audio: true });
    expect(ro.content.some((c) => c.type === "audio")).toBe(false);
    expect(textOf(ro)).toContain("needs MCP protocol 2025-03-26");
  });

  test("validation errors and Chrome block never reach the engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "Google Chrome" }))).toContain("blocked");
    expect(textOf(await s.call("click", { app: "com.google.Chrome", element_index: 1 }))).toContain("blocked");
    expect(textOf(await s.call("click", { app: "TextEdit" }))).toContain("element_index or both x and y");
    expect(textOf(await s.call("type_text", { app: "TextEdit" }))).toContain("missing required argument: text");
    expect(textOf(await s.call("nope", {}))).toContain("unknown tool");
    for (const [tool, args, msg] of [
      ["click", { app: "TextEdit", element_index: 1, hold_ms: 30001 }, "hold_ms must be from 0 to 30000"],
      ["click", { app: "TextEdit", element_index: 1, hold_ms: -1 }, "hold_ms must be from 0 to 30000"],
      ["press_key", { app: "TextEdit", key: "a", hold_ms: 1.5 }, "hold_ms must be an integer"],
      ["click", { app: "TextEdit", element_index: 1, modifiers: "" }, "modifiers must not be empty"],
      ["click", { app: "TextEdit", element_index: 1, screenshot: "yes" }, "screenshot must be true or false"],
      ["paste", { app: "TextEdit", text: "x", format: "rtf" }, "format must be one of text, md, html"],
      ["paste", { app: "TextEdit" }, "missing required argument: text"],
      ["start_audio_recording", { max_duration_ms: 50 }, "max_duration_ms must be from 100 to 300000"],
      ["start_audio_recording", { max_duration_ms: 300001 }, "max_duration_ms must be from 100 to 300000"],
      ["stop_audio_recording", { include_audio: "true" }, "include_audio must be true or false"],
    ]) expect(textOf(await s.call(tool, args))).toContain(msg);
    expect(spawns(sb).length).toBe(0);
  });

  test("app-access elicitation is accepted, but Chrome is declined by its resolved identity", async () => {
    const sb = sandbox({ FAKE_ELICIT: "1" }), s = startShim(sb);
    await s.init();
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined();
    const r = await s.call("get_app_state", { app: "/tmp/browser-link" }); // name hides Chrome
    expect(r.isError).toBe(true);
    expect(sb.events().filter((e) => e.ev === "elicit").map((e) => e.action)).toEqual(["accept", "decline"]);
  });

  test("UTF-8 split across stream chunks is decoded intact", async () => {
    const sb = sandbox({ FAKE_SPLIT: "1" }), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toBe(FULL);
  });
});

describe("guidance", () => {
  test("OpenAI docs from the installed app become instructions, resources and prompts", async () => {
    const sb = sandbox(); fakeInstall(sb);
    const s = startShim(sb);
    const init = (await s.init()).result;
    expect(init.capabilities.resources).toBeDefined();
    expect(init.capabilities.prompts).toBeDefined();
    const ins = init.instructions;
    expect(ins.length).toBeLessThanOrEqual(4096);
    for (const t of ["get_app_state", "osascript", "Helium", "ALWAYS-CONFIRM-RULE", "HAND-OFF-RULE", "SCOPE-RULE", "Omitted for length", "openai-cua://engine/first-use"]) expect(ins).toContain(t);
    const uris = (await s.rpc("resources/list", {})).result.resources.map((r) => r.uri);
    expect(uris).toContain("openai-cua://cua/docs/tinysky-alt-confirmations.md");
    expect(uris).toContain("openai-cua://sky/docs/sky-window-api.md");
    expect(uris).toContain("openai-cua://plugins/computer-use/skills/computer-use/SKILL.md");
    expect(uris).toContain("openai-cua://plugins/computer-use/plugin.json");
    expect(uris.some((u) => /linux|win\.md/.test(u))).toBe(false); // macOS only
    const read = async (uri) => (await s.rpc("resources/read", { uri })).result?.contents[0].text;
    expect(await read("openai-cua://plugins/computer-use/skills/computer-use/SKILL.md")).toBe("CODEX-SKILL"); // newest version wins
    expect(await read("openai-cua://bridge/guide")).toContain("get_app_state ← ");
    expect(await read("openai-cua://engine/first-use")).toContain("CORE-DOC"); // before the engine ran: same files it reads
    expect((await s.rpc("resources/read", { uri: "openai-cua://nope" })).error.code).toBe(-32002);
    const prompts = (await s.rpc("prompts/list", {})).result.prompts.map((p) => p.name);
    expect(prompts).toEqual(["computer-use", "confirmation-policy"]);
    const cu = (await s.rpc("prompts/get", { name: "computer-use", arguments: { task: "TASK-X" } })).result.messages[0].content.text;
    for (const t of ["CORE-DOC", "CODEX-SKILL", "TASK-X", "these openai-computer-use tools"]) expect(cu).toContain(t);
    expect((await s.rpc("prompts/get", { name: "confirmation-policy" })).result.messages[0].content.text).toContain("ALWAYS-CONFIRM-RULE");
    expect(spawns(sb).length).toBe(0); // none of this starts the engine
  });

  test("missing OpenAI docs degrade to our own short policy", async () => {
    const sb = sandbox(), s = startShim(sb);
    const ins = (await s.init()).result.instructions;
    expect(ins).toContain("not found in the installed app");
    expect(ins).toContain("Confirm with the user");
    expect((await s.rpc("prompts/get", { name: "confirmation-policy" })).error.code).toBe(-32602);
    expect((await s.rpc("resources/read", { uri: "openai-cua://engine/first-use" })).error.code).toBe(-32002);
    expect((await s.rpc("resources/list", {})).result.resources.length).toBe(2);
  });

  test("first-use docs pass through once per session, with the tool mapping", async () => {
    const sb = sandbox({ FAKE_DOCS: "## Computer Use\nFIRST-USE-BODY" }), s = startShim(sb);
    await s.init();
    const r1 = await s.call("get_app_state", { app: "TextEdit" });
    expect(r1.content[0].text).toContain("FIRST-USE-BODY");
    expect(r1.content[0].text).toContain("get_app_state ← ");
    expect(r1.content.at(-1).type).toBe("image");
    expect(textOf(r1)).toContain("tree of TextEdit é日");
    const r2 = await s.call("get_app_state", { app: "TextEdit" });
    expect(textOf(r2)).toBe("No change in the accessibility tree since your last observation of TextEdit; all element indices are still valid."); // REPL "declared with const" warnings are not docs
    expect(textOf(await s.call("get_app_state", { app: "TextEdit", mode: "text" }))).toBe(FULL); // docs only once
    expect((await s.rpc("resources/read", { uri: "openai-cua://engine/first-use" })).result.contents[0].text).toBe("## Computer Use\nFIRST-USE-BODY");
  });

  test("docs a REPL prints mid-session (reset) are captured from before the cell's start marker", async () => {
    const sb = sandbox({ FAKE_DOCS: "", FAKE_REPL_RESET: path.join(os.tmpdir(), `reset-${process.pid}-${Date.now()}`), FAKE_RESET_DOCS: "RESET-DOCS" }), s = startShim(sb);
    await s.init();
    const r1 = await s.call("press_key", { app: "TextEdit", key: "a" });
    expect(r1.content[0].text).toContain("RESET-DOCS");
    expect(textOf(await s.call("press_key", { app: "TextEdit", key: "a" }))).not.toContain("RESET-DOCS");
  });
});

describe("observation", () => {
  const REST = Array.from({ length: 20 }, (_, i) => `\n\t\t${i + 2} button Action ${i}`).join("");
  const T1 = `Window: "doc"\n\t0 standard window doc\n\t\t1 text area Value: hello${REST}`;
  const T2 = `Window: "doc"\n\t0 standard window doc\n\t\t1 text area Value: hello world\nsecond line${REST}`;
  const treeSb = (env = {}) => {
    const sb = sandbox(env);
    const file = path.join(sb.dir, "trees.json");
    sb.env.FAKE_TREE_FILE = file;
    sb.setTree = (t) => fs.writeFileSync(file, JSON.stringify({ TextEdit: t }));
    return sb;
  };

  test("diffTree: changed lines under their ancestors; null for window switch or large change", () => {
    expect(diffTree(T1, T1)).toBe("");
    // a multi-line value is shown whole, with its element line
    expect(diffTree(T1, T2)).toBe('  Window: "doc"\n  \t0 standard window doc\n- \t\t1 text area Value: hello\n+ \t\t1 text area Value: hello world\n+ second line');
    // only the changed lines of an otherwise unchanged multi-line value
    const M = (x) => T1.replace("Value: hello", `Value: l1\nl2\n${x}\nl4`);
    expect(diffTree(M("l3"), M("l3!"))).toBe('  Window: "doc"\n  \t0 standard window doc\n  \t\t1 text area Value: l1\n  …\n- l3\n+ l3!\n  …');
    expect(diffTree(T1, T1.replace('"doc"', '"other"'))).toBeNull(); // window switch
    expect(diffTree(T1, T1.replaceAll("Action", "Other"))).toBeNull(); // diff not smaller
  });

  test("auto mode: first observation full + screenshot, then labelled diffs; engine diffs never used", async () => {
    const sb = treeSb(), s = startShim(sb);
    await s.init();
    sb.setTree(T1);
    const first = await s.call("get_app_state", { app: "TextEdit" });
    expect(textOf(first)).toBe(`Full accessibility tree of TextEdit:\n${T1}`);
    expect(first.content[1].type).toBe("image");
    const same = await s.call("get_app_state", { app: "TextEdit" });
    expect(textOf(same)).toContain("No change in the accessibility tree");
    expect(same.content.length).toBe(1); // diff mode: no screenshot
    sb.setTree(T2);
    const act = await s.call("type_text", { app: "TextEdit", text: " world" });
    expect(textOf(act)).toStartWith("Done. Accessibility diff since your last observation of TextEdit");
    expect(textOf(act)).toContain("+ \t\t1 text area Value: hello world\n+ second line");
    expect(textOf(act)).not.toContain("button Action"); // unchanged elements omitted
    const obs = sb.events().filter((e) => e.ev === "observe" && e.kind !== "shot");
    expect(obs.length).toBe(3);
    expect(obs.every((e) => e.disableDiffing && e.emit === false)).toBe(true);
    expect(JSON.stringify(sb.events())).not.toContain("ENGINE DIFF");
  });

  test("explicit modes: full, text, diff, screenshot (forces the next tree to be full)", async () => {
    const sb = treeSb(), s = startShim(sb);
    await s.init();
    sb.setTree(T1);
    const diff0 = await s.call("get_app_state", { app: "TextEdit", mode: "diff" }); // nothing seen yet → full
    expect(textOf(diff0)).toStartWith("Full accessibility tree");
    expect(diff0.content.length).toBe(1);
    const text = await s.call("get_app_state", { app: "TextEdit", mode: "text" });
    expect(textOf(text)).toBe(`Full accessibility tree of TextEdit:\n${T1}`);
    expect(text.content.length).toBe(1);
    const full = await s.call("get_app_state", { app: "TextEdit", mode: "full" });
    expect(textOf(full)).toStartWith("Full accessibility tree");
    expect(full.content[1].type).toBe("image");
    const shot = await s.call("get_app_state", { app: "TextEdit", mode: "screenshot" });
    expect(textOf(shot)).toContain("No accessibility tree was read");
    expect(shot.content[1].type).toBe("image");
    const after = await s.call("get_app_state", { app: "TextEdit" });
    expect(textOf(after)).toStartWith("Full accessibility tree"); // not a diff after screenshot-only
    expect(after.content[1].type).toBe("image");
    expect(textOf(await s.call("get_app_state", { app: "TextEdit", mode: "bogus" }))).toContain("mode must be one of");
  });

  test("full mode notes a missing screenshot", async () => {
    const sb = treeSb({ FAKE_NO_SHOT: "1" }), s = startShim(sb);
    await s.init();
    const r = await s.call("get_app_state", { app: "TextEdit" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toEndWith("(No screenshot is available for this window.)");
  });

  test("output is capped near 25k tokens, keeping head and tail", () => {
    const big = "a".repeat(150_000) + "TAIL";
    const out = limitOutput([{ type: "text", text: big }, ...Array.from({ length: 10 }, () => ({ type: "image", data: "x" }))]);
    const txt = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(txt.length).toBeLessThan(101_000);
    expect(txt).toContain("characters truncated");
    expect(txt).toContain("TAIL");
    expect(out.at(-1).text).toBe("[2 more image(s) dropped: at most 8 images per call]");
    expect(out.filter((c) => c.type === "image").length).toBe(8);
  });
});

describe("batch", () => {
  test("runs steps in one cell with one state read, defaulting the app", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const r = await s.call("batch", { app: "TextEdit", steps: [
      { tool: "click", args: { element_index: 3 } },
      { tool: "type_text", args: { text: "hi ${x}`" } },
      { tool: "press_key", args: { key: "Return" } },
    ] });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe(`Batch completed: all 3 steps ran.\n\n${FULL}`);
    expect(sb.events().filter((e) => e.ev === "action").map((e) => [e.method, e.args[0]])).toEqual([["click", 3], ["typeText", "hi ${x}`"], ["pressKey", "Return"]]);
    expect(sb.events().filter((e) => e.ev === "cell" && !e.code.includes("getState")).length).toBe(1); // + the handshake cell
    expect(sb.events().filter((e) => e.ev === "observe").length).toBe(1);
  });

  test("screenshot is a batch option: one image per app after the last step", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("batch", { app: "TextEdit", steps: [{ tool: "click", args: { element_index: 1, screenshot: true } }] }))).toContain("screenshot is a batch option");
    const r = await s.call("batch", { app: "TextEdit", screenshot: true, steps: [{ tool: "press_key", args: { key: "cmd+a" } }, { tool: "press_key", args: { key: "Tab" } }] });
    expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(sb.events().filter((e) => e.ev === "action").map((e) => e.args[0])).toEqual(["super+a", "Tab"]); // chords normalized per step
    expect(sb.events().filter((e) => e.ev === "observe").map((e) => [e.kind, e.disableDiffing])).toEqual([["tree+shot", true]]);
  });

  test("stops at the first failing step and reports it with the state", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const r = await s.call("batch", { steps: [
      { tool: "press_key", args: { app: "TextEdit", key: "a" } },
      { tool: "press_key", args: { app: "TextEdit", key: "FAIL" } },
      { tool: "press_key", args: { app: "TextEdit", key: "never" } },
    ] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toStartWith("Batch stopped at step 2 of 3 (press_key): fake pressKey failure\nSteps 1-1 completed; steps 3-3 were not run.");
    expect(textOf(r)).toContain(FULL);
    expect(sb.events().filter((e) => e.ev === "action").map((e) => e.args[0])).toEqual(["a", "FAIL"]);
  });

  test("every step is validated before anything runs", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const bad = async (steps, msg, extra = {}) => expect(textOf(await s.call("batch", { steps, ...extra }))).toContain(msg);
    await bad([{ tool: "press_key", args: { app: "TextEdit", key: "a" } }, { tool: "click", args: { app: "TextEdit" } }], "step 2 (click): click needs element_index or both x and y");
    await bad([{ tool: "press_key", args: { key: "a" } }], "step 1 (press_key): missing required argument: app");
    await bad([{ tool: "get_app_state", args: { app: "TextEdit" } }], "tool must be one of");
    await bad([{ tool: "batch", args: {} }], "tool must be one of");
    await bad([{ tool: "click", args: { app: "Google Chrome", element_index: 1 } }], "blocked");
    await bad([{ tool: "click", args: { element_index: 1 }, code: "x" }], "unknown key: code");
    await bad([{ tool: "press_key", args: { key: "a" } }], "blocked", { app: "Chrome" });
    await bad([], "steps must have 1-50 entries");
    expect(spawns(sb).length).toBe(0);
  });
});

describe("run_cua_js", () => {
  const jsSb = (env = {}) => sandbox({ OPENAI_CUA_ENABLE_JS: "1", ...env });

  test("disabled by default: not listed, refused with how to enable", async () => {
    const sb = sandbox(), s = startShim(sb);
    const init = (await s.init()).result;
    expect(init.instructions).not.toContain("run_cua_js");
    const names = (await s.rpc("tools/list", {})).result.tools.map((t) => t.name);
    expect(names).not.toContain("run_cua_js");
    expect(names).not.toContain("reset_repl");
    expect(textOf(await s.call("run_cua_js", { code: "1" }))).toContain("OPENAI_CUA_ENABLE_JS=1");
    expect(textOf(await s.call("reset_repl", {}))).toContain("disabled");
    expect(spawns(sb).length).toBe(0);
  });

  test("bindings persist across calls, bridge cells leak none, reset_repl clears them", async () => {
    const sb = jsSb(), s = startShim(sb);
    const init = (await s.init()).result;
    expect(init.instructions).toContain("run_cua_js");
    expect((await s.rpc("tools/list", {})).result.tools.map((t) => t.name)).toContain("run_cua_js");
    expect((await s.call("run_cua_js", { code: "globalThis.counter = 41; globalThis.A = 'mine';" })).isError).toBeUndefined();
    await s.call("get_app_state", { app: "TextEdit" }); // bridge cell must not clobber A
    const r = await s.call("run_cua_js", { code: "counter++; nodeRepl.write(`${counter} ${A}`); const app = await cua.getApp('TextEdit'); await app.pressKey('x');" });
    expect(textOf(r)).toBe("42 mine\nauto-emitted state for TextEdit"); // getApp displays state, as in Codex
    expect(sb.events().some((e) => e.ev === "action" && e.args[0] === "x")).toBe(true);
    expect(textOf(await s.call("reset_repl", {}))).toContain("REPL reset");
    expect(sb.events().some((e) => e.ev === "js_reset")).toBe(true);
    expect(textOf(await s.call("run_cua_js", { code: "nodeRepl.write(typeof counter)" }))).toBe("undefined");
    expect((await s.call("get_app_state", { app: "TextEdit" })).isError).toBeUndefined(); // bridge works after reset
  });

  test("script errors are reported with the output so far", async () => {
    const sb = jsSb(), s = startShim(sb);
    await s.init();
    const r = await s.call("run_cua_js", { code: "nodeRepl.write('before'); throw new Error('boom')" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("boom\nbefore");
  });

  test("Chrome stays blocked: static check, and approval declined by resolved identity even via cua.computer", async () => {
    const sb = jsSb({ FAKE_ELICIT: "1" }), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("run_cua_js", { code: "await cua.getApp('Google Chrome')" }))).toContain("blocked");
    expect(spawns(sb).length).toBe(0);
    for (const code of ["await cua.computer.get_app_state({ app: '/tmp/browser-link' })", "await cua.getApp('/tmp/browser-link')"]) { // names hide Chrome
      const r = await s.call("run_cua_js", { code });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("not approved");
    }
    await s.call("reset_repl", {});
    expect((await s.call("run_cua_js", { code: "await cua.computer.get_app_state({ app: '/tmp/browser-link' })" })).isError).toBe(true);
    expect(sb.events().filter((e) => e.ev === "elicit").map((e) => e.action)).toEqual(["decline", "decline", "decline"]);
    expect(sb.events().filter((e) => e.ev === "computer")).toEqual([]);
  });

  test("large script output is truncated", async () => {
    const sb = jsSb(), s = startShim(sb);
    await s.init();
    const r = await s.call("run_cua_js", { code: "nodeRepl.write('x'.repeat(300000) + 'END')" });
    expect(textOf(r).length).toBeLessThan(101_000);
    expect(textOf(r)).toContain("characters truncated");
    expect(textOf(r)).toContain("END");
  });
});

describe("lifecycle", () => {
  test("slow initialize is awaited", async () => {
    const sb = sandbox({ FAKE_INIT_DELAY_MS: "300" }), s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("list_apps"))).toContain("com.apple.TextEdit [running]");
  });

  test("rejected initialize / failed authorization are reported, shim stays up and retries", async () => {
    for (const [knob, msg] of [["FAKE_INIT_ERROR", "rejected initialize"], ["FAKE_AUTH_FAIL", "not authorized/ready: Native apps: Error: Sky Computer Use native pipe startup failed"]]) {
      const sb = sandbox({ [knob]: "1" }), s = startShim(sb);
      await s.init();
      const r = await s.call("list_apps");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(msg);
      expect(textOf(r)).toContain("--doctor");
      expect((await s.rpc("ping", {})).result).toEqual({});
      await s.call("list_apps");
      expect(spawns(sb).length).toBe(2);
    }
  });

  test("missing runtime gives a clear error without crashing", async () => {
    const sb = sandbox({ OPENAI_CUA_MCP_JSON: "/nonexistent/mcp.json" }), s = startShim(sb);
    await s.init();
    const r = await s.call("list_apps");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("runtime not found");
    expect((await s.rpc("ping", {})).result).toEqual({});
  });

  test("idle release never interrupts an active call; next call restarts", async () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "150", FAKE_CELL_DELAY_MS: "450" }), s = startShim(sb);
    await s.init();
    expect((await s.call("list_apps")).isError).toBeUndefined();
    await sleep(400);
    expect(sb.events().some((e) => e.ev === "eof" || e.ev === "sigterm")).toBe(true);
    expect((await s.call("list_apps")).isError).toBeUndefined();
    expect(spawns(sb).length).toBe(2);
  });

  test("a retired engine's late exit cannot affect its in-flight replacement", async () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "100", FAKE_SLOW_EXIT_MS: "300", FAKE_CELL_DELAY_MS: "500" }), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    await sleep(200); // idle fired at ~100ms; old engine exits ~300ms later
    const old = spawns(sb)[0].pid;
    expect(alive(old)).toBe(true);
    const r = await s.call("get_app_state", { app: "TextEdit" }); // old exits mid-call
    expect(alive(old)).toBe(false);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe(FULL);
    expect((await s.call("list_apps")).isError).toBeUndefined(); // still served by the replacement
    expect(spawns(sb).length).toBe(2);
  });

  test("engine crash: reads retry transparently, actions report and recover", async () => {
    const sb = sandbox({ FAKE_CRASH_ONCE: path.join(os.tmpdir(), `crash-${process.pid}-${Date.now()}`) });
    const s = startShim(sb);
    await s.init();
    expect(textOf(await s.call("get_app_state", { app: "TextEdit" }))).toBe(FULL);
    const sb2 = sandbox({ FAKE_CRASH_ONCE: path.join(os.tmpdir(), `crash2-${process.pid}-${Date.now()}`) });
    const s2 = startShim(sb2);
    await s2.init();
    const r = await s2.call("press_key", { app: "TextEdit", key: "Return" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("exited");
    expect((await s2.call("press_key", { app: "TextEdit", key: "Return" })).isError).toBeUndefined();
  });

  test("hung engine times out and is replaced", async () => {
    const sb = sandbox({ FAKE_HANG: "1", OPENAI_CUA_CALL_TIMEOUT_MS: "200" }), s = startShim(sb);
    await s.init();
    const t = Date.now();
    const r = await s.call("list_apps");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("timed out");
    expect(Date.now() - t).toBeLessThan(3000);
    expect(sb.events().find((e) => e.ev === "cell" && e.code.includes("__cb")).timeout_ms).toBe(200);
    const hung = spawns(sb)[0].pid;
    await sleep(300);
    expect(alive(hung)).toBe(false);
    await s.call("list_apps");
    expect(spawns(sb).length).toBe(2); // replaced
  });

  test("cancelled calls: queued ones never run, running ones are stopped, no response sent", async () => {
    const sb = sandbox({ FAKE_CELL_DELAY_MS: "400" }), s = startShim(sb);
    await s.init();
    let answered = 0;
    const a = s.rpc("tools/call", { name: "press_key", arguments: { app: "TextEdit", key: "a" } }); // id 2, runs
    s.rpc("tools/call", { name: "type_text", arguments: { app: "TextEdit", text: "never" } }).then(() => answered++); // id 3, queued
    await sleep(100);
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
    expect((await a).result.isError).toBeUndefined();
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) + "\n");
    const c = s.rpc("tools/call", { name: "press_key", arguments: { app: "TextEdit", key: "b" } }); // id 4, cancel mid-run
    c.then(() => answered++);
    await sleep(150);
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } }) + "\n");
    await sleep(600);
    expect(sb.events().filter((e) => e.ev === "action").map((e) => e.args[0])).toEqual(["a"]);
    expect(sb.events().some((e) => e.ev === "sigterm" || e.ev === "eof")).toBe(true);
    expect(answered).toBe(0);
    expect((await s.call("list_apps")).isError).toBeUndefined(); // recovers
  });

  test("shutdown kills an engine that ignores SIGTERM, and its descendants", async () => {
    const sb = sandbox({ FAKE_IGNORE_TERM: "1" }), s = startShim(sb);
    await s.init();
    await s.call("list_apps");
    const { pid, grandchild } = spawns(sb)[0];
    s.p.stdin.end();
    expect(await s.exited).toBe(0);
    await sleep(100);
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  test("an audio recording keeps the engine from idle release until it is stopped", async () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "150" }), s = startShim(sb);
    await s.init();
    await s.call("start_audio_recording", { max_duration_ms: 100 }); // kept for 100 ms + 5 s grace
    await sleep(450);
    expect(sb.events().some((e) => e.ev === "eof" || e.ev === "sigterm")).toBe(false);
    expect((await s.call("stop_audio_recording")).isError).toBeUndefined();
    await sleep(450);
    expect(sb.events().some((e) => e.ev === "eof" || e.ev === "sigterm")).toBe(true);
    expect(spawns(sb).length).toBe(1);
  });

  test("40 concurrent calls share one engine", async () => {
    const sb = sandbox(), s = startShim(sb);
    await s.init();
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => s.call(i % 2 ? "list_apps" : "get_app_state", { ...(i % 2 ? {} : { app: "TextEdit" }) })));
    expect(rs.every((r) => !r.isError)).toBe(true);
    expect(spawns(sb).length).toBe(1);
  });
});

describe("installer", () => {
  function fakeBin(sb) {
    const bin = path.join(sb.dir, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(sb.dir, "calls.jsonl");
    const script = (body) => `#!${NODE}\nconst fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({cmd:require("path").basename(process.argv[1]),a})+"\\n");${body}`;
    fs.writeFileSync(path.join(bin, "claude"), script(`const st=${JSON.stringify(path.join(sb.dir, "claude-state"))};
if(a[1]==="add-json"){const f=st+".failed";if(process.env.FAKE_ADD_FAIL_ONCE&&!fs.existsSync(f)){fs.writeFileSync(f,"");process.exit(1);}fs.writeFileSync(st,a[5]);}
if(a[1]==="get"){if(!fs.existsSync(st))process.exit(1);console.log(fs.readFileSync(st,"utf8"));}`), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "codex"), script(`const st=${JSON.stringify(path.join(sb.dir, "codex-removed"))};
if(a[1]==="get")process.exit(fs.existsSync(st)?1:0);
if(a[1]==="remove")fs.writeFileSync(st,"");`), { mode: 0o755 });
    fs.symlinkSync(NODE, path.join(bin, "node"));
    return { bin, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
  }
  function repoCopy(sb, name) {
    const dest = path.join(sb.dir, name);
    fs.mkdirSync(path.join(dest, "src"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "install.mjs"), path.join(dest, "install.mjs"));
    for (const f of fs.readdirSync(path.join(ROOT, "src"))) fs.copyFileSync(path.join(ROOT, "src", f), path.join(dest, "src", f));
    fs.cpSync(path.join(ROOT, "skills"), path.join(dest, "skills"), { recursive: true });
    return dest;
  }

  test("installs with argv only (no shell expansion), persists env, denies native CU, removes legacy worker", () => {
    const sb = sandbox({ OPENAI_CUA_IDLE_MS: "1234" });
    const { bin, calls } = fakeBin(sb);
    const repo = repoCopy(sb, "repo-$(touch INJECTED)");
    const cfg = path.join(sb.dir, "claude-cfg");
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ switchModelsOnFlag: false, deniedMcpServers: [{ serverName: "x" }] }), { mode: 0o600 });
    fs.mkdirSync(path.join(cfg, "skills/openai-computer-use"), { recursive: true });
    fs.writeFileSync(path.join(cfg, "skills/openai-computer-use/SKILL.md"), "OLD USER SKILL");
    const r = spawnSync(NODE, [path.join(repo, "install.mjs")], { cwd: sb.dir, encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(sb.dir, "INJECTED"))).toBe(false);
    const add = calls().find((c) => c.cmd === "claude" && c.a[1] === "add-json");
    const spec = JSON.parse(add.a[5]);
    expect(spec.args).toEqual([path.join(fs.realpathSync(repo), "src/shim.mjs")]);
    expect(spec.env.OPENAI_CUA_IDLE_MS).toBe("1234");
    expect(spec.env.OPENAI_CUA_MCP_JSON).toBe(sb.env.OPENAI_CUA_MCP_JSON);
    expect(fs.statSync(path.join(cfg, "settings.json")).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
    expect(settings).toEqual({ switchModelsOnFlag: false, deniedMcpServers: [{ serverName: "x" }, { serverName: "computer-use" }] });
    expect(calls().some((c) => c.cmd === "codex" && c.a[1] === "remove" && c.a[2] === "openai-cua-worker")).toBe(true);
    expect(fs.readdirSync(path.join(sb.dir, "state/backups")).length).toBeGreaterThan(0);
    const skill = path.join(cfg, "skills/openai-computer-use");
    expect(fs.realpathSync(skill)).toBe(fs.realpathSync(path.join(repo, "skills/openai-computer-use")));
    const saved = fs.readdirSync(path.join(sb.dir, "state/backups")).find((f) => f.startsWith("skills-openai-computer-use."));
    expect(fs.readFileSync(path.join(sb.dir, "state/backups", saved, "SKILL.md"), "utf8")).toBe("OLD USER SKILL");
    const again = spawnSync(NODE, [path.join(repo, "install.mjs"), "--skip-live"], { cwd: sb.dir, encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
    expect(again.stdout).toContain("already linked");
  });

  test("failed preflight (missing runtime, bad settings) changes nothing", () => {
    for (const [env, settings] of [[{ OPENAI_CUA_MCP_JSON: "/nonexistent/mcp.json" }, "{}"], [{}, "null"], [{}, "{oops"], [{}, '{"deniedMcpServers":{}}']]) {
      const sb = sandbox(env);
      const { bin, calls } = fakeBin(sb);
      const cfg = path.join(sb.dir, "claude-cfg");
      fs.mkdirSync(cfg);
      fs.writeFileSync(path.join(cfg, "settings.json"), settings);
      const r = spawnSync(NODE, [path.join(ROOT, "install.mjs")], { encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("No configuration was changed");
      expect(calls().filter((c) => c.a[0] === "mcp")).toEqual([]);
      expect(fs.readFileSync(path.join(cfg, "settings.json"), "utf8")).toBe(settings);
    }
  });

  test("failed registration restores the previous one and leaves settings alone", () => {
    const sb = sandbox({ FAKE_ADD_FAIL_ONCE: "1" });
    const { bin, calls } = fakeBin(sb);
    const cfg = path.join(sb.dir, "claude-cfg");
    fs.mkdirSync(cfg);
    const old = { type: "stdio", command: "/old/node", args: ["/old/shim.mjs"], env: {} };
    fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ mcpServers: { "openai-computer-use": old } }));
    fs.writeFileSync(path.join(cfg, "settings.json"), "{}");
    const r = spawnSync(NODE, [path.join(ROOT, "install.mjs"), "--skip-live"], { encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Previous registration restored");
    const adds = calls().filter((c) => c.a[1] === "add-json");
    expect(JSON.parse(adds.at(-1).a[5])).toEqual(old);
    expect(fs.readFileSync(path.join(cfg, "settings.json"), "utf8")).toBe("{}");
  });
  test("--enable-js opts in, a later plain install keeps it, --disable-js removes it", () => {
    const sb = sandbox();
    const { bin, calls } = fakeBin(sb);
    const cfg = path.join(sb.dir, "claude-cfg");
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, "settings.json"), "{}");
    const install = (...flags) => {
      const r = spawnSync(NODE, [path.join(ROOT, "install.mjs"), "--skip-live", ...flags], { encoding: "utf8", env: { ...sb.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfg } });
      expect(r.status).toBe(0);
      const spec = JSON.parse(calls().filter((c) => c.a[1] === "add-json").at(-1).a[5]);
      fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ mcpServers: { "openai-computer-use": spec } }));
      return spec.env.OPENAI_CUA_ENABLE_JS;
    };
    expect(install()).toBeUndefined();
    expect(install("--enable-js")).toBe("1");
    expect(install()).toBe("1");
    expect(install("--disable-js")).toBeUndefined();
  });
});
