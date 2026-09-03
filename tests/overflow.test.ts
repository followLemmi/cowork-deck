// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { watchOverflow } from "../src/overflow";

/** jsdom lays nothing out, so the three numbers the measurement reads are set on
 *  the element directly. That is the whole of what this module does — read three
 *  numbers and name the edge — so driving it this way tests the rule rather than
 *  the browser. */
function box(scrollWidth: number, clientWidth: number, scrollLeft = 0): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  el.scrollLeft = scrollLeft;
  document.body.append(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("ResizeObserver", undefined);
});

describe("which way there is more", () => {
  it("says nothing when everything fits", () => {
    const el = box(400, 400);
    watchOverflow(el);
    expect(el.dataset.overflow).toBe("");
  });

  /** The board's own case, and the one the audit saw: five columns in a row wide
   *  enough for three, showing the third one cut in half with nothing on screen
   *  to say the row continued. */
  it("says right when the row is cut off at its right edge", () => {
    const el = box(1200, 400);
    watchOverflow(el);
    expect(el.dataset.overflow).toBe("right");
  });

  it("says both in the middle, and left at the end", () => {
    const el = box(1200, 400, 300);
    const w = watchOverflow(el);
    expect(el.dataset.overflow).toBe("both");
    el.scrollLeft = 800;
    w.refresh();
    expect(el.dataset.overflow).toBe("left");
  });

  /** `scrollWidth` and `clientWidth` are integers where the scroll position is
   *  fractional, so a box scrolled fully right can report a fraction of a pixel
   *  left to go. A fade that never quite goes away is worse than none: it says
   *  there is more when there is not. */
  it("treats a sub-pixel remainder as being at the edge", () => {
    const el = box(1200, 400, 799.5);
    watchOverflow(el);
    expect(el.dataset.overflow).toBe("left");
  });

  it("re-measures on a scroll", () => {
    const el = box(1200, 400);
    watchOverflow(el);
    el.scrollLeft = 800;
    el.dispatchEvent(new Event("scroll"));
    expect(el.dataset.overflow).toBe("left");
  });

  it("stops listening when told to", () => {
    const el = box(1200, 400);
    watchOverflow(el).stop();
    el.scrollLeft = 800;
    el.dispatchEvent(new Event("scroll"));
    expect(el.dataset.overflow).toBe("right");
  });
});
