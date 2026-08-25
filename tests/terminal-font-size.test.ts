// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};
// Nor an IntersectionObserver, and nor Tauri's injected internals — the panel builds
// a real output `Channel`, whose constructor registers its handler through them.
(globalThis as any).IntersectionObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};
(globalThis as any).window.__TAURI_INTERNALS__ ??= {
  transformCallback: () => 1,
  unregisterCallback: () => {},
};

const fit = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onData() {} onResize() {} focus() {} write() {} clear() {}
    attachCustomKeyEventHandler() {}
    dispose = vi.fn();
    cols = 80; rows = 24;
    options: Record<string, unknown>;
    // Real xterm exposes its constructor options as `.options`, and that is the
    // whole point here: the panel's constructor passes `fontSize` there, and a mock
    // that dropped the argument would report `undefined` and make the test look like
    // a bug in the code.
    constructor(opts: Record<string, unknown>) { this.options = { ...opts }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fit; } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), writeSession: vi.fn().mockResolvedValue(undefined), resizeSession: vi.fn().mockResolvedValue(undefined),
}));

import { TerminalPanel } from "../src/terminal";
import { applyScale, broadcastScale, DEFAULT_SCALE, terminalFontPx } from "../src/ui-scale";

/** `fit()` bails out on a zero-sized mount, and jsdom reports every element as
 *  zero-sized — so the mount has to claim a size for the refit to be observable. */
function mount(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  return el;
}

const term = (p: TerminalPanel) => (p as unknown as { term: { options: Record<string, unknown> } }).term;

/** Every panel this file builds, disposed between tests.
 *
 *  Not tidiness: a panel listens on `window`, so one left alive by an earlier test
 *  receives the next test's broadcast too. That is correct behaviour — `Deck` disposes
 *  panels when a session closes — but it means a leaked panel here makes a later
 *  assertion about how often `fit` ran count someone else's terminal. */
const live: TerminalPanel[] = [];
function panel(session = "s"): TerminalPanel {
  const p = new TerminalPanel(session, mount());
  live.push(p);
  return p;
}

beforeEach(() => {
  while (live.length) live.pop()!.dispose();
  vi.clearAllMocks();
  applyScale(DEFAULT_SCALE, document.documentElement);
});

describe("TerminalPanel.setFontSize", () => {
  it("refits after changing the size, which is the half that reaches the PTY", () => {
    const p = panel();
    fit.mockClear(); // the constructor fits once
    p.setFontSize(18);
    expect(term(p).options.fontSize).toBe(18);
    // Without this, the terminal draws at the new size while the PTY keeps the old
    // cols/rows: nothing looks wrong until the agent wraps a line.
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when the size has not changed", () => {
    const p = panel();
    const size = term(p).options.fontSize as number;
    fit.mockClear();
    p.setFontSize(size);
    expect(fit).not.toHaveBeenCalled();
  });

  it("is born at the scale in force, not at a literal 14", () => {
    // A session opened after the preference changed must not come up at the default
    // and sit there until the next change.
    applyScale(1.3, document.documentElement);
    const p = panel();
    expect(term(p).options.fontSize).toBe(terminalFontPx(1.3));
  });
});

describe("the ui-scale event", () => {
  it("resizes a live terminal", () => {
    const p = panel();
    fit.mockClear();
    broadcastScale(1.45);
    expect(term(p).options.fontSize).toBe(terminalFontPx(1.45));
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("reaches every live terminal, which is why it is an event and not a fan-out", () => {
    const a = panel("a");
    const b = panel("b");
    broadcastScale(1.45);
    expect(term(a).options.fontSize).toBe(terminalFontPx(1.45));
    expect(term(b).options.fontSize).toBe(terminalFontPx(1.45));
  });

  it("stops reaching a disposed terminal", () => {
    const p = panel();
    const before = term(p).options.fontSize;
    p.dispose();
    fit.mockClear();
    broadcastScale(1.45);
    // A listener on `window` outlives the panel unless dispose takes it off, and a
    // closed session would then keep a disposed terminal alive and touch it.
    expect(term(p).options.fontSize).toBe(before);
    expect(fit).not.toHaveBeenCalled();
  });
});
