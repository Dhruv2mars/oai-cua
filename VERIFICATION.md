# Verification — v0.2 (2026-10-19)

**Machine:** macOS (Darwin 25.6.0). Claude Code 2.1.303, work profile
`CLAUDE_CONFIG_DIR=~/.claude-work`, running under T3 Code.
**OpenAI side:** ChatGPT.app 26.1013.40934 is installed, but its main process
was **not running** for any test below (`pgrep` of `ChatGPT.app/Contents/MacOS`
found nothing).

All GUI input went into disposable fixtures only:

- `/tmp/cua-remediate/fixture-*.txt`, opened in TextEdit with `open -g`
- Calculator

## Automated (`bun run check`)

The check runs `node --check` on every module, then 20 bun tests. The tests use
a fake cua-repl that executes the generated cells against a fake `cua` API.
They cover:

- protocol and complete schemas
- EOF exit
- tool translation (click by index or coordinates, ASCII typing, paste for non-ASCII)
- validation and the Chrome block
- elicitation auto-accept
- UTF-8 split across chunks
- slow, rejected and unauthorized engine start
- missing runtime
- idle release that doesn't hit active calls
- a retired engine's late exit
- crash with retry and recovery
- hung-engine timeout and replacement
- cancellation: a queued cancelled call never runs; a running one stops its engine; no response is sent
- process-group shutdown of an engine that ignores SIGTERM, including its descendants
- Chrome declined by the identity the service resolves, even when the app name hides it
- 40 concurrent calls on one engine
- installer: argv-only execution in a `$(touch INJECTED)` path, persisted env,
  native computer-use deny that keeps existing settings, legacy removal,
  backups, the settings file's permission mode kept, a failed preflight
  (missing runtime, `null`, malformed or wrong-typed settings) that changes
  nothing, and a failed registration that restores the previous one

Mutation check: each of these bugs was reintroduced, and the matching test
failed:

- per-chunk UTF-8 decoding
- idle timer armed at request time
- retired exit clearing the global engine
- leader-only kill
- no Chrome decline
- queued cancellation ignored

## Live (real Claude → shim → cua-repl → SkyComputerUseService)

| Check | Result |
| --- | --- |
| Installer | Preflight ran a live `list_apps` (650ms). It then registered the shim (`claude mcp get` reports connected), denied `computer-use` (`switchModelsOnFlag:false` and the other settings were kept), removed `openai-cua-worker` from `~/.codex/config.toml`, and stopped 3 legacy workers. Backups are `0600` in `~/.openai-cua-bridge/backups`. |
| Fresh `claude -p` session, work profile | `mcp_servers: openai-computer-use connected`. All 10 tools are present with real schemas; Claude reported that `type_text` requires `app` and `text`. `get_app_state(TextEdit)` returned the AX tree and 1 image. click, `press_key super+Down` and `type_text " \| claude-e2e ✓ 42"` landed in the fixture, confirmed by AppleScript reading the document. |
| Background behaviour | Two sessions ran at the same time, about 20 actions including 9 clicks, and cold-launched Calculator. Across 916 samples at 50 Hz in that window, the cursor had **0 position changes** and the frontmost app stayed **Helium**. Frontmost was also Helium in all 4,500 samples over 110 s. Earlier probes: a coordinate click left 150 cursor samples unchanged. |
| Concurrent apps | Session A appended " \| session-A" to the TextEdit fixture. Session B computed 12+30 = **42** in Calculator by clicking buttons. Their calls interleaved between 18:17:06 and 18:17:18Z, each on its own engine. |
| Unicode | Engine `typeText` dropped `é`, `日` and `ü`, so the bridge pastes non-ASCII text. `ünïcödé 日本 ✓` arrived intact, and the clipboard hash was unchanged before and after the paste. |
| Latency | Cold start plus `list_apps`: about 650–700ms. Warm `get_app_state` with screenshot: 63ms. Actions, including returning the updated AX diff: about 0.45–0.6 s. |
| Idle recycle | With idle set to 3 s, the engine and its REPL were gone after 4.5 s. The next call started a new engine and succeeded. |
| Engine death | `kill -9` of cua-repl, then of its `node_repl`: the next `get_app_state` succeeded in about 0.75 s on a new engine. |
| Failed service / authorization | With the native pipe pointed at a nonexistent socket, the call failed after 6 s with "engine is not authorized/ready: … native pipe startup failed" plus the doctor hint. No false readiness, and the shim stayed up. |
| Bad input | Invalid element: `server error -10005: 9999 is an invalid element ID`. Unknown app: `Invalid app`. Chrome: refused without starting the engine. |
| Session lifecycle | On EOF the shim exits in under 50ms. Claude's SIGINT at session end stops the engine. After each run, no engine or REPL processes owned by the bridge survived. |
| Native computer use | Claude 2.1.303 registers it as dynamic MCP server `computer-use` only behind a feature flag (cached `tengu_malort_pedway` is false here). It is per-project opt-in through `enabledMcpServers`, and no project had it. The installer adds the supported user-level `deniedMcpServers` entry. Shim `instructions` (under the 4096-char limit) route GUI tasks. |

