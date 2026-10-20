# openai-cua-bridge

Use OpenAI's **computer-use engine** (the one ChatGPT/Codex desktop uses) from
**Claude Code** on macOS: screenshots, accessibility trees and real input, run
in the background without moving your cursor or changing the frontmost app.

No OpenAI model is called. No OpenAI binaries are vendored here. **The ChatGPT
app does not need to be running.** It only has to be installed, because the
engine ships inside it.

## How it works

```
Claude Code ──stdio MCP──▶ src/shim.mjs ──stdio MCP──▶ cua-repl ──native pipe──▶ SkyComputerUseService
(T3 Code)                  (this repo)                 (in ChatGPT.app)           (~/.codex/computer-use)
```

ChatGPT.app bundles `@oai/cua-repl`, the MCP server behind Codex's
`unified-computer-use` plugin. Its signed `node_repl` runtime connects to
`SkyComputerUseService` over the service's native pipe. That works from a
process that Claude/T3 launches, even while the ChatGPT GUI is closed.

The shim starts one engine per Claude session, lazily, on the first tool call.
It turns each Claude tool call into a short JavaScript cell for OpenAI's `cua`
API. Arguments are embedded as JSON literals.

- `get_app_state` returns the numbered accessibility tree plus a JPEG screenshot.
- Actions return the updated accessibility state, as a diff.
- `type_text` types single-line printable ASCII as keystrokes. Text with a
  newline, carriage return or tab, or any non-ASCII character, goes through the
  engine's paste instead. That way a newline can never become a Return press
  that submits a form, and characters the engine's own typing drops (`é`, `日`)
  arrive intact. The engine restores your clipboard afterwards.
- `paste` inserts plain text, or rich text rendered from Markdown (`format: "md"`)
  or HTML (`format: "html"`). It goes to the current focus. The macOS engine
  has no `element_index` for paste; only its browser tabs do.
- `click` takes `modifiers`, a key chord held for the whole click (`"shift"`,
  `"super"`, `"super+shift"`), and `hold_ms`, the mouse-down time (0–30000).
  `press_key` takes `hold_ms` too. The engine's key names are case-sensitive
  and it rejects `control`, `option` and `Cmd`, so the shim maps `cmd`,
  `command`, `control`, `option`, `opt`, `⌘`, `⌃`, `⌥` and `⇧`, in any case,
  to `super`, `ctrl`, `alt` and `shift`.
- Every action accepts `screenshot: true` to also return a screenshot of the
  state after the action, so a coordinate click can be checked in one call.
- `start_audio_recording` and `stop_audio_recording` record the computer's
  audio output (loopback, not the microphone) as a 24 kHz stereo WAV.
  `stop_audio_recording` returns the file path and duration, and with
  `include_audio: true` it also returns MCP audio content, up to 10 MB. The
  engine only registers audio when started with `SKY_ENABLE_AUDIO=1` and
  `NODE_REPL_ENABLE_AUDIO=1`. The shim sets both, unless
  `OPENAI_CUA_AUDIO=0`. It accepts the engine's "record computer audio"
  approval only during a `start_audio_recording` call and declines it at any
  other time. The engine is kept alive until the recording ends.
- The engine asks for per-app access approval. The shim grants it automatically.
  OpenAI's service still enforces its own denied and forbidden app policy.
- **Google Chrome is blocked.** Any app name matching `chrome` is refused.
  Approval is also declined when the service resolves an app to Chrome, and the
  engine's own browser surface and Chrome backend are disabled.

Tools: `list_apps`, `get_app_state`, `click`, `type_text`, `paste`,
`press_key`, `scroll`, `drag`, `set_value`, `select_text`,
`perform_secondary_action`, `start_audio_recording`, `stop_audio_recording`,
plus the `browser_*` tools for Helium (below).

### OpenAI's guidance, delivered at runtime

