# browser thread: Helium browser surface

Done = every capability below works against Helium over CDP (live probe of this
worktree's shim against a disposable Helium profile), Chrome is refused,
`bun run check` is green, README + VERIFICATION updated, PR squash-merged.

- [x] Study Codex browser stack (docs, browser-service backends, cua browser APIs)
- [x] Decide: OpenAI backend reuse vs own CDP client (own client; evidence in VERIFICATION)
- [x] Verify a disposable Helium profile runs beside the user's instance
- [x] src/browser.mjs: CDP client (node WebSocket), endpoint discovery, Helium-only verification
- [x] list tabs / claim / open in background / navigate without focus
- [x] snapshot with stable refs (backendDOMNodeId)
- [x] click / type / select / press_key by ref
- [x] page + element screenshots (incl. background tabs)
- [x] file upload into input[type=file]
- [x] JS dialog detection + handling
- [x] read text from background tabs
- [x] tab cleanup (agent tabs closed on cleanup/exit unless kept; claimed tabs released)
- [x] behaviour rules: own text + runtime-loaded OpenAI docs (browser_guide)
- [x] Chrome ban: refuse endpoints owned by Google Chrome / non-Helium
- [x] tests with fake CDP server
- [x] live probe of shim against disposable Helium
- [x] fix: mouseMoved 5s stall in hidden tabs
- [x] fix: new-tab links / window.open raising Helium (background-open + front restore)
- [x] README, VERIFICATION
- [ ] ask user about enabling remote debugging in their live Helium (in final report)
- [x] close disposable instance
- [ ] PR, rebase, check, squash-merge
