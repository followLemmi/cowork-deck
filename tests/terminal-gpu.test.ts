// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

(globalThis as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
(globalThis as any).window.__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  unregisterCallback: () => {},
};

/** A driveable IntersectionObserver: the panel's whole GPU policy hangs off
 *  visibility, so the tests have to be able to say when a tile is on screen. */
const watchers: { cb: (e: { isIntersecting: boolean }[]) => void; el: Element }[] = [];
(globalThis as any).IntersectionObserver = class {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe(el: Element) { watchers.push({ cb: this.cb, el }) }
  unobserve() {}
  disconnect() { for (let i = watchers.length - 1; i >= 0; i--) if (watchers[i].cb === this.cb) watchers.splice(i, 1) }
};
const setOnScreen = (el: Element, isIntersecting: boolean) => {
  for (const w of [...watchers]) if (w.el === el) w.cb([{ isIntersecting }]);
};
/** Several records delivered in one callback — what a real observer does when two
 *  update steps elapse before delivery. */
const setOnScreenBatch = (el: Element, states: boolean[]) => {
  for (const w of [...watchers]) if (w.el === el) w.cb(states.map((isIntersecting) => ({ isIntersecting })));
};

/** Counts contexts the way the webview does: created minus disposed. */
let liveContexts = 0;
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() { liveContexts++ }
    onContextLoss() {}
    dispose() { liveContexts-- }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    // Keeps the constructor's options, so `cursorBlink` can be read back — that
    // coupling is one of the things under test.
    constructor(opts: Record<string, unknown>) { this.options = { ...opts } }
    loadAddon() {} open() {} onData() {} onResize() {} focus() {} clear() {} dispose() {}
    attachCustomKeyEventHandler() {} write() {}
    cols = 80; rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), writeSession: vi.fn().mockResolvedValue(undefined), resizeSession: vi.fn().mockResolvedValue(undefined),
}));

import { TerminalPanel, MAX_GPU_CONTEXTS } from "../src/terminal";

/** A panel plus the element its visibility is driven through. Every one made here
 *  is disposed after the test: the context budget is process-wide by design, so a
 *  panel left alive in one test would spend the cap in the next. */
const made: TerminalPanel[] = [];
function panel() {
  const el = document.createElement("div");
  const p = new TerminalPanel("s", el);
  made.push(p);
  return { el, p };
}
/** The blink flag is only reachable through the options object xterm was built
 *  with, which is exactly where the renderer swap writes it. */
const blinks = (p: TerminalPanel) => ((p as any).term.options.cursorBlink as boolean);

beforeEach(() => { watchers.length = 0; liveContexts = 0 });
afterEach(() => { for (const p of made.splice(0)) p.dispose() });

describe("the WebGL context budget", () => {
  /** A panel that nobody can see must not hold a context: the cap is small and the
   *  terminals on screen are the ones that need it. */
  it("takes no context until the tile is actually on screen", () => {
    const { p } = panel();
    expect(liveContexts).toBe(0);
    expect(blinks(p)).toBe(false);
  });

  /** The blink and the renderer are one decision, not two.
   *
   *  Under the DOM renderer blinking is a CSS animation on the cursor's span, and
   *  `DomRenderer.renderRows` rebuilds that span on every repaint of its row — a
   *  fresh node restarts the animation at 0%, so a TUI that repaints continuously
   *  makes the cursor strobe at the repaint rate instead of blinking once a second.
   *  The WebGL renderer drives the same blink off a 600ms timer no repaint touches.
   *  So blink follows the context: on with it, off without it. */
  it("turns the cursor blink on with the context and off again with it", () => {
    const { el, p } = panel();

    setOnScreen(el, true);
    expect(liveContexts).toBe(1);
    expect(blinks(p)).toBe(true);

    setOnScreen(el, false);
    expect(liveContexts).toBe(0);
    expect(blinks(p)).toBe(false);
  });

  /** Going over WebKit's ceiling is worse than staying on the DOM renderer: the
   *  webview does not refuse the extra context, it force-loses the oldest one — so
   *  an uncapped policy would blank the terminal someone is reading to serve one
   *  they are not. Past the cap a panel simply renders in the DOM. */
  it("stops at the cap instead of letting the webview evict someone", () => {
    const panels = Array.from({ length: MAX_GPU_CONTEXTS + 3 }, () => panel());
    for (const { el } of panels) setOnScreen(el, true);

    expect(liveContexts).toBe(MAX_GPU_CONTEXTS);
    expect(panels.slice(0, MAX_GPU_CONTEXTS).every(({ p }) => blinks(p))).toBe(true);
    expect(panels.slice(MAX_GPU_CONTEXTS).some(({ p }) => blinks(p))).toBe(false);
  });

  /** And the queue drains: a tile that is minimized or scrolled away hands its slot
   *  to whoever has been waiting longest, rather than leaving it idle. */
  it("passes a freed slot to the panel that has waited longest", () => {
    const panels = Array.from({ length: MAX_GPU_CONTEXTS + 2 }, () => panel());
    for (const { el } of panels) setOnScreen(el, true);

    const firstWaiter = panels[MAX_GPU_CONTEXTS];
    const secondWaiter = panels[MAX_GPU_CONTEXTS + 1];
    expect(blinks(firstWaiter.p)).toBe(false);

    setOnScreen(panels[0].el, false);

    expect(liveContexts).toBe(MAX_GPU_CONTEXTS);
    expect(blinks(panels[0].p)).toBe(false);
    expect(blinks(firstWaiter.p)).toBe(true);
    expect(blinks(secondWaiter.p)).toBe(false);
  });

  /** Closing a tile has to give the slot back too. A leak here is invisible until
   *  enough sessions have been opened and closed that the budget is gone and every
   *  new terminal quietly renders in the DOM. */
  it("releases the slot when the panel is disposed, not just when it is hidden", () => {
    const panels = Array.from({ length: MAX_GPU_CONTEXTS + 1 }, () => panel());
    for (const { el } of panels) setOnScreen(el, true);
    const waiter = panels[MAX_GPU_CONTEXTS];
    expect(blinks(waiter.p)).toBe(false);

    panels[0].p.dispose();

    expect(liveContexts).toBe(MAX_GPU_CONTEXTS);
    expect(blinks(waiter.p)).toBe(true);
  });
});

/** An `IntersectionObserver` batch can hold more than one record for the same
 *  element, and only one element is observed here — so a batch is that element's
 *  history, and the last record is the state it is in now. Read as "intersecting
 *  somewhere in the batch", a [shown, hidden] delivery would hand a context to a
 *  tile that is hidden again — and latch `onScreen`, so no later return counts as
 *  a transition and the tile never gets its slot back. */
describe("a batch of intersection records", () => {
  it("reads the newest record, not any intersecting one", () => {
    const { el } = panel();

    setOnScreenBatch(el, [true, false]);

    expect(liveContexts).toBe(0);

    // And the state did not latch: the next real return is still a transition.
    setOnScreen(el, true);

    expect(liveContexts).toBe(1);
  });
});
