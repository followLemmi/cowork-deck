import type { Options } from "@tauri-apps/api/event";

/** What a window label says about the window.
 *
 *  The other half of `src-tauri/src/windows.rs`, which mints these labels. Kept
 *  as a pure function of a string rather than reading `getCurrentWindow()` here,
 *  because two windows cannot coexist in one jsdom document — so every test of
 *  cross-window behaviour has to happen at a seam like this one, the shape the
 *  codebase already uses for `nextWaitingAcross` and `zoomParticipants`.
 *
 *  The prefix is duplicated across the language boundary and cannot be shared.
 *  `windows.rs` carries the same constant and a test tying it to the capability
 *  glob; `tests/window-role.test.ts` ties this copy to the same string. Two
 *  tests, because a mismatch is invisible: a label that parses to no workspace
 *  here would silently render the placeholder in a window that is pinned to one. */
const WORKSPACE_PREFIX = "workspace-";

/** The main window's label. The other half of `windows::MAIN` in Rust, and the
 *  address a workspace window hands its workspace back to. */
export const MAIN_WINDOW_LABEL = "main";

/** The label for the window pinned to `workspaceId`.
 *
 *  The other half of `workspace_label` in `src-tauri/src/windows.rs`, and pinned
 *  to the same literal by the test beside this one — a drift is invisible at
 *  runtime and would address a window that does not exist. */
export function workspaceLabel(workspaceId: string): string {
  return WORKSPACE_PREFIX + workspaceId;
}

/** The workspace a label names, or null for the main window or anything added
 *  later. */
export function workspaceIdOf(label: string): string | null {
  if (!label.startsWith(WORKSPACE_PREFIX)) return null;
  const id = label.slice(WORKSPACE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Which kind of window this is, and which workspace it is pinned to.
 *
 *  Parsed from the label rather than asked for over IPC: `getCurrentWindow()` is
 *  synchronous and the label is known before the first DOM query, so the whole
 *  app can be started without waiting on the backend for the one fact that
 *  decides how to start it.
 */
export type WindowRole =
  | { kind: "main" }
  | { kind: "workspace"; workspaceId: string };

/** The role a window label names.
 *
 *  Anything that is not a workspace label is the main window — including a label
 *  nobody has taught this function about. That direction is deliberate: an
 *  unknown window that behaves like the main one is a window that works, and one
 *  that behaves like a workspace window is a window with no workspace, which is
 *  the fourth state #246 refuses to let exist.
 */
export function roleOf(label: string): WindowRole {
  const workspaceId = workspaceIdOf(label);
  return workspaceId === null ? { kind: "main" } : { kind: "workspace", workspaceId };
}

/** Listen options that narrow a listener to what was addressed to `label`.
 *
 *  Needed because `emitTo` does not, on its own, mean "to that window". A bare
 *  `listen()` registers with `EventTarget::Any` (the default in
 *  `@tauri-apps/api/event`), and Tauri's delivery filter short-circuits on it:
 *  `match_any_or_filter` in `tauri/src/event/listener.rs` answers true for an
 *  `Any` listener *whatever* the emit was addressed to. So an addressed event
 *  was in fact a broadcast, and every window holding a bare `listen` for it
 *  acted on somebody else's mail.
 *
 *  What that cost (#349): deleting a workspace emits `workspace://gone` to that
 *  workspace's window, and the main window — which holds the same listener, and
 *  whose handler closes the window it is in — closed itself. No window, no
 *  error, and a process still running, because the floating status pill kept the
 *  event loop alive. The pill is gone (#394); a workspace window left up keeps it
 *  alive the same way, which is why `main.rs` exits the app explicitly when the
 *  main window is destroyed.
 *
 *  `kind: "Window"` rather than `"Webview"` or `"WebviewWindow"`: the emitting
 *  side passes a bare label, which becomes `AnyLabel`, and `AnyLabel` matches
 *  all three — so any of them would deliver. `Window` is what
 *  `getCurrentWindow().listen` uses, and matching the API's own choice keeps one
 *  shape in the app.
 *
 *  Only for events that are **addressed**. A broadcast still arrives: an
 *  unfiltered emit — `emit()` here, `app.emit` in Rust — matches every listener
 *  whatever its target, so narrowing one costs nothing it used to hear.
 */
export function addressedTo(label: string): Options {
  return { target: { kind: "Window", label } };
}
