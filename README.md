# oai-cua

Use OpenAI's **computer-use engine** (the one ChatGPT/Codex desktop uses) from
**Claude Code** on macOS: screenshots, accessibility trees and real input, run
in the background without moving your cursor or changing the frontmost app.

No OpenAI model is called. No OpenAI binaries are vendored here. **The ChatGPT
app does not need to be running.** It only has to be installed, because the
engine ships inside it.

## Install

```
/plugin marketplace add Dhruv2mars/oai-cua
/plugin install oai-cua@oai-cua
```

The plugin does one thing: it adds the computer-use MCP server. Its tools
appear as `mcp__plugin_oai-cua_computer-use__<tool>`. It ships no agents,
hooks, skills or settings, and it doesn't change your settings.

**Prerequisites (set up once, yourself):**

- macOS.
- The ChatGPT desktop app installed, with its Computer Use plugin enabled once.
  That creates `~/.codex/computer-use/` and the engine's plugin manifest.
- Accessibility and Screen Recording permission for Codex Computer Use, as for
  ChatGPT itself.
- `node` 22+ on your `PATH` (the browser tools use its built-in `WebSocket`).

**Options** (`/plugin configure oai-cua@oai-cua`, or `/config`):

- `enable_js` (off): adds `run_cua_js` and `reset_repl` (see below).
- `computer_history` (off): adds the Computer History tools (see below).
- `approval` (`auto`): app-access approval when Claude Code can't ask you
  itself; `prompt` or `deny-unknown` instead (see below).

**Update:** `claude plugin update oai-cua@oai-cua`, then `/reload-plugins` or
restart. New releases arrive when the version changes. **Uninstall:**
`claude plugin uninstall oai-cua@oai-cua`. This also deletes the plugin's data
directory (logs, screenshots, state) unless you pass `--keep-data`.

**Moving from the old `install.mjs` registration:** run
`claude mcp remove -s user openai-computer-use` (or `oai-cua`, if you ran the
installer after the rename). The old installer also left a skill symlink in
`~/.claude/skills/` and a `deniedMcpServers` entry for `computer-use` in
`settings.json`. Neither is needed any more; remove them if you like.

**Health check:** `node ~/.claude/plugins/cache/oai-cua/oai-cua/<version>/src/shim.mjs --doctor`
(or `bun run doctor` in a clone) checks runtime discovery, starts the engine
and times `list_apps`.

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

- `get_app_state` observes an app's key window. Its `mode` picks what comes back:

  | `mode` | Returns |
  | --- | --- |
  | `auto` (default) | The first observation of an app in a session is `full`; later ones are `diff`. |
  | `full` | The full numbered accessibility tree plus a JPEG screenshot. |
  | `text` | The full tree, with no screenshot. |
  | `diff` | Only what changed since this session last saw the app, with no screenshot. |
  | `screenshot` | Only the image. The next tree for that app is then sent in full, so indices are never relied on unseen. |

- Actions return the state afterwards in the same form. Every result says what
  it is: `Full accessibility tree of …`, `Accessibility diff since your last
  observation of …`, or `No change …`. In a diff, `-` marks removed lines, `+`
  marks added or changed ones, unchanged ancestors are shown as context, and a
  changed multi-line value shows only its changed lines. A full tree is sent
  instead when the window changed or the diff would not be much smaller.
- Diffs are computed by the bridge, per session. The engine can diff too, but
  its baseline is shared by every session using the service, so one session's
  observation could turn into another session's "no change"
  ([VERIFICATION.md](VERIFICATION.md)).
- `batch` runs up to 50 action steps (`{tool, args}`, any action tool) in one
  engine call and reads the state once at the end, for each app it touched.
  Every step is validated before anything runs. It stops at the first failing
  step and reports which one failed, along with the state at that point.
  `screenshot: true` is a batch option there, not a step argument.
