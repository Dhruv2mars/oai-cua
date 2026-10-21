# Changelog

## 1.0.0 (2026-10-21)

First stable release.

- Needs Node 22 or later. The browser tools use Node's built-in `WebSocket`, and on older Node they now say so instead of reporting "connection refused".
- No Command Line Tools install dialog on Macs without Xcode tools: the focus helper is only compiled when a developer directory exists, otherwise focus restore uses osascript. A helper that stops answering is dropped for osascript.
- Browser: a tab the user opens from a claimed tab is no longer closed at cleanup. Screenshots by ref don't scroll the user's tabs. Agent tabs stay yours across a reconnect to Helium. `browser_read` is bounded, and browser results share the ~25k-token output cap.
- A numeric-string `timeout_ms` works. An accessibility tree too long to be returned whole is not used as the next diff's baseline.
- `shim.log` rotates at about 1 MB. A relative or unsubstituted `OAI_CUA_STATE_DIR` falls back to `~/.oai-cua`.
- Removed: the `OPENAI_CUA_*` environment names (use `OAI_CUA_*`), and the package `bin` entry.
- MIT license, CI on macOS, CHANGELOG and a release script. The README says up front that this is unofficial and depends on private ChatGPT interfaces.

## 0.2.2 (2026-10-20)

- Browser clicks and keys actually reach background tabs.

## 0.2.1 (2026-10-20)

- Acceptance-test fixes: approval prompts in T3 Code, a turn ending no longer blocks other clients, stops, a docs leak, and an `open_tab` race.

## 0.2.0 (2026-10-20)

- Packaged as the `oai-cua` Claude Code plugin (renamed from openai-cua-bridge).
- Drives OpenAI's installed computer-use engine directly: no ChatGPT window, no OpenAI model calls.
- Per-app approval, `stop_app` and turns, takeover handling, actionable errors and focus restore.
- Observation modes with per-session diffs, `batch`, and opt-in `run_cua_js` / `reset_repl`.
- Helium browser surface over CDP (Helium only, background tabs).
- Record & Replay, and opt-in Computer History.
- OpenAI's computer-use guidance delivered at runtime. Richer actions: click modifiers and hold, key hold and aliases, paste formats, audio, and post-action screenshots.
