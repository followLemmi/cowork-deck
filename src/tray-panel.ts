/** What the status-area menu says.
 *
 *  The tray icon is a native menu — see ADR-0011 — and this is the half of it
 *  that knows anything. `src-tauri/src/tray.rs` turns a list of sections into a
 *  menu and routes a click back; what goes in the rows is decided here, in the
 *  same language as the limits block and out of the same pure helpers, so the
 *  tray and the deck cannot disagree about a number.
 *
 *  **`PANEL` below is the extensibility claim, and it is deliberately boring.**
 *  A section is one entry in that array: a heading, and a function from the
 *  facts to its rows. Nothing about `trayPanel` changes as sections are added,
 *  and nothing in `tray.rs` changes at all. Same shape, for the same reason, as
 *  `SECTIONS` in `settings.ts`.
 *
 *  Pure: no DOM, no IPC, no clock. `now` is passed in, exactly as the block
 *  takes it, so every reset time in one menu is relative to one instant and the
 *  whole thing is testable as a rule rather than through a menu nobody can open
 *  from a test.
 */

import type { AiUsage, TrayPanel, TrayRow } from "./ipc";
import type { RemoteSession } from "./cross-window";
import { limitFoot, primaryWindow, readingOf, sourceLabel } from "./usage";

/** Everything a section is allowed to look at.
 *
 *  Passed in rather than read here, for the reason this file is pure: a section
 *  that reached for the clock or for `usageSnapshot` would be a section that
 *  cannot be tested, and the point of the shape is that adding one is cheap.
 */
export interface TrayFacts {
  usage: AiUsage[];
  /** Every window's sessions, as `allSessions` orders them. */
  sessions: RemoteSession[];
  now: number;
}

/** What a row's click asks for. Two verbs, and both already have an answer in
 *  the deck — the tray adds no behaviour of its own, it reaches the behaviour
 *  that is there. */
export const ACTIONS = {
  /** Open the usage dialog for one provider. The argument is `AiUsage.provider`,
   *  the registry key, never the label. */
  usage: (provider: string) => `usage:${provider}`,
  /** Focus one session, wherever it lives. Routed exactly as a click on the pill
   *  is routed — see `pill://focus-next` in `app.ts`. */
  session: (id: string) => `session:${id}`,
} as const;

/** Read a row's action back. `null` for anything this file did not mint.
 *
 *  The far end of `ACTIONS`, and here rather than in `app.ts` so that the two
 *  halves of the vocabulary sit next to each other and a new verb cannot be
 *  added to one without the other being in view.
 */
export function parseAction(action: string): { verb: "usage" | "session"; id: string } | null {
  const at = action.indexOf(":");
  if (at <= 0) return null;
  const verb = action.slice(0, at);
  const id = action.slice(at + 1);
  if (!id) return null;
  if (verb === "usage" || verb === "session") return { verb, id };
  return null;
}

/** How many sessions a section will list before it stops naming them.
 *
 *  A menu is a list somebody reads standing up. Twelve rows of session names
 *  under a heading is a scroll, and a scrolling status menu is a worse way to
 *  answer "who is blocked on me" than the pill already is. What is left over is
 *  counted rather than dropped.
 */
const MAX_SESSION_ROWS = 6;

interface PanelSection {
  /** Not shown. For the tests, and for a caller that wants to find one. */
  id: string;
  heading: string;
  rows: (f: TrayFacts) => TrayRow[];
}

const PANEL: PanelSection[] = [
  {
    id: "limits",
    heading: "Limits",
    /** One row per connected AI, and the tier is in every one of them.
     *
     *  ADR-0009 in a menu: a bare percentage here would break the same rule the
     *  deck's rows were built to keep. So the row is the label, the tier, the
     *  reading, and — when there is one — the sentence about the state, which is
     *  `limitFoot`'s and shared with the block rather than written again.
     */
    rows: ({ usage, now }) => {
      if (!usage.length) return [reading("No AI detected on this machine.")];
      return usage.map((snap) => {
        const win = primaryWindow(snap);
        if (!win) {
          return {
            text: `${snap.label} · ${snap.error ?? "no limits reported"}`,
            action: ACTIONS.usage(snap.provider),
          };
        }
        const parts = [snap.label, sourceLabel(win.source), readingOf(win)];
        const foot = limitFoot(win, snap.error, now);
        if (foot) parts.push(foot);
        return { text: parts.join(" · "), action: ACTIONS.usage(snap.provider) };
      });
    },
  },
  {
    id: "sessions",
    heading: "Sessions",
    /** The ones waiting, by name and clickable, and a count of the rest.
     *
     *  Waiting first and waiting only, among the rows that get a name: "who is
     *  blocked on me" is the question this surface is answering, and a list that
     *  mixed in nine contentedly running sessions would bury the three that are
     *  not. The rest are a number, which is all they need to be.
     */
    rows: ({ sessions }) => {
      if (!sessions.length) return [reading("No sessions are open.")];
      const waiting = sessions.filter((s) => s.state === "waitingInput");
      const rows: TrayRow[] = waiting
        .slice(0, MAX_SESSION_ROWS)
        .map((s) => ({ text: `${s.name} · waiting for input`, action: ACTIONS.session(s.session) }));
      const unnamed = waiting.length - rows.length;
      if (unnamed > 0) rows.push(reading(`${unnamed} more waiting for input`));
      if (!waiting.length) rows.push(reading("Nothing is waiting for input."));
      const others = sessions.length - waiting.length;
      if (others > 0) rows.push(reading(plural(others, "other session", "other sessions")));
      return rows;
    },
  },
];

/** A row that is a fact rather than a control. */
function reading(text: string): TrayRow {
  return { text, action: null };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the icon says on hover.
 *
 *  One line, and it answers the question the icon is there for. Never the
 *  waiting count on its own: that is the pill's sentence, and two surfaces
 *  saying it is the duplication #393 forbids. What this adds is the thing the
 *  pill cannot say — that the deck is running and has nothing to report.
 */
function tooltipFor(f: TrayFacts): string {
  const waiting = f.sessions.filter((s) => s.state === "waitingInput").length;
  const spent = f.usage.filter((s) => s.windows.some((w) => w.state === "exhausted"));
  if (spent.length) {
    return spent.length === 1
      ? `cowork-deck — ${spent[0].label} has nothing left`
      : "cowork-deck — more than one AI has nothing left";
  }
  if (waiting) return `cowork-deck — ${plural(waiting, "session is", "sessions are")} waiting`;
  return "cowork-deck";
}

/** Compose the report.
 *
 *  An empty section is impossible by construction: a section whose rows come
 *  back empty is given one row saying so, because a heading over a blank is
 *  worse than a sentence. That is enforced here rather than trusted to each
 *  section, so a section added later cannot forget it.
 */
export function trayPanel(f: TrayFacts): TrayPanel {
  return {
    sections: PANEL.map((s) => {
      const rows = s.rows(f);
      return { heading: s.heading, rows: rows.length ? rows : [reading("Nothing to report.")] };
    }),
    tooltip: tooltipFor(f),
    waiting: f.sessions.filter((s) => s.state === "waitingInput").length,
  };
}

/** The sections there are, in order. For the tests, which assert that the
 *  renderer is generic over this list rather than knowing the two names in it. */
export const PANEL_SECTIONS: readonly string[] = PANEL.map((s) => s.id);
