# control — user control, safety and reliability parity

Done = all items below implemented (or proven infeasible in VERIFICATION.md),
`bun run check` green with fake-engine regression tests, a live probe of this
worktree's shim showing each capability, PR squash-merged to main.

## Research (done)
- [x] Engine approval elicitation shape (`computer-use-policy.js`): message, `_meta.riskLevel`, `subtitle`, `persist`, `tool_params.app` (bundle id), `tool_params_display`. Asked on every wrapped call; persistence is the host's job.
- [x] Error codes only survive as message text across the sky service RPC (`errors.js` code table).
- [x] Public cua API has no stop/turn-end; a bridge-owned trusted node_repl service can reach `ComputerUseIPCAppStopRequest {app: appPath}` and `ComputerUseIPCCodexTurnEndedRequest {threadID, turnID}`.
- [x] AppStop releases the session and blocks the app "for this turn"; TurnEnded clears it for the next turn and fences late calls carrying the ended turn id. cua-repl `turn_ended` tool is a no-op today (no trusted handler registered).
- [x] Cell timeout is suspended while an elicitation is pending.
- [x] Headless Claude Code advertises `elicitation` but auto-answers `cancel` in ~4 ms.
- [x] `NSRunningApplication.activate(.activateIgnoringOtherApps)` from a background Swift helper: <1 ms call, frontmost in ~22 ms (vs ~140 ms osascript).

## Implementation
- [x] approval.mjs: session + persistent (0600) approvals, MCP elicitation forwarding, fast-cancel fallback, OPENAI_CUA_APPROVAL=auto|prompt|deny-unknown (prompt = native macOS dialog), Chrome hard-block
- [x] engine: async elicitation replies, shim timer paused during approval, turn metadata on every cell, trusted bridge service env
- [x] bridge-service.mjs: resolve / stopApp / turnEnded allowlist
- [x] turn lifecycle: new turn after idle gap / cancellation / stop_app; TurnEnded IPC + cua-repl `turn_ended`
- [x] stop_app tool
- [x] takeover: keyboard actions refresh + retry once; index/coord actions return error + fresh state + hand-back guidance
- [x] diagnose.mjs: map engine errors to actionable messages
- [x] display-name lookup retry by bundle id
- [x] focus.mjs + focus-helper.swift: frontmost guard + restore, OPENAI_CUA_RESTORE_FOCUS=0
- [x] tests (fake engine) for each behaviour
- [x] README + VERIFICATION
- [x] live probe: approval, stop_app, takeover/diagnostics, Helium cmd+t focus sampler
- [x] rebase onto main (#2–#6): re-ported onto structured payloads, focus guard handles batch targets, stop_app remembers resolved bundle ids
- [x] PR #9 opened + linked, check green, squash-merged

## Found along the way
- [x] Turn metadata needs `session_id` (not just `thread_id`) for TurnEnded to clear a stop
- [x] Turn-end cell must carry the ended turn's metadata
- [x] Post-action focus check alone left Helium front ~620 ms → helper now pushes activation events (≈100 ms)
- [x] Display names with trailing space / "(Nightly)" suffix normalized for the bundle-id retry
- [x] Takeover cannot be provoked live without real user input (documented in VERIFICATION.md)
