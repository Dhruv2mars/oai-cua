// Tiny resident helper for the focus guard (compiled once by src/focus.mjs).
// stdin lines → stdout JSON lines:
//   front         {"pid":…,"bundle":…,"name":…,"path":…} of the frontmost app
//   activate PID  {"ok":true|false}
// Unprompted, on every app activation: {"event":"activated","pid":…,"bundle":…,…}
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

func reply(_ obj: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  print(String(decoding: data, as: UTF8.self))
}

func describe(_ app: NSRunningApplication?) -> [String: Any] {
  guard let app = app else { return ["pid": -1] }
  return ["pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "path": app.bundleURL?.path ?? ""]
}

func activate(_ pid: pid_t) -> Bool {
  guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
  if app.activate(options: [.activateIgnoringOtherApps]) { return true }
  // Fallback: ask LaunchServices to bring the running app forward.
  guard let url = app.bundleURL else { return false }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  cfg.addsToRecentItems = false
  let done = DispatchSemaphore(value: 0)
  var ok = false
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in ok = err == nil; done.signal() }
  _ = done.wait(timeout: .now() + 2)
  return ok
}

NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  var obj = describe(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
  obj["event"] = "activated"
  reply(obj)
}

// Reads stdin off the main thread; AppKit state is read on the main run loop,
// which keeps frontmostApplication current.
DispatchQueue.global().async {
  while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    switch parts.first ?? "" {
    case "front": DispatchQueue.main.sync { reply(describe(NSWorkspace.shared.frontmostApplication)) }
    case "activate":
      let pid = pid_t(parts.count > 1 ? parts[1] : "") ?? -1
      DispatchQueue.main.sync { reply(["ok": activate(pid)]) }
    default: reply(["error": "unknown command"])
    }
  }
  exit(0)
}
RunLoop.main.run()
