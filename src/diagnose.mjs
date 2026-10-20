// Turns raw computer-use engine errors into actionable guidance. Error codes
// from SkyComputerUseService only reach us as message text ("Computer Use
// server error -10005: …"), so this matches on codes and phrases.
const RULES = [
  ["user-stopped", /explicitly stopped by the user|-10012\b|userStoppedSession/i,
    "The user stopped Computer Use for this app. Stop working on it now and hand back to the user; say you can continue if they want. It is available again after the turn ends."],
  ["user-acting", /The user changed '|-10016\b|userIntervened/i,
    "The user took over this app. If the user is acting in it, stop and hand back. Otherwise call get_app_state for fresh state before sending more actions."],
  ["user-busy", /The user is still interacting with/i,
    "The user is using this app right now. Wait a few seconds and retry, or hand back to the user."],
  ["paste-conflict", /conflicted with your paste/i,
    "Check the app's state with get_app_state: the user's clipboard may have been pasted instead of your text."],
  ["turn-ended", /current turn ended/i,
    "Another computer-use client (e.g. ChatGPT or Codex) ended its turn, and the service refuses other clients until that client's engine exits, usually within a few minutes. Hand back to the user, or wait and retry."],
  ["approval-denied", /was not approved to use|not approved/i,
    "The user declined access to this app. Do not retry; ask the user whether to use it."],
  ["org-policy", /blocked from using the app .*organization/i,
    "This app is blocked by organization policy. Use another way to do the task."],
  ["forbidden", /not allowed to use the app .*safety|-10006\b|appNotAllowed/i,
    "OpenAI's computer-use service does not allow this app. Use another way to do the task."],
  ["locked", /-10020\b|screenLocked|The Mac is locked/i,
    "The Mac is locked. Ask the user to unlock it, then retry."],
  ["permissions-pending", /-10014\b|permissionsPending/i,
    "A macOS permission prompt for Codex Computer Use is waiting. Ask the user to approve it, then retry."],
  ["permissions", /-10009\b|permissionsNotGranted|-10000\b|senderProcessNotAuthenticated/i,
    "Grant Accessibility and Screen Recording to \"Codex Computer Use\" in System Settings › Privacy & Security (or open ChatGPT › Computer Use once), then retry."],
  ["not-running", /-10007\b|Running application not found|runningApplicationNotFound/i,
    "The app is not running (it may have quit). Call get_app_state to launch it again."],
  ["no-window", /cgWindowNotFound|No capturable window/i,
    "The app has no capturable window: it may have none open, or be minimized, hidden or on another Space. Open or restore a window (for example press_key super+n), then call get_app_state."],
  ["bad-element", /is an invalid element ID/i,
    "That element index is stale or out of range. Call get_app_state for fresh indices."],
  ["no-session", /-10011\b|noActiveSession/i,
    "There is no session for this app. Call get_app_state first."],
  ["app-not-found", /-10010\b|-10018\b|Invalid app|ambiguousApp|ambiguous app/i,
    "The app was not found or is ambiguous. Use list_apps and pass its exact bundle id (e.g. com.apple.TextEdit) or full .app path."],
  ["ax-error", /-10008\b|accessibilityError/i,
    "The app's accessibility tree could not be read. Call get_app_state again, or act by x/y coordinates."],
  ["blocked-url", /-10015\b|blockedURL/i,
    "That URL is blocked by policy."],
  ["client-version", /-10013\b|incompatibleClientVersion/i,
    "The engine and the Codex Computer Use service versions do not match. Update the ChatGPT app and open it once."],
];

export function diagnose(message) {
  const m = String(message ?? "");
  for (const [kind, re, hint] of RULES) if (re.test(m)) return { kind, hint };
  return null;
}

// The original message plus guidance, when there is any.
export function explain(message) {
  const d = diagnose(message);
  return d ? `${message}\nWhat to do: ${d.hint}` : String(message ?? "");
}