## Independent review

Codex gpt-6.1-sol (high) reviewed the code read-only. It confirmed there is no
JavaScript injection in `buildCell`, and that the redesign makes the ownership
blocker and findings 3, 8 and 9 inapplicable. It reported 5 issues, all fixed
and covered by the tests above:

1. Shutdown could leave a SIGTERM-ignoring engine or its `node_repl` running.
   Fix: the engine runs in its own process group with bounded SIGKILL
   escalation, and the shim waits for it.
2. MCP cancellation was ignored.
3. The Chrome block was name-based only. Fix: the engine's approval request is
   also declined by the bundle id the service resolves.
4. Installer: settings were validated after the registration changed, and a
   failed add left no registration. Fix: settings are validated in preflight,
   and the previous registration is restored on failure.
5. The settings rewrite could loosen the file's mode. Fix: the original mode is
   kept.

After the fixes, the full live set was re-run: installer (idempotent), idle
release, `kill -9` of the engine and of its REPL, no orphans, and a fresh
`claude -p` session appending " | post-review ✓" to the fixture. Cold start was
then about 1.3 s, with or without the process-group change, so the difference
from the earlier ~0.7 s comes from service and machine state.

The Chrome identity refusal was deliberately **not** exercised live, because
the user forbids opening Chrome. In the post-fix session, Claude also declined
a `get_app_state("Google Chrome")` request on its own, citing the user's rule.

## Real-world acceptance (Claude Haiku 5.5, separate T3 Claude Code session)

A fresh T3-delegated Claude Code child on the work profile (shim pid 35507) used
only the bridge tools for a trip-budget task:

- `list_apps` worked.
- In Calculator, which it cold-launched in the background, it computed
  128.50 + 64.25 + 39.90 = **232.65** by clicking buttons.
- It wrote the line items, the total, and `café ☕ 日本 ✓` into a scratch TextEdit
  document. The text matched byte-for-byte when read back with AppleScript.
- An invalid element returned a clean `-10005` error and the session recovered.
- Cursor and frontmost app (T3 Code) were identical before and after.
- Cleanup was complete. The shim log shows no failures.
- Verdict: **PASS**.

## Remaining limits

- **The ChatGPT app must stay installed.** Its main process does not need to
  run.
- **Private interface.** The bridge relies on OpenAI's internal `cua` API and
  plugin manifest layout. App updates may break it; `bun run doctor` detects
  that.
- **Clean-machine permissions.** The first-ever Accessibility and
  Screen Recording grants were already in place on this machine. The flow
  needed to grant them on a clean Mac was not exercised.
- **Old shim processes.** Claude sessions started before the install still run
  the v0.1 shim in memory until `/mcp` reconnect or a restart.
- **T3-launched sessions.** The fresh-session tests used `claude -p` from this
  T3 environment, with the same binary and profile T3 launches. A brand-new T3
  thread was not opened, per the instruction not to create threads.

## 2026-10-20 — action parity (thread `actions`)

Live runs drove the worktree's `node src/shim.mjs` over stdio JSON-RPC (engine
26.1013.40934). Targets were a scratch rich-text TextEdit document,
`actions-rich.rtf`, and Finder with the inert key F19. `bun run check`: 26/26
pass.

**Key names (engine, raw `press_key`, Finder + F19).** Accepted: `super`, `cmd`,
`command`, `Command`, `ctrl`, `Control_L`, `alt`, `Alt_L`, `meta`, `Meta_L`,
`shift`, `Shift_L`, `Super_L`, `Super_R`. Rejected with `keyNotFound`:
`control`, `Control`, `Ctrl`, `option`, `Option`, `opt`, `Cmd`, `Alt`,
`Super`, `SHIFT`, `fn`, `hyper`, `win`. Names are case-sensitive (`return`,
`tab`, `Space`, `esc`, `up` and `Enter` are rejected), and a modifier-only
chord fails with `keyPressIncludedNoNonModifierKeys`. The shim therefore maps
`cmd`/`command`/`control`/`option`/`opt`/`⌘⌃⌥⇧` in any case to
`super`/`ctrl`/`alt`/`shift`. Through the shim, `control+F19` and
`Option + Cmd + F19` succeed.

