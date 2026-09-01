/** What one window tells the others about its sessions.
 *
 *  The shape of the message, and the one rule that has to hold across windows
 *  without them having spoken. Pure data and a pure function, deliberately: two
 *  windows cannot coexist in one jsdom document and the harness's event bus has
 *  no notion of a target, so cross-window behaviour cannot be tested through the
 *  DOM at all — it has to be tested at a seam like this. The same shape the
 *  codebase already uses for `nextWaitingAcross`, `zoomParticipants` and
 *  `serializeTiles`.
 *
 *  It was three functions before #394, all three for the floating pill's click
 *  and its count. Adding the reports up went with the pill and has not come
 *  back: nothing counts windows any more, because the status-area panel is a
 *  list and the badge's number is composed with it (`tray-panel.ts`). The other
 *  two are here because #393 gave them a caller again — the panel names every
 *  session in one order, and a click on one of those rows has to reach the
 *  window that holds it.
 */
import type { SessionState } from "./ipc";

/** One session, as another window describes it.
 *
 *  A **list**, not a count, and that decision is what makes the rest of this
 *  file small — and what let the floating pill go (#394) without taking anything
 *  with it. A count would have answered "how many are waiting" and nothing else;
 *  the same message carrying the sessions answers which window to raise when
 *  somebody clicks a row in the status-area panel, *and* what to draw in the
 *  main window's sidebar for a workspace that has been pulled out. Two problems
 *  that outlived the count, one message.
 */
export interface RemoteSession {
  session: string;
  name: string;
  state: SessionState;
  workspaceId?: string;
}

/** What a window announces about itself on every render. */
export interface WindowSessions {
  label: string;
  sessions: RemoteSession[];
}

/** Every window's report, keyed by the window that sent it. */
export type SessionsByWindow = Map<string, RemoteSession[]>;

/** The window that holds `session`, or null if nobody reports it.
 *
 *  What lets a row of the status-area panel reach the session it names: the main
 *  window composes the panel out of every window's report, and this says where
 *  to send the click when the row belongs to somebody else.
 */
export function windowOf(byWindow: SessionsByWindow, session: string): string | null {
  for (const [label, sessions] of byWindow) {
    if (sessions.some((s) => s.session === session)) return label;
  }
  return null;
}

/** Every session any window reports, in a stable order.
 *
 *  Ordered by window label and then by the order that window listed them, so the
 *  panel lists the same sessions in the same order twice running. Without it the
 *  order would depend on `Map` insertion order, which depends on which window
 *  happened to report first after a restart — and a menu whose rows move between
 *  two openings is a menu you cannot click without reading it again.
 */
export function allSessions(byWindow: SessionsByWindow): RemoteSession[] {
  return [...byWindow.keys()].sort().flatMap((label) => byWindow.get(label) ?? []);
}

/** A starting point for notification ids that no two windows share.
 *
 *  `NotifyRouter`'s sequence started at 1 in every window, so id 3 meant a
 *  different session in each of them — and clicking a notification resolved to
 *  the wrong tile, in a window that then raised itself over the one the person
 *  was using. Disjoint ranges make a foreign id resolve to nothing instead,
 *  which is the right answer whether or not the plugin delivers an action to
 *  every listening webview.
 *
 *  A hash rather than a counter because there is nowhere to keep a counter: the
 *  windows do not talk before their first notification, and the label is the one
 *  thing each of them knows for certain about itself. Collisions are possible in
 *  principle and cost a misrouted click; the range is wide enough that it takes
 *  a deliberate pair of labels.
 */
export function notifyIdSeed(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 2048;
  // A million apart: no window will raise a million notifications in a run, and
  // the total stays inside what a notification id can safely hold.
  return h * 1_000_000 + 1;
}
