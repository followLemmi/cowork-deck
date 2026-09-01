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
  meterFraction,
  primaryWindow,
  readingOf,
  sourceLabel,
  stateClass,
  formatReset,
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
 *  Two of the three tones say the state in words as well as in a hue, which is
 *  the point of them: amber and red are the whole difference between "keep
 *  working" and "nothing will move", and a difference carried by hue alone is one
 *  a person who cannot see the hue does not get. The hue is on this line rather
 *  than on a bar because the strip has no room for a bar — see `strip`.
 *
 *  `glance` is the one place the strip and a row disagree, and only about a
 *  healthy window's reset time: a row has the room, and on the strip "resets
 *  19:00" beside a reading of 12% answers a question nobody asked.
 */
type Tone = "out" | "near" | "quiet";

function noteFor(
  snap: AiUsage,
  win: LimitWindow | null,
  now: number,
  glance: boolean,
): { text: string; tone: Tone } | null {
  if (win?.state === "exhausted") {
    return {
      text: win.resetsAt === null
        ? "nothing moves — no reset time known"
        : `nothing moves until ${formatReset(win.resetsAt, now)}`,
      tone: "out",
    };
  }
  if (win?.state === "near") {
    return {
      text: win.resetsAt === null
        ? "nearly spent"
        : `nearly spent — resets ${formatReset(win.resetsAt, now)}`,
      tone: "near",
    };
  }
  if (win?.resetsAt != null) {
    return glance ? null : { text: `resets ${formatReset(win.resetsAt, now)}`, tone: "quiet" };
  }
  // An error, and only an error. An unknown row used to add "not known" here,
  // which said the same thing the reading beside it already said — and two ways
  // of saying nothing read as two facts. What that row needs is the action, and
  // the action is the button next to it.
  if (snap.error) return { text: snap.error, tone: "quiet" };
  return null;
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
    this.el.replaceChildren();
    // Nothing detected is not an empty block — it is no block. An app on a
    // machine with no AI on it should not carry a strip over a blank.
    if (!snaps.length) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    const glance = usageGlance(snaps)!;

    const list = document.createElement("div");
    list.className = "lim-list";
    list.id = LIST_ID;
    list.hidden = !this.open;
    for (const snap of snaps) list.append(this.row(snap, now));

    // The list first and the strip after it, so the rows grow UPWARD out of the
    // panel's foot: the thing a person just pressed stays under their pointer,
    // and the reading they were looking at does not jump.
    this.el.append(list, this.strip(glance, now, list));
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
        win ? sourceLabel(win.source) : "",
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
      line.append(span(`lim-src lim-src--${win.source}`, sourceLabel(win.source)));
      line.append(span("lim-reading", readingOf(win)));
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
    const ask = this.askButton(snap, win);
    if (ask) strip.append(ask);
    return strip;
  }

  private row(snap: AiUsage, now: number): HTMLElement {
    const win = primaryWindow(snap);
    const row = document.createElement("div");
    row.className = "lim-row";
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
        win ? sourceLabel(win.source) : "",
        win?.resetsAt ? `resets ${formatReset(win.resetsAt, now)}` : "",
        "— open the detail",
      ]
        .filter(Boolean)
        .join(", "),
    );
    open.onclick = () => openUsageDialog(snap, this.host, () => this.redraw(Date.now()));

    const line = document.createElement("span");
    line.className = "lim-line";
    line.append(span("lim-name", snap.label));
    if (win) {
      // The tier, beside the number and in the same size as it. Not a tooltip
      // and not a footnote: two numbers that look alike and mean different
      // things are worse than one number and a blank (ADR-0009).
      line.append(span(`lim-src lim-src--${win.source}`, sourceLabel(win.source)));
      line.append(span("lim-reading", readingOf(win)));
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
    const ask = this.askButton(snap, win);
    if (ask) row.append(ask);
    return row;
  }

  /** The action for a reading nobody can read, or `null` when there is nothing to
   *  offer. Shared by the row and the strip: the same absence, the same way out. */
  private askButton(snap: AiUsage, win: LimitWindow | null): HTMLButtonElement | null {
    const unreadable = !win || win.state === "unknown";
    const probe = snap.probeCommand;
    if (!unreadable || !probe) return null;
    const ask = document.createElement("button");
    ask.className = "lim-probe";
    ask.type = "button";
    ask.textContent = "Ask";
    ask.title = `Run ${probe} in a tile`;
    ask.setAttribute("aria-label", `Ask ${snap.label} what is left — runs ${probe} in a tile`);
    ask.onclick = () => {
      void this.host.openCommandTile(`${snap.label}: limits`, probe, this.host.cwd());
    };
    return ask;
  }
}