**click modifiers.** In the scratch document, a click at the start of line 1
followed by a plain click at x=78 left an empty `AXSelectedText`. The same pair
with `modifiers: "shift"` on the second click selected `actions rich s`.

**hold_ms is honoured** (same engine session, the delta is the hold):

| call | time |
| --- | --- |
| click `hold_ms: 0` | 626 ms |
| click `hold_ms: 3000` | 3658 ms |
| press_key F19 `hold_ms: 0` | 473 ms |
| press_key F19 `hold_ms: 2000` | 2518 ms |
| click `hold_ms: 30001` | rejected by the shim: `hold_ms must be from 0 to 30000` |

**paste formats and multi-line type_text.** These were read back through
AppleScript as paragraph text plus per-word font:

- `type_text "\nline two\nline three café"` produced the separate paragraphs
  `line two` and `line three café`, inserted with one paste.
- `paste format:"md" "**boldword** then plain"` produced `boldword` in
  Times-Bold, then Times-Roman.
- `paste format:"html" "<i>italword</i> then <b>htmlbold</b>"` produced
  Times-Italic for `italword` and Times-Bold for `htmlbold`.
- `paste format:"text" "**literal stars**"` kept the asterisks literally.
- The clipboard contents were byte-identical before and after the run.
- `screenshot: true` on `click` and `paste` returned a JPEG of the
  post-action window, about 30–39 KB of base64, next to the AX diff.

**paste element_index.** This is not possible on macOS. The `App.paste` in
`types.d.ts` is `paste(text, options)`. Only the browser `Tab.paste` takes an
`elementIndex`, so the tool documents focusing first.

**Audio.**

- With `SKY_ENABLE_AUDIO=1` and `NODE_REPL_ENABLE_AUDIO=1`, `cua.computer` gains
  `start_audio_recording` and `stop_audio_recording`, and
  `nodeRepl.emitAudio` exists. Without the flags, neither is present. The keys
  were listed live.
- A raw 1.5 s recording produced
  `/var/folders/.../sky-computer-audio-<uuid>.wav`. `afinfo` reports 2 ch,
  24000 Hz, Int16, 1.500 s, 146176 bytes. `emitAudio` returned an `audio/wav`
  MCP content item.
- The engine asks "Allow Computer Use to record computer audio?". The shim
  accepted it only inside the `start_audio_recording` cell (shim.log:
  `approved: Allow Computer Use to record computer audio?`). The fake-engine
  tests prove that it is declined in every other cell.
- In a real Claude Code (Haiku 5.5) session wired to the worktree shim,
  `start_audio_recording {max_duration_ms: 1000}` followed by
  `stop_audio_recording {include_audio: true}` returned
  `sky-computer-audio-DA4BB81A-….wav`, 1.04 s, 103936 bytes, WAV (24 kHz
  stereo). Claude Code received it as a 101.5 KB `audio/wav` block.

**Audit of the macOS `App` API (types.d.ts, bind_mac_app.js).** Every method and
option is now exposed: click `mouseButton`, `clickCount`, `key` and
`durationMs`; pressKey `durationMs`; paste `format`; selectText
`prefix`, `suffix` and `selectionType`; fractional scroll `pages`; drag;
setValue; and performSecondaryAction. `scroll {pixels}` is excluded because
`bind_mac_app.js` throws "macOS scroll accepts pages, not pixels.".
`windowId` references and `AppInfo.windows` are excluded because they are
Linux/Windows only. Observation options (`emit`, `disableDiffing`) and batching
belong to thread `observe`.

**Cleanup.** The scratch document was closed without saving. During an earlier
locked-screen probe, a failed probe filter sent `super+shift+a` and
`super+comma` to Finder. The two Finder windows they opened were closed again;
the only leftover is a harmless select-all of desktop icons.
# Parity: OpenAI guidance delivered to Claude (2026-10-20)

Branch `parity/guidance`. ChatGPT.app 26.1013.40934 installed; nothing from it
is vendored. All text below was read live from the installed app.

