#!/usr/bin/env node
// Test double for OpenAI's SkyComputerUseClient (`event-stream mcp`,
// `computer-history mcp`). Records every request in $FAKE_LOG.
// Knobs (env): FAKE_EVENTS_DIR (where a recording is written), FAKE_HISTORY_STATE.
import fs from "node:fs";
import path from "node:path";

const E = process.env;
const record = (ev) => fs.appendFileSync(E.FAKE_LOG, JSON.stringify({ pid: process.pid, native: true, ...ev }) + "\n");
const sub = process.argv.slice(2).join(" ");
record({ ev: "native-spawn", sub, ppid: process.ppid });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });

let rec = { isRecording: false, maxDurationSeconds: 1800 };
let settings = { observation: { allowlist: [], blocklist: [], defaultApplicationBehavior: "observe", defaultURLBehavior: "observe" } };
let state = E.FAKE_HISTORY_STATE || "stopped";
const pending = new Map();
let nextId = 0;
const ask = (method, params) => new Promise((r) => { const id = `srv-${++nextId}`; pending.set(id, r); send({ jsonrpc: "2.0", id, method, params }); });
let initCaps = {};

async function tool(name, args) {
  record({ ev: "native-call", sub, name, args });
  switch (name) {
    case "event_stream_status": return ok(rec);
    case "event_stream_start": {
      if (rec.isRecording) return ok(rec);
      if (!initCaps.elicitation) return err("Record & Replay approval requires an MCP client that supports elicitation.");
      const r = await ask("elicitation/create", { _meta: { persist: ["always"] }, message: "Allow ChatGPT to record your actions on your Mac?", requestedSchema: { type: "object", properties: {} } });
      record({ ev: "native-elicit-result", action: r?.action });
      if (r?.action !== "accept") return err(`Record & Replay approval ${r?.action === "cancel" ? "cancelled" : "denied"} via MCP elicitation.`);
      const dir = path.join(E.FAKE_EVENTS_DIR, "session-1");
      fs.mkdirSync(dir, { recursive: true });
      rec = { isRecording: true, maxDurationSeconds: 1800, sessionID: "session-1", eventsPath: path.join(dir, "events.jsonl"), metadataPath: path.join(dir, "session.json") };
      return ok(rec);
    }
    case "event_stream_stop": {
      if (rec.isRecording) {
        const ev = [
          { type: "session.started", timestamp: 1 },
          { type: "window.changed", application: { localizedName: "TextEdit", bundleIdentifier: "com.apple.TextEdit" }, window: { title: "Notes" } },
          { type: "mouse.click", application: { localizedName: "TextEdit", bundleIdentifier: "com.apple.TextEdit" }, button: "left", clickCount: 1, target: { role: "AXButton", title: "New Document" } },
          { type: "keyboard.text_input", target: { role: "AXTextArea", title: "Body" }, text: "Hello " },
          { type: "keyboard.text_input", target: { role: "AXTextArea", title: "Body" }, text: "world" },
          { type: "keyboard.text_input", secureInput: true, text: "hunter2" },
          { type: "keyboard.text_input", target: { role: "AXTextField", title: "Token" }, text: "sk-abcdefghijklmnopqrstuvwxyz" },
          { type: "keyboard.shortcut", modifiers: ["command"], keyEquivalent: "s" },
          { type: "session.ended", endReason: "recording_controls_stopped" },
        ];
        fs.writeFileSync(rec.eventsPath, ev.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
        rec = { ...rec, isRecording: false, endReason: "recording_controls_stopped" };
      }
      return ok(rec);
    }
    case "computer_history_status": return ok({ state, eventStreamRootPath: "/tmp/Skysight" });
    case "computer_history_get_settings": return ok(settings);
    case "computer_history_update_settings": settings = args; return ok(settings);
    case "computer_history_pause": state = state === "running" ? "paused" : state; return ok({ state });
    case "computer_history_resume": state = state === "paused" ? "running" : state; return ok({ state });
    default: return err(`unknown tool ${name}`);
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method == null) { pending.get(m.id)?.(m.result); pending.delete(m.id); continue; }
    if (m.method === "initialize") { initCaps = m.params?.capabilities ?? {}; record({ ev: "native-init", caps: initCaps }); send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }); }
    else if (m.method === "tools/call") tool(m.params.name, m.params.arguments).then((result) => send({ jsonrpc: "2.0", id: m.id, result }));
  }
});
process.stdin.on("end", () => { record({ ev: "native-eof", sub }); process.exit(0); });
process.on("SIGTERM", () => { record({ ev: "native-sigterm", sub }); process.exit(0); });