- `run_cua_js` and `reset_repl` are opt in (the `enable_js` option, or
  `OAI_CUA_ENABLE_JS=1`). `run_cua_js` runs JavaScript in the engine's
  persistent REPL with the `cua` API, as Codex's `js` tool does. Top-level
  bindings persist across calls, and the bridge's own cells don't add any.
  `reset_repl` discards them. The REPL can import Node modules such as
  `node:child_process`, so enabling it is equivalent to letting Claude run local
  code.
- Tool output is capped at about 25k tokens (100k characters, keeping the head
  and the tail) and 8 images per call, like Codex's output limit.
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
  `OAI_CUA_AUDIO=0`. It considers the engine's "record computer audio"
  approval only during a `start_audio_recording` call, through the approval
  flow below, and declines it at any other time. The engine is kept alive until the recording ends.
- **Per-app approval.** The engine asks before it uses each app. The shim
  shows you that request through MCP elicitation, with the app, its bundle id,
  OpenAI's risk level and an "Always allow" choice. It asks once per app per
  session. Always-allowed apps are saved in `approvals.json` in the state dir
  (mode `0600`). Delete an entry to be asked again. Apps always-allowed under
  the old standalone installer (`~/.oai-cua/approvals.json`) are not carried
  over to the plugin's state dir (`~/.claude/plugins/data/oai-cua-oai-cua/`);
  copy the file there to keep them. Some clients advertise
  elicitation but answer it themselves within milliseconds. No person answers
  that fast. An instant `cancel` (headless Claude Code, about 4 ms) always
  counts as "this client can't ask". An instant `decline` counts only under an
  Agent SDK host (`CLAUDE_CODE_ENTRYPOINT` `sdk-ts` or `sdk-py`, e.g. T3 Code, about 2 ms),
  whose Claude Code declines every prompt it can't show. Elsewhere it stays a
  refusal, so an Elicitation hook that declines an app still works. If such a
  host has its own deliberate decline rules, set `approval` to `prompt` or
  `deny-unknown` so they aren't replaced by `auto`. For those
  clients, and for clients without elicitation, the `approval` option
  (`OAI_CUA_APPROVAL`) decides:
  - `auto` (the default) accepts.
  - `prompt` shows a native macOS dialog.
  - `deny-unknown` declines apps that are not already allowed.

  OpenAI's service still enforces its own denied and forbidden app policy.
- **Stop and takeover.** `stop_app` ends an app's session, like the menu-bar
  "Stop" in ChatGPT. Without `app`, it stops every app the session used.
  If the user takes over an app mid-action:
  - `press_key`, `type_text` and `paste` refresh the state and retry once.
  - Index and coordinate actions return the error, fresh state and an
    instruction to hand back to the user.

  When the user stops a session, Claude is told to stop and hand back.
- **Actionable errors.** Raw engine errors gain a "What to do" line. The engine
  reports codes like `-10005` only as text. Covered cases include a stale
  element, a missing window, an unknown or ambiguous app, a declined approval,
  missing permissions, a locked screen, and a user stop or takeover. If the
  engine rejects a display name, the shim retries it once by the bundle id that
  `list_apps` reports for it.
- **Focus restore.** Some apps bring themselves to the front when they get
  background input. Helium does when it opens a tab. During each action the
  shim watches app activations. If the target app takes the front, it
  re-activates the app you were using within about 100 ms. This uses a small
  Swift helper that is compiled once into the state dir's `bin/`; without
  `swiftc` it falls back to `osascript`. Set `OAI_CUA_RESTORE_FOCUS=0` to
  turn it off.
- **Google Chrome is blocked.** Any app name matching `chrome` is refused, in
  every tool, batch step and script. App-access approval is declined when the
  service resolves an app to Chrome. The bridge answers approval outside the
  REPL, so scripts can't answer it themselves, even when they import the raw
  service client. The engine's own browser surface and Chrome backend are also disabled.
