// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { wireResizer } from "../src/resize";

/** The frame, driven by hand. `wireResizer` runs its pointer half through
 *  `startDrag` since #424, so a write waits for a frame rather than happening per
 *  event — which is the property that made the diff pane's drag affordable and
 *  which the other four grips did not have. Same harness as `tests/drag.test.ts`,
 *  and for the same reason: jsdom has `requestAnimationFrame` and no clock worth
 *  relying on. */
let queue: FrameRequestCallback[] = [];

/** A grip and a box whose width is a number this test owns — the module takes
 *  `read`/`write` as functions precisely so it can be driven without layout, which
 *  jsdom does not have. */
function harness(over: Partial<Parameters<typeof wireResizer>[0]> = {}) {
  const grip = document.createElement("div");
  document.body.append(grip);
  let px = 300;
  const written: number[] = [];
  const committed: number[] = [];
  wireResizer({
    grip,
    grow: "right",
    label: "Panel width",
    min: 240,
    max: () => 600,
    read: () => px,
    write: (n) => { px = n; written.push(n); },
    commit: (n) => committed.push(n),
    ...over,
  });
  return { grip, written, committed, at: () => px };
}

/* Both coordinates on every event, even where a test only cares about one: a
   grip reads whichever axis it grows along, and an `undefined` on the other one
   makes the delta `NaN` rather than zero. */
const down = (grip: HTMLElement, x: number, y = 0) =>
  grip.dispatchEvent(Object.assign(
    new Event("pointerdown", { bubbles: true }), { clientX: x, clientY: y, pointerId: 1 }));
const move = (grip: HTMLElement, x: number, y = 0) =>
  grip.dispatchEvent(Object.assign(
    new Event("pointermove", { bubbles: true }), { clientX: x, clientY: y, pointerId: 1 }));
const up = (grip: HTMLElement) =>
  grip.dispatchEvent(Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 1 }));

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom has no pointer capture; the module calls it on every drag.
  Element.prototype.setPointerCapture = vi.fn();
  queue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;            // ids from 1, so 0 stays "no frame pending"
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Run every frame the drag has asked for so far. */
function frame(): void {
  const due = queue;
  queue = [];
  for (const cb of due) cb(performance.now());
}

