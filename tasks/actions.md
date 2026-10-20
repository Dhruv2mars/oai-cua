# Thread "actions": action tools at parity with cua's macOS App API

Done = every item below is shipped (or proven infeasible in VERIFICATION.md), `bun run check` is green,
a live probe of this worktree's shim shows each capability, and the PR is squash-merged.

- [x] Research: types.d.ts, bind_mac_app.js, sky mac client, audio gate, live key-name probe
- [x] click `modifiers` → ClickOptions.key, `hold_ms` → durationMs (0..30000 integer)
- [x] press_key `hold_ms` → PressKeyOptions.durationMs
- [x] modifier alias normalization (cmd/command/control/option/opt/⌘…) → names the engine accepts (live-verified)
- [x] `paste` tool: text/md/html, clipboard restore by engine; element_index → prove unsupported on macOS
- [x] type_text: text with newlines/CR/tabs/non-ASCII goes through paste
- [x] audio: start/stop_audio_recording tools, gate enabled (SKY_ENABLE_AUDIO / NODE_REPL_ENABLE_AUDIO), approval accepted only for our start cell, engine kept alive while recording, WAV path + optional MCP audio
- [x] `screenshot: true` on every action returns post-action screenshot
- [x] audit: other macOS App methods/options (excluding observe/batch)
- [x] fake-engine regression tests
- [x] README + VERIFICATION dated section
- [x] live probe of worktree shim (screen was locked at start: CGSSessionScreenIsLocked)
- [ ] branch/commit/push/PR/link/rebase/check/squash-merge
