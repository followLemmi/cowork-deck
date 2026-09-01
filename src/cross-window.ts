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
 *  It was three functions before #394. Adding the reports up, finding the window
 *  that holds a session, and flattening them into one stable order all existed
 *  for the floating pill's click and its count; the deck reads the same reports
 *  through the proxy rows it renders from them, which carry their own window's
 *  label, so none of the three had a caller left.
 */
import type { SessionState } from "./ipc";

/** One session, as another window describes it.
 *
 *  A **list**, not a count, and that decision is what makes the rest of this
 *  file small — and what let the floating pill go (#394) without taking anything
 *  with it. A count would have answered "how many are waiting" and nothing else;
 *  the same message carrying the sessions answers which window to raise when
 *  somebody asks for the next one, *and* what to draw in the main window's
 *  sidebar for a workspace that has been pulled out. Two problems that outlived
 *  the count, one message.
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
