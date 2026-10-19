# openai-cua-bridge

Use the **OpenAI / Codex computer-use engine** (the same one the ChatGPT desktop
app uses) from **Claude Code** on macOS — screenshots + accessibility tree +
real input, driven in the background without taking over your cursor or screen.

No OpenAI models are called. No OpenAI binaries are vendored here. This only
launches the computer-use client already installed on your Mac and bridges its
MCP protocol to Claude Code.

## How it works

OpenAI's `SkyComputerUseService` authorizes a client by its **process ancestry**:
the responsible process must be a trusted OpenAI app (`com.openai.codex`, i.e.
the ChatGPT desktop app) that also holds the macOS **Automation** permission.
Launching the client from Claude Code directly is rejected (`bootstrapTimedOut` /
untrusted sender). So the bridge splits in two:

```
Claude Code ──stdio──▶ shim ──unix socket──▶ worker ──▶ SkyComputerUseClient ──▶ SkyComputerUseService
(T3 Code)                                     ▲
                                              └─ spawned by the ChatGPT app (responsible = app ⇒ authorized)
```

- **worker** (`src/worker.mjs`) — registered in `~/.codex/config.toml`, so the
  ChatGPT app spawns it; it inherits app-trust, owns one authorized client,
  auto-accepts the per-app access prompt, and serves a Unix socket. Extra spawns
  become harmless keep-alive stubs; the idle client is released after a timeout.
- **shim** (`src/shim.mjs`) — registered with Claude Code; a trust-less stdio
  proxy to the worker's socket. `tools/list` is served from cached live schemas;
  `tools/call` is proxied; if the worker is down you get a clear error.

Tools exposed: `list_apps`, `get_app_state` (screenshot + numbered a11y tree),
`click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`, `select_text`,
`perform_secondary_action`.

## Requirements

- macOS, with the **ChatGPT desktop app** (Codex) installed and its Computer Use
  runtime present under `~/.codex/computer-use/`.
- The ChatGPT app **must be running** — it is the trust + Automation-permission
  anchor. Its window may be closed, but the process must be alive. There is no
  way to use OpenAI's engine without it (no standalone service launcher exists).
- Node 18+.

## Install

```sh
node install.mjs
```

This registers the worker with Codex, registers the shim with Claude Code (user
scope), and prints how to disable Claude's native computer-use. Then, with the
ChatGPT app running, start or resume one Codex conversation so the app spawns the
worker.

## Caveats / status (v0.1)

- **App required & resource cost.** The ChatGPT app idles at ~GBs of RAM; that is
  the price of reusing OpenAI's engine. Closing its window frees some.
- **Worker spawn is tied to the app's session machinery.** The app spawns the
  worker from `config.toml`; if no worker is up, the shim returns an actionable
  error. Making the worker reliably always-on (a detached keeper that retains
  app-trust vs. a pinned session) is the next open item.
- **Private IPC.** Relies on OpenAI's internal computer-use protocol; a ChatGPT
  app update can change paths/behavior and break the bridge.
- `OPENAI_CUA_CLIENT_PATH`, `CODEX_HOME`, `OPENAI_CUA_IDLE_MS` override defaults.

## License

MIT. Not affiliated with or endorsed by OpenAI or Anthropic.