- Only the key window can be observed. On macOS, `cua.getApp` takes only an app
  name, and the API has no `listWindows` and no window parameter. To work in
  another window, click the app's **Window** menu, then click the window's
  title. This makes it the key window without bringing the app to the front.

Tools: `list_apps`, `get_app_state`, `click`, `type_text`, `paste`,
`press_key`, `scroll`, `drag`, `set_value`, `select_text`,
`perform_secondary_action`, `batch`, `stop_app`, `start_audio_recording`,
`stop_audio_recording`, the opt-in `run_cua_js` and `reset_repl`, plus the `browser_*` tools
for Helium (below).

### OpenAI's guidance, delivered at runtime

Claude gets the same model-facing guidance OpenAI gives its own model. The text
is read from the installed ChatGPT.app and `~/.codex` at startup (plugin paths
follow the newest installed version) and is never copied into this repo
(`src/guidance.mjs`):

- **Server instructions:** our short workflow rules plus the most important
  sections of OpenAI's confirmation policy (`tinysky-alt-confirmations.md`),
  within Claude Code's 4096-character cap. If the file is missing, a short
  policy of our own is used instead.
- **Resources** (`oai-cua://…`): the cua docs, macOS sky docs and skills,
  the cua-repl tool texts, the Codex `computer-use` plugin skill, plugin
  manifests and `NODE_REPL_INSTRUCTIONS_*` strings. There is also
  `oai-cua://bridge/guide`, which maps the cua API onto these tools, and
  `oai-cua://engine/first-use`.
- **Prompts:** `computer-use` (guide + first-use docs + Codex skill, with an
  optional task) and `confirmation-policy` (verbatim).
- **First-use documentation:** a fresh engine prints its core docs and policy
  before any output. The shim captures that text, including after an engine
  restart, and puts it once per session at the front of the next tool result,
  with a note mapping OpenAI's tool names (`js`, `node_repl`) onto these tools.

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
`OAI_CUA_PYTHON`. The client is released when idle, but not while a
recording is running.

### Computer History (opt-in, off by default)

Turn on the `computer_history` option (or set `OAI_CUA_COMPUTER_HISTORY=1`) to expose `computer_history_status`,
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
| `browser_screenshot` | JPEG of the viewport, full page or one element (by ref). Also saved under the state dir's `screenshots/` (last 30 kept). |
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
- **Input reaches hidden tabs.** Chromium drops mouse and key input to a
  background tab until it has drawn its current page, so each click or key
  first draws one frame (a 1×1 capture, ~50ms).
- **Refs belong to one page.** A ref is accepted only from the tab's latest
  snapshot of its current document; after a navigation, take a new snapshot.

**Enabling it (once, by the user):** in Helium open
`chrome://inspect/#remote-debugging` and turn on *Allow remote debugging for
this browser instance*. No restart is needed. Helium then shows an
*Allow remote debugging?* prompt when a session first connects. Until it is on,
browser tools return these instructions, and Helium can still be used through
`get_app_state("Helium")`.

