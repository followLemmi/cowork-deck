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

/** The workspace a label names, or null for the main window, the pill, or
 *  anything added later. */
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