Claude gets the same model-facing guidance OpenAI gives its own model. The text
is read from the installed ChatGPT.app and `~/.codex` at startup (plugin paths
follow the newest installed version) and is never copied into this repo
(`src/guidance.mjs`):

- **Server instructions:** our short workflow rules plus the most important
  sections of OpenAI's confirmation policy (`tinysky-alt-confirmations.md`),
  within Claude Code's 4096-character cap. If the file is missing, a short
  policy of our own is used instead.
- **Resources** (`openai-cua://…`): the cua docs, macOS sky docs and skills,
  the cua-repl tool texts, the Codex `computer-use` plugin skill, plugin
  manifests and `NODE_REPL_INSTRUCTIONS_*` strings. There is also
  `openai-cua://bridge/guide`, which maps the cua API onto these tools, and
  `openai-cua://engine/first-use`.
- **Prompts:** `computer-use` (guide + first-use docs + Codex skill, with an
  optional task) and `confirmation-policy` (verbatim).
- **First-use documentation:** a fresh engine prints its core docs and policy
  before any output. The shim captures that text, including after an engine
  restart, and puts it once per session at the front of the next tool result,
  with a note mapping OpenAI's tool names (`js`, `node_repl`) onto these tools.

The Claude Code skill `skills/openai-computer-use/SKILL.md` (our own text)
teaches the observe/act/verify loop, app targeting, newline caveats, the
confirmation taxonomy and this setup's defaults: Helium only, never Chrome,
delegate computer use to Haiku subagents, and no AppleScript/osascript/JXA/
System Events/CGEvent for UI work.

### Record & Replay (native client)

`record_start`, `record_status`, `record_stop` and `recording_to_skill` use the
Record & Replay MCP server built into OpenAI's `SkyComputerUseClient`
(`event-stream mcp`), loaded from `~/.codex/computer-use/` at runtime.

- `record_start` records **your** clicks, typing and window content for up to
  30 minutes. OpenAI's service asks for consent first. The shim forwards that
  prompt to Claude Code as an MCP elicitation, so you answer it. The shim never
  answers it. A client without elicitation support can't start a recording.
