// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startDrag, type DragPoint } from "../src/drag";

/** jsdom has `requestAnimationFrame` but no clock worth relying on, so the frame is
 *  driven by hand: nothing runs until `frame()` says so, which is exactly the
 *  property under test — that a write waits for a frame instead of happening per
 *  event. */
let queue: FrameRequestCallback[] = [];
let cancelled: number[] = [];

beforeEach(() => {
  queue = [];
  cancelled = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;            // ids from 1, so 0 stays "no frame pending"
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { cancelled.push(id); });
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Run every frame the drag has asked for so far. */
function frame(): void {
  const due = queue;
  queue = [];
  for (const cb of due) cb(performance.now());
}

function grip(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

const down = (x = 100, y = 100) =>
  new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, cancelable: true });

function move(el: HTMLElement, x: number, y = 100): void {
  el.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 1 }));
}

function up(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
}

interface Spy {
  applied: DragPoint[];
  committed: number;
}

function wire(el: HTMLElement, e: PointerEvent, ctx: unknown = { it: "measured" }) {
  const spy: Spy = { applied: [], committed: 0 };
  const started = startDrag(el, e, {
    measure: () => ctx as object | null,
    apply: (_c, at) => { spy.applied.push(at); },
    commit: () => { spy.committed++; },
  });
  return { spy, started };
}

describe("startDrag, the frame rule", () => {
  // The whole reason the module exists. Three events inside one frame are three
  // forced layouts if each one writes, and one if they are coalesced.
  it("writes once a frame however many events arrive", () => {
    const el = grip();
    const { spy } = wire(el, down());
    move(el, 90);
    move(el, 80);
    move(el, 70);
    expect(spy.applied).toEqual([]);          // nothing has been written yet
    frame();
    expect(spy.applied).toEqual([{ x: 70, y: 100 }]);   // the newest position, once
  });

  it("writes again on the next frame", () => {
    const el = grip();
    const { spy } = wire(el, down());
    move(el, 90);
    frame();
    move(el, 60);
    frame();
    expect(spy.applied).toEqual([{ x: 90, y: 100 }, { x: 60, y: 100 }]);
  });

  // The released position is the one that sticks, so the frame the last movement
  // asked for has to be honoured rather than dropped: cancelling it would leave the
  // pane a frame behind the pointer, and leave `commit` persisting that.
  it("applies the last position before committing, even mid-frame", () => {
    const el = grip();
    const { spy } = wire(el, down());
    move(el, 90);
    frame();
    move(el, 40);                             // no frame runs for this one
    up(el);
    expect(spy.applied).toEqual([{ x: 90, y: 100 }, { x: 40, y: 100 }]);
    expect(spy.committed).toBe(1);
    expect(cancelled).toHaveLength(1);        // and the pending frame was dropped
  });

  it("does not apply twice when the last frame had already run", () => {
    const el = grip();
    const { spy } = wire(el, down());
    move(el, 90);
    frame();
    up(el);
    expect(spy.applied).toEqual([{ x: 90, y: 100 }]);
    expect(spy.committed).toBe(1);
  });
});

describe("startDrag, the gesture's edges", () => {
  it("refuses when there is nothing to measure, and leaves the press alone", () => {
    const el = grip();
    const e = down();
    const started = startDrag(el, e, {
      measure: () => null,
      apply: () => { throw new Error("must not write"); },
    });
    expect(started).toBe(false);
    // A refused drag is not a drag: the press must still do whatever a press does.
    expect(e.defaultPrevented).toBe(false);
    move(el, 40);
    frame();
  });

  it("claims the press when it does start", () => {
    const el = grip();
    const e = down();
    expect(wire(el, e).started).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it("commits once when a cancel follows an up", () => {
    const el = grip();
    const { spy } = wire(el, down());
    up(el);
    el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(spy.committed).toBe(1);
  });

  it("commits on a cancel alone — a gesture the pointer never finished", () => {
    const el = grip();
    const { spy } = wire(el, down());
    move(el, 70);
    el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(spy.applied).toEqual([{ x: 70, y: 100 }]);
    expect(spy.committed).toBe(1);
  });

  it("stops listening once it is over", () => {
    const el = grip();
    const { spy } = wire(el, down());
    up(el);
    move(el, 10);
    frame();
    expect(spy.applied).toEqual([]);
    expect(spy.committed).toBe(1);
  });

  // `setPointerCapture` is undefined in jsdom, and a drag that cannot capture is
  // still a drag — the listeners are on the grip, so the gesture merely stops at the
  // grip's edge instead of following the pointer out. Throwing there would take the
  // whole gesture out in a test environment for the sake of one in the browser.
  it("survives a grip that cannot capture the pointer", () => {
    const el = grip();
    expect((el as unknown as { setPointerCapture?: unknown }).setPointerCapture).toBeUndefined();
    const { spy, started } = wire(el, down());
    expect(started).toBe(true);
    move(el, 55);
    frame();
    expect(spy.applied).toEqual([{ x: 55, y: 100 }]);
  });

  it("captures the pointer where it can, so the gesture follows it out of the grip", () => {
    const el = grip();
    const capture = vi.fn();
    (el as unknown as { setPointerCapture: unknown }).setPointerCapture = capture;
    wire(el, down());
    expect(capture).toHaveBeenCalledWith(1);
  });

  // The context is measured once and handed back unchanged: a caller that snapshots
  // its layout in `measure` must get that same snapshot for the whole gesture.
  it("hands the same measurement to every write and to the commit", () => {
    const el = grip();
    const ctx = { ch: 8.5 };
    const seen: unknown[] = [];
    startDrag(el, down(), {
      measure: () => ctx,
      apply: (c) => { seen.push(c); },
      commit: (c) => { seen.push(c); },
    });
    move(el, 90);
    frame();
    move(el, 80);
    frame();
    up(el);
    expect(seen).toEqual([ctx, ctx, ctx]);
    expect(seen.every((s) => s === ctx)).toBe(true);
  });

  it("needs no commit", () => {
    const el = grip();
    const applied: DragPoint[] = [];
    startDrag(el, down(), { measure: () => ({}), apply: (_c, at) => { applied.push(at); } });
    move(el, 90);
    frame();
    expect(() => up(el)).not.toThrow();
    expect(applied).toHaveLength(1);
  });
});
