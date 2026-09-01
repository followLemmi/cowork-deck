/** The limits: one line at the foot of the panel, and every row behind it.
 *
 *  Still a block in the panel rather than a page of it, and that half of the
 *  decision has not moved: `deck`, `journal` and `scenarios` are places you go; a
 *  limit is something you glance at while working, and a screen you have to
 *  navigate to would be consulted exactly once — on the day you first found it,
 *  and never at the moment it mattered.
 *
 *  What moved is how much of the panel it takes. One row per AI, three lines
 *  each, meant the block was a slab that grew with the number of accounts and
 *  never yielded, and the space came out of the page above it — the part being
 *  worked in. So the glance is now ONE line for the whole deck: the AI that is
 *  worst off, named, with its tier and its reading, and a count of the others.
 *  The rows are still here, one press away, and the strip stays put when they
 *  open because the list grows upward from it. See ADR-0011.
 *
 *  A row is one AI: which AI, which tier the number is on, the reading, a thin
 *  meter, and when it lifts. The detail is in the dialog, because the question a
 *  glance asks is "can I keep working" and everything else is a follow-up.
 *
 *  Everything reaches the DOM through `textContent`. Account names, plans and
 *  error text all come from outside this app — the same rule, for the same
 *  reason, as `github-screen.ts`.
 */

import type { AiUsage, LimitWindow } from "./ipc";
import { icon } from "./icons";
import { openUsageDialog, type UsageDialogHost } from "./usage-dialog";
import {
  formatReset,
  limitFoot,
  meterFraction,
  rankedAis,
  readingOf,
  stateClass,
  tierNote,
  usageGlance,
  type UsageGlance,
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
     small window behind the status-area icon (ADR-0013). The alternative was a
     second implementation of a row — the meter, the tier chip, the foot
     sentence, the accessible name — and a second implementation is how the two
     surfaces would come to disagree about a number, which is the thing
     `usage.ts` exists to prevent. */

  /** Draw the strip: the one folded line the rows open from. Omitted where the
   *  surface is already the glance. The status-area panel is opened
   *  deliberately, draws its own "Limits" heading, and is small enough that
   *  every row fits — so a fold inside it would put the rows two presses deep
   *  for a window that exists to show them in one. */
  strip?: boolean;
  /** What a row's click opens. The dialog in this window by default. The tray
   *  panel has no room for a dialog, so it sends the person to the deck's. */
  openDetail?(snap: AiUsage): void;
  /** What the "Ask" button on an unreadable row does. Runs the command in a
   *  tile here; the tray panel has no tiles, so it asks the deck for one. */
  openProbe?(snap: AiUsage): void;
}

/** What the strip's `aria-controls` points at. One `#limits` per window, so one
 *  id — and it has to exist in the document even while folded, or the control
 *  would name a target that is not there. */
const LIST_ID = "lim-list";

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

/** The thin bar, at the fraction `usage.ts` allows. A row's, and only a row's:
 *  see `strip` for why the one line at the foot of the panel has none. */
function meterOf(win: LimitWindow, fill: number): HTMLElement {
  const meter = document.createElement("span");
  meter.className = `lim-meter ${stateClass(win.state)}`;
  const bar = document.createElement("span");
  bar.className = "lim-fill";
  bar.style.width = `${Math.round(fill * 100)}%`;
  meter.append(bar);
  return meter;
}

/** The words under a reading, or `null` when there are none worth printing.
 *
 *  **The sentence is not decided here.** It is `limitFoot`'s, in `usage.ts`, so
 *  that the row in this panel and the row in the status-area menu cannot come to
 *  disagree about what an exhausted window with no known reset reads as. What
 *  this function adds is the two things only a drawn surface has an opinion
 *  about: the tone, and whether the sentence is worth the line at all.
 *
 *  Two of the three tones say the state in words as well as in a hue, which is
 *  the point of them: amber and red are the whole difference between "keep
 *  working" and "nothing will move", and a difference carried by hue alone is one
 *  a person who cannot see the hue does not get. The hue is on this line rather
 *  than on a bar because the strip has no room for a bar — see `strip`.
 *
 *  `glance` is the one place the strip and a row disagree, and only about a
 *  healthy window's reset time: a row has the room, and on the strip "resets
 *  19:00" beside a reading of 12% answers a question nobody asked. A window that
 *  is near or spent keeps its sentence on the strip, because that is the case the
 *  strip exists for.
 */
type Tone = "out" | "near" | "quiet";