- `record_stop` returns the paths to `events.jsonl` and the session metadata.
- `recording_to_skill` turns the recording into a draft
  `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (mode `0600`) with inputs, steps
  and replay guidance. It drops secure-input events and redacts text that looks
  like a secret. It won't overwrite an existing skill unless you pass
  `overwrite: true`. Claude then refines the draft with you.

The service only answers a client whose parent is OpenAI-signed and whose
responsible process may send it Apple Events. The shim therefore launches
`python3 src/spawn-disclaimed.py` → ChatGPT's signed `cua_node` →
`SkyComputerUseClient`. The python step disclaims responsibility. It needs
python3 from Homebrew, `/usr/local` or the Xcode Command Line Tools, or set
`OPENAI_CUA_PYTHON`. The client is released when idle, but not while a
recording is running.

### Computer History (opt-in, off by default)

Set `OPENAI_CUA_COMPUTER_HISTORY=1` to expose `computer_history_status`,
`computer_history_get_settings`, `computer_history_update_settings`,
`computer_history_pause` and `computer_history_resume`. Without it the tools
are not listed, and the bridge never contacts the recorder.

- The bridge can't turn Computer History on. Starting it, and clearing it, are
  only possible in ChatGPT's settings.
- Computer History is OpenAI's rolling local log of the apps, windows and URLs
  you use. It writes event segments under
  `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Caches/ComputerUse/Skysight`.
  ChatGPT summarizes them into memories with `codex exec`.
- The service applies its own observe and do-not-observe rules before anything
  is written. These tools only read or replace those rules, or pause and resume
  the recorder. `resume` and `update_settings` change what gets recorded, so
  Claude should only call them when you ask.

### Helium browser surface (`browser_*` tools)

Web pages in **Helium** get a real browser surface, comparable to what Codex's
browser plugin gives the model for Chrome. It is driven over the Chrome DevTools
Protocol with Node's built-in `WebSocket` (`src/browser.mjs`, no dependencies)
and works on **background tabs**: Helium is never brought to the front.

| Tool | What it does |
| --- | --- |
| `browser_list_tabs` | Tabs with ids (`t1`…), titles, URLs and flags (`[agent]`, `[claimed]`, `[kept:…]`, open dialog). Touches no tab. |
| `browser_open_tab` | New background tab (optionally a background window). Returns its snapshot. |
| `browser_claim_tab` | Take control of one of the user's tabs. Claimed tabs are released, never closed. |
| `browser_navigate` | URL, back, forward or reload without focusing. The URL a tab already shows is not reloaded. |
| `browser_snapshot` | Accessibility tree with stable refs (`[ref=e42]` = DOM backend node id). Diff against the previous snapshot by default. |
| `browser_read` | Page text, paged by `offset`/`max_chars`. Works in background tabs. |
| `browser_screenshot` | JPEG of the viewport, full page or one element (by ref). Also saved under `~/.openai-cua-bridge/screenshots/` (last 30 kept). |
| `browser_click` / `browser_type` / `browser_press_key` / `browser_select` | Input by ref or x/y. Any Unicode. Each action returns the snapshot diff, new tabs it opened, and any dialog it raised. |
| `browser_upload_file` | Files into an `<input type=file>` without a file picker. |
| `browser_handle_dialog` | Accept or dismiss alert/confirm/prompt/beforeunload. |
| `browser_keep_tab` / `browser_close_tab` / `browser_cleanup` | Tab cleanup. Tabs the session opened are closed on cleanup and at session end unless kept as a deliverable or handoff. |
| `browser_show_tab` | Bring a tab to the front, only when the user wants to see it. |
| `browser_guide` | Our browser rules plus OpenAI's `browser-safety` and `confirmations` docs, loaded at runtime from the installed Codex browser plugin. The rules are also attached to the first browser result of each session. |

Rules enforced in code:

- **Helium only.** Every endpoint must be on loopback. The process listening on
  the port is resolved (`lsof` → executable → `CFBundleIdentifier`) and must be
  `net.imput.helium`. Google Chrome is refused by bundle id and by executable
  path, and so is anything else. The check runs again after connecting.
- **The user's tabs are read-only** until `browser_claim_tab`. Only tabs the
  session opened can be closed.
- **No focus stealing.** Tabs open with `background: true`. A link that would
  open a new tab is opened as a background tab instead of being clicked. If a
  page still raises Helium (e.g. `window.open`), the app that was in front gets
  focus back, and the result says so.
- **Dialogs never hang a call.** Input races against `Page.javascriptDialogOpening`.

**Enabling it (once, by the user):** in Helium open
`chrome://inspect/#remote-debugging` and turn on *Allow remote debugging for
this browser instance*. No restart is needed. Helium then shows an
*Allow remote debugging?* prompt when a session first connects. Until it is on,
browser tools return these instructions, and Helium can still be used through
`get_app_state("Helium")`.

Other endpoints: `OPENAI_CUA_HELIUM_CDP` (port or `ws://` URL) and
`OPENAI_CUA_HELIUM_USER_DATA_DIR` (colon-separated profile dirs whose
`DevToolsActivePort` is read). Both still go through the Helium-only check.

### Engine lifecycle

| Event | What happens |
| --- | --- |
| Engine idle (default 5 minutes) | Released. Idle time never starts while a call is queued or running. |
| Engine crashes, or its REPL is killed | The next call restarts it. A read-only call that was in flight is retried once. |
| Engine hangs | The call times out (default 60s) and the engine is replaced. |
| Session ends (stdin EOF or SIGINT) | The engine's whole process group is stopped, with SIGKILL after 1.5s. No orphaned processes are left. |
| A call is cancelled | If still queued, it never runs. If running, its engine is stopped. |
| Startup | Readiness means a real `cua.getState` with no service errors. A broken or unauthorized service returns a precise error, never a false "ready". |

