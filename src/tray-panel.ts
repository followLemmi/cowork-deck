/** What the status-area surface shows, and the one list that decides it.
 *
 *  Behind the icon is a small window (`tray.html`), drawn with the deck's own
 *  stylesheet: meters, tier chips, state rails. On Linux it is a native menu
 *  instead, because a StatusNotifierItem's click is not deliverable to us on
 *  most desktops — see ADR-0013.
 *
 *  **`PANEL` below is the extensibility claim, and it is deliberately boring.**
 *  A section is one entry: a heading, the rows it would be as text, and how it
 *  draws. Nothing about `trayPanel` or `fillPanel` changes as sections are
 *  added, and nothing in `src-tauri/src/tray.rs` changes at all. The same shape,
 *  for the same reason, as `SECTIONS` in `settings.ts`.
 *
 *  A section declares BOTH renderings, and that pairing is the point. Two lists
 *  — one for the window and one for the menu — is how a Linux desktop ends up
 *  being told something different from a Mac one, six months after nobody
 *  remembers there were two.
 *
 *  Nothing here reaches for the clock or for `usageSnapshot`: `now` and the
 *  facts are passed in, so a section stays testable and the whole menu is
 *  relative to one instant.
 */

import type { AiUsage, SessionState, TrayPanel, TrayRow } from "./ipc";
import type { RemoteSession } from "./cross-window";
import { LimitsBlock } from "./usage-block";
import { limitFoot, primaryWindow, readingOf, tierNote } from "./usage";

/** Everything a section is allowed to look at. */
export interface TrayFacts {
  usage: AiUsage[];
  /** Every window's sessions, as `allSessions` orders them. */
  sessions: RemoteSession[];
  now: number;
}

/** What a row's click asks for. Three verbs, and all three already have an
 *  answer in the deck — the tray adds no behaviour of its own, it reaches the
 *  behaviour that is there. */
export const ACTIONS = {
  /** Open the usage dialog for one provider. The argument is `AiUsage.provider`,
   *  the registry key, never the label. */
  usage: (provider: string) => `usage:${provider}`,
  /** Run the command that would answer an unreadable row, in a tile. */
  probe: (provider: string) => `probe:${provider}`,
  /** Focus one session, wherever it lives. The main window is what routes it,
   *  because it is the only one that knows which window holds a session — see
   *  `onTrayAction` in `app.ts`. */
  session: (id: string) => `session:${id}`,
} as const;

export type ActionVerb = "usage" | "probe" | "session";

/** Read a row's action back. `null` for anything this file did not mint.
 *
 *  The far end of `ACTIONS`, and here rather than in `app.ts` so that the two
 *  halves of the vocabulary sit next to each other and a new verb cannot be
 *  added to one without the other being in view.
 */
export function parseAction(action: string): { verb: ActionVerb; id: string } | null {
  const at = action.indexOf(":");
  if (at <= 0) return null;
  const verb = action.slice(0, at);
  const id = action.slice(at + 1);
  if (!id) return null;
  if (verb === "usage" || verb === "probe" || verb === "session") return { verb, id };
  return null;
}

/** How many sessions each surface names before it stops naming them.
 *
 *  The two numbers differ, and that is the one place the renderings are allowed
 *  to: a menu is a list somebody reads standing up, and twelve rows in one is a
 *  scroll nobody asked for — while the panel is a window that scrolls anyway, so
 *  it can afford to show the deck. Same facts, same order, different budget.
 *
 *  What is left over is counted either way, never dropped: a surface that
 *  silently stopped would be lying about how many people are waiting on you.
 */
const MAX_MENU_ROWS = 6;
const MAX_PANEL_ROWS = 10;

/** What a session's state is called on this surface.
 *
 *  "waiting for input" rather than the ledger's "waiting for a decision": this
 *  surface is read at a glance from outside the window, and "input" is the word
 *  for the thing being asked of you. `done` is deliberately not folded into
 *  `idle`: an agent that has finished its turn parked at the prompt is not the
 *  same as one that never started, and keeping them apart is a decision the deck
 *  already made (README, "Sessions").
 */
export function stateWord(state: SessionState): string {
  switch (state) {
    case "waitingInput":
      return "waiting for input";
    case "working":
      return "working";
    case "done":
      return "finished a turn";
    case "error":
      return "stopped on an error";
    case "ended":
      return "ended";
    default:
      return "idle";
  }
}

