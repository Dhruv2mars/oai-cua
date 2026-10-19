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
- Non-ASCII `type_text` goes through the engine's paste. The engine's own typing
  drops characters such as `é` and `日`. The engine restores your clipboard
  afterwards.
- The engine asks for per-app access approval. The shim grants it automatically.
  OpenAI's service still enforces its own denied and forbidden app policy.
- **Google Chrome is blocked.** Any app name matching `chrome` is refused.
  Approval is also declined when the service resolves an app to Chrome, and the
  browser surface and Chrome backend are disabled.

Tools: `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`,
`scroll`, `drag`, `set_value`, `select_text`, `perform_secondary_action`.

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

The installer changes nothing unless every preflight passes. It then does four
things:

1. Registers the shim as user-scoped `openai-computer-use` in
   `$CLAUDE_CONFIG_DIR/.claude.json`, using argv with no shell. It persists any
   `CODEX_HOME` and `OPENAI_CUA_*` overrides in the server's env.
2. Adds `deniedMcpServers: [{serverName: "computer-use"}]` to
   `$CLAUDE_CONFIG_DIR/settings.json`, so Claude's built-in computer use can't
   claim GUI tasks. Pass `--keep-native` to skip this.
3. Removes the v0.1 `openai-cua-worker` from the Codex config with
   `codex mcp remove`, and stops any legacy worker processes.
4. Writes `0600` backups of every file it changes to
   `~/.openai-cua-bridge/backups/`. That directory is mode `0700`.

Already-running Claude sessions keep their old server process until you run
`/mcp` → reconnect, or restart the session.

Overrides:

- `OPENAI_CUA_IDLE_MS`: idle release. Default 300000; 0 disables it.
- `OPENAI_CUA_CALL_TIMEOUT_MS`: per-call timeout. Default 60000.
- `OPENAI_CUA_MCP_JSON`: path to a cua-repl manifest.
- `OPENAI_CUA_APP`: ChatGPT.app path, used for the fallback.
- `CODEX_HOME`, `OPENAI_CUA_STATE_DIR`.

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