Several Claude sessions run independent engines. OpenAI's service serves them
concurrently.

## Requirements

- macOS, with the ChatGPT desktop app installed and its Computer Use plugin
  enabled once. That plugin creates `~/.codex/computer-use/` and the
  `unified-computer-use` plugin manifest.
- macOS Accessibility and Screen Recording permission for Codex Computer Use,
  granted once, as for ChatGPT itself.
- Node 18+ for the shim. Bun runs the tests.

## Install / check

```sh
node install.mjs        # preflight (incl. a live engine call) → register → verify
bun run check           # syntax + regression tests (fake engine, no GUI)
bun run doctor          # live: runtime discovery + engine + list_apps timing
```

The installer changes nothing unless every preflight passes. It then does five
things:

1. Registers the shim as user-scoped `openai-computer-use` in
   `$CLAUDE_CONFIG_DIR/.claude.json`, using argv with no shell. It persists any
   `CODEX_HOME` and `OPENAI_CUA_*` overrides in the server's env.
2. Adds `deniedMcpServers: [{serverName: "computer-use"}]` to
   `$CLAUDE_CONFIG_DIR/settings.json`, so Claude's built-in computer use can't
   claim GUI tasks. Pass `--keep-native` to skip this.
3. Removes the v0.1 `openai-cua-worker` from the Codex config with
   `codex mcp remove`, and stops any legacy worker processes.
4. Symlinks the skill to `$CLAUDE_CONFIG_DIR/skills/openai-computer-use`, so it
   follows the repo like the registered shim does. Anything already there is
   backed up first. Pass `--skip-skill` to skip this.
5. Writes `0600` backups of every file it changes to
   `~/.openai-cua-bridge/backups/`. That directory is mode `0700`.

Already-running Claude sessions keep their old server process until you run
`/mcp` → reconnect, or restart the session.

Overrides:

- `OPENAI_CUA_IDLE_MS`: idle release. Default 300000; 0 disables it.
- `OPENAI_CUA_CALL_TIMEOUT_MS`: per-call timeout. Default 60000.
- `OPENAI_CUA_AUDIO`: `0` turns computer-audio recording off.
- `OPENAI_CUA_MCP_JSON`: path to a cua-repl manifest.
- `OPENAI_CUA_APP`: ChatGPT.app path, used for the fallback and for OpenAI's docs.
- `OPENAI_CUA_INSTRUCTIONS_MAX`: server instructions budget. Default 4096.
- `CODEX_HOME`, `OPENAI_CUA_STATE_DIR`.
- `OPENAI_CUA_COMPUTER_HISTORY=1`: expose the Computer History tools. Off by default.
- `OPENAI_CUA_PYTHON`, `OPENAI_CUA_NATIVE_CLIENT`, `OPENAI_CUA_NATIVE_PARENT`:
  the python3, `SkyComputerUseClient` and signed parent `node` used for the
  native client.

## Limits

- **Private interface.** The bridge uses OpenAI's internal `cua` JavaScript API
  and plugin layout. A ChatGPT update can change them. The shim prefers the
  newest plugin manifest that the app writes, so paths follow updates.
  `bun run doctor` shows breakage quickly.
- **Resources.** Each active session runs one cua-repl (node, about 38 MB) plus
  a `node_repl` (about 13 MB). The engine is released when idle. When needed,
  `SkyComputerUseService` (about 86 MB) is launched by macOS and exits on its
  own.
- Approval is automatic, so Claude Code's own tool permissions are the gate.

Measured results are in [VERIFICATION.md](VERIFICATION.md). The v0.1 audit is
in [AUDIT.md](AUDIT.md).

## License

MIT. Not affiliated with or endorsed by OpenAI or Anthropic.