/** The order sessions are listed in, and it is by what wants a person.
 *
 *  Blocked first, then broken, then finished-and-parked — which is the order
 *  `nextWaitingAcross` and the top bar's ledger already put them in. Within a
 *  rank the order each window reported, so two consecutive draws agree.
 */
function rank(state: SessionState): number {
  switch (state) {
    case "waitingInput":
      return 0;
    case "error":
      return 1;
    case "done":
      return 2;
    case "working":
      return 3;
    case "ended":
      return 5;
    default:
      return 4;
  }
}

/** Every session, in that order. A stable sort, so the reported order survives
 *  inside a rank. */
export function byUrgency(sessions: RemoteSession[]): RemoteSession[] {
  return [...sessions].sort((a, b) => rank(a.state) - rank(b.state));
}

/** How a section reaches the deck. One string, the same one either surface
 *  sends, routed in `app.ts`. */
export type Act = (action: string) => void;

interface PanelSection {
  /** Not shown. For the tests, and for a caller that wants to find one. */
  id: string;
  heading: string;
  /** The section as sentences, for the Linux menu. */
  rows: (f: TrayFacts) => TrayRow[];
  /** The section as itself, for the window. Returns a teardown when it has one.
   *  `body` is emptied before this is called. */
  fill: (body: HTMLElement, f: TrayFacts, act: Act) => void;
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
        const parts = [snap.label, readingOf(win)];
        // After the reading, and only when there is one to qualify — the same
        // rule and the same words as the block's own row (`tierNote`).
        const tier = tierNote(win);
        if (tier) parts.push(tier);
        const foot = limitFoot(win, snap.error, now);
        if (foot) parts.push(foot);
        return { text: parts.join(" · "), action: ACTIONS.usage(snap.provider) };
      });
    },
    /** `LimitsBlock` itself, not a copy of it.
     *
     *  This is the whole reason the panel is a window: the block already draws
     *  the meter, the tier chip, the state colour and the accessible name, and
     *  #393 asked for that rendering to be reused rather than reimplemented. The
     *  three hooks below are all that differs — the surface is already a glance
     *  and needs no strip to fold behind, has no room for a dialog, and has no
     *  tiles to open.
     */
    fill: (body, f, act) => {
      const block = new LimitsBlock(body, {
        strip: false,
        openDetail: (snap) => act(ACTIONS.usage(snap.provider)),
        openProbe: (snap) => act(ACTIONS.probe(snap.provider)),
        // Neither is reachable — `openDetail` and `openProbe` take every path
        // that would have used them — and both are required by the interface the
        // deck's own host satisfies. They throw rather than doing nothing, so a
        // fourth path added later says so instead of silently going nowhere.
        openCommandTile: () => {
          throw new Error("the tray panel has no tiles; use openProbe");
        },
        cwd: () => {
          throw new Error("the tray panel has no workspace");
        },
      });
      block.render(f.usage, f.now);
      // The block hides itself when nothing is detected — right in the deck's
      // panel, where a heading over a blank would be noise, and wrong here,
      // where this section's heading is already drawn and would stand over
      // nothing. So the sentence is put back.
      if (!f.usage.length) {
        body.hidden = false;
        body.replaceChildren(note("No AI detected on this machine."));
      }
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
    /** The menu's terse form: the ones waiting, by name, and a count of the rest.
     *
     *  Waiting only, among the rows that get a name — "who is blocked on me" is
     *  the question, and a menu that mixed in nine contentedly running sessions
     *  would bury the three that are not.
     */
    rows: ({ sessions }) => {
      if (!sessions.length) return [reading("No sessions are open.")];
      const waiting = sessions.filter((s) => s.state === "waitingInput");
      const rows: TrayRow[] = waiting
        .slice(0, MAX_MENU_ROWS)
        .map((s) => ({ text: `${s.name} · ${stateWord(s.state)}`, action: ACTIONS.session(s.session) }));
      const unnamed = waiting.length - rows.length;
      if (unnamed > 0) rows.push(reading(`${unnamed} more waiting for input`));
      if (!waiting.length) rows.push(reading("Nothing is waiting for input."));
      const others = sessions.length - waiting.length;
      if (others > 0) rows.push(reading(plural(others, "other session", "other sessions")));
      return rows;
    },
    /** The window lists the deck: every session, urgent first, each one a row
     *  that takes you to it.
     *
     *  A menu could not afford this and the panel can, which is the point of it
     *  being a window. It is also the more useful half of the answer — "nothing
     *  is waiting" is worth more when you can see the eleven that are working. */
    fill: (body, { sessions }, act) => {
      if (!sessions.length) {
        body.append(note("No sessions are open."));
        return;
      }
      if (!sessions.some((s) => s.state === "waitingInput")) {
        body.append(note("Nothing is waiting for input."));
      }
      const ordered = byUrgency(sessions);
      for (const s of ordered.slice(0, MAX_PANEL_ROWS)) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tray-sess";
        // The state on the element, not only in a class, so the rail beside it
        // is coloured by the same `[data-state]` rules the deck's own session
        // rows and tiles use. One vocabulary for "this one is waiting", across
        // every surface that has to say it (`styles.css`).
        row.dataset.state = s.state;
        // What survives a repaint, in `tray-window.ts`'s hands rather than this
        // file's: every row here is replaced whenever the deck reports, and a
        // person tabbed onto the ninth one has to come back to the ninth one.
        // The same attribute and the same convention `LimitsBlock` uses for its
        // own rows, so one walk finds either.
        row.dataset.focusKey = `sess:${s.session}`;
        const word = stateWord(s.state);
        // One sentence for a reader, rather than two spans to assemble — the
        // same rule the limits row's accessible name follows.
        row.setAttribute("aria-label", `${s.name} — ${word}, go to it`);
        const name = document.createElement("span");
        name.className = "tray-sess-name";
        // A session's name comes from a transcript this app did not write.
        name.textContent = s.name;
        const state = document.createElement("span");
        state.className = "tray-sess-state";
        state.textContent = word;
        row.append(name, state);
        row.onclick = () => act(ACTIONS.session(s.session));
        body.append(row);
      }
      const unnamed = ordered.length - Math.min(ordered.length, MAX_PANEL_ROWS);
      if (unnamed > 0) body.append(note(plural(unnamed, "more session", "more sessions")));
    },
  },
];

