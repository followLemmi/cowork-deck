// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { wireResizer } from "../src/resize";

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

const down = (grip: HTMLElement, x: number) =>
  grip.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: x, pointerId: 1 }));
const move = (grip: HTMLElement, x: number) =>
  grip.dispatchEvent(Object.assign(new Event("pointermove", { bubbles: true }), { clientX: x, pointerId: 1 }));
const up = (grip: HTMLElement) =>
  grip.dispatchEvent(Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 1 }));

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom has no pointer capture; the module calls it on every drag.
  Element.prototype.setPointerCapture = vi.fn();
});

describe("a panel's resize grip", () => {
  it("follows the pointer", () => {
    const h = harness();
    down(h.grip, 100);
    move(h.grip, 160);
    expect(h.at()).toBe(360);
  });

  it("grows the other way when the grip is on the panel's left", () => {
    // The tool panel's edge: dragging LEFT makes it wider, because the panel is to
    // the right of the grip.
    const h = harness({ grow: "left" });
    down(h.grip, 500);
    move(h.grip, 440);
    expect(h.at()).toBe(360);
  });

  it("clamps at both ends rather than letting a panel vanish", () => {
    const h = harness();
    down(h.grip, 500);
    move(h.grip, 0);
    expect(h.at()).toBe(240);
    move(h.grip, 5000);
    expect(h.at()).toBe(600);
  });

  /** A save per frame is a file write per frame. The width is written on every
   *  frame and stored once, when the gesture ends. */
  it("writes on every frame and commits once", () => {
    const h = harness();
    down(h.grip, 100);
    move(h.grip, 120);
    move(h.grip, 140);
    expect(h.written.length).toBe(2);
    expect(h.committed).toEqual([]);
    up(h.grip);
    expect(h.committed).toEqual([340]);
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

  it("ignores keys that are not the two it owns", () => {
    const h = harness();
    for (const key of ["ArrowUp", "ArrowDown", "Enter", "a"]) {
      h.grip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    expect(h.at()).toBe(300);
    expect(h.committed).toEqual([]);
  });
});
