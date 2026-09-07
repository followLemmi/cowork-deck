/** The limits, as a row of dials: each AI's own mark with its week drawn around
 *  it.
 *
 *  A GLANCE rather than a page, which is the half of ADR-0011 that has never
 *  moved — `deck`, `journal` and `scenarios` are places you go, and a limit is
 *  something you look at while working. What has moved is the shape of the
 *  glance. It was a slab of rows, then one folded line naming the worst-off AI
 *  (#392), and now dials in a fixed order.
 *
 *  The line had one flaw that shrinking it further could not fix: it named ONE
 *  AI. Which one it named changed with the readings, so the word a person had
 *  learned to look for moved, and the other AIs existed only as `+2`. Marks in a
 *  fixed order are read by POSITION rather than by name — the answer to "how is
 *  Claude doing" is in the same place every time, and it is there whether or not
 *  Claude happens to be the worst off.
 *
 *  What each part carries, and why it is that part:
 *
 *  - **The ring is the week** (`ringWindow`). A ring is a period coming round
 *    again, and the week is the period worth planning against.
 *  - **The mark is the AI**, and it is the AI's own logo rather than something
 *    drawn to match this app's icon set — see `BRAND_PATHS` in `icons.ts`.
 *  - **The caption is the reading, in figures.** A ring at 4% is a hairline and
 *    a ring at 0% is nothing at all, and neither is distinguishable at a glance
 *    from a ring that is not working. The number under it is what makes the
 *    drawing checkable, and it is the reason this surface can afford to be a
 *    drawing in the first place.
 *  - **The dot is what the ring is not saying** (`dialAlert`). A five-hour
 *    window nearly spent is what stops work in the next ten minutes, and a dial
 *    showing a comfortable 62% while the deck is about to be refused would be
 *    answering a question nobody asked.
 *  - **The card is everything else**: both windows in full, each with its
 *    qualifier and its reset, the plan and the account. ADR-0009's rule holds
 *    inside it exactly as it held in a row.
 *  - **A press opens the dialog**, which is where the caveats and the actions
 *    live. Nothing interactive is inside the card: it is a description, and a
 *    control that appears under the pointer and vanishes when it leaves is a
 *    control nobody can reach.
 *
 *  Two of the dials are HELD — `soon` in `usage.ts` — and that is a claim about
 *  the roadmap rather than about the machine. See `dialLineup` for why a held
 *  brand is not asked for a reading even where the backend has one.
 *
 *  Everything reaches the DOM through `textContent`. Account names, plans and
 *  error text all come from outside this app — the same rule, for the same
 *  reason, as `github-screen.ts`.
 */

import type { AiUsage, LimitWindow } from "./ipc";
import { brandIcon, hasBrand, icon } from "./icons";
import { openUsageDialog, type UsageDialogHost } from "./usage-dialog";
import {
  dialLineup,
  formatReset,
  limitFoot,
  meterFraction,
  readingOf,
  stateClass,
  tierNote,
  type Dial,
} from "./usage";

/** The least this block needs from the deck: somewhere to run the command that
 *  would answer a dial it cannot read. Kept on the host rather than on a button
 *  in the card — the dialog is where the action is offered. */
export interface CommandRunner {
  openCommandTile(titleText: string, command: string, cwd: string): void | Promise<void>;
}

export interface DialsHost extends CommandRunner, UsageDialogHost {
  /** Where a probe tile should run. Any directory will do — the command asks
   *  about an account, not about a repository — so this is the active workspace
   *  simply because that is the folder a person is already thinking about. */
  cwd(): string;

  /* --- What each surface needs -------------------------------------------
     The row is drawn in two windows: the deck's top bar and the small window
     behind the status-area icon (ADR-0013). The alternative was a second
     implementation of a dial — the ring, the qualifier, the reset, the
     accessible name — and a second implementation is how two surfaces come to
     disagree about a number, which is what `usage.ts` exists to prevent. */

