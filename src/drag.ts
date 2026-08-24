/** Pointer drags, coalesced to the frame.
 *
 *  Two things in this app are resized by dragging a grip — the diff drawer's width
 *  and the terminal drawer's height — and both were written the same way: write the
 *  new size, then read layout back, inside the `pointermove` handler. That order is
 *  the whole bug. A read after a write forces the engine to lay out *there and
 *  then*, so it never gets to coalesce two events into one frame, and every event
 *  delivered pays the full cost. On a 165 Hz display with a high-polling mouse there
 *  are a great many events, and measured against a 2500-row diff one such layout is
 *  15–28 ms — three to four frames of a 6.25 ms budget, per event.
 *
 *  Hence the one rule this module exists to hold: **a drag reads layout once, before
 *  it starts, and writes at most once a frame.** `measure` is where a caller does its
 *  reading; `apply` is where it does its writing, and nothing in `apply` may read
 *  layout back — within a frame there is nothing that could have changed the layout
 *  except `apply` itself, so a read there can only be the forced kind.
 *
 *  What `measure` hands to `apply` is therefore a snapshot, and the caller has to be
 *  content with one for the length of the gesture. That is not a compromise: the
 *  numbers a resize needs — the size of one `ch`, the root font size, how much room
 *  the row has — cannot change while a pointer is down unless the window itself is
 *  resized, and both callers already watch for that with a `ResizeObserver`.
 */

/** Where the pointer is. Coordinates rather than the event, because the event is
 *  live and the frame that consumes it is not: holding a `PointerEvent` across a
 *  frame boundary keeps a whole event object alive to read two numbers off it. */
export interface DragPoint {
  x: number;
  y: number;
}

export interface Drag<T> {
  /** Read whatever the gesture needs, once, before it starts. Returning null
   *  refuses the drag — which is what a caller with no layout to measure must do:
   *  jsdom reports zero for every box, and a delta divided by a zero-width `ch`
   *  would set a size to `NaN`. */
  measure: () => T | null;
  /** Write the new size. Called at most once a frame, with the newest pointer
   *  position rather than every position passed over — a drag is a gesture towards
   *  a place, and the places it crossed on the way are not interesting.
   *
   *  **Must not read layout.** See the note at the top of the file. */
  apply: (ctx: T, at: DragPoint) => void;
  /** The gesture is over. Runs after the last `apply`, so whatever it persists is
   *  the size the pointer was released on, and runs exactly once whether the
   *  gesture ended in a `pointerup` or was cancelled. This is where the work that
   *  must not happen per frame goes — reaching the disk, refitting a terminal. */
  commit?: (ctx: T) => void;
}

/** Begin a drag on `grip`, from the `pointerdown` that started it.
 *
 *  Returns whether it began: false means `measure` refused, and the caller should
 *  behave as though the press were not a drag at all — in particular it should not
 *  have called `preventDefault`, which is why this function owns that call rather
 *  than expecting one before it. */
export function startDrag<T>(grip: HTMLElement, down: PointerEvent, drag: Drag<T>): boolean {
  const ctx = drag.measure();
  if (ctx === null) return false;

  down.preventDefault();
  // Undefined in jsdom, and a drag that cannot capture the pointer is still a
  // drag: the listeners below are on the grip, so without capture the gesture
  // simply stops when the pointer leaves the grip instead of following it. That is
  // a degradation in a browser that has no such gap and the whole gesture in a
  // test environment that does, so it must not throw either way.
  if (typeof grip.setPointerCapture === "function") grip.setPointerCapture(down.pointerId);

  let at: DragPoint = { x: down.clientX, y: down.clientY };
  /** The pending frame, or 0 for none. Held so a second event in the same frame
   *  replaces the position instead of queueing a second write. */
  let frame = 0;
  let over = false;

  const paint = () => {
    frame = 0;
    drag.apply(ctx, at);
  };

  const move = (m: PointerEvent) => {
    at = { x: m.clientX, y: m.clientY };
    if (frame === 0) frame = requestAnimationFrame(paint);
  };

  const end = () => {
    // `pointerup` and `pointercancel` are both wired, and a cancelled gesture can
    // deliver one after the other. Everything below has to happen once.
    if (over) return;
    over = true;
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    // The frame the last movement asked for may not have run yet, and cancelling
    // it without applying it would leave the size a frame behind the pointer —
    // visibly, because that is the frame the eye is left looking at, and durably,
    // because `commit` is what persists the size.
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
      drag.apply(ctx, at);
    }
    drag.commit?.(ctx);
  };

  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  return true;
}
