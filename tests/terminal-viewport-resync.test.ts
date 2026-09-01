// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

(globalThis as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
(globalThis as any).window.__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  unregisterCallback: () => {},
};

/** The same driveable observer `terminal-gpu.test.ts` uses: the resync hangs off
 *  visibility, so the test has to be the thing that says when a tile is on screen. */
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

const syncScrollArea = vi.fn();

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class { onContextLoss() {} dispose() {} },
}));
vi.mock("@xterm/xterm", () => ({
  // Shaped like the real thing all the way down to `_core.viewport`, because that
  // path is what the panel walks. The contract test below is what says the shape
  // is still the one xterm ships.
  Terminal: class {
    options: Record<string, unknown> = {};
    _core = { viewport: { syncScrollArea } };
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

import { TerminalPanel } from "../src/terminal";

const made: TerminalPanel[] = [];
function panel() {
  const el = document.createElement("div");
  const p = new TerminalPanel("s", el);
  made.push(p);
  return { el, p };
}

beforeEach(() => { watchers.length = 0; syncScrollArea.mockClear() });
afterEach(() => { for (const p of made.splice(0)) p.dispose() });

/** #340. A tile hidden with `display: none` keeps taking output, and every refresh
 *  xterm does while it is hidden rebuilds the DOM scroll area against a viewport of
 *  zero height. The rows on screen stay right — `ydisp` is untouched — but the
 *  scrollbar is left at the top, and the first wheel tick reads that scrollbar and
 *  flies up into the scrollback. Nothing in xterm resyncs the two on the way back:
 *  the return is not a resize, so `fit()` is a no-op and no dimensions change
 *  fires. The panel has to say so itself. */
describe("the scrollbar on the way back from hidden", () => {
  it("resyncs xterm's viewport when the tile comes on screen", () => {
    const { el } = panel();
    expect(syncScrollArea).not.toHaveBeenCalled();

    setOnScreen(el, true);

    expect(syncScrollArea).toHaveBeenCalledTimes(1);
  });

  /** Off screen is the state that breaks the scroll area, not the one that mends
   *  it, and a panel that nobody can see is measured at zero — resyncing there
   *  would write the same wrong height back. */
  it("does not resync on the way out", () => {
    const { el } = panel();
    setOnScreen(el, true);
    syncScrollArea.mockClear();

    setOnScreen(el, false);

    expect(syncScrollArea).not.toHaveBeenCalled();
  });

  /** An `IntersectionObserver` fires on every threshold crossing and on observe,
   *  and a deck of tiles scrolling in the strip produces a stream of them. Only a
   *  real change of state is a return. */
  it("resyncs once per return, not once per observer callback", () => {
    const { el } = panel();

    setOnScreen(el, true);
    setOnScreen(el, true);
    setOnScreen(el, false);
    setOnScreen(el, true);

    expect(syncScrollArea).toHaveBeenCalledTimes(2);
  });

  /** A batch can hold more than one record for the same element, and only one
   *  element is observed here — so a batch is that element's history, and the last
   *  record is the state it is in now. Read as "intersecting somewhere in the
   *  batch", a [shown, hidden] delivery resyncs a tile that is hidden again, which
   *  measures a box of zero height and writes the broken scroll area straight
   *  back — and latches `onScreen`, so nothing resyncs on any later return. */
  it("reads the newest record in a batch, not any intersecting one", () => {
    const { el } = panel();

    setOnScreenBatch(el, [true, false]);

    expect(syncScrollArea).not.toHaveBeenCalled();

    // And the state did not latch: the next real return is still a transition.
    setOnScreen(el, true);

    expect(syncScrollArea).toHaveBeenCalledTimes(1);
  });
});

/** `Viewport.syncScrollArea` is not public API. It is reached through `_core`, the
 *  same door `FitAddon` uses, and the panel guards the call so a version that moves
 *  it degrades to a no-op rather than a crash — which would put the bug back
 *  silently. This is the alarm on that: it opens a real xterm and asserts the path
 *  is still there, so the bump that breaks it fails here instead of in someone's
 *  scrollback. */
describe("xterm's private viewport", () => {
  it("still exposes syncScrollArea at _core.viewport", async () => {
    const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
    // xterm's `CoreBrowserService` reads `matchMedia` to track the device pixel
    // ratio, and jsdom has none.
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const term = new Terminal();
    term.open(el);

    const viewport = (term as any)._core?.viewport;
    expect(typeof viewport?.syncScrollArea).toBe("function");

    term.dispose();
    el.remove();
  });
});
