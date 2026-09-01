// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom has neither observer, nor Tauri's injected internals — the panel builds
// a real output `Channel`, whose constructor registers its handler through them.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};
(globalThis as any).IntersectionObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};
(globalThis as any).window.__TAURI_INTERNALS__ ??= {
  transformCallback: () => 1,
  unregisterCallback: () => {},
};

/** What the terminal is showing, as the test wants it shown. The panel reads
 *  the screen rather than the output stream — Claude Code repaints only when
 *  something changes, so a long tool call can be silent for a minute with the
 *  hint up throughout — and this is that screen. */
let screen: string[] = [];
/** Which of those rows xterm wrapped from the row above. */
let wrapped = new Set<number>();
let captured: ((e: any) => boolean) | null = null;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onResize() {} onData() {} focus() {} write() {} clear() {} dispose() {}
    attachCustomKeyEventHandler(fn: (e: any) => boolean) { captured = fn; }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
    // Faithful on the two things the panel asks of a buffer: rows are addressed
    // from `baseY` — the screen, not wherever the person has scrolled — and a
    // row that does not exist answers undefined rather than throwing.
    buffer = {
      active: {
        baseY: 0,
        getLine: (y: number) =>
          screen[y] === undefined
            ? undefined
            : { translateToString: () => screen[y], isWrapped: wrapped.has(y) },
      },
    };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), startShellSession: vi.fn(),
  writeSession: vi.fn().mockResolvedValue(undefined),
  resizeSession: vi.fn().mockResolvedValue(undefined),
  prepareWorkspace: vi.fn(), claimSession: vi.fn(),
}));

import { TerminalPanel } from "../src/terminal";

const WORKING = ["> ", "✻ Cogitating… (12s · esc to interrupt)"];
const FREE = ["> ", "  ? for shortcuts"];

const ESC = {
  type: "keydown", code: "Escape", key: "Escape",
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
};

const made: TerminalPanel[] = [];
function panel() {
  const p = new TerminalPanel("s-1", document.createElement("div"));
  made.push(p);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  captured = null;
  screen = [];
  wrapped = new Set();
  // Force macOS so the passthrough guard treats Cmd (not Ctrl) as the app modifier.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});
afterEach(() => {
  for (const p of made.splice(0)) p.dispose();
  vi.useRealTimers();
});

describe("a turn ended by Escape", () => {
  it("is reported once the hint has gone", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = WORKING;

    captured!(ESC);
    expect(seen).toEqual([]);   // nothing on the keystroke alone

    screen = FREE;              // the interrupt landed
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(["s-1"]);

    // And only once — the wait is over, not still watching an idle screen.
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual(["s-1"]);
  });

  it("does not consume the key: the interrupt still reaches the process", () => {
    const p = panel();
    p.onInterrupt = () => {};
    screen = WORKING;
    // Returning false here would stop xterm sending `ESC` to the pty, which is
    // the interrupt itself — this path watches and takes nothing.
    expect(captured!(ESC)).toBe(true);
  });

  it("says nothing when there was no turn to interrupt", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = FREE;   // Escape clearing a half-typed prompt, not an interrupt

    captured!(ESC);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
  });

  it("says nothing when Claude Code spent the key on something else", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    // A completion menu dismissed over a running turn: the key was taken, the
    // turn was not. The hint never goes, so nothing is reported and the hooks
    // stay in charge.
    screen = WORKING;

    captured!(ESC);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);   // and the wait gave up rather than spinning
  });

  it("gives up rather than reporting the NEXT turn's end", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = WORKING;

    captured!(ESC);
    vi.advanceTimersByTime(5000);   // the key did something else; the wait is over
    screen = FREE;                  // this turn ends on its own, minutes later
    vi.advanceTimersByTime(5000);
    // `Stop` reports that one. A wait still open would report it twice.
    expect(seen).toEqual([]);
  });

  it("keeps one wait for a person pressing Escape twice", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = WORKING;

    captured!(ESC);
    captured!(ESC);
    captured!(ESC);
    expect(vi.getTimerCount()).toBe(1);

    screen = FREE;
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(["s-1"]);
  });

  /** A tile in a four-column deck is narrow, and a status line longer than it
   *  is arrives as two rows with the second marked wrapped. Reading them as two
   *  lines would find the hint in neither. */
  it("finds a hint the terminal wrapped across two rows", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = ["✻ Cogitating… (1m 4s · ↓ 3.1k tokens · esc ", "to interrupt)"];
    wrapped = new Set([1]);

    captured!(ESC);
    expect(vi.getTimerCount()).toBe(1);

    screen = FREE;
    wrapped = new Set();
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(["s-1"]);
  });

  it("is not started by Escape with a modifier held", () => {
    const p = panel();
    p.onInterrupt = () => {};
    screen = WORKING;

    captured!({ ...ESC, shiftKey: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is dropped when the panel goes", () => {
    const seen: string[] = [];
    const p = panel();
    p.onInterrupt = (s) => seen.push(s);
    screen = WORKING;
    captured!(ESC);

    p.dispose();
    expect(vi.getTimerCount()).toBe(0);   // nothing left to touch a disposed terminal
    screen = FREE;
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
  });

  it("starts no wait at all on a panel nobody is listening to", () => {
    panel();          // a drawer's shell terminal: no `onInterrupt`, and no hint either
    screen = WORKING;
    captured!(ESC);
    expect(vi.getTimerCount()).toBe(0);
  });
});