function noteFor(
  snap: AiUsage,
  win: LimitWindow | null,
  now: number,
  glance: boolean,
): { text: string; tone: Tone } | null {
  // An error, and only an error. An unknown row used to add "not known" here,
  // which said the same thing the reading beside it already said — and two ways
  // of saying nothing read as two facts. What that row needs is the action, and
  // the action is the button next to it.
  if (!win) return snap.error ? { text: snap.error, tone: "quiet" } : null;
  const healthy = win.state !== "exhausted" && win.state !== "near";
  if (glance && healthy && win.resetsAt !== null) return null;
  const text = limitFoot(win, snap.error, now);
  if (text === null) return null;
  const tone: Tone = win.state === "exhausted" ? "out" : win.state === "near" ? "near" : "quiet";
  return { text, tone };
}

const TONE_CLASS: Record<Tone, string> = {
  out: "lim-out-text",
  near: "lim-near-text",
  quiet: "lim-reset",
};

/** The second line. `others` is the word about the AIs this line is not about,
 *  and it rides here rather than on the line above because the line above has no
 *  room for it — and because this is the line a person reads when something is
 *  wrong, which is the only time there is anything to say. */
function footOf(note: { text: string; tone: Tone }, others?: string | null): HTMLElement {
  const foot = document.createElement("span");
  foot.className = "lim-foot";
  foot.append(span(TONE_CLASS[note.tone], note.text));
  // Bracketed rather than after a separator: when the line above has run out of
  // room this drops to its own, and a dangling "·" at the start of a line is a
  // separator with nothing on one side of it.
  if (others) foot.append(span("lim-others", `(${others})`));
  return foot;
}

/** How many AIs the strip is not naming: `+3`, and nothing else, because the line
 *  it sits on has no room for anything else. What it does is say that there is a
 *  list behind this one reading. */
function restOf(g: UsageGlance): string | null {
  return g.others ? `+${g.others}` : null;
}

/** What is wrong with the AIs the strip is not naming, for the second line.
 *
 *  A strip that folded two spent accounts into a bare `+3` would be hiding
 *  exactly what it exists to surface. It can go on the second line without
 *  hiding, and that falls out of the ranking rather than needing a rule: the AI
 *  being named is the worst of them, so if any other is near or spent, the named
 *  one is at least as bad — and a second line is therefore already there. */
function alarmOf(g: UsageGlance): string | null {
  if (g.othersSpent) return `${g.othersSpent} more spent`;
  if (g.othersNear) return `${g.othersNear} more nearly spent`;
  return null;
}

export class LimitsBlock {
  constructor(
    private el: HTMLElement,
    private host: LimitsHost,
  ) {}

  private last: AiUsage[] = [];

  /** Whether the rows are showing.
   *
   *  Held here rather than read back off the DOM so the sixty-second re-read
   *  cannot fold a list somebody has open. Deliberately not persisted: folded is
   *  the default because folded is the answer, and an app that came up expanded
   *  because of something done last Tuesday would have given the panel height
   *  back away. */
  private open = false;

  /** Draw the block from a snapshot.
   *
   *  `now` is passed in rather than read off the clock so that every reset time
   *  in one paint is relative to one instant, and so the rendering is testable
   *  without freezing time. */
  render(snaps: AiUsage[], now: number): void {
    this.last = snaps;
    // What has to survive the repaint, read off the old DOM before it goes. This
    // runs on a sixty-second timer, and every element in here is replaced each
    // time: without this, a person reading row nine is returned to row one by a
    // clock, mid-sentence, and the keyboard is thrown back to the top of the
    // document. Keyed by what a control IS rather than by node, because not one
    // of these nodes lives to be focused again.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && this.el.contains(active)
      ? active.dataset.focusKey ?? null
      : null;
    const scrollTop = this.list()?.scrollTop ?? 0;

    this.el.replaceChildren();
    // Nothing detected is not an empty block — it is no block. An app on a
    // machine with no AI on it should not carry a strip over a blank.
    if (!snaps.length) {
      this.el.hidden = true;
      // And a block that has gone away keeps no fold. Folded is the default
      // because folded is the answer, and coming back expanded because of a press
      // made before the last AI disappeared would take panel height nobody asked
      // for, for a reading nobody was waiting on.
      this.open = false;
      return;
    }
    this.el.hidden = false;
    const ranked = rankedAis(snaps);
    const glance = usageGlance(snaps)!;

    const list = document.createElement("div");
    list.className = "lim-list";
    list.id = LIST_ID;
    list.hidden = !this.open;
    // Worst off first, out of the same ranking the strip picks its AI from, so
    // the list this opens is topped by the AI the strip just named. In detection
    // order the two agreed only by luck: an exhausted AI found last sat below the
    // fold of a list capped at 15rem while the strip pointed straight at it.
    for (const { snap, window: win } of ranked) list.append(this.row(snap, win, now));

    if (this.host.strip === false) {
      // No strip, so nothing to fold and nothing that could keep the list shut.
      // A surface that asked for the rows alone gets the rows alone.
      list.hidden = false;
      this.el.append(list);
    } else {
      // The strip FIRST in the DOM and the rows after it, so a screen reader
      // moving forward from the control it just pressed arrives inside what that
      // press revealed. On screen the order is the other way up —
      // `column-reverse` on `#limits` — so the rows still grow upward out of the
      // panel's foot and the thing under the pointer stays under it.
      this.el.append(this.strip(glance, now, list), list);
    }

    list.scrollTop = scrollTop;
    if (focusKey) this.refocus(focusKey);
  }

