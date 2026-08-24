import { describe, it, expect } from "vitest";
import { hasLeftWindow, startsTearOut, TEAR_OUT_MARGIN } from "../src/tear-out";

/** The two decisions in the tear-out gesture that are decisions rather than
 *  plumbing. The rest of it is `setPointerCapture` and a window being created
 *  under a cursor — neither of which exists in jsdom, and the second of which
 *  cannot be checked anywhere but a real desktop. Part of #248. */
const VIEW = { width: 1440, height: 900 };

describe("has the pointer left the window", () => {
  it("says no while the pointer is inside it", () => {
    expect(hasLeftWindow(700, 400, VIEW)).toBe(false);
    expect(hasLeftWindow(0, 0, VIEW)).toBe(false);
    expect(hasLeftWindow(1440, 900, VIEW)).toBe(false);
  });

  /** Not a zero margin, and this is the case that says why. The sidebar's rows
   *  start a few pixels from the window's left edge, so a person tidying a row's
   *  position or overshooting a click would tear their workspace out. */
  it("says no for a small overshoot past the edge", () => {
    expect(hasLeftWindow(-1, 400, VIEW)).toBe(false);
    expect(hasLeftWindow(-TEAR_OUT_MARGIN, 400, VIEW)).toBe(false);
  });

  /** Pointer capture keeps delivering moves after the pointer leaves, with
   *  coordinates that simply go negative or past the far edge — which is why
   *  nothing has to be polled until there is a window to place. */
  it("says yes past the margin, on any of the four sides", () => {
    expect(hasLeftWindow(-TEAR_OUT_MARGIN - 1, 400, VIEW)).toBe(true);
    expect(hasLeftWindow(700, -TEAR_OUT_MARGIN - 1, VIEW)).toBe(true);
    expect(hasLeftWindow(VIEW.width + TEAR_OUT_MARGIN + 1, 400, VIEW)).toBe(true);
    expect(hasLeftWindow(700, VIEW.height + TEAR_OUT_MARGIN + 1, VIEW)).toBe(true);
  });
});

describe("which presses can begin a tear-out", () => {
  const press = (over: Partial<Parameters<typeof startsTearOut>[0]> = {}) => ({
    button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over,
  });

  it("the primary button, unmodified", () => {
    expect(startsTearOut(press())).toBe(true);
  });

  /** A right-click opens a context menu and a middle-click is somebody's paste;
   *  neither is the start of dragging a window out. */
  it("not the other buttons", () => {
    expect(startsTearOut(press({ button: 1 }))).toBe(false);
    expect(startsTearOut(press({ button: 2 }))).toBe(false);
  });

  /** A modified click is a shortcut on some platform, and the row's ordinary
   *  click has to keep working — a press that does not become a drag must cost
   *  nothing. */
  it("not a modified click", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      expect(startsTearOut(press({ [mod]: true })), mod).toBe(false);
    }
  });
});