Other endpoints: `OAI_CUA_HELIUM_CDP` (port or `ws://` URL) and
`OAI_CUA_HELIUM_USER_DATA_DIR` (colon-separated profile dirs whose
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
| Approval prompt open | The call's timeout clock pauses until you answer. |

Several Claude sessions run independent engines. OpenAI's service serves them
concurrently.

### Turns

OpenAI's service scopes some state to a *turn*. MCP has no turn boundaries, so
every call carries this session's turn id, and the shim ends the turn when one
of these happens:

- Claude makes no calls for `OAI_CUA_TURN_IDLE_MS` (default 60000; 0 disables
  this).
- A call is cancelled, for example because you interrupted Claude.
- `stop_app` runs.

At turn end the shim calls cua-repl's `turn_ended` lifecycle tool. It does
**not** send the service's own turn-ended request: while the engine that sent
it is alive, the service refuses *every other* client with "the current turn
ended", so two Claude sessions would block each other for minutes.

A stop (yours from the menu bar, or `stop_app`'s) lasts until the service's
connection to the engine closes. So `stop_app` replaces the engine at once,
and the app is released without staying blocked. A stop of yours is honoured
for the rest of the turn; when that turn ends, the engine is replaced and the
app works again in the next turn. Nothing is retried. While an audio
recording is running the engine is kept, and the replacement waits for the
next turn end after it.

Stopping and resolving apps go through a small trusted `node_repl` service of
the shim's own (`src/bridge-service.mjs`). It loads OpenAI's IPC client from
the installed app at runtime and only allows resolve and stop-app requests.

## Development

```sh
bun run check           # syntax + regression tests (fake engine, no GUI)
bun run doctor          # live: runtime discovery + engine + list_apps timing
claude --plugin-dir .   # load this checkout as the plugin
```

Bun runs the tests; the shim itself runs on Node with no dependencies. To
release, bump `version` in both `package.json` and `.claude-plugin/plugin.json`
(a test keeps them equal); installed plugins only update when it changes.

Environment overrides. The plugin sets the state dir and its three options; the
rest are for development (the pre-rename `OPENAI_CUA_*` names are still read for one release):

- `OAI_CUA_IDLE_MS`: idle release. Default 300000; 0 disables it.
- `OAI_CUA_CALL_TIMEOUT_MS`: per-call timeout. Default 60000.
- `OAI_CUA_AUDIO`: `0` turns computer-audio recording off.
- `OAI_CUA_APPROVAL`: approval fallback, `auto` (default), `prompt` or
  `deny-unknown`.
- `OAI_CUA_TURN_IDLE_MS`: quiet time that ends a turn. Default 60000.
- `OAI_CUA_RESTORE_FOCUS`: `0` disables focus restore.
- `OAI_CUA_MCP_JSON`: path to a cua-repl manifest.
- `OAI_CUA_APP`: ChatGPT.app path, used for the fallback and for OpenAI's docs.
- `OAI_CUA_INSTRUCTIONS_MAX`: server instructions budget. Default 4096.
- `CODEX_HOME`; `OAI_CUA_STATE_DIR` (the plugin's data directory under the
  plugin, otherwise `~/.oai-cua`; a relative or unsubstituted value also means
  `~/.oai-cua`). `shim.log` there is capped at about 1 MB, with the previous
  one kept as `shim.log.1`.
- `OAI_CUA_COMPUTER_HISTORY=1`: expose the Computer History tools. Off by default.
- `OAI_CUA_ENABLE_JS=1`: enables `run_cua_js` and `reset_repl`.
- `OAI_CUA_PYTHON`, `OAI_CUA_NATIVE_CLIENT`, `OAI_CUA_NATIVE_PARENT`:
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
- With the default `auto` fallback, a client that can't show elicitation gets
  automatic approval. In that case Claude Code's own tool permissions are the
  gate. Use `prompt` or `deny-unknown` for a per-app gate in headless use.
- `stop_app` and a stop from ChatGPT's menu bar are service-wide. They also end
  that app's sessions for other clients using it at the same moment.
- A stop made by *another* client lasts until that client's engine exits.
  Replacing this shim's engine doesn't clear it.
- A stop of yours ends with its turn, and `stop_app` (on any app) or 60 s of
  quiet ends the turn. So if Claude calls `stop_app` right after being told
  you stopped an app, your app is usable again at once.
- A `stopApp` sent from a `run_cua_js` script isn't followed by an engine
  replacement, so that app stays stopped for every client until the engine is
  released when idle (5 minutes). Use the `stop_app` tool instead.
- `run_cua_js` scripts can call the bridge's trusted service too. It only
  offers resolve and stop-app; neither can answer an approval.

Measured results are in [VERIFICATION.md](VERIFICATION.md). The v0.1 audit is
in [AUDIT.md](AUDIT.md).

## License

MIT. Not affiliated with or endorsed by OpenAI or Anthropic.
