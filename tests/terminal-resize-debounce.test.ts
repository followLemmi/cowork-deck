// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

/** The `onResize` xterm would call, captured so a test can fire it the way a refit
 *  does. Real xterm hands `{ cols, rows }`; so does this. */
let emitResize: ((size: { cols: number; rows: number }) => void) | null = null;

const fit = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onData() {} focus() {} write() {} clear() {}
    attachCustomKeyEventHandler() {}
    onResize(cb: (size: { cols: number; rows: number }) => void) { emitResize = cb; }
    dispose = vi.fn();
    cols = 80; rows = 24;
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.options = { ...opts }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fit; } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
const resizeSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/ipc", () => ({
  startSession: vi.fn().mockResolvedValue({ kind: "none" }),
  startCommandSession: vi.fn().mockResolvedValue(undefined),
  writeSession: vi.fn(),
  resizeSession: (s: string, c: number, r: number) => resizeSession(s, c, r),
}));

import { TerminalPanel } from "../src/terminal";

function mount(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  return el;
}

const live: TerminalPanel[] = [];
function panel(session = "s"): TerminalPanel {
  const p = new TerminalPanel(session, mount());
  live.push(p);
  return p;
}

/** One refit's worth of `onResize`. */
function resized(cols: number, rows: number): void {
  emitResize?.({ cols, rows });
}

beforeEach(() => {
  vi.useFakeTimers();
  while (live.length) live.pop()!.dispose();
  emitResize = null;
  vi.clearAllMocks();
});

afterEach(() => { vi.useRealTimers(); });

describe("the PTY hears about a resize once, when it is over", () => {
  // The measurement this exists for: one drag of the terminal drawer's grip put 81
  // pointer events through `fit()` and 150 `resize_session` calls through here. Each
  // one is an ioctl, a SIGWINCH, and a full-screen redraw by the agent.
  it("collapses a gesture's worth of sizes into one call", () => {
    panel();
    for (let rows = 24; rows > 10; rows--) resized(80, rows);
    expect(resizeSession).not.toHaveBeenCalled();     // nothing yet: the size is still moving
    vi.advanceTimersByTime(100);
    expect(resizeSession).toHaveBeenCalledTimes(1);
    // The trailing edge, and this is the half that matters: the child has to be told
    // the size the gesture *ended* on, or it wraps against a width the terminal no
    // longer has.
    expect(resizeSession).toHaveBeenCalledWith("s", 80, 11);
  });

  it("sends a second gesture too", () => {
    panel();
    resized(80, 20);
    vi.advanceTimersByTime(100);
    resized(80, 30);
    vi.advanceTimersByTime(100);
    expect(resizeSession).toHaveBeenCalledTimes(2);
    expect(resizeSession).toHaveBeenLastCalledWith("s", 80, 30);
  });

  // `applyLayout`, a workspace switch and the refit after the zoom animation all call
  // `fit()` on tiles whose box has not moved. Each of those used to be a round trip
  // and a redraw.
  it("says nothing when the size has not actually changed", () => {
    panel();
    resized(80, 20);
    vi.advanceTimersByTime(100);
    expect(resizeSession).toHaveBeenCalledTimes(1);
    resized(80, 20);
    vi.advanceTimersByTime(100);
    expect(resizeSession).toHaveBeenCalledTimes(1);
  });

  it("counts the size a session was started at as already sent", async () => {
    const p = panel();
    await p.start("/tmp", null, null);
    // 80x24 is what `start` handed the backend, and a refit to the same numbers —
    // `document.fonts.ready` resolving, say — must not tell it twice.
    resized(80, 24);
    vi.advanceTimersByTime(100);
    expect(resizeSession).not.toHaveBeenCalled();
    resized(80, 25);
    vi.advanceTimersByTime(100);
    expect(resizeSession).toHaveBeenCalledWith("s", 80, 25);
  });

  it("counts a command tile's starting size the same way", async () => {
    const p = panel();
    await p.startCommand("/tmp", "cargo build");
    resized(80, 24);
    vi.advanceTimersByTime(100);
    expect(resizeSession).not.toHaveBeenCalled();
  });

  // A panel is disposed when its session closes. The size of a PTY that is going
  // away is not worth an ioctl, and a timer that outlives the panel to send one is
  // worth even less.
  it("drops a held size when the panel is disposed", () => {
    const p = panel();
    resized(80, 12);
    p.dispose();
    vi.advanceTimersByTime(500);
    expect(resizeSession).not.toHaveBeenCalled();
  });

  it("swallows a rejection from a session that has already ended", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    resizeSession.mockRejectedValueOnce(new Error("no such session"));
    panel();
    resized(80, 15);
    vi.advanceTimersByTime(100);
    await vi.runAllTicks();
    await Promise.resolve();
    expect(debug).toHaveBeenCalledWith("terminal resize skipped", expect.any(Error));
    debug.mockRestore();
  });
});