  /** How much of this is on screen when nobody is asking.
   *
   *  `popover` (the deck) shows one word and hides the dials behind it. The top
   *  bar is a row of the deck's OWN state — what is blocked, what is waiting —
   *  and three logos sitting in it permanently read as three more controls. One
   *  press-or-point opens the lot.
   *
   *  `float` (the status-area panel) shows the dials, because that window is
   *  nothing but a glance and hiding its content behind a hover would put it two
   *  gestures deep. What it cannot do is grow: a card in the flow pushed the
   *  sessions below it down every time a pointer crossed a logo. So the card
   *  floats OVER what is under it, at `cardMount`. */
  detail?: "popover" | "float";

  /** Where a floating card is hung, for `float`.
   *
   *  It has to be outside the panel's scrolling list and inside the panel's own
   *  rounded box: an absolutely positioned card inside `#tray-sections` is
   *  clipped by that container and adds to its scroll height, which is the
   *  content-shifting this mode exists to stop, one level down. `null` or absent
   *  falls back to this block's own element. */
  cardMount?(): HTMLElement | null;

  /** What a dial's press opens. The dialog in this window by default. The tray
   *  panel has no room for a dialog, so it sends the person to the deck's. */
  openDetail?(snap: AiUsage): void;
}

/** One `#limits` per window, so one id for each of the two things a control
 *  points at. */
const CARD_ID = "lim-card";
const POP_ID = "lim-pop";

/** The ring's geometry, in the units of its own viewBox. `r` and the stroke
 *  together decide how much of the 32-unit box is ink; the rendered size is the
 *  stylesheet's business. */
const R = 13.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

const SVG_NS = "http://www.w3.org/2000/svg";

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

/** The ring: a track, and an arc over it where there is a fraction to draw.
 *
 *  No arc at all when there is none, which is the same rule the meter has always
 *  kept (`meterFraction`): an arc drawn at some arbitrary sweep would be this app
 *  inventing a denominator it has just said it does not have. The track alone is
 *  a true drawing of "nothing is known" — and the caption under it says so in
 *  words, because a bare track and a track at 0% look alike and are not.
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

/** The reading under a dial, in as few characters as it can be said in.
 *
 *  A share becomes a percentage and everything else becomes a dash, which is the
 *  same rule `readingOf` keeps in words: an absolute with no ceiling is not a
 *  percentage of anything, and printing one here would be this app inventing a
 *  denominator. `soon` is not a reading at all and says so. */
function captionOf(d: Dial): string {
  if (d.soon) return "soon";
  if (!d.snap) return "—";
  const f = d.ring ? d.ring.usedFraction : null;
  return f === null ? "—" : `${Math.round(f * 100)}%`;
}

/** One window, as three lines in the card: what it is and what it reads, the
 *  meter, and the sentence about its state.
 *
 *  The qualifier is `tierNote`'s, which prints NOTHING for the account's own
 *  accounting — ADR-0009 as amended. An unqualified number is the account's, and
 *  that is what a person assumes anyway; the failure that record exists to
 *  prevent is the other direction, this app's own narrower count being read as
 *  the account's, and only the weaker tiers can commit it. The tier NAMES live
 *  in the dialog beside the sentences that define them, which is where a
 *  vocabulary is taught. */
