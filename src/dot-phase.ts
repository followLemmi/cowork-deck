/** One clock for every ambient dot on the deck.
 *
 *  A CSS animation starts when its element is created, and the session list is
 *  rebuilt wholesale by the five-second poll — `renderList` says so itself. So a
 *  dot breathing on a 3.6s period was being restarted a little over two-thirds
 *  of the way through a swell and snapped back to the top of it, twelve times a
 *  minute, on every row at once. That is the blink. The period was only what
 *  made it hard to look away from, which is why slowing the loops down is half
 *  the fix and this is the other half.
 *
 *  A NEGATIVE `animation-delay` seeks into an animation rather than postponing
 *  it: a dot handed `-8000ms` is already eight seconds into a loop that never
 *  restarted. Measured from one epoch fixed at load, a dot created at any moment
 *  lands on the phase every surviving dot is already at — so the rebuild stops
 *  being visible, and the tile chip (which is never rebuilt) agrees with the
 *  list row (which is rebuilt constantly) instead of drifting against it.
 *
 *  Deliberately NOT reduced modulo the period. A negative delay of any size
 *  seeks correctly, so one number serves both loops and keeps serving them if
 *  either period is retuned. A modulus would have to be their common multiple,
 *  and would break silently the first time somebody changed one of the two
 *  numbers without noticing it was load-bearing here. The magnitude is only
 *  milliseconds since load — exact in a double for far longer than a session
 *  stays open.
 *
 *  The value goes on the ELEMENT while the animation is on its `::before`. That
 *  works because custom properties inherit into a pseudo-element and
 *  `animation-delay` does not, and it is the only reason a pseudo-element can be
 *  phased at all from script.
 *
 *  Nothing here runs per frame: the property is written once, at creation, and
 *  the loops stay transform/opacity on the compositor. That is the constraint
 *  the note beside `@keyframes pulse-dot` records, and it is not negotiable —
 *  animating a custom property instead would recompute style for every dot on
 *  every frame, which is the repaint this was all trying to avoid.
 */
const EPOCH = performance.now();

/** Put a freshly created dot in step with the ones already on screen.
 *
 *  Call it on any element whose `::before` carries `breathe` or `pulse-dot`,
 *  right after the class that starts one is set. Harmless on the states that do
 *  not animate — the variable is simply never read. */
export function syncDotPhase(el: HTMLElement): void {
  el.style.setProperty("--dot-phase", `${Math.round(EPOCH - performance.now())}ms`);
}
