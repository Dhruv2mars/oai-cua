// Fake Helium DevTools endpoint for tests: a Bun WebSocket server speaking the
// subset of CDP that src/browser.mjs uses. Every command is recorded in calls.
// Page model: one form with a button (ref e10, raises alert() when clicked),
// a textbox (e11), a <select> (e12), a file input (e13) and a link that opens
// a new tab (e14); https://empty.example/ has no elements. Like a hidden
// Chromium tab, a target drops mouse and key input until a screenshot has drawn
// a frame of its current document; navigation reports Page.frameNavigated.
export function startFakeCdp({ userTabs = [{ title: "User Mail", url: "https://mail.example/inbox" }] } = {}) {
  const calls = [];
  const targets = new Map();
  let n = 0, sockets = new Set();
  const emit = (msg) => { for (const ws of sockets) ws.send(JSON.stringify(msg)); };
  const addTarget = (url, title, openerId) => {
    const t = { targetId: `T${++n}`, type: "page", url, title, openerId, value: "", session: null, dialog: null, held: [], framed: false, keys: [] };
    targets.set(t.targetId, t);
    emit({ method: "Target.targetCreated", params: { targetInfo: info(t) } });
    return t;
  };
  const info = (t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title, ...(t.openerId ? { openerId: t.openerId } : {}) });
  for (const u of userTabs) addTarget(u.url, u.title);
  const bySession = (s) => [...targets.values()].find((t) => t.session === s);
  const ax = (t) => t.url === "about:blank" || t.url.includes("empty") ? [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" } }] : [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: t.title }, childIds: ["2", "3", "4", "5", "6", "7"] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 10 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Name" }, value: { value: t.value }, backendDOMNodeId: 11 },
    { nodeId: "4", parentId: "1", role: { value: "combobox" }, name: { value: "Size" }, backendDOMNodeId: 12 },
    { nodeId: "5", parentId: "1", role: { value: "button" }, name: { value: "Choose File" }, backendDOMNodeId: 13 },
    { nodeId: "6", parentId: "1", role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 14, properties: [{ name: "url", value: { value: "https://docs.example/" } }] },
    { nodeId: "7", parentId: "1", role: { value: "StaticText" }, name: { value: `Body of ${t.title}` } },
  ];
  const BOX = { 10: [40, 10], 11: [40, 50], 12: [40, 90], 13: [40, 130], 14: [40, 170] };
  const hit = (x, y) => Object.entries(BOX).find(([, [cx, cy]]) => Math.abs(cx - x) < 20 && Math.abs(cy - y) < 10)?.[0];

  function handle(m, reply) {
    const t = m.sessionId ? bySession(m.sessionId) : null;
    const p = m.params ?? {};
    switch (m.method) {
      case "Browser.getVersion": return reply({ product: "Chrome/141.0.0.0", userAgent: "Helium" });
      case "Target.setDiscoverTargets": return reply({});
      case "Target.getTargets": return reply({ targetInfos: [...targets.values()].map(info) });
      case "Target.createTarget": { // like Chromium: a finished about:blank first, the URL commits later
        const nt = addTarget("about:blank", "about:blank");
        if (p.url !== "about:blank") setTimeout(() => { nt.url = p.url; nt.title = `Page ${p.url}`; }, 60);
        return reply({ targetId: nt.targetId });
      }
      case "Target.attachToTarget": { const at = targets.get(p.targetId); at.session = `S-${at.targetId}`; return reply({ sessionId: at.session }); }
      case "Target.detachFromTarget": { const dt = bySession(p.sessionId); if (dt) dt.session = null; emit({ method: "Target.detachedFromTarget", params: { sessionId: p.sessionId } }); return reply({}); }
      case "Target.closeTarget": targets.delete(p.targetId); emit({ method: "Target.targetDestroyed", params: { targetId: p.targetId } }); return reply({ success: true });
      case "Target.activateTarget": case "Page.bringToFront": case "Page.enable": case "DOM.focus": case "DOM.scrollIntoViewIfNeeded":
        if (p.backendNodeId != null && !BOX[p.backendNodeId]) return reply(null, "No node with given id found");
        return reply({});
      case "Page.navigate": t.url = p.url; t.title = `Page ${p.url}`; t.value = ""; t.framed = false;
        emit({ sessionId: t.session, method: "Page.frameNavigated", params: { frame: { id: t.targetId, url: p.url } } });
        setTimeout(() => emit({ sessionId: t.session, method: "Page.frameStoppedLoading", params: { frameId: t.targetId } }), 20);
        emit({ sessionId: t.session, method: "Page.frameStartedLoading", params: { frameId: t.targetId } });
        return reply({ frameId: t.targetId });
      case "Accessibility.getFullAXTree": return reply({ nodes: ax(t) });
      case "DOM.getContentQuads": { const [x, y] = BOX[p.backendNodeId]; return reply({ quads: [[x - 10, y - 5, x + 10, y - 5, x + 10, y + 5, x - 10, y + 5]] }); }
      case "DOM.describeNode": return reply({ node: p.backendNodeId === 13 ? { nodeName: "INPUT", attributes: ["type", "file"] } : { nodeName: "BUTTON", attributes: [] } });
      case "DOM.setFileInputFiles": return reply({});
      case "DOM.resolveNode": return reply({ object: { objectId: `obj-${p.backendNodeId}` } });
      case "Page.getFrameTree": return reply({ frameTree: { frame: { id: t.targetId } } });
      case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
      case "Runtime.callFunctionOn": return reply({ result: { value: p.objectId === "obj-12" ? { selected: p.arguments[0].value } : p.objectId === "obj-14" ? "https://docs.example/" : null } });
      case "Runtime.evaluate": if (p.expression === "document.readyState") return reply({ result: { value: t.url.includes("slow") ? "loading" : "complete" } });
        return reply({ result: { value: { title: t.title, url: t.url, text: `Body of ${t.title}\n\n\n\nmore` } } });
      case "Page.getLayoutMetrics": return reply({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 }, cssContentSize: { width: 800, height: 2000 } });
      case "Page.captureScreenshot": t.framed = true; return reply({ data: Buffer.from("fake-jpeg").toString("base64") });
      case "Input.insertText": if (t.dialog) return t.held.push(() => reply({})); t.value += p.text; return reply({});
      case "Input.dispatchKeyEvent": if (t.dialog) return t.held.push(() => reply({}));
        if (t.framed && p.type !== "keyUp") t.keys.push(p.key);
        return reply({});
      case "Input.dispatchMouseEvent": {
        if (t.dialog) return t.held.push(() => reply({}));
        if (!t.framed) return reply({}); // acknowledged, never delivered
        const id = hit(p.x, p.y);
        if (p.type === "mouseReleased" && id === "10") {
          t.dialog = { type: "confirm", message: "Delete everything?" };
          emit({ sessionId: t.session, method: "Page.javascriptDialogOpening", params: t.dialog });
          return t.held.push(() => reply({})); // blocked until the dialog closes
        }
        if (p.type === "mouseReleased" && id === "14") addTarget("https://docs.example/", "Docs", t.targetId);
        return reply({});
      }
      case "Page.handleJavaScriptDialog":
        if (!t.dialog) return reply(null, "No dialog is showing");
        t.dialog = null;
        emit({ sessionId: t.session, method: "Page.javascriptDialogClosed", params: { result: p.accept } });
        t.held.splice(0).forEach((f) => f());
        return reply({});
      default: return reply(null, `'${m.method}' wasn't found`);
    }
  }

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, data) {
        const m = JSON.parse(String(data));
        calls.push(m);
        handle(m, (result, error) => ws.send(JSON.stringify(error ? { id: m.id, error: { message: error }, sessionId: m.sessionId } : { id: m.id, result, sessionId: m.sessionId })));
      },
    },
  });
  return {
    port: server.port, calls, targets,
    endpoint: { host: "127.0.0.1", port: server.port, path: "/devtools/browser/fake", source: "fake" },
    count: (method) => calls.filter((c) => c.method === method).length,
    stop: () => server.stop(true),
  };
}