## Automated (`bun run check`: 30 pass, 0 fail after rebasing on #2)

New tests run against a fake installed app and plugin cache built in a temp
dir (`fakeInstall`), so they don't depend on this Mac:

- instructions stay within 4096 characters, include our rules (osascript ban,
  Helium) and the priority policy sections, and list what was omitted;
- resources: cua docs, sky docs, Codex skill and plugin.json are listed; Linux
  and Windows files are dropped; the newest cached plugin version wins;
  unknown URIs return `-32002`; none of this starts the engine;
- prompts `computer-use` (with a task argument) and `confirmation-policy`;
- missing docs fall back to our own short policy;
- first-use docs come once per session ahead of the result, with the tool
  mapping. Later calls carry no docs, even though the REPL prints
  `Warning: A was declared with const` noise before the marker. A mutation
  check confirmed it: with the filter removed, this test fails;
- docs printed by a REPL that resets mid-session are captured from before the
  cell's start marker;
- the installer symlinks the skill, backs up an existing one, and is
  idempotent ("already linked").

## Live: worktree shim over stdio (`/tmp/guidance-probe/probe.mjs`)

- `initialize`: instructions are 3974 characters. They include Types of
  Instruction, Hand-Off, Always Confirm and Pre-Approval verbatim. Omitted for
  length, with a pointer to the resource: Scope, Sensitive Data &
  "Transmission", No Confirmation Needed, Confirmation Hygiene. The full policy
  still reaches the model through the first-use docs.
- `resources/list`: 27 resources. These are 5 cua docs, the macOS sky skill,
  `sky-window-api.md`, 13 cua-repl instruction texts, the Codex computer-use
  `SKILL.md`, 3 plugin manifests, `NODE_REPL_INSTRUCTIONS_*`, the guide and
  first-use.
