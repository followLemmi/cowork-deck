// @vitest-environment jsdom
//
// Taking over a session another window is still rendering.
//
// The sequence is the design, and every step of it exists because the obvious
// shortcut is wrong: a panel born with resize authority tells the PTY about a
// window that is not showing it yet; a replay into a terminal of a different
// width stitches itself into garbage, because Ink repaints relative to the
// current one; and reusing the launch path would run `claude --resume` against a
// PTY that is still alive — a second agent on one conversation.
import { describe, it, expect, vi, beforeEach } from "vitest";

const written: string[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onResize() {} focus() {} clear() {} dispose() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    write(d: string) { written.push(d); }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class { serialize() { return "WHAT-WAS-ON-SCREEN"; } },
}));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), startShellSession: vi.fn(),
  prepareWorkspace: vi.fn(),
  writeSession: vi.fn().mockResolvedValue(undefined),
  resizeSession: vi.fn().mockResolvedValue(undefined),
  claimSession: vi.fn().mockResolvedValue(undefined),
}));

import { TerminalPanel } from "../src/terminal";
import { claimSession, resizeSession, startSession } from "../src/ipc";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A panel born for a hand-off: inert, which is the fourth constructor argument. */
function inertPanel() {
  const mount = document.createElement("div");
  document.body.append(mount);
  return new TerminalPanel("s1", mount, false, true);
}

beforeEach(() => {
  vi.clearAllMocks();
  written.length = 0;
});

describe("taking a session over", () => {
  /** The defect the whole epic starts from, one layer down: `start(..., resume)`
   *  runs `claude --resume`, and against a PTY that is still alive that is a
   *  second agent writing into one transcript. */
  it("spawns nothing", async () => {
    await inertPanel().attach();
    expect(startSession).not.toHaveBeenCalled();
    expect(claimSession).toHaveBeenCalledWith("s1", expect.anything());
  });

  /** A panel built for a hand-off must not tell the PTY its geometry before it
   *  owns the session: the child would take a SIGWINCH for a window that is not
   *  showing it, and Ink would repaint at a width nobody can see. */
  it("says nothing to the PTY until it has authority", async () => {
    const panel = inertPanel();
    await panel.attach();
    await flush();
    expect(resizeSession).not.toHaveBeenCalled();
  });

  /** And then exactly one authoritative size, sent directly rather than through
   *  the debounce — the debounce is there to collapse a drag, and this is not
   *  one. */
  it("sends the settled size once when it is activated", async () => {
    const panel = inertPanel();
    await panel.attach();
    panel.activate();
    await flush();
    expect(vi.mocked(resizeSession).mock.calls[0]).toEqual(["s1", 80, 24]);
  });

  /** SIGWINCH is the only way to get a true current frame out of a running TUI,
   *  and a resize to the size it already has is not a change — hence the detour
   *  through `rows - 1`. Never `Ctrl+L`: that reaches Claude Code as input. */
  it("makes the process redraw by nudging the size and putting it back", async () => {
    const panel = inertPanel();
    await panel.attach();
    panel.activate();
    await flush();
    expect(vi.mocked(resizeSession).mock.calls).toEqual([
      ["s1", 80, 24],
      ["s1", 80, 23],
      ["s1", 80, 24],
    ]);
  });

  it("puts back what the person was looking at", () => {
    inertPanel().replay("EARLIER OUTPUT");
    expect(written[0]).toBe("EARLIER OUTPUT");
  });

  /** The one mode the repaint does not restore. Ink re-emits the alternate
   *  screen and application cursor keys on every redraw, so those correct
   *  themselves; bracketed paste is sent once at startup and the new terminal
   *  never saw it. Without this, pasting into a reattached terminal regresses
   *  permanently and silently. */
  it("re-asserts bracketed paste, which nothing else will", () => {
    inertPanel().replay("");
    expect(written.join("")).toContain("[?2004h");
  });

  /** Read from the window giving the session up, while it is still alive — which
   *  is why no ring buffer is kept in Rust for this. */
  it("hands over what is on its screen", () => {
    expect(inertPanel().serialize()).toBe("WHAT-WAS-ON-SCREEN");
  });
});
