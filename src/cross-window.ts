/** What one window tells the others about its sessions, and what the main window
 *  works out from all of it.
 *
 *  Pure functions of plain data, deliberately. Two windows cannot coexist in one
 *  jsdom document and the harness's event bus has no notion of a target, so
 *  cross-window behaviour cannot be tested through the DOM at all — it has to be
 *  tested at seams like these. The same shape the codebase already uses for
 *  `nextWaitingAcross`, `zoomParticipants` and `serializeTiles`.
 */
import type { SessionState } from "./ipc";

/** One session, as another window describes it.
 *
 *  A **list**, not a count, and that decision is what makes the rest of this
 *  file small. A count answers "how many are waiting" and nothing else; the same
 *  message carrying the sessions answers that *and* which window to raise when
 *  somebody asks for the next one, *and* what to draw in the main window's
 *  sidebar for a workspace that has been pulled out. Three problems, one message.
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

/** How many sessions are waiting for input, across every window.
 *
 *  The pill used to flap between two partial counts every five seconds, because
 *  each window computed the number from its own tiles and then broadcast it as
 *  though it were the app's. Whichever arrived last won.
 */
export function sumWaiting(byWindow: SessionsByWindow): number {
  let n = 0;
  for (const sessions of byWindow.values()) {
    for (const s of sessions) if (s.state === "waitingInput") n++;
  }
  return n;
}

/** The window that holds `session`, or null if nobody reports it.
 *
 *  Used to answer "who is blocked on me" across monitors: the main window works
 *  out which session is next and this says where to send the request.
 */
export function windowOf(byWindow: SessionsByWindow, session: string): string | null {
  for (const [label, sessions] of byWindow) {
    if (sessions.some((s) => s.session === session)) return label;
  }
  return null;
}

/** Every session any window reports, in a stable order.
 *
 *  Ordered by window label and then by the order that window listed them, so
 *  "the next one waiting" means the same thing twice running. Without that the
 *  answer would depend on `Map` insertion order, which depends on which window
 *  happened to report first after a restart.
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