- First `list_apps` (1.5 s, cold engine; after rebase on #2): item 0 is a 23,982-character
  first-use block (OpenAI's `## Computer Use` docs + confirmation policy, after
  our mapping note). The second call has no docs block.
  `openai-cua://engine/first-use` then returns the engine’s 22,410-character
  text.
- Bug found live and fixed: the persistent REPL's redeclaration warnings were
  being taken for first-use docs, so docs were re-sent and the resource was
  overwritten.

## Live: fresh `claude -p` session (Haiku, `--strict-mcp-config` → worktree shim)

The model answered:

1. Quoting instructions: "Never open or operate Google Chrome; the only browser
   allowed is Helium."
2. "27 resources from the openai-computer-use server."
3. Read the policy resource: "# Computer Use Confirmations Policy".
4. Called `list_apps`: the first line was "[First-use documentation from
   OpenAI's installed computer-use engine, shown once per session; …]", and it
   "contained documentation about the cua API".

A second fresh session, with the skill symlinked into a scratch project's
`.claude/skills`, found and invoked `openai-computer-use` and quoted its
"Helium is the only browser" rule. The installer was not run against the real
profile, because it would re-point the registered server at this worktree.
After merge, `node install.mjs` from the main checkout links the skill.

---

# Verification: SkyComputerUseService parity, thread "service" (2026-10-20)

Scope: the native `SkyComputerUseClient` MCP servers, Record & Replay, Computer
History (Skysight), and other service-layer features. The work used read-only
probes, plus one `record_start` whose consent prompt was **declined**. No
recording was started and no Computer History setting was changed.

## Native client: where it is and how ChatGPT launches it

- Binary: `~/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`
  (14.8 MB, arm64). Identifier `com.openai.sky.CUAService.cli`, team
  `2DC432GLL2`, hardened runtime. Its entitlements are only the app group
  `2DC432GLL2.com.openai.sky.CUAService` and keychain groups. It has **no**
  `com.apple.security.automation.apple-events`.
- ChatGPT's plugins launch it through `bin/computer-use-client-launcher`, a
  shell `exec` of the binary above. For example,
  `plugins/openai-bundled/plugins/record-and-replay/.mcp.json` runs
  `computer-use-client-launcher event-stream mcp`.
- `--experimental-dump-help` lists the subcommands: `mcp`, `event-stream mcp`,
  `computer-history mcp`, `calendar mcp`, `messages mcp` and `turn-ended`.
- `tools/list` (initialize and tools/list only) returned these tools:
  - `mcp`: the same 10 tools as the bridge (`list_apps`, `get_app_state`,
    `click`, `perform_secondary_action`, `set_value`, `select_text`, `scroll`,
    `drag`, `press_key`, `type_text`). It has no modifier hold, paste or
    batching.
  - `event-stream`: `event_stream_start`, `event_stream_status`,
    `event_stream_stop`.
  - `computer-history`: `computer_history_pause`, `_resume`, `_status`,
    `_get_settings` and `_update_settings`. The settings are `observation`:
    `defaultApplicationBehavior` and `defaultURLBehavior` (each `observe` or
    `do_not_observe`), plus `allowlist` and `blocklist` of `{scope: app|url, bundleID|urlDomain}`.
  - `calendar`: `list_calendars`, `list_events`, `get_event`, `create_event`,
    `update_event`, `delete_event`.
  - `messages`: `find_chats`, `read_messages`, `search_messages`,
    `send_message`, `count_message_activity`, `read_image`.

## Reachability: three gates, and how the bridge passes them

1. **TCC (Apple Events).** When the client is spawned directly, its first
   call hangs at bootstrap. The unified log shows:
   `tccd: Prompting policy for hardened runtime; service: kTCCServiceAppleEvents requires entitlement com.apple.security.automation.apple-events but it is missing for responsible={… com.t3tools.t3code …}`.
   The responsible process (the host app) decides the outcome.
2. **Sender authentication.** Spawning it through
   `posix_spawn` + `responsibility_spawnattrs_setdisclaim` (the client becomes
   self-responsible) gets past TCC. The service then answers
   `Computer Use server error -10000: Sender process is not authenticated`.
   Service strings show why: `CODEX_COMPUTER_USE_IPC_AUTHORIZATION_FAILURE_REASON_{MISSING_PARENT,UNTRUSTED_PARENT,RELAY_WITHOUT_TRUSTED_ANCESTOR}`,
   `trustedProcessRequirement`, `senderAncestorIdentities`, team IDs
   `2DC432GLL2`, and executables `node`, `node_repl` and `codex-acp`.
3. **Trusted parent.** ChatGPT's own `cua_node/bin/node` is signed by team
   `2DC432GLL2` and has the `automation.apple-events` entitlement. Using it as
   the client's parent, with responsibility disclaimed, works. The chain
   `python3 -I src/spawn-disclaimed.py → cua_node/bin/node -e <spawn> → SkyComputerUseClient`
   returned `list_apps` in about 600 ms. That signed node is the same runtime
   the bridge already uses for cua-repl. Nothing is vendored.

Closed alternative: an engine cell can't reach `computeruse.sock` directly.
Importing `@oai/sky/.../targets/mac/client.js` in a cua-repl cell and calling
`request("ComputerUseIPCEventStreamStatusRequest")` returned
`Sky Computer Use native pipe is unavailable`. `nodeRepl.nativePipe` is only
given to trusted service code.

## Native `mcp` vs cua-repl: benchmark (not adopted for core tools)

The test ran 3 runs of each path, in fresh processes, with the same calls.
The screen was locked, so `get_app_state` measured the IPC round trip of a
`cgWindowNotFound` reply. That error is the same on both paths.

| | cua-repl (shim) | native `mcp` |
| --- | --- | --- |
| initialize | 69–84 ms | 558–787 ms |
| first `list_apps` (cold) | 1350–1522 ms | 577–619 ms |
| cold total | ~1.42–1.61 s | ~1.18–1.41 s |
| warm `list_apps` | 9–13 ms | 8–22 ms |
| warm `get_app_state` | 6–8 ms | 8–42 ms |

Verdict: cold start is about 0.2 s faster on the native path. Warm calls are
equal. The native path has fewer features: no hold, paste or batching, and no
auto-approval (each app needs a fresh elicitation). It also needs the
python3 disclaim hop. So the core tools stay on cua-repl. The native client is
used only for the features cua-repl lacks (below).

## Record & Replay: shipped

- New tools: `record_start`, `record_status` and `record_stop`, backed by
  `event-stream mcp`. A fourth tool, `recording_to_skill`, writes a Claude
  Code `SKILL.md`. Its template and wording are our own.
- Consent: the service sends
  `elicitation/create "Allow ChatGPT to record your actions on your Mac?"`.
  The shim forwards it to the Claude client and returns that client's answer.
  If the client does not advertise elicitation, the shim does not advertise it
  to the service either, so the bridge never gives consent on the user's
  behalf. Claude Code 2.1.303 supports elicitation (`elicitation:{form:…}` in
  its binary).
- The event schema was recovered from service strings. Event types are
  `session.started|ended`, `window.changed`, `mouse.click`,
  `mouse.context_menu`, `mouse.drag`, `keyboard.text_input`, `keyboard.submit`,
  `keyboard.shortcut`, `terminal.value_changed`, `selection.changed` and
  `debug.error`. Fields include `secureInput`, `bundleIdentifier`, `button`,
  `clickCount`, `modifiers`, `target`, `origin`, `destination`,
  `keyEquivalent`, `selectedText`, `endReason` and `eventCount`. No real
  recording exists on this machine (the `Caches/ComputerUse` directory is
  absent), so the converter looks fields up tolerantly. **Unverified:** the
  exact nesting of fields in a real `events.jsonl`.
- Live probe of this worktree's shim (`/tmp/service-probe/live/probe.mjs`;
  the probe client declines every elicitation):
  ```
  ## record_status 1406ms isError=false   {"isRecording": false, "maxDurationSeconds": 1800}
  CLIENT GOT elicitation/create {"message":"Allow ChatGPT to record your actions on your Mac?","requestedSchema":{"properties":{},"type":"object"}}
  ## record_start 21ms isError=true        Record & Replay approval denied via MCP elicitation.
  ## record_status 12ms isError=false      {"isRecording": false, ...}
  ## recording_to_skill 5ms isError=false  Wrote /tmp/service-probe/live/skills/service-probe-demo/SKILL.md (4 steps, 1 inputs from 4 events)   [synthetic events file]
  ```
  `bun run doctor` now also reports
  `✓ native client (Record & Replay status, read-only): { "isRecording" : false, "maxDurationSeconds" : 1800 }`.
  This step is optional and doesn't fail the doctor.

