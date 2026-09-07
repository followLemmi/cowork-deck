/** The limits, as a row of dials: one mark per AI with its week drawn around it.
 *
 *  A GLANCE rather than a page, which is the half of ADR-0011 that has never
 *  moved — `deck`, `journal` and `scenarios` are places you go, and a limit is
 *  something you look at while working. What has moved is the shape of the
 *  glance. It was a slab of rows, then one folded line naming the worst-off AI
 *  (#392), and now three dials in a fixed order.
 *
 *  The line had one flaw that shrinking it further could not fix: it named ONE
 *  AI. Which one it named changed with the readings, so the word a person had
 *  learned to look for moved, and the other AIs existed only as `+2`. Three
 *  marks in a fixed order are read by POSITION rather than by name — the answer
 *  to "how is Claude doing" is in the same place every time, and it is there
 *  whether or not Claude happens to be the worst off.
 *
 *  What each part carries, and why it is that part:
 *
 *  - **The ring is the week** (`ringWindow`). A ring is a period coming round
 *    again, and the week is the period worth planning against.
 *  - **The mark is the AI.** Three silhouettes, told apart at 14px; the popover
 *    names them in words, so the drawing only has to be memorable.
 *  - **The dot is what the ring is not saying** (`dialAlert`). A five-hour
 *    window nearly spent is what stops work in the next ten minutes, and a dial
 *    showing a comfortable 62% while the deck is about to be refused would be
 *    answering a question nobody asked.
 *  - **The popover is everything else**: both windows in full, each with its
 *    tier and its reset, the plan and the account. ADR-0009's rule holds inside
 *    it exactly as it held in a row — a number and where it came from, together.
 *  - **A press opens the dialog**, which is where the caveats and the two
 *    actions live. Nothing interactive is inside the popover: it is a
 *    description, `aria-describedby` says so, and a control that appears under
 *    the pointer and vanishes when it leaves is a control nobody can reach.
 *
 *  Two of the three dials are HELD — `soon` in `usage.ts` — and that is a claim
 *  about the roadmap rather than about the machine. See `dialLineup` for why a
 *  held brand is not asked for a reading even where the backend has one.
 *
 *  Everything reaches the DOM through `textContent`. Account names, plans and
 *  error text all come from outside this app — the same rule, for the same
 *  reason, as `github-screen.ts`.
 */

import type { AiUsage, LimitWindow } from "./ipc";
import { icon, type IconName } from "./icons";
import { openUsageDialog, type UsageDialogHost } from "./usage-dialog";
import {
  dialLineup,
  formatReset,
  limitFoot,
  meterFraction,
  readingOf,
  sourceLabel,
  stateClass,
  tierNote,
  type Dial,
} from "./usage";

/** The least this block needs from the deck: somewhere to run the command that
 *  would answer a dial it cannot read. Kept on the host rather than on a button
 *  in the popover — the dialog is where the action is offered. */
export interface CommandRunner {
  openCommandTile(titleText: string, command: string, cwd: string): void | Promise<void>;
}

export interface DialsHost extends CommandRunner, UsageDialogHost {
  /** Where a probe tile should run. Any directory will do — the command asks
   *  about an account, not about a repository — so this is the active workspace
   *  simply because that is the folder a person is already thinking about. */
  cwd(): string;

  /* --- What the tray panel needs, and the deck does not ------------------
     The row is drawn in two windows: the deck's top bar and the small window
     behind the status-area icon (ADR-0013). The alternative was a second
     implementation of a dial — the ring, the tier, the reset, the accessible
     name — and a second implementation is how two surfaces come to disagree
     about a number, which is what `usage.ts` exists to prevent. */

  /** Where the detail goes.
   *
   *  `popover` floats it under the row, which needs somewhere to float: the
   *  deck's top bar has the whole window under it. The tray panel does not —
   *  `#tray` clips what leaves it, so a popover there would be a card with its
   *  bottom sheared off. So the panel gets it `inline`, below the row and always
   *  showing: one dial's detail at a time, the most urgent by default, and
   *  hovering or tabbing changes which. A window that is opened deliberately can
   *  afford to have the answer already on it. */
  detail?: "popover" | "inline";

  /** What a dial's press opens. The dialog in this window by default. The tray
   *  panel has no room for a dialog, so it sends the person to the deck's. */
  openDetail?(snap: AiUsage): void;
}

/** What a dial's `aria-describedby` points at. One row per window, so one id. */
const CARD_ID = "lim-card";

/** The mark in the middle of each dial. A brand with no drawing of its own gets
 *  the generic one rather than an empty circle — a provider added in Rust
 *  reaches this screen without this file learning its name (`dialLineup`), and
 *  it should not arrive as a hole. */
const MARKS: Record<string, IconName> = {
  claude: "mark-claude",
  codex: "mark-codex",
  gemini: "mark-gemini",
};
const GENERIC_MARK: IconName = "sparkle";