describe("a panel's resize grip", () => {
  it("follows the pointer", () => {
    const h = harness();
    down(h.grip, 100);
    move(h.grip, 160);
    // Nothing yet: the write is the frame's, not the event's.
    expect(h.written).toEqual([]);
    frame();
    expect(h.at()).toBe(360);
  });

  it("grows the other way when the grip is on the panel's left", () => {
    // The tool panel's edge: dragging LEFT makes it wider, because the panel is to
    // the right of the grip.
    const h = harness({ grow: "left" });
    down(h.grip, 500);
    move(h.grip, 440);
    frame();
    expect(h.at()).toBe(360);
  });

  it("clamps at both ends rather than letting a panel vanish", () => {
    const h = harness();
    down(h.grip, 500);
    move(h.grip, 0);
    frame();
    expect(h.at()).toBe(240);
    // And back off the stop: every frame is measured from where the gesture
    // STARTED, so a clamp does not leave the box somewhere it never was.
    move(h.grip, 5000);
    frame();
    expect(h.at()).toBe(600);
  });

  /** A save per frame is a file write per frame. The width is written on every
   *  frame and stored once, when the gesture ends. */
  it("writes on every frame and commits once", () => {
    const h = harness();
    down(h.grip, 100);
    move(h.grip, 120);
    move(h.grip, 140);
    // Two events, ONE frame, one write — which is the point of routing through
    // `startDrag`: the second position replaces the first rather than queueing a
    // second write, and only the newest is painted.
    frame();
    expect(h.written).toEqual([340]);
    expect(h.committed).toEqual([]);
    up(h.grip);
    expect(h.committed).toEqual([340]);
  });

  /** The frame the last movement asked for may not have run when the pointer
   *  comes up, and dropping it would leave the box a frame behind the pointer —
   *  visibly, and durably, because `commit` is what persists the size. */
  it("paints the last movement even if its frame never ran", () => {
    const h = harness();
    down(h.grip, 100);
    move(h.grip, 190);
    up(h.grip);
    expect(h.at()).toBe(390);
    expect(h.committed).toEqual([390]);
  });

  /** A drag is the only gesture in this app with no keyboard equivalent unless one
   *  is written, and a panel somebody cannot resize with a keyboard is a panel they
   *  cannot resize. */
  it("moves on the arrow keys, and commits each press", () => {
    const h = harness({ step: 20 });
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(h.at()).toBe(320);
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(h.at()).toBe(300);
    expect(h.committed).toEqual([320, 300]);
  });

  it("means the same thing by the same key on either edge", () => {
    // Right moves the edge right, whichever panel it belongs to: the keys mean
    // "move this edge that way", not "make it bigger", which would invert between
    // the two panels and be wrong on one of them.
    const left = harness({ grow: "left", step: 20 });
    left.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(left.at()).toBe(280);
  });

  it("reports itself as a splitter with a value a reader can hear", () => {
    const h = harness();
    expect(h.grip.getAttribute("role")).toBe("separator");
    expect(h.grip.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.grip.getAttribute("aria-label")).toBe("Panel width");
    expect(h.grip.tabIndex).toBe(0);
    // The value, and the range it sits in — "300" alone says nothing about how much
    // room is left.
    expect(h.grip.getAttribute("aria-valuenow")).toBe("300");
    expect(h.grip.getAttribute("aria-valuemin")).toBe("240");
    expect(h.grip.getAttribute("aria-valuemax")).toBe("600");
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(h.grip.getAttribute("aria-valuenow")).toBe("316");
  });

  it("ignores keys that are not the ones it owns", () => {
    const h = harness();
    for (const key of ["ArrowUp", "ArrowDown", "Enter", "a", "PageUp"]) {
      h.grip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    expect(h.at()).toBe(300);
    expect(h.committed).toEqual([]);
  });

  /** Part of a window splitter's keyboard contract rather than an extra: on a
   *  panel that takes fifty presses to cross, they are the difference between a
   *  reachable end and a theoretical one. Only the diff pane's own grip had them
   *  before #424, which is the shape of the whole finding. */
  it("goes to either end on Home and End", () => {
    const h = harness();
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(h.at()).toBe(240);
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(h.at()).toBe(600);
    expect(h.committed).toEqual([240, 600]);
  });
});

/** The terminal drawer's axis, which had no shared implementation at all before
 *  #424 — it was a third hand-rolled copy, with the separator role and none of
 *  the value. */
describe("a grip that resizes upwards", () => {
  function vertical() {
    const grip = document.createElement("div");
    document.body.append(grip);
    let rows = 14;
    const committed: number[] = [];
    wireResizer({
      grip,
      grow: "up",
      label: "Resize the terminal drawer",
      min: 4,
      max: () => 30,
      step: 1,
      // One row is 19.2px at the default scale, which is what makes this grip's
      // unit a row rather than a pixel.
      unitPx: () => 19.2,
      read: () => rows,
      write: (n) => { rows = Math.round(n); },
      commit: (n) => committed.push(Math.round(n)),
      valueText: (n) => `${Math.round(n)} rows`,
    });
    return { grip, committed, at: () => rows };
  }

  it("says it is a horizontal separator, because it splits top from bottom", () => {
    const h = vertical();
    expect(h.grip.getAttribute("aria-orientation")).toBe("horizontal");
    // The half `drawer.ts`'s own grip never had: it announced itself as a
    // splitter and then said nothing about where it was.
    expect(h.grip.getAttribute("aria-valuenow")).toBe("14");
    expect(h.grip.getAttribute("aria-valuemin")).toBe("4");
    expect(h.grip.getAttribute("aria-valuemax")).toBe("30");
    expect(h.grip.getAttribute("aria-valuetext")).toBe("14 rows");
  });

  it("counts pointer travel in its own unit, not in pixels", () => {
    const h = vertical();
    down(h.grip, 0, 500);
    // Up by five rows' worth of pixels, and a row is 19.2px at this scale.
    move(h.grip, 0, 500 - 5 * 19.2);
    frame();
    expect(h.at()).toBe(19);
  });

  it("moves on the up and down arrows, not the left and right ones", () => {
    const h = vertical();
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(h.at()).toBe(15);
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(h.at()).toBe(14);
    h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(h.at()).toBe(14);
  });
});

describe("a grip whose commit is expensive", () => {
  function held() {
    const grip = document.createElement("div");
    document.body.append(grip);
    let px = 300;
    const committed: number[] = [];
    const gestures: string[] = [];
    wireResizer({
      grip,
      grow: "left",
      label: "Diff pane width",
      min: 240,
      max: () => 600,
      step: 20,
      commitOn: "keyup",
      beginGesture: () => gestures.push("begin"),
      read: () => px,
      write: (n) => { px = n; },
      commit: (n) => { gestures.push("end"); committed.push(n); },
    });
    return { grip, committed, gestures, at: () => px };
  }

  /** A held arrow repeats, and the diff pane's commit reaches the disk and
   *  refits a grid of up to 10,000 cells. One write per repeat is one disk write
   *  per frame. */
  it("writes on every repeat and commits once, when the key comes up", () => {
    const h = held();
    for (let i = 0; i < 3; i++) {
      h.grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    }
    expect(h.at()).toBe(360);
    expect(h.committed).toEqual([]);
    h.grip.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    expect(h.committed).toEqual([360]);
  });

  it("does not commit a key it never moved on", () => {
    const h = held();
    h.grip.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    expect(h.committed).toEqual([]);
  });

  /** `beginGesture` and `commit` are a pair, and the diff pane relies on it: the
   *  first freezes a metrics snapshot and the second releases it. A begin without
   *  an end would leave the pane answering every layout question from a snapshot
   *  taken while a pointer was down. */
  it("pairs beginGesture with commit across a drag", () => {
    const h = held();
    down(h.grip, 500);
    move(h.grip, 440);
    frame();
    up(h.grip);
    expect(h.gestures).toEqual(["begin", "end"]);
  });
});
