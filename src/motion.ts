/** The two things about motion that JavaScript has to know.
 *
 *  Almost all of this app's motion is CSS, and deliberately: a transition the
 *  stylesheet owns is one the stylesheet's own `prefers-reduced-motion` switch can
 *  collapse, and one nothing has to time. What is left here is the residue — the
 *  cases where script has to START a motion, or WAIT one out, and therefore has to
 *  agree with the stylesheet about how long it lasts.
 *
 *  The rule that makes this a module rather than two helpers where they are used:
 *  **a duration is never written in TypeScript.** It is read from the token the
 *  motion actually runs on. The stylesheet's motion block argues at length that a
 *  duration written twice drifts, and it had already happened here — a 220ms
 *  cleanup left behind as the margin on a morph that had been 180ms.
 */

/** A duration token, in milliseconds, read off the root element.
 *
 *  0 when the property is missing or unparseable, which in practice is jsdom and
 *  nothing else: no stylesheet means nothing is transitioning, so there is no
 *  motion for a delay to protect and no reason for a test to wait one out.
 *  `parseFloat` takes the unit off — every `--dur-*` is declared in `ms`. */
export function tokenMs(name: string): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : 0;
}

/** How long to hold a refit off for, while a layout of `--dur-3` settles.
 *
 *  `--dur-1` is the margin, and it is the only number here that is a choice rather
 *  than a consequence: it is the smallest duration the system has. Read at the
 *  moment of use rather than at module load, because the root's custom properties
 *  are not resolved until the stylesheet is in. */
export function settleMs(): number {
  return tokenMs("--dur-3") + tokenMs("--dur-1");
}

/** Whether a window-layout animation is in flight. */
let held = false;

/** Hold every terminal's automatic refit off while a layout animates, and let it
 *  go again after.
 *
 *  A `fit` is not a cheap answer to a new box: it re-measures the cell, recomputes
 *  `cols`, and on a change reflows the whole buffer, scrollback included. An
 *  ANIMATED width delivers a new box every frame, so what should be one reflow
 *  becomes one per frame for the length of the transition — the same cost
 *  `drag.ts` exists to keep out of a gesture, which the sidebar's collapse button
 *  had kept for itself because only the grip was ever fixed.
 *
 *  It lives here, and not beside the ResizeObserver that honours it, so that the
 *  two ends do not have to know each other: `app.ts` starts a motion and sets
 *  this, `terminal.ts` reads it, and neither imports the other. That is also what
 *  keeps it out of the twenty-one test files that mock `terminal.ts` — a flag on
 *  the mocked module would have had to be added to every one of them.
 *
 *  Deliberately NOT paired with a timer of its own: the caller owns the release,
 *  because the caller is the one that knows which motion it started and has to
 *  land a single refit at the end of it. A missed release leaves every terminal
 *  permanently deaf to its box, which is a worse failure than the jank this
 *  avoids — hence the release and the refit sit in one callback at the one call
 *  site. */
export function holdRefits(on: boolean) {
  held = on;
}

/** Whether refits are currently held. For the ResizeObserver that has to ask. */
export function refitsHeld(): boolean {
  return held;
}
