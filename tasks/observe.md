# observe — observation efficiency + multi-step composition

Done = all items below implemented or proven infeasible (VERIFICATION.md), `bun run check` green,
live probe of this worktree's shim shows each capability, PR squash-merged.

- [x] Read engine docs/types; live-probe engine (REPL persistence, diff markers, mac window API)
- [x] Finding: engine diff baseline is shared across sessions → compute per-session diffs in the bridge
- [x] get_app_state modes: auto|full|text|diff|screenshot; first call full, later diff
- [x] Clear labelling: full tree vs diff vs no change (actions + get_app_state)
- [x] Screenshot-only → next tree observation is full
- [x] Diff whole entries (multi-line values), only changed value lines; full tree when diff isn't smaller
- [x] batch tool: ordered steps, per-step validation, one cell, one state read per app, stop at first failure
- [x] run_cua_js + reset_repl (opt-in OAI_CUA_ENABLE_JS=1, installer --enable-js/--disable-js)
- [x] Chrome: static check; in-REPL guard proven impossible (engine freezes cua.computer) → removed; approval decline holds from scripts
- [x] Output limit (~25k tokens / 8 images) for all tool results
- [x] Bridge cells don't leak top-level bindings into the user's REPL namespace
- [x] Window targeting: infeasible on macOS API (evidence) → documented Window-menu workaround, verified live
- [x] Tests (fake engine) for every new behaviour (52 pass after rebase)
- [x] README + VERIFICATION (dated, measured)
- [x] Live probe of worktree shim (scratch TextEdit docs only, closed afterwards)
- [x] PR #6, link, rebase (actions, guidance, service, browser), check (65 pass), squash-merge