/** The ring's geometry, in the units of its own viewBox. `r` and the stroke
 *  together decide how much of the 32-unit box is ink; the rendered size is the
 *  stylesheet's business. */
const R = 13.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function para(cls: string, text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The ring: a track, and an arc over it where there is a fraction to draw.
 *
 *  No arc at all when there is none, which is the same rule the meter has always
 *  kept (`meterFraction`): an arc drawn at some arbitrary sweep would be this app
 *  inventing a denominator it has just said it does not have. The track alone is
 *  a true drawing of "nothing is known".
 */
function ringOf(fill: number | null, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `dial-ring ${cls}`.trim());
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("class", "dial-track");
  track.setAttribute("cx", "16");
  track.setAttribute("cy", "16");
  track.setAttribute("r", String(R));
  svg.append(track);

  if (fill !== null) {
    const arc = document.createElementNS(SVG_NS, "circle");
    arc.setAttribute("class", "dial-arc");
    arc.setAttribute("cx", "16");
    arc.setAttribute("cy", "16");
    arc.setAttribute("r", String(R));
    // Twelve o'clock. A bare `<circle>` starts its dash pattern at THREE, which
    // reads as a gauge already a quarter spent; it sweeps clockwise from there,
    // which is the direction a person reads a dial, so the rotation is the whole
    // correction.
    arc.setAttribute("transform", "rotate(-90 16 16)");
    const lit = CIRCUMFERENCE * fill;
    arc.setAttribute("stroke-dasharray", `${lit.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`);
    svg.append(arc);
  }
  return svg;
}

/** One window, as three lines in the popover: what it is and what it reads, the
 *  meter, and the sentence about its state.
 *
 *  The tier is printed by NAME here, not as the row's shortened caveat. This is
 *  the surface with room for the vocabulary — the same call the dialog makes,
 *  and for the same reason ADR-0009's amendment gives: a row has no room to
 *  teach a word, and a card does. */
function windowLine(w: LimitWindow, error: string | null, now: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "dial-win";
  box.dataset.window = w.id;
  box.dataset.state = w.state;

  const head = document.createElement("div");
  head.className = "lim-line";
  head.append(span("lim-name", w.label));
  head.append(span("lim-reading", readingOf(w)));
  head.append(span(`lim-src lim-src--${w.source}`, sourceLabel(w.source)));
  box.append(head);

  const fill = meterFraction(w);
  if (fill !== null) {
    const meter = document.createElement("span");
    meter.className = `lim-meter ${stateClass(w.state)}`;
    const bar = document.createElement("span");
    bar.className = "lim-fill";
    bar.style.width = `${Math.round(fill * 100)}%`;
    meter.append(bar);
    box.append(meter);
  }

  // The words are `limitFoot`'s, in `usage.ts`, so the card, the deck's dialog
  // and the status-area menu cannot come to disagree about what an exhausted
  // window with no known reset reads as. What is decided here is only the tone.
  const text = limitFoot(w, error, now);
  if (text !== null) {
    const tone = w.state === "exhausted" ? "lim-out-text" : w.state === "near" ? "lim-near-text" : "lim-reset";
    box.append(span(`dial-foot ${tone}`, text));
  }
  return box;
}

/** The windows in the order the card reads them: the one the ring drew first,
 *  then the rest as the provider declared them.
 *
 *  Ring first because the card has to explain the drawing a person is looking
 *  at. Declared order for the rest because that is the provider's own reading
 *  order and this file has no better opinion about it. */
function orderedWindows(snap: AiUsage, ring: LimitWindow | null): LimitWindow[] {
  if (!ring) return snap.windows;
  return [ring, ...snap.windows.filter((w) => w !== ring)];
}

/** What the card says for one dial. */
function cardBody(d: Dial, now: number): HTMLElement[] {
  const out: HTMLElement[] = [];

  const head = document.createElement("div");
  head.className = "dial-card-head";
  head.append(span("dial-card-name", d.label));
  if (d.soon) head.append(span("dial-soon", "Coming soon"));
  out.push(head);

  if (d.soon) {
    out.push(
      para(
        "dial-card-note",
        "This deck does not read this AI's limits yet. The dial is here so the " +
          "row does not change shape on the day it starts to.",
      ),
    );
    return out;
  }

  const snap = d.snap;
  if (!snap) {
    out.push(para("dial-card-note", "Not found on this machine."));
    return out;
  }

  // Who this is about. A plan and an account are the two facts that explain an
  // unexpected ceiling, and neither is guessable from the numbers — which is why
  // they are on the glance now rather than only in the dialog behind it.
  const who = [snap.account, snap.plan].filter(Boolean).join(" · ");
  if (who) out.push(para("lim-who", who));
  if (snap.error) out.push(para("lim-error", snap.error));

  if (!snap.windows.length) {
    out.push(para("dial-card-note", "This AI reported no limit windows."));
  }
  for (const w of orderedWindows(snap, d.ring)) out.push(windowLine(w, snap.error, now));

  // Where the rest is. Not a button: see the note at the top of this file about
  // what may and may not live inside a description.
  out.push(para("dial-card-hint", "Press for the caveats and what to do about them."));
  return out;
}