## Computer History (Skysight): reachable, exposed only on opt-in

- Live reads, with the tools enabled by `OPENAI_CUA_COMPUTER_HISTORY=1`:
  `computer_history_status` →
  `{"state":"stopped","eventStreamRootPath":"~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Caches/ComputerUse/Skysight"}`.
  `computer_history_get_settings` → empty allow and block lists, with both
  defaults `observe`. Nothing was paused, resumed or updated live.
- The MCP surface has no start or clear. The service has the IPC requests
  `ComputerUseIPCSkysightStartRequest`, `…StopRequest` and
  `…ClearHistoryRequest`, but only over the trusted pipe (see the closed route
  above). So the bridge can't turn recording on.
- **Data it touches:** the service writes
  `Skysight/segments/<timestamp>/events.jsonl` (app, window, URL and UI events)
  and `metadata.json`, plus `suppressed.jsonl` for events that the rules
  blocked. Strings show 10-minute and 6-hour summaries made by `codex exec`
  (`--sandbox read-only --ephemeral`) from "UNTRUSTED OBSERVED INPUT". They
  also show URL policy filtering (`EventStreamURLPolicyRecordFilter`,
  `isURLBlocked`) and default exclusions for system UI such as
  `com.apple.controlcenter` and `com.apple.LocalAuthentication.UIAgent`.
  The bridge only reads status and settings and passes through rule changes.
  It never reads segment contents itself.

## Other service-layer features: documented only

- **Lock screen** (`CUALockScreenGuardian.app`, `SystemLockScreenMonitor`,
  "The Mac is locked and automatic unlock …" errors). This is control-thread
  territory. Observed here: while the Mac was locked, window calls failed with
  `-10005 cgWindowNotFound` on both paths.
- **Menu-bar status item** (`CodexStatusItemStateNotificationPublisher`,
  `ComputerUseIPCCodexStatusItemMenuStateRequest`) and **stopApplication**
  (`ComputerUseIPCAppStopRequest`). Both are reachable only over the trusted
  pipe and belong to the "control" thread (stop and takeover). Not exposed here.
- **Calendar and Messages MCP servers** are reachable by the same launch chain.
  They are not exposed: they read and write personal data, and they are
  outside this brief.

## Automated

`bun run check` → 27 pass. The new file `test/service.test.mjs` uses a fake
`SkyComputerUseClient` launched through the real python3 disclaim chain. It
covers:

- the tool list, with Computer History hidden by default
- consent forwarded to the client and accepted
- consent declined, and a client with no elicitation support (nothing is
  answered for the user)
- the SKILL.md content: secure input dropped, secrets redacted, typing merged
  into inputs, mode `0600`, no overwrite unless asked
- argument validation
- a missing client binary
- the native client stopped on shim exit
- Computer History opt-in, with nested schema validation
