# plugin thread checklist

Done = `claude plugin validate --strict .` and `bun run check` pass; in an empty temp CLAUDE_CONFIG_DIR the `mcp__plugin_oai-cua_computer-use__*` tools are listed and a live `list_apps` / `get_app_state` works; uninstall removes the plugin data dir; PR squash-merged after the rebrand.

- [x] .claude-plugin/plugin.json (+ version-sync test), marketplace.json (source ./), .mcp.json (state → ${CLAUDE_PLUGIN_DATA})
- [x] userConfig: enable_js, computer_history (booleans; shim accepts "true"), approval (auto|prompt|deny-unknown)
- [x] Remove install.mjs, install-bridge script, installer tests, and skills/ (a plugin would auto-load it)
- [x] README: two-line install, prerequisites, options, update/uninstall, migration, --doctor
- [x] Evidence: --plugin-dir init tool list; local marketplace install → mcp list → live list_apps + get_app_state(Finder) → options toggle tools → uninstall removes data dir
- [x] Old deniedMcpServers {serverName: "computer-use"} does not block the plugin's server
- [x] PR + link (#8)
- [x] Rebrand (#7) + control (#9) merged; rebuilt on main with OAI_CUA_* names; added `approval` option (new on main); re-verified
- [ ] Squash-merge