/** A row that is a fact rather than a control. */
function reading(text: string): TrayRow {
  return { text, action: null };
}

/** The same thing, drawn: a line that says something and does nothing. */
function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "tray-note";
  p.textContent = text;
  return p;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the icon says on hover.
 *
 *  One line, and it answers the question the icon is there for. Never the
 *  waiting count on its own: the dock badge is already that number, and a
 *  tooltip repeating it is the duplication ADR-0013 decision 3 forbids. What
 *  this adds is the thing a badge cannot say — that the deck is running and has
 *  nothing to report.
 */
function tooltipFor(f: TrayFacts): string {
  const waiting = waitingIn(f.sessions);
  const spent = f.usage.filter((s) => s.windows.some((w) => w.state === "exhausted"));
  if (spent.length) {
    return spent.length === 1
      ? `cowork-deck — ${spent[0].label} has nothing left`
      : "cowork-deck — more than one AI has nothing left";
  }
  if (waiting) return `cowork-deck — ${plural(waiting, "session is", "sessions are")} waiting`;
  return "cowork-deck";
}

export function waitingIn(sessions: RemoteSession[]): number {
  return sessions.filter((s) => s.state === "waitingInput").length;
}

/** Compose the report: the menu's rows, the tooltip, and the badge count.
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
    waiting: waitingIn(f.sessions),
  };
}

/** Draw the whole panel into `root`, section by section.
 *
 *  The layout, and the whole of it: a heading and a body per section. The same
 *  claim `build_menu` makes on the other side — it has never heard of a limit or
 *  a session, and adding one does not come through here.
 */
export function fillPanel(root: HTMLElement, f: TrayFacts, act: Act): void {
  root.replaceChildren();
  for (const section of PANEL) {
    const el = document.createElement("section");
    el.className = "tray-sec";
    el.dataset.section = section.id;
    const head = document.createElement("h2");
    head.textContent = section.heading;
    const body = document.createElement("div");
    body.className = "tray-body";
    section.fill(body, f, act);
    // A section that drew nothing still says so, for the reason `trayPanel`
    // gives: a heading over a blank is worse than a sentence.
    if (!body.childNodes.length) body.append(note("Nothing to report."));
    el.append(head, body);
    root.append(el);
  }
}

/** The sections there are, in order. For the tests, which assert that both
 *  renderers are generic over this list rather than knowing the names in it. */
export const PANEL_SECTIONS: readonly string[] = PANEL.map((s) => s.id);
