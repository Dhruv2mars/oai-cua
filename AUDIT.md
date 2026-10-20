# Project audit — 2026-10-19

> Project renamed to oai-cua on 2026-10-20. Names below were updated to the
> new ones (server `oai-cua`, `OAI_CUA_*`, `~/.oai-cua`). The runs themselves
> used the pre-rename names (openai-cua-bridge, openai-computer-use, OPENAI_CUA_*).

**Verdict: the scaffolding and registration work is largely complete; the bridge
does not meet the requested reliable, ready-to-use standard. The current live
installation failed a read-only engine call.**

Reviewed commit `8f981ce91360f05f1d7614909a735d7915fa538b`, all tracked files,
all 100 user/assistant messages in the original Claude thread, relevant execution
records, and its cleanup delegate. Original thread:
[Computer Use in ChatGPT and Codex](t3-thread://v1/0f54eb7e-96bc-4b0e-bf1e-a37737c918f6).
Two independent review agents examined worker lifecycle and shim/installer
behavior. Their accepted reproductions were rerun by the parent.

## What was actually completed

- GitHub repository exists, is private, and `HEAD` matches `origin/main`.
- T3 project exists at the correct workspace; this audit runs in it.
- `~/.codex/config.toml` registers the worker. The OpenAI client exists.
- `~/.claude-work/.claude.json` registers the shim for the work profile.
  The personal profile had no shim registration at the start of this audit.
- `switchModelsOnFlag` is false in both personal and work settings. The installed
  Claude CLI 2.1.303 contains this setting and describes pausing instead of
  automatically switching models when safeguards flag a message.
- The old relay directory, downloaded package, temporary probes and config
  backups identified by the cleanup delegate were absent before audit fixtures
  were created. OpenAI's installed runtime remains. No matching CUA signing
  identity appeared in the current read-only keychain check.
- Node syntax checks pass for all four modules. There are no repository tests,
  test script, or CI workflow. The earlier thread only syntax-checked the final
  implementation and smoke-tested its worker-down behavior.

## Live failure: worker ownership is not tied to app trust

**P1 — `src/worker.mjs:42–49`, `install.mjs:38`.** The installer registers the
worker in shared Codex configuration. Any Codex client can launch it, including
the Codex CLI inside T3. The first reachable socket wins; no successful engine
call or trust check is required. Later workers become permanent stubs.

Observed process ancestry at audit time:

```text
worker 44700 → Codex CLI 44632 → Node 44586 → T3 Code 26933 → T3 Code 26887
```

The worker log nevertheless said `responsible-via=app` and recorded later workers
deferring to it. A socket `ping` succeeded in 8ms. A real `tools/call` for
`list_apps` returned `isError: true`, text `bootstrapTimedOut`, in 5775ms.
This confirms that socket availability and `bridge-up` do not establish engine
readiness. A valid app-launched worker would also defer to this existing socket
under the current code. The desktop app cannot fix that just by spawning another
instance. Restrict ownership to a successfully authorized worker and make health
reflect that result.

## Other reproduced defects

1. **P1 — retired-client callbacks kill or crash the replacement.**
   `src/worker.mjs:73–85`. Exit/output callbacks refer to the mutable global
   `client`. With idle=500ms and a fake client taking 300ms to terminate, its
   eventual exit killed the newly started client and failed that client's request
   with `client released`. Late elicitation output after release crashed at
   line 85 with `Cannot read properties of null (reading 'stdin')`. Capture each
   child instance and ignore obsolete callbacks.

2. **P1 — installer paths undergo shell command expansion.** `install.mjs:52`.
   JSON string quoting does not safely quote Bash arguments. In an isolated copy
   named `repo-$(touch INJECTED)`, installation executed the harmless marker
   command and registered a truncated shim path. This requires a specially named
   checkout; it is not evidence of exploitation on this machine. Use an argument
   array with `execFileSync`/`spawnSync`.

3. **P1 — valid TOML can be broken by installation.** `install.mjs:34–39`.
   `[mcp_servers."openai-cua-worker"]` is a valid spelling of the table, but the
   string check misses it and appends the same table again. Installation exits
   successfully while the parser rejects duplicate keys. A commented copy of
   the unquoted header causes the opposite problem: registration is skipped.
   Existing entries pointing at an old checkout are also never updated.

4. **P2 — launch and stream errors crash the worker.** `src/worker.mjs:82` and
   `src/lib.mjs:55–58`. A missing executable caused unhandled `ENOENT`, exit 1,
   and a stale socket. A valid overridden client also failed when the unrelated
   fixed `CLIENT_CWD` directory was absent (`src/lib.mjs:13–20`). Closing the
   stdout reader and sending a stdio ping caused unhandled asynchronous `EPIPE`.
   Catching exceptions around `write()` does not handle stream error events.

5. **P2 — initialization is neither awaited nor validated.**
   `src/worker.mjs:100–104`. The worker sends initialized/list messages before
   receiving the initialize response and treats list errors as readiness. A fake
   client delaying initialization by 80ms rejected the early list; repeated
   bridge lists stayed empty after initialization succeeded. An explicit
   initialization rejection was also ignored.

6. **P2 — Unicode is silently corrupted across stream chunks.**
   `src/lib.mjs:38`. Decoding each buffer separately turns a split `é` into `��`,
   or a split `日` into `���`, in otherwise valid JSON. This affects both text
   input arguments and accessibility-tree output. Use streaming UTF-8 decoding.

7. **P2 — active operations are treated as idle.** `src/worker.mjs:69–75,115`.
   The idle deadline starts when a request is sent and ignores pending requests.
   With idle=150ms, a valid fake 450ms operation was terminated early with
   `client released`. The production default is 120 seconds; the test shortened
   it to reproduce the same scheduling behavior.

8. **P2 — concurrent stale-socket recovery can create two owners.**
   `src/worker.mjs:44–49,157`. A scheduling barrier paused two workers after both
   found a stale socket. Resuming them in sequence let both bind and report
   `bridge-up` on independent connections. Stopping the first removed the
   second's pathname, leaving the second alive but unreachable to new callers.
   Ordinary 24-worker bursts did not reproduce this; the controlled schedule did.

9. **P2 — fallback schemas do not refresh automatically.**
   `src/shim.mjs:44–52`, `src/lib.mjs:63–78`. Offline fallback tools have no named
   parameters or required fields. After a fake worker appeared, the shim emitted
   no `notifications/tools/list_changed`, despite advertising that capability.
   Only an explicit second list obtained actual schemas. Valid JSON `null` in
   the cache also produced invalid `tools: null`. Claude's own refresh behavior
   was not tested. In the live schemas, almost every action requires `app`.

10. **P2 — proxy timers outlive completed requests.** `src/shim.mjs:31–36`.
    After an immediate unavailable-worker response and stdin EOF, the shim
    remained alive because its 60-second timeout was never cleared. Every proxy
    request leaves such a timer until its deadline.

11. **P2 — failed preflight still mutates configuration.** `install.mjs:22–39`.
    A nonexistent client sets `exitCode` but does not stop installation. The
    isolated fixture still appended worker config and invoked Claude remove/add
    before exiting 1. Validate prerequisites before making changes.

12. **P2 — installer environment overrides are not saved.**
    `install.mjs:38,52`. Registrations contain no `CODEX_HOME`, custom client path,
    or idle environment. A later GUI launch without those variables uses defaults.
    Actual desktop app environment inheritance was not tested; the omission
    in generated registrations is confirmed.

## Claims that remain unverified

- **Final bridge driving actions through Claude/T3:** not demonstrated. The
  earlier successful proof was a separate probe returning apps and a Finder
  screenshot. The later action probe never spawned; the thread itself records
  this. Its proposed `type_text` request also omitted the required `app` argument.
- **No cursor movement, no foreground changes, and parallel app behavior:**
  no completed action, focus/cursor measurement, or live multi-app test in the
  recorded verification. Reusing the engine alone does not verify these claims
  for this integration.
- **Always-on operation or surviving session/app shutdown:** unresolved in the
  original thread and not tested here. The shared-worker startup defect above
  must be addressed before a useful live lifecycle test.
- **Native Claude computer use explicitly disabled / guaranteed routing:** the
  installer only prints manual instructions. The prior check established an
  absence of selected MCP configuration entries, not actual tool availability
  and routing in a fresh Claude session. No explicit native-server disable or
  routing policy is installed by this repository.
- **Universal impossibility of app-free use:** this implementation depends on
  an app-authorized launch, and prior alternatives failed. The recorded tests
  and absence of a LaunchAgent do not establish impossibility of every other
  arrangement. No app-free implementation was delivered.
- **Socket isolation:** current state directory/socket modes are `0755`, and
  a fixture with umask `002` produced `0775`. Explicit private modes are absent.
  Cross-user access was not exercised; no cross-user exploit is claimed.

## Validation and handoff

Isolated tests used fake clients and temporary homes; live testing only pinged
the bridge and called read-only `list_apps`. Forty concurrent fake tool requests
shared one client and all succeeded. No live input actions, app shutdown,
implementation changes, commits, pushes, or PRs were performed.

Reproduction harnesses and captured worker results are retained at
`/private/tmp/openai-cua-bridge-audit-20261019/` (temporary evidence, not a shipped
test suite). Run harnesses with `rtk proxy bun <harness.mjs>`; they run project
worker/shim subprocesses with Node and isolated HOME/CODEX_HOME. The concurrent
ownership harness uses a temporary preload only to control scheduling.

During audit, `bun --check install.mjs` unexpectedly executed the installer.
Its added personal-profile shim registration was removed immediately; the
resulting personal config structurally matches the pre-operation automatic
backup. Existing work/Codex registrations were rechecked unchanged. Syntax
verification was repeated with `node --check`.

Fix trusted ownership and retired-client handling first, then the installer and
protocol/transport defects. Before calling this ready, demonstrate a fresh
Claude/T3 session listing real schemas and completing a reversible input task,
then test idle restart, worker failure/recovery, concurrent apps, and session
closure while measuring foreground/cursor behavior.

---

## Resolution — v0.2 (2026-10-19)

The text above is the historical audit of v0.1 (`8f981ce`). v0.2 removes the
app-trust worker, Unix socket and Codex registration. OpenAI's own `cua-repl`
runtime reaches `SkyComputerUseService` from a Claude-launched process with
the ChatGPT GUI closed, so app trust is no longer needed. Claude's shim now
drives that runtime directly. Evidence is in VERIFICATION.md.

| Finding | Status | How |
| --- | --- | --- |
| Live blocker (untrusted socket owner, false health) | Inapplicable / fixed | There are no shared owners. Each session owns its engine. Readiness requires a real `getState` with no service errors (`src/engine.mjs` handshake). Failures are reported precisely (live test: unreachable service). The legacy registration and processes were removed by the installer. |
| 1 Retired client callbacks | Fixed | Per-instance state. Exit only clears `cur` if it is the same instance. Test: "retired engine's late exit…", mutation-verified. |
| 2 Shell injection in installer | Fixed | `spawnSync` argv only. Test: repo path `repo-$(touch INJECTED)`. |
| 3 TOML string editing | Inapplicable | The installer no longer writes TOML. Legacy removal uses `codex mcp remove`. |
| 4 Launch/stream errors crash | Fixed | Handlers for `error` on the process, stdin, stdout and stderr. Missing runtime returns a clear error and the shim stays up. Tests: missing runtime, crash. |
| 5 Initialize not awaited/validated | Fixed | Initialize is awaited and validated, and the first cell is checked. Tests: slow init, rejected init, auth failure. |
| 6 Per-chunk UTF-8 | Fixed | `StringDecoder`. Test: byte-by-byte stream, mutation-verified. Live: non-ASCII `type_text` via paste. |
| 7 Idle kills active work | Fixed | The idle timer only arms when nothing is queued or running. Test: 450ms call with 150ms idle, mutation-verified. |
| 8 Stale-socket double owner | Inapplicable | There is no socket. |
| 9 Fallback schemas / list_changed | Inapplicable / fixed | Complete static schemas are always served. There is no cache and nothing to refresh. |
| 10 Shim timers delay exit | Fixed | Request timers are cleared on settle. On stdin EOF or a signal, the shim stops the engine and exits explicitly. Test: EOF exit in under 1s and engine gone. |
| 11 Preflight still mutates | Fixed | All checks run, including a live engine call, before any write. Test: failed preflight leaves files untouched and makes no `claude mcp` calls. |
| 12 Env overrides not persisted | Fixed | `CODEX_HOME` and `OAI_CUA_*` are written into the registration's `env`. Test asserts this. |
| State/socket permissions | Fixed | The state dir is `0700`, and the log and backups are `0600`. There is no socket. |
| Native computer use routing | Fixed | `deniedMcpServers` entry for `computer-use`, a supported mechanism. Server `instructions` route GUI tasks. |