/** One sentence carrying everything the dial draws, for a reader who gets none
 *  of the drawing. The popover is a description and may be missed; this may not
 *  be. */
function dialLabel(d: Dial, now: number): string {
  if (d.soon) return `${d.label} — coming soon`;
  if (!d.snap) return `${d.label} — not found on this machine`;
  const parts = [d.label];
  if (d.ring) {
    parts.push(`${d.ring.label}: ${readingOf(d.ring)}`);
    const tier = tierNote(d.ring);
    if (tier) parts.push(tier);
    if (d.ring.resetsAt !== null) parts.push(`resets ${formatReset(d.ring.resetsAt, now)}`);
  } else {
    parts.push("no windows");
  }
  if (d.alert === "exhausted") parts.push("another window is spent");
  if (d.alert === "near") parts.push("another window is nearly spent");
  if (d.snap.error) parts.push(d.snap.error);
  parts.push("— open the detail");
  return parts.filter(Boolean).join(", ");
}

/** How urgent a dial is, for deciding which one the inline card shows first.
 *  Spent before nearly spent before everything else; a held brand last. It is
 *  deliberately NOT the order the dials are drawn in — see `dialLineup`. */
function cardRank(d: Dial): number {
  if (d.soon || !d.snap) return 5;
  if (d.ring?.state === "exhausted" || d.alert === "exhausted") return 0;
  if (d.ring?.state === "near" || d.alert === "near") return 1;
  if (d.snap.error) return 2;
  return d.ring ? 3 : 4;
}

export class LimitDials {
  constructor(
    private el: HTMLElement,
    private host: DialsHost,
  ) {}

  private last: AiUsage[] = [];

  /** Which dial the card is describing, by provider, or `null` for none.
   *
   *  Held here rather than read back off the DOM so the sixty-second re-read
   *  cannot close a card somebody is reading, or move it to another AI. */
  private shown: string | null = null;

  private get inline(): boolean {
    return this.host.detail === "inline";
  }

  /** Draw the row from a snapshot.
   *
   *  `now` is passed in rather than read off the clock so that every reset time
   *  in one paint is relative to one instant, and so the rendering is testable
   *  without freezing time. */
  render(snaps: AiUsage[], now: number): void {
    this.last = snaps;
    // What has to survive the repaint, read off the old DOM before it goes. This
    // runs on a sixty-second timer and every element here is replaced each time:
    // without it, the keyboard is thrown back to the top of the document by a
    // clock. Keyed by what a control IS rather than by node, because not one of
    // these nodes lives to be focused again.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && this.el.contains(active)
      ? active.dataset.focusKey ?? null
      : null;

    this.el.replaceChildren();
    this.el.hidden = false;

    const dials = dialLineup(snaps);
    // The inline card always says something, so a surface with no pointer on it
    // still answers. The most urgent readable dial, and a held one only if
    // there is nothing else — which on a machine with no AI on it is what there
    // is.
    if (this.inline && !dials.some((d) => d.provider === this.shown)) {
      this.shown = [...dials].sort((a, b) => cardRank(a) - cardRank(b))[0]?.provider ?? null;
    }

    const row = document.createElement("div");
    row.className = "dial-row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Limits");
    for (const d of dials) row.append(this.dial(d, now));

    const card = document.createElement("div");
    card.className = this.inline ? "dial-card dial-card--inline" : "dial-card";
    card.id = CARD_ID;
    if (!this.inline) card.setAttribute("role", "tooltip");
    const on = dials.find((d) => d.provider === this.shown) ?? null;
    // On the element, so a surface that has to rebuild its whole document can
    // read back which dial was open before it did — see `selected`.
    card.dataset.provider = on?.provider ?? "";
    card.hidden = on === null;
    if (on) card.append(...cardBody(on, now));

    // The row first and the card after it, so a reader moving forward off the
    // dial it is describing arrives inside the description. On screen the
    // popover floats under the row, which is the same order.
    this.el.append(row, card);
    this.describe();