function windowLine(w: LimitWindow, error: string | null, now: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "dial-win";
  box.dataset.window = w.id;
  box.dataset.state = w.state;

  const head = document.createElement("div");
  head.className = "lim-line";
  head.append(span("lim-name", w.label));
  head.append(span("lim-reading", readingOf(w)));
  const note = tierNote(w);
  if (note) head.append(span(`lim-src lim-src--${w.source}`, note));
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
 *  of the drawing. The card may be missed; this may not. */
function dialLabel(d: Dial, now: number): string {
  if (d.soon) return `${d.label} — coming soon`;
  if (!d.snap) return `${d.label} — not found on this machine`;
  const parts = [d.label];
  if (d.ring) {
    parts.push(`${d.ring.label}: ${readingOf(d.ring)}`);
    const note = tierNote(d.ring);
    if (note) parts.push(note);
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

/** How urgent a dial is, for deciding which one the card opens on. Spent before
 *  nearly spent before everything else; a held brand last. It is deliberately
 *  NOT the order the dials are drawn in — see `dialLineup`. */
function cardRank(d: Dial): number {
  if (d.soon || !d.snap) return 5;
  if (d.ring?.state === "exhausted" || d.alert === "exhausted") return 0;
  if (d.ring?.state === "near" || d.alert === "near") return 1;
  if (d.snap.error) return 2;
  return d.ring ? 3 : 4;
}

/** The worst state anything in the lineup is in, for the one word in the bar.
 *
 *  The whole reason the trigger is not a bare word: hiding the dials behind a
 *  press is only acceptable if the press is not needed to find out that
 *  something is wrong. `null` is a lineup with nothing to report. */
function alarmOf(dials: Dial[]): "near" | "exhausted" | null {
  let out: "near" | "exhausted" | null = null;
  for (const d of dials) {
    for (const state of [d.ring?.state, d.alert]) {
      if (state === "exhausted") return "exhausted";
      if (state === "near") out = "near";
    }
  }
  return out;
}

export class LimitDials {
  constructor(
    private el: HTMLElement,
    private host: DialsHost,
  ) {
    /* Three listeners for closing the deck's popover, and they are installed
       HERE rather than in `trigger` for one reason: `el` outlives the paint.
       Every other listener in this file is on a node this block creates and
       throws away once a minute, so attaching is free; attaching to `el` on
       every paint would add a listener a minute for as long as the window is
       open. They read the DOM when they fire instead of closing over it.

       The pointer one is on the WHOLE block rather than on the word: the popover
       is a descendant, so the pointer travelling from the word into the dials
       does not leave, and this fires only when it has genuinely gone. */
    el.addEventListener("mouseleave", () => this.shut());
    el.addEventListener("focusout", (e) => {
      const to = (e as FocusEvent).relatedTarget;
      if (to instanceof Node && el.contains(to)) return;
      this.shut();
    });
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape" || !this.open) return;
      this.pinned = false;
      this.shut();
      this.el.querySelector<HTMLElement>(".dial-trigger")?.focus({ preventScroll: true });
    });
  }

  private last: AiUsage[] = [];

  /** Which dial the card is describing, by provider, or `null` for none.
   *
   *  Held here rather than read back off the DOM so the sixty-second re-read
   *  cannot close a card somebody is reading, or move it to another AI. */
  private shown: string | null = null;

  /** Whether the deck's popover is showing, and whether a press pinned it there.
   *
   *  Two flags rather than one because they answer different questions: a
   *  pointer opens and closes it, and a press keeps it open through both. A
   *  keyboard has no pointer, which is the case the pin exists for. */
  private open = false;
  private pinned = false;

  /** The floating card, which lives outside this block's own element and must
   *  therefore be taken away by hand — nothing else will empty its parent. */
  private card: HTMLElement | null = null;

  private get floats(): boolean {
    return this.host.detail === "float";
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

    this.card?.remove();
    this.card = null;
    this.el.replaceChildren();
    this.el.hidden = false;

    const dials = dialLineup(snaps);
    // The card in the deck's popover always says something — it is inside a box
    // that is already floating, and an empty box would open at one height and
    // jump to another. The floating card in the panel says nothing until a
    // pointer asks, because it covers what is under it.
    if (!this.floats && !dials.some((d) => d.provider === this.shown)) {
      this.shown = [...dials].sort((a, b) => cardRank(a) - cardRank(b))[0]?.provider ?? null;
    }

    const row = document.createElement("div");
    row.className = "dial-row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Limits");
    for (const d of dials) row.append(this.dial(d, now));

    const card = document.createElement("div");
    card.className = this.floats ? "dial-card dial-card--float" : "dial-card";
    card.id = CARD_ID;
    if (this.floats) card.setAttribute("role", "tooltip");
    this.card = card;

    if (this.floats) {
      // The row where the panel put it, and the card hung somewhere it will not
      // be clipped or scrolled — see `cardMount`.
      this.el.append(row);
      (this.host.cardMount?.() ?? this.el).append(card);
    } else {
      // The trigger FIRST in the DOM and what it opens after it, so a reader
      // moving forward off the control it just pressed arrives inside what that
      // press revealed. On screen the popover floats under the trigger, which is
      // the same order.
      const pop = document.createElement("div");
      pop.className = "dial-pop";
      pop.id = POP_ID;
      pop.hidden = !this.open;
      pop.append(row, card);
      this.el.append(this.trigger(dials, now, pop), pop);
    }

    this.fillCard(dials, now);
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
   *  vanished from under the pointer every five seconds. */
  get selected(): string | null {
    return this.shown;
  }

  set selected(provider: string | null) {
    this.shown = provider;
  }

  /** The one word in the top bar, and what it is hiding.
   *
   *  ADR-0011 put the reading itself in the bar and this takes it back out,
   *  which is the trade #498 makes: the bar is a row of the deck's own state,
   *  and three logos parked in it read as three more controls rather than as a
   *  reading. What does NOT go behind the press is the alarm — the dot below is
   *  the reason hiding the rest is acceptable at all. */
  private trigger(dials: Dial[], now: number, pop: HTMLElement): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dial-trigger";
    b.dataset.focusKey = "trigger";
    b.setAttribute("aria-expanded", String(this.open));
    b.setAttribute("aria-controls", POP_ID);
    b.title = "What every connected AI has left";
    b.append(span("dial-trigger-word", "Limits"));

    const alarm = alarmOf(dials);
    if (alarm) {
      b.dataset.alarm = alarm;
      const dot = document.createElement("span");
      dot.className = "dial-dot";
      dot.setAttribute("aria-hidden", "true");
      b.append(dot);
    }
    const caret = document.createElement("span");
    caret.className = "dial-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.append(icon("chevron", 12));
    b.append(caret);

    b.setAttribute(
      "aria-label",
      [
        "Limits",
        alarm === "exhausted" ? "something is spent" : alarm === "near" ? "something is nearly spent" : "",
        "— what every connected AI has left",
      ].filter(Boolean).join(", "),
    );

    const open = () => {
      if (this.open) return;
      this.open = true;
      pop.hidden = false;
      b.setAttribute("aria-expanded", "true");
      this.fillCard(dialLineup(this.last), now);
    };
    b.addEventListener("mouseenter", open);
    // A pointer opens it by pointing; a keyboard opens it by pressing. There is
    // deliberately no `focus` opener: Escape shuts the box and hands the
    // keyboard back to this word, and a word that opened on focus would open it
    // again on the way — Escape would do nothing at all.
    //
    // A press also PINS it, so a keyboard, which has no pointer to hold in
    // place, can go into the dials and back out without the box shutting behind
    // it.
    b.addEventListener("click", () => {
      this.pinned = !this.pinned;
      if (this.pinned) open();
      else this.shut();
    });
    return b;
  }

  /** Shut the deck's popover, unless a press is holding it open.
   *
   *  Reached from the pointer leaving the whole block, from the focus going
   *  somewhere else in the window, and from Escape — see the constructor for why
   *  those three live there rather than here. It walks the DOM rather than
   *  closing over the nodes, because the nodes it would close over are replaced
   *  every minute. */
  private shut(): void {
    if (this.pinned || !this.open) return;
    this.open = false;
    const pop = this.el.querySelector<HTMLElement>(`#${POP_ID}`);
    if (pop) pop.hidden = true;
    this.el.querySelector<HTMLElement>(".dial-trigger")?.setAttribute("aria-expanded", "false");
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

    const face = document.createElement("span");
    face.className = "dial-face";
    const fill = d.ring && !d.soon ? meterFraction(d.ring) : null;
    face.append(ringOf(fill, d.ring && !d.soon ? stateClass(d.ring.state) : ""));

    const mark = document.createElement("span");
    mark.className = "dial-mark";
    // The AI's own logo where there is one, and a house icon where the registry
    // grew a provider this app has never heard of (#308) — never a hole.
    mark.append(hasBrand(d.provider) ? brandIcon(d.provider, 20) : icon("sparkle", 20));
    face.append(mark);

    if (d.alert) {
      const dot = document.createElement("span");
      dot.className = "dial-dot";
      dot.setAttribute("aria-hidden", "true");
      face.append(dot);
    }
    b.append(face);
    // The figure the ring cannot say. A ring at 4% is a hairline and a ring at
    // 0% is nothing at all — and "nothing at all" is exactly what a ring that is
    // not working looks like.
    b.append(span("dial-caption", captionOf(d)));

    const show = () => this.show(d.provider, now);
    b.addEventListener("mouseenter", show);
    b.addEventListener("focus", show);
    // A floating card covers what is under it, so it goes when the pointer does.
    // The one inside the deck's popover stays: it is in a box that is already
    // open, and blanking it would collapse that box under the pointer.
    if (this.floats) {
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
    // Inside the deck's popover something is always described; see `render`.
    if (!this.floats && provider === null) return;
    if (this.shown === provider) return;
    this.shown = provider;
    this.fillCard(dialLineup(this.last), now);
  }

  /** Put the selected dial's detail in the card, and point the right control at
   *  it. One place, called from the paint and from every hover, so the two
   *  cannot come to disagree about what is in there. */
  private fillCard(dials: Dial[], now: number): void {
    const card = this.card;
    if (!card) return;
    const d = dials.find((x) => x.provider === this.shown) ?? null;
    card.replaceChildren();
    // On the element, so a surface that has to rebuild its whole document can
    // read back which dial was open before it did — see `selected`.
    card.dataset.provider = d?.provider ?? "";
    card.hidden = d === null;
    if (d) card.append(...cardBody(d, now));

    for (const b of this.el.querySelectorAll<HTMLElement>(".dial")) {
      // A floating card is a description OF the dial the pointer is on, and of
      // no other — three dials pointing at one card would have a reader
      // announce the same paragraph three times. Inside the popover it needs no
      // such pointer: it is the next thing in the document.
      if (this.floats && d !== null && b.dataset.provider === d.provider) {
        b.setAttribute("aria-describedby", CARD_ID);
      } else {
        b.removeAttribute("aria-describedby");
      }
    }
    if (this.floats && d !== null) this.place(card);
  }

  /** Hang the floating card under the row, inside whatever room is left.
   *
   *  Measured rather than declared, because the card's parent is not the row's:
   *  it is the panel's own box, chosen so the card is neither clipped by the
   *  scrolling list nor able to add to its scroll height. `top` is therefore the
   *  distance between two rectangles.
   *
   *  And a height, which is the part that is not cosmetic. That box clips —
   *  which is what stops the card escaping the panel's rounded edge — so a card
   *  taller than the room under the row is a card with its last line sheared
   *  off, and the last line of a spent window is "nothing moves until 19:00".
   *  Clamped and scrolling instead: a scrollbar is a worse card than one that
   *  fits and a far better one than one that lies. A floor of 6rem, so a
   *  measurement taken before the panel has been laid out cannot collapse it to
   *  nothing. */
  private place(card: HTMLElement): void {
    const row = this.el.querySelector<HTMLElement>(".dial-row");
    const parent = card.offsetParent ?? card.parentElement;
    if (!row || !(parent instanceof HTMLElement)) return;
    const r = row.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const top = Math.round(r.bottom - p.top + 6);
    card.style.top = `${top}px`;
    card.style.maxHeight = `max(6rem, ${Math.round(p.height - top - 8)}px)`;
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
