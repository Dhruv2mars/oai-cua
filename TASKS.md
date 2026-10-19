# Project audit

Done means every requested deliverable in the original Claude thread is checked
against current code and local evidence, reproducible defects are documented,
and unverified behavior is explicitly identified. Audit only; do not change
implementation or user configuration.

- [x] Inventory project, instructions, and git state.
- [x] Find the original Claude T3 thread.
- [x] Map original requests and completion claims to evidence.
- [x] Independently review worker lifecycle and MCP protocol behavior.
- [x] Verify installer, local registration, routing settings, and cleanup claims.
- [x] Run isolated integration reproductions and safe live health checks.
- [x] Verify delegated findings and record severity and exact locations.
- [x] Report readiness, confirmed defects, and verification limits in AUDIT.md.

Confirmed so far: private GitHub repository and T3 registration exist; work-profile
shim and shared Codex worker are registered; both switchModelsOnFlag settings are
false, and the installed Claude CLI supports that setting. Scratch relay and
/tmp/cua-* files are absent. Current live owner was spawned by T3's Codex CLI;
its read-only list_apps call returned bootstrapTimedOut. No live input actions
were attempted. Bun --check unexpectedly executed install.mjs during verification;
the resulting personal-profile registration was removed immediately. Existing
work-profile and Codex registrations were rechecked unchanged.

Audit complete: AUDIT.md records the live startup blocker, 12 other reproduced
defects, completed deliverables, and unverified behavior. Both delegated reviews
completed and their accepted reproductions were independently rerun. Evidence
is retained under /private/tmp/openai-cua-bridge-audit-20261019/; disposable test
homes and cua-* scratch created during the audit were removed. Implementation
and remediation remain unchanged and outside this audit's scope.

## Remediation — 2026-10-19

Done (self-verifiable): `bun run check` passes (syntax + regression tests);
installed registration launches the new shim; a fresh `claude -p` session on the
work profile lists the real tool schemas and completes get_app_state + a
reversible TextEdit input through Claude→shim→cua-repl→SkyComputerUseService;
cursor/frontmost samples unchanged during actions; two sessions drive different
apps concurrently; idle release, engine kill/recovery, multiple clients, failed
runtime and session EOF verified live; legacy Codex worker removed; every AUDIT
finding annotated fixed or inapplicable with evidence in VERIFICATION.md.

Key discovery: ChatGPT.app ships `@oai/cua-repl` (Codex's unified-computer-use
plugin server). Launched from a Claude/T3 process it reaches
SkyComputerUseService over its native pipe with the ChatGPT GUI **not running**
(listApps 11ms, TextEdit AX+screenshot 238ms, background typing). So the
app-trust worker/socket is unnecessary: the shim drives cua-repl directly.

- [x] Investigate app-free path (cua-repl works without ChatGPT GUI).
- [x] Measure engine: background input, cursor/frontmost unchanged, Unicode
      typeText drops é/日 (use paste; clipboard restored).
- [x] Rewrite: shim → per-session engine (cua-repl) with lifecycle/timeouts.
- [x] Installer: execFile args, preflight-before-mutate, persisted env, remove
      legacy Codex worker via `codex mcp remove`, backups, verification.
- [x] Regression tests with fake cua-repl + `bun run check`.
- [x] Routing: server instructions; native computer-use disable mechanism.
- [x] Live install; kill legacy workers; clean stale socket/state.
- [x] Live verification via fresh `claude -p` (schemas, state, input, concurrency,
      idle, crash recovery, multi-client, failed runtime, EOF).
- [x] Independent review; re-verify; VERIFICATION.md, README, AUDIT annotations.
- [x] User request: never open Chrome. Chrome quit; user data, updater agents
      and caches moved to ~/.Trash/chrome-removed-20261019; bridge refuses
      /chrome/i apps and disables browser surface; rule added to CLAUDE.md and
      ~/.codex/AGENTS.md. Pending: root-owned /Applications/Google Chrome.app and
      /Library Google updater agents/daemons need the user's sudo.
- [x] Apply review findings (5/5); re-run check (20/20) + live lifecycle + fresh session.