    if (focusKey) this.refocus(focusKey);
  }

  /** Re-draw from the snapshot already in hand. For the dialog's "clear", which
   *  changes what a dial should say without a new read. */
  redraw(now: number): void {
    this.render(this.last, now);
  }

  /** Which dial the card is describing, and how to say so before the first
   *  paint.
   *
   *  For the status-area panel, which rebuilds its ENTIRE document on every
   *  report from the deck — a fresh body and a fresh block, every few seconds
   *  (`tray-window.ts`). This block's own bookkeeping cannot survive that,
   *  because the DOM it reads is the DOM that is about to be thrown away. So the
   *  panel carries the value across for it, exactly as it already carries the
   *  scroll position and the focused control. Without it the card in the panel
   *  snapped back to the most urgent AI every five seconds, under the pointer of
   *  somebody reading a different one. */
  get selected(): string | null {
    return this.shown;
  }

  set selected(provider: string | null) {
    this.shown = provider;
  }

  private dial(d: Dial, now: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dial";
    b.dataset.focusKey = `dial:${d.provider}`;
    b.dataset.provider = d.provider;
    // On the element rather than only in a class, so the stylesheet reaches the
    // ring's hue without a second carrier — the vocabulary the deck's own
    // session rows and tiles already use for exactly this.
    b.dataset.state = d.soon || !d.snap ? "none" : d.ring?.state ?? "unknown";
    if (d.soon) b.dataset.soon = "true";
    if (d.alert) b.dataset.alert = d.alert;
    b.setAttribute("aria-label", dialLabel(d, now));
    // Held and undetected dials still take focus and still describe themselves.
    // `disabled` would take both away, and "why is this one grey" is exactly the
    // question the description answers.
    if (d.soon || !d.snap) b.setAttribute("aria-disabled", "true");

    const fill = d.ring && !d.soon ? meterFraction(d.ring) : null;
    b.append(ringOf(fill, d.ring && !d.soon ? stateClass(d.ring.state) : ""));

    const mark = document.createElement("span");
    mark.className = "dial-mark";
    mark.append(icon(MARKS[d.provider] ?? GENERIC_MARK, 14));
    b.append(mark);

    if (d.alert) {
      const dot = document.createElement("span");
      dot.className = "dial-dot";
      dot.setAttribute("aria-hidden", "true");
      b.append(dot);
    }

    // The paint's clock rather than the hover's, which is the contract at the top
    // of `render`: every reset time on screen is relative to one instant, and the
    // module reads no clock of its own. The row repaints once a minute and these
    // times are printed to the minute, so the two never disagree visibly.
    const show = () => this.show(d.provider, now);
    b.addEventListener("mouseenter", show);
    b.addEventListener("focus", show);
    // A popover follows the pointer away; an inline card does not, because the
    // panel it lives in would change height every time a pointer crossed it.
    if (!this.inline) {
      b.addEventListener("mouseleave", () => this.show(null, now));
      b.addEventListener("blur", () => this.show(null, now));
      b.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.show(null, now);
      });
    }

    b.onclick = () => {
      const snap = d.snap;
      if (!snap) return;
      if (this.host.openDetail) return this.host.openDetail(snap);
      openUsageDialog(snap, this.host, () => this.redraw(Date.now()));
    };
    return b;
  }

  /** Move the card, in place rather than through `render`, so the control keeps
   *  focus and a hover does not rebuild the row under the pointer. */
  private show(provider: string | null, now: number): void {
    // A held card cannot be closed in the panel: something is always described
    // there, and blanking it on the way out would leave a hole the height of a
    // card.
    if (this.inline && provider === null) return;
    if (this.shown === provider) return;
    this.shown = provider;
    const card = this.el.querySelector<HTMLElement>(`#${CARD_ID}`);
    if (!card) return;
    const d = dialLineup(this.last).find((x) => x.provider === provider) ?? null;
    card.replaceChildren();
    card.dataset.provider = d?.provider ?? "";
    card.hidden = d === null;
    if (d) card.append(...cardBody(d, now));
    this.describe();
  }

  /** Point exactly one dial at the card, and only where the card is a popover.
   *
   *  The description belongs to the dial it is describing and to no other, or a
   *  reader tabbing the row would be read the same paragraph three times. In the
   *  panel the card is not a description of any one dial — it is a pane of the
   *  window that happens to follow the pointer — so nothing points at it and
   *  every dial's own `aria-label` carries its reading instead. */
  private describe(): void {
    for (const b of this.el.querySelectorAll<HTMLElement>(".dial")) {
      if (!this.inline && this.shown !== null && b.dataset.provider === this.shown) {
        b.setAttribute("aria-describedby", CARD_ID);
      } else {
        b.removeAttribute("aria-describedby");
      }
    }
  }

  /** Put the keyboard back on the control it was on. Matched by walking rather
   *  than by an attribute selector, because a provider key is not escaped and a
   *  selector built out of one would be the only place in this module that
   *  cared. `preventScroll`, because restoring focus is not a request to move
   *  the view. */
  private refocus(key: string): void {
    for (const el of this.el.querySelectorAll<HTMLElement>("[data-focus-key]")) {
      if (el.dataset.focusKey === key) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  }
}