  /** The row list as it stands, or `null` before the first paint. */
  private list(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`#${LIST_ID}`);
  }

  /** Put the keyboard back on the control it was on. Matched by walking rather
   *  than by an attribute selector, because a provider key is not escaped and a
   *  selector built out of one would be the only place in this module that cared.
   *  `preventScroll`, because restoring focus is not a request to move the view. */
  private refocus(key: string): void {
    for (const el of this.el.querySelectorAll<HTMLElement>("[data-focus-key]")) {
      if (el.dataset.focusKey === key) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  }

  /** Re-draw from the snapshot already in hand. For the dialog's "clear", which
   *  changes what a row should say without a new read. */
  redraw(now: number): void {
    this.render(this.last, now);
  }

  /** The one line that is always there.
   *
   *  It names the AI whose answer to "can I keep working" is worst, because the
   *  others cannot make that answer better, and it carries that AI's tier beside
   *  its reading for the same reason every other surface does — the source of a
   *  usage number is part of the number (ADR-0009). A bare percentage would have
   *  fitted in less room and said less than nothing.
   *
   *  There is no meter on it, and that is the one thing this line gave up. Name,
   *  tier and reading come to about 230 of the 246 pixels a 280px panel leaves,
   *  and a 34px bar took the name down to "Clau…" — a clipped label identifies an
   *  AI badly, a clipped number identifies nothing at all, and the bar was the
   *  only one of the four that says something the reading beside it already said.
   *  The state's hue moved to the second line with the words, so it is still
   *  amber near a ceiling and red past it.
   */
  private strip(g: UsageGlance, now: number, list: HTMLElement): HTMLElement {
    const { snap, window: win } = g;
    const strip = document.createElement("div");
    strip.className = "lim-strip";
    // On the element rather than only in a class, so a later rule can select on
    // the state without a second carrier — as the rows already do.
    strip.dataset.state = win?.state ?? "unknown";
    strip.dataset.provider = snap.provider;
    // Folded or not, said twice on purpose. `aria-expanded` belongs to the
    // CONTROL, and the rules that swap the glance for the block's name have to
    // reach every span inside the strip — so the styling hook sits on the one
    // element that is an ancestor of all of them.
    strip.dataset.open = String(this.open);

    const note = noteFor(snap, win, now, true);
    const rest = restOf(g);
    const alarm = alarmOf(g);

    const open = document.createElement("button");
    open.className = "lim-summary";
    open.type = "button";
    open.dataset.focusKey = "strip";
    open.setAttribute("aria-expanded", String(this.open));
    open.setAttribute("aria-controls", LIST_ID);
    // For the sighted reader, who gets no heading over one line. The block's own
    // name is the first word of the accessible name below, where a reader needs
    // it and where it costs no pixels.
    open.title = "What every connected AI has left";
    open.setAttribute(
      "aria-label",
      [
        "Limits",
        snap.label,
        win ? `${win.label}: ${readingOf(win)}` : "no windows",
        win ? tierNote(win) ?? "" : "",
        note?.text ?? "",
        rest ? `${g.others} more` : "",
        alarm ?? "",
      ]
        .filter(Boolean)
        .join(", "),
    );
    // Folded in place rather than through `render`, so the control keeps focus
    // and a keyboard is not thrown back to the top of the panel by its own press.
    open.onclick = () => {
      this.open = !this.open;
      open.setAttribute("aria-expanded", String(this.open));
      strip.dataset.open = String(this.open);
      list.hidden = !this.open;
    };

    const line = document.createElement("span");
    line.className = "lim-line";
    // The block's name, and it shows only while the rows are open — at which
    // point every reading below says what this line was saying, and a strip
    // repeating the row above it is the same fact printed twice. Folded, the
    // reading is worth more than the word; open, the word is all that is left to
    // say, and it is where a person finally learns what the strip is called.
    line.append(span("lim-word", "Limits"));
    line.append(span("lim-name", snap.label));
    if (win) {
      line.append(span("lim-reading", readingOf(win)));
      // What qualifies the number, AFTER it, and only when there is something to
      // qualify — see `tierNote`. It used to be the tier's own name, always, and
      // before the reading; ADR-0009's amendment is why it is neither now, here
      // and on every row below.
      const note2 = tierNote(win);
      if (note2) line.append(span(`lim-src lim-src--${win.source}`, note2));
    }
    if (rest) line.append(span("lim-rest", rest));
    const caret = document.createElement("span");
    caret.className = "lim-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.append(icon("chevron", 12));
    line.append(caret);
    open.append(line);

    // The second line, and the only thing that can make this strip two lines
    // tall: it appears when something is nearly or wholly spent, which is when
    // being larger is the point rather than the complaint.
    if (note) open.append(footOf(note, alarm));
    strip.append(open);

    // A strip nobody can read is the case the glance has to keep answerable: the
    // way out cannot be behind the fold, or it is behind a fold on the one row
    // that has nothing to show for itself.
    const ask = this.askButton(snap, win, "strip");
    if (ask) strip.append(ask);
    return strip;
  }

  private row(snap: AiUsage, win: LimitWindow | null, now: number): HTMLElement {
    // The window is handed in rather than found again: `rankedAis` already picked
    // it to place this row, and a row that re-derived its own would be a second
    // chance for the two to disagree.
    const row = document.createElement("div");
    row.className = "lim-row";
    row.dataset.state = win?.state ?? "unknown";
    row.dataset.provider = snap.provider;

    const open = document.createElement("button");
    open.className = "lim-open";
    open.type = "button";
    open.dataset.focusKey = `row:${snap.provider}`;
    // The accessible name says everything the row says, in one sentence: a
    // reader should not have to assemble five spans into a meaning.
    open.setAttribute(
      "aria-label",
      [
        snap.label,
        win ? `${win.label}: ${readingOf(win)}` : "no windows",
        win ? tierNote(win) ?? "" : "",
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
      // The qualifier, beside the number and in the same size as it. Not a
      // tooltip and not a footnote: two numbers that look alike and mean
      // different things are worse than one number and a blank — which is
      // ADR-0009, as amended. See `tierNote` for what is printed and what is not.
      const tier = tierNote(win);
      if (tier) line.append(span(`lim-src lim-src--${win.source}`, tier));
    }
    open.append(line);

    if (win) {
      const fill = meterFraction(win);
      // No share, no meter. A bar drawn at an arbitrary width would be this app
      // inventing a denominator it has already said it does not have.
      if (fill !== null) open.append(meterOf(win, fill));
    }
    const note = noteFor(snap, win, now, false);
    if (note) open.append(footOf(note));

    row.append(open);

    // The one thing a person can do about a row nobody can read: run the command
    // that would answer it, in a tile, and read it with their own eyes. Better
    // than a blank meter, because it hands over the thing they would otherwise
    // go and do by hand.
    const ask = this.askButton(snap, win, "row");
    if (ask) row.append(ask);
    return row;
  }

  /** The action for a reading nobody can read, or `null` when there is nothing to
   *  offer. Shared by the row and the strip: the same absence, the same way out. */
  private askButton(snap: AiUsage, win: LimitWindow | null, where: string): HTMLButtonElement | null {
    const unreadable = !win || win.state === "unknown";
    const probe = snap.probeCommand;
    if (!unreadable || !probe) return null;
    const ask = document.createElement("button");
    ask.className = "lim-probe";
    ask.type = "button";
    // The strip's Ask and the row's Ask are the same offer in two places, and a
    // repaint has to tell them apart to hand focus back to the right one.
    ask.dataset.focusKey = `${where}-probe:${snap.provider}`;
    ask.textContent = "Ask";
    ask.title = `Run ${probe} in a tile`;
    ask.setAttribute("aria-label", `Ask ${snap.label} what is left — runs ${probe} in a tile`);
    ask.onclick = () => {
      if (this.host.openProbe) return this.host.openProbe(snap);
      void this.host.openCommandTile(`${snap.label}: limits`, probe, this.host.cwd());
    };
    return ask;
  }
}
