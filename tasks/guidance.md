# guidance thread checklist

Done = OpenAI's model-facing computer-use guidance reaches Claude at runtime (instructions, resources/prompts, first-use docs once per session), a repo skill teaches the workflow, tool descriptions carry OpenAI's guidance, `bun run check` green, live `claude -p` probe proves delivery.

- [x] Inventory OpenAI model-facing texts (cua docs, sky docs/skills, Codex plugin skills + plugin.json, NODE_REPL_INSTRUCTIONS_*, cua-repl instructions, first-use docs)
- [x] src/guidance.mjs: runtime discovery (version-following, graceful when missing), resources, prompts
- [x] MCP `instructions` from installed policy within Claude Code's 4096-char cap
- [x] First-use docs: capture from handshake + bootstrap output, pass through once per session
- [x] Filter REPL "declared with const" warnings (found live)
- [x] Tool descriptions: parity with OpenAI guidance
- [x] skills/openai-computer-use/SKILL.md (own text) + install.mjs symlink with backup
- [x] Tests (fake engine emits bootstrap docs; resources; prompts; instructions budget; skill install)
- [x] README + VERIFICATION
- [x] Live probe: shim over stdio + fresh `claude -p --mcp-config` against worktree
- [x] Rebase on origin/main (#2 merged: paste, audio, modifiers); merged tool descriptions, API map, skill newline section
- [ ] PR, squash-merge
