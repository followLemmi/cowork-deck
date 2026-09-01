/** The limits block: one row per connected AI, in the panel, always there.
 *
 *  A block rather than a fifth page. `deck`, `journal` and `scenarios` are places
 *  you go; a limit is something you glance at while working, and a screen you
 *  have to navigate to would be consulted exactly once — on the day you first
 *  found it, and never at the moment it mattered.
 *
 *  A row is one line: which AI, which tier the number is on, the reading, a thin
 *  meter, and when it lifts. The detail is in the dialog, because the question a
 *  glance asks is "can I keep working" and everything else is a follow-up.
 *
 *  Everything reaches the DOM through `textContent`. Account names, plans and
 *  error text all come from outside this app — the same rule, for the same
 *  reason, as `github-screen.ts`.
 */

import type { AiUsage } from "./ipc";
import { openUsageDialog, type UsageDialogHost } from "./usage-dialog";
import {
  meterFraction,
  primaryWindow,
  readingOf,
  sourceLabel,
  stateClass,
  formatReset,
  limitFoot,
  tierNote,
} from "./usage";

/** The least this block needs from the deck: somewhere to run the command that
 *  would answer a row it cannot read. */
export interface CommandRunner {
  openCommandTile(titleText: string, command: string, cwd: string): void | Promise<void>;
}

export interface LimitsHost extends CommandRunner, UsageDialogHost {
  /** Where a probe tile should run. Any directory will do — the command asks
   *  about an account, not about a repository — so this is the active workspace
   *  simply because that is the folder a person is already thinking about. */
  cwd(): string;
  /* --- What the tray panel needs, and the deck does not ------------------
     Three optional hooks, each defaulting to what this block has always done,
     because the block is now drawn in two windows: the deck's panel and the
     small window behind the status-area icon (ADR-0011). The alternative was a
     second implementation of a row — the meter, the tier chip, the foot
     sentence, the accessible name — and a second implementation is how the two
     surfaces would come to disagree about a number, which is the thing
     `usage.ts` exists to prevent. */

  /** Draw the block's own heading. Omitted where the surface already has one:
   *  the tray panel draws its section headings itself, and two "Limits" in a
   *  340px window is a mistake nobody has to make twice. */
  heading?: boolean;
  /** What a row's click opens. The dialog in this window by default. The tray
   *  panel has no room for a dialog, so it sends the person to the deck's. */
  openDetail?(snap: AiUsage): void;
  /** What the "Ask" button on an unreadable row does. Runs the command in a
   *  tile here; the tray panel has no tiles, so it asks the deck for one. */
  openProbe?(snap: AiUsage): void;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

export class LimitsBlock {
  constructor(
    private el: HTMLElement,
    private host: LimitsHost,
  ) {}

  private last: AiUsage[] = [];

  /** Draw the block from a snapshot.
   *
   *  `now` is passed in rather than read off the clock so that every reset time
   *  in one paint is relative to one instant, and so the rendering is testable
   *  without freezing time. */
  render(snaps: AiUsage[], now: number): void {
    this.last = snaps;
    this.el.replaceChildren();
    // Nothing detected is not an empty block — it is no block. An app on a
    // machine with no AI on it should not carry a heading over a blank.
    if (!snaps.length) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    const island = document.createElement("div");
    island.className = "island lim-block";
    if (this.host.heading !== false) {
      const head = document.createElement("h3");
      head.textContent = "Limits";
      island.append(head);
    }
    for (const snap of snaps) island.append(this.row(snap, now));
    this.el.append(island);
  }

  /** Re-draw from the snapshot already in hand. For the dialog's "clear", which
   *  changes what a row should say without a new read. */
  redraw(now: number): void {
    this.render(this.last, now);
  }

  private row(snap: AiUsage, now: number): HTMLElement {
    const win = primaryWindow(snap);
    const row = document.createElement("div");
    row.className = "lim-row";
    // On the row rather than only in a class, so the rail beside it and any
    // later rule can select on the state without a second carrier.
    row.dataset.state = win?.state ?? "unknown";
    row.dataset.provider = snap.provider;

    const open = document.createElement("button");
    open.className = "lim-open";
    open.type = "button";
    // The accessible name says everything the row says, in one sentence: a
    // reader should not have to assemble five spans into a meaning.
    open.setAttribute(
      "aria-label",
      [
        snap.label,
        win ? `${win.label}: ${readingOf(win)}` : "no windows",
        win ? tierNote(win) : "",
        win?.resetsAt ? `resets ${formatReset(win.resetsAt, now)}` : "",
        "— open the detail",
      ]
        .filter(Boolean)
        .join(", "),
    );
    open.onclick = () =>
      this.host.openDetail
        ? this.host.openDetail(snap)
        : openUsageDialog(snap, this.host, () => this.redraw(Date.now()));

    const line = document.createElement("span");
    line.className = "lim-line";
    line.append(span("lim-name", snap.label));
    if (win) {
      line.append(span("lim-reading", readingOf(win)));
      // What qualifies the number, AFTER it, and only when there is something to
      // qualify — see `tierNote`. It used to be the tier's own name, always, and
      // before the reading; ADR-0009's amendment is why it is neither now. Two
      // numbers that look alike and mean different things are still worse than
      // one number and a blank, and this is what keeps them apart.
      const note = tierNote(win);
      if (note) line.append(span(`lim-src lim-src--${win.source}`, note));
    }
    open.append(line);

    if (win) {
      const fill = meterFraction(win);
      // No share, no meter. A bar drawn at an arbitrary width would be this app
      // inventing a denominator it has already said it does not have.
      if (fill !== null) {
        const meter = document.createElement("span");
        meter.className = `lim-meter ${stateClass(win.state)}`;
        const bar = document.createElement("span");
        bar.className = "lim-fill";
        bar.style.width = `${Math.round(fill * 100)}%`;
        meter.append(bar);
        open.append(meter);
      }
      // The sentence is `limitFoot`'s, shared with the tray menu so the two
      // cannot disagree about what an exhausted window with no known reset
      // reads as. Only the class is decided here — an exhausted row is painted,
      // and a reset time or an error is not.
      const text = limitFoot(win, snap.error, now);
      if (text !== null) {
        const foot = document.createElement("span");
        foot.className = "lim-foot";
        foot.append(span(win.state === "exhausted" ? "lim-out-text" : "lim-reset", text));
        open.append(foot);
      }
    }

    row.append(open);

    // The one thing a person can do about a row nobody can read: run the command
    // that would answer it, in a tile, and read it with their own eyes. Better
    // than a blank meter, because it hands over the thing they would otherwise
    // go and do by hand.
    const unreadable = !win || win.state === "unknown";
    const probe = snap.probeCommand;
    if (unreadable && probe) {
      const ask = document.createElement("button");
      ask.className = "lim-probe";
      ask.type = "button";
      ask.textContent = "Ask";
      ask.title = `Run ${probe} in a tile`;
      ask.setAttribute("aria-label", `Ask ${snap.label} what is left — runs ${probe} in a tile`);
      ask.onclick = () => {
        if (this.host.openProbe) return this.host.openProbe(snap);
        void this.host.openCommandTile(`${snap.label}: limits`, probe, this.host.cwd());
      };
      row.append(ask);
    }
    return row;
  }
}
