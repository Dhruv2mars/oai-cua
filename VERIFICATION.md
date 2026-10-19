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
