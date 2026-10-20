// Browser surface tests: HeliumBrowser against a fake CDP endpoint, the
// Helium-only endpoint check, and the shim's browser_* routing.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_TOOLS, HeliumBrowser, browserGuide, checkOwners, discoverEndpoints, formatAXTree, parseKey, validateBrowser, verifyEndpoint } from "../src/browser.mjs";
import { startFakeCdp } from "./fake-cdp.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const NODE = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cua-browser-"));

function setup(opts) {
  const fake = startFakeCdp(opts);
  const codexHome = tmp();
  const fronts = [], activated = [];
  const b = new HeliumBrowser({ discover: () => [fake.endpoint], verify: () => null, settleMs: 5, codexHome, shotsDir: path.join(codexHome, "shots"),
    front: () => fronts.shift() ?? "com.example.editor", activate: (id) => activated.push(id) });
  cleanup.push(() => { fake.stop(); }, () => b.close());
  const call = (name, args) => b.call(name, args);
  const open = async (url) => /Opened (t\d+)/.exec(textOf(await call("browser_open_tab", { url })))[1];
  return { fake, b, codexHome, call, open, fronts, activated };
}

describe("browser: Helium-only endpoints", () => {
  test("Chrome is refused by bundle id or executable; anything but Helium is refused", () => {
    expect(checkOwners([{ pid: 1, exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", bundleId: "com.google.Chrome" }])).toContain("Google Chrome is blocked");
    expect(checkOwners([{ pid: 1, exe: "/x/Helium.app/Contents/MacOS/Helium", bundleId: "com.google.Chrome.canary" }])).toContain("Google Chrome is blocked");
    expect(checkOwners([{ pid: 1, exe: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", bundleId: "com.brave.Browser" }])).toContain("only Helium is allowed");
    expect(checkOwners([{ pid: 1, exe: "/Applications/Helium.app/Contents/MacOS/Helium", bundleId: "net.imput.helium" }, { pid: 2, exe: "/usr/bin/nc", bundleId: "" }])).toContain("only Helium");
    expect(checkOwners([{ pid: 1, exe: "/Applications/Helium.app/Contents/MacOS/Helium", bundleId: "net.imput.helium" }])).toBeNull();
    expect(checkOwners(null)).toContain("nothing listening");
    expect(verifyEndpoint({ host: "10.0.0.5", port: 9222 })).toContain("only a local Helium");
  });

  test("a real non-Helium listener (this test process) is refused before any CDP traffic", async () => {
    const fake = startFakeCdp();
    cleanup.push(() => fake.stop());
    const b = new HeliumBrowser({ discover: () => [fake.endpoint] }); // real verifyEndpoint
    const r = await b.call("browser_list_tabs", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("only Helium is allowed");
    expect(fake.calls.length).toBe(0);
  });

  test("endpoint discovery: env port/URL and DevToolsActivePort files; none means not enabled", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/abc\n");
    expect(discoverEndpoints({ OAI_CUA_HELIUM_USER_DATA_DIR: dir })).toEqual([{ host: "127.0.0.1", port: 9333, path: "/devtools/browser/abc", source: dir }]);
    expect(discoverEndpoints({ OAI_CUA_HELIUM_CDP: "9444", OAI_CUA_HELIUM_USER_DATA_DIR: "" })[0]).toMatchObject({ host: "127.0.0.1", port: 9444 });
    expect(discoverEndpoints({ OAI_CUA_HELIUM_CDP: "ws://127.0.0.1:9555/devtools/browser/x", OAI_CUA_HELIUM_USER_DATA_DIR: "" })[0]).toMatchObject({ port: 9555, path: "/devtools/browser/x" });
    const b = new HeliumBrowser({ discover: () => [] });
    const r = await b.call("browser_list_tabs", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("chrome://inspect/#remote-debugging");
  });
});

describe("browser: tools against fake Helium", () => {
  test("list, open in background, snapshot with refs, ownership rules", async () => {
    const { fake, call } = setup();
    const list = textOf(await call("browser_list_tabs", {}));
    expect(list).toContain('t1 "User Mail" — https://mail.example/inbox');
    expect(fake.count("Target.attachToTarget")).toBe(0); // listing touches no tab
    const opened = textOf(await call("browser_open_tab", { url: "https://example.com/" }));
    expect(opened).toContain("Opened t2 in the background");
    expect(opened).toContain('- button "Go" [ref=e10]');
    expect(opened).toContain('- link "Docs" [url="https://docs.example/"] [ref=e14]');
    expect(fake.calls.find((c) => c.method === "Target.createTarget").params).toMatchObject({ background: true, newWindow: false });
    // the user's tab: readable, but not controllable until claimed
    expect(textOf(await call("browser_snapshot", { tab: "t1" }))).toContain("Body of User Mail");
    const denied = await call("browser_click", { tab: "t1", ref: "e10" });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("browser_claim_tab");
    expect(textOf(await call("browser_claim_tab", { tab: "t1" }))).toContain("Claimed t1");
  });

  test("type returns a snapshot diff; select, key, read, navigate skip-same-URL", async () => {
    const { fake, call, open } = setup();
    const tab = await open("https://example.com/");
    const typed = textOf(await call("browser_type", { tab, ref: "e11", text: "héllo 日本" }));
    expect(typed).toContain('+ textbox "Name" value="héllo 日本" [ref=e11]');
    expect(typed).toContain('- textbox "Name" [ref=e11]');
    expect(fake.calls.find((c) => c.method === "Input.insertText").params.text).toBe("héllo 日本");
    expect(textOf(await call("browser_select", { tab, ref: "e12", values: ["L"] }))).toContain('Selected "L" in e12');
    expect(textOf(await call("browser_press_key", { tab, key: "super+a" }))).toContain("Pressed super+a");
    expect(fake.calls.find((c) => c.method === "Input.dispatchKeyEvent").params).toMatchObject({ type: "rawKeyDown", modifiers: 4, commands: ["selectAll"] });
    const read = textOf(await call("browser_read", { tab, max_chars: 8 }));
    expect(read).toContain("Body of ");
    expect(read).toContain("call again with offset=8");
    expect(textOf(await call("browser_navigate", { tab, url: "https://example.com/" }))).toContain("not reloading");
    expect(fake.count("Page.navigate")).toBe(1); // open_tab's own
    expect(textOf(await call("browser_navigate", { tab, url: "https://other.example/" }))).toContain("URL: https://other.example/");
    expect(fake.count("Page.navigate")).toBe(2);
    expect(fake.count("Target.activateTarget") + fake.count("Page.bringToFront")).toBe(0); // never stole focus
  });

  test("click that raises a dialog returns promptly; dialog is reported and handled", async () => {
    const { call, open } = setup();
    const tab = await open("https://example.com/");
    const t0 = Date.now();
    const clicked = textOf(await call("browser_click", { tab, ref: "e10" }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(clicked).toContain(`A JavaScript confirm dialog is open in ${tab}: "Delete everything?"`);
    expect(textOf(await call("browser_snapshot", { tab }))).toContain("frozen until you call browser_handle_dialog");
    expect(textOf(await call("browser_list_tabs", {}))).toContain("[confirm dialog open]");
    expect(textOf(await call("browser_handle_dialog", { tab, accept: false }))).toContain("Dismissed the confirm dialog");
    expect(textOf(await call("browser_handle_dialog", { tab, accept: true }))).toContain("No dialog is open");
  });

  test("new-tab links open as background tabs; if Helium still takes the front, the previous app gets it back", async () => {
    const { fake, call, open, fronts, activated } = setup();
    const tab = await open("https://example.com/");
    const r = textOf(await call("browser_click", { tab, ref: "e14" }));
    expect(r).toContain("opened it in the background as t3");
    expect(r).toContain("URL: https://docs.example/");
    expect(fake.calls.filter((c) => c.method === "Target.createTarget").at(-1).params).toEqual({ url: "about:blank", background: true, newWindow: false });
    expect(fake.calls.filter((c) => c.method === "Page.navigate").at(-1).params).toEqual({ url: "https://docs.example/" });
    expect(fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type !== "mouseMoved").length).toBe(0);
    expect(activated).toEqual([]);
    fronts.push("com.example.editor", "net.imput.helium");
    expect(textOf(await call("browser_press_key", { tab, key: "Return" }))).toContain("Helium came to the front during browser_press_key; com.example.editor was put back in front.");
    expect(activated).toEqual(["com.example.editor"]);
    fronts.push("net.imput.helium", "net.imput.helium"); // Helium already in front: left alone
    await call("browser_press_key", { tab, key: "Return" });
    expect(activated.length).toBe(1);
  });

  test("screenshots (viewport, element, full page) are returned and saved", async () => {
    const { codexHome, call, open } = setup();
    await call("browser_list_tabs", {}); // user tab is t1
    const tab = await open("https://example.com/");
    const vp = await call("browser_screenshot", { tab });
    expect(vp.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(textOf(vp)).toContain("viewport 800×600");
    expect(textOf(await call("browser_screenshot", { tab, ref: "e10" }))).toContain("element e10");
    expect(textOf(await call("browser_screenshot", { tab: "t1", full_page: true }))).toContain("full page"); // user's tab, read-only
    expect(fs.readdirSync(path.join(codexHome, "shots")).length).toBe(3);
  });

  test("upload only into a file input, only existing absolute files", async () => {
    const { fake, call, open } = setup();
    const tab = await open("https://example.com/");
    const file = path.join(tmp(), "a.txt");
    fs.writeFileSync(file, "x");
    expect(textOf(await call("browser_upload_file", { tab, ref: "e13", paths: [file] }))).toContain("Attached a.txt to e13");
    expect(fake.calls.find((c) => c.method === "DOM.setFileInputFiles").params).toEqual({ files: [file], backendNodeId: 13 });
    expect(textOf(await call("browser_upload_file", { tab, ref: "e10", paths: [file] }))).toContain("not an <input type=file>");
    expect(textOf(await call("browser_upload_file", { tab, ref: "e13", paths: ["/nope/missing.txt"] }))).toContain("not a file");
    expect(textOf(await call("browser_upload_file", { tab, ref: "e13", paths: ["rel.txt"] }))).toContain("must be absolute");
    expect(fake.count("DOM.setFileInputFiles")).toBe(1);
  });

  test("cleanup closes agent tabs (incl. ones they opened) unless kept, releases claims, never closes user tabs", async () => {
    const { fake, b, call } = setup({ userTabs: [{ title: "A", url: "https://a.example/" }, { title: "B", url: "https://b.example/" }] });
    await call("browser_list_tabs", {}); // user tabs are t1, t2
    await call("browser_open_tab", { url: "https://x.example/" }); // t3
    await call("browser_open_tab", { url: "https://y.example/" }); // t4
    expect(textOf(await call("browser_click", { tab: "t3", x: 40, y: 170 }))).toContain("A new tab t5 was opened by t3");
    await call("browser_keep_tab", { tab: "t4", reason: "deliverable" });
    await call("browser_claim_tab", { tab: "t1" });
    const closeUser = await call("browser_close_tab", { tab: "t2" });
    expect(closeUser.isError).toBe(true);
    const out = textOf(await call("browser_cleanup", {}));
    expect(out).toContain("closed t3, t5; kept t4; released t1");
    expect([...fake.targets.values()].map((t) => t.url).sort()).toEqual(["https://a.example/", "https://b.example/", "https://y.example/"]);
    await call("browser_open_tab", {}); // session end closes unkept tabs too
    await b.close();
    expect(fake.targets.size).toBe(3);
  });

  test("guide: own rules always; OpenAI policy docs loaded at runtime when installed", async () => {
    const home = tmp();
    expect(browserGuide(home)).toContain("Never open, drive or connect to Google Chrome");
    expect(browserGuide(home)).not.toContain("OpenAI's browser policy");
    const docs = path.join(home, "plugins/cache/openai-bundled/browser/9.1.0/docs");
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, "browser-safety.md"), "# Safety marker");
    expect(browserGuide(home)).toContain("# Safety marker");
    const { call } = setup();
    expect(textOf(await call("browser_list_tabs", {}))).toContain("Browser rules"); // first result carries the rules once
    expect(textOf(await call("browser_list_tabs", {}))).not.toContain("Browser rules");
  });
});

describe("browser: helpers", () => {
  test("validation, key parsing, AX formatting", () => {
    expect(validateBrowser("browser_click", { tab: "t1" })).toContain("needs ref or both x and y");
    expect(validateBrowser("browser_click", { tab: "t1", ref: "button" })).toContain("ref must look like");
    expect(validateBrowser("browser_navigate", { tab: "t1", url: "https://a", action: "back" })).toContain("exactly one");
    expect(validateBrowser("browser_type", { tab: "t1", text: "" })).toBeNull();
    expect(validateBrowser("browser_bogus", {})).toContain("unknown tool");
    expect(parseKey("ctrl+shift+k")).toMatchObject({ key: "K", code: "KeyK", modifiers: 10, text: undefined });
    expect(parseKey("Return")).toMatchObject({ key: "Enter", text: "\r" });
    expect(() => parseKey("hyper+x")).toThrow("unknown modifier");
    const lines = formatAXTree([
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", role: { value: "checkbox" }, name: { value: "Agree" }, properties: [{ name: "checked", value: { value: "true" } }], backendDOMNodeId: 5 },
    ]);
    expect(lines).toEqual(['- checkbox "Agree" [checked] [ref=e5]']);
    expect(BROWSER_TOOLS.every((t) => t.name.startsWith("browser_"))).toBe(true);
  });
});

describe("browser: shim routing", () => {
  test("tools/list includes browser tools; browser calls never start the engine; non-Helium port refused", async () => {
    const fake = startFakeCdp();
    const dir = tmp();
    const p = spawn(NODE, [path.join(ROOT, "src/shim.mjs")], {
      env: { ...process.env, HOME: dir, OAI_CUA_STATE_DIR: path.join(dir, "state"), OAI_CUA_MCP_JSON: path.join(dir, "missing.json"), OAI_CUA_HELIUM_CDP: String(fake.port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(() => { fake.stop(); try { p.kill("SIGKILL"); } catch {} });
    let buf = "", id = 0;
    const waiters = new Map();
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
    const rpc = (method, params) => new Promise((r) => { const i = ++id; waiters.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })).result;
    expect(init.instructions).toContain("browser_*");
    const tools = (await rpc("tools/list", {})).result.tools;
    expect(tools.filter((t) => t.name.startsWith("browser_")).length).toBe(BROWSER_TOOLS.length);
    expect(tools.find((t) => t.name === "browser_snapshot").annotations.readOnlyHint).toBe(true);
    const r = (await rpc("tools/call", { name: "browser_list_tabs", arguments: {} })).result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("only Helium is allowed");
    expect(fake.calls.length).toBe(0);
  });
});
