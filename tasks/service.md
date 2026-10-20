# Thread "service" — SkyComputerUseService parity

- [x] Locate native client + how ChatGPT/Codex launches it
- [x] Native `mcp` tools/list (initialize + tools/list only)
- [x] Find a launch route the service accepts (disclaimed spawn under ChatGPT's signed node)
- [x] Socket route from cua-repl cells (closed: no nativePipe for user cells)
- [x] Benchmark native vs cua-repl (no win → native not adopted for core tools)
- [x] Record & Replay API discovery (event-stream mcp)
- [x] Computer History discovery (computer-history mcp, IPC-only start/clear)
- [x] Lock screen / menu bar / stopApplication notes (control-owned → document only)
- [x] src/native.mjs: native MCP client transport (disclaim spawn, lazy, idle release, consent forwarded to the human)
- [x] Record & Replay tools: record_start / record_status / record_stop
- [x] recording_to_skill converter (schema-tolerant, redacting, own wording)
- [x] Computer History tools, opt-in (env gate), status/settings/pause/resume
- [x] Fake native client + regression tests
- [x] README tool list + env vars
- [x] VERIFICATION.md dated section with evidence
- [x] Live probe of worktree shim (read-only status calls)
- [x] bun run check green; commit, PR #4, link, rebase, squash-merge
