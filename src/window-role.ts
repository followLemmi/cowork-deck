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

/** The workspace a label names, or null for the main window, the pill, or
 *  anything added later. */
export function workspaceIdOf(label: string): string | null {
  if (!label.startsWith(WORKSPACE_PREFIX)) return null;
  const id = label.slice(WORKSPACE_PREFIX.length);
  return id.length > 0 ? id : null;
}
