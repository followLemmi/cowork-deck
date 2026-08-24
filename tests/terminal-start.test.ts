// @vitest-environment jsdom
//
// What happens between a tile appearing and its process existing.
//
// `start_session` runs on the thread that paints the window, so the work it
// used to do inline — resolving the workspace's `gh` token, finding `claude` —
// is now done by `prepare_workspace` first, off that thread. That makes the gap
// between "the terminal is on screen and focused" and "there is a process to
// type at" longer, and a `write_session` for a session the backend has not made
// yet succeeds and throws the bytes away. So the panel holds them.
import { describe, it, expect, vi, beforeEach } from "vitest";

(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

// Every spawn opens a real `Channel` for its output, and `Channel`'s constructor
// registers its handler with Tauri's injected internals — absent in jsdom, so
// without this the launch throws before it ever reaches the code under test.
// The output path is `terminal-write.test.ts`'s subject; here only the
// registration has to exist.
(globalThis as any).window.__TAURI_INTERNALS__ ??= {
  transformCallback: () => 1,
  unregisterCallback: () => {},
};

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onResize() {} focus() {} write() {} clear() {} dispose() {}
    attachCustomKeyEventHandler() {}
    private data: ((d: string) => void) | null = null;
    onData(fn: (d: string) => void) { this.data = fn; }
    /** Real xterm feeds `input` to `onData`; the panel's write to the session
     *  hangs off that, so a mock that swallowed it would test nothing. */
    input(d: string) { this.data?.(d); }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), startShellSession: vi.fn(),
  writeSession: vi.fn(), resizeSession: vi.fn(), prepareWorkspace: vi.fn(),
}));

import { TerminalPanel } from "../src/terminal";
import { startSession, startCommandSession, writeSession, prepareWorkspace } from "../src/ipc";

/** A promise plus the handle to settle it, so a test can hold a launch open and
 *  type into the gap. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const AUTH = { account: null, degraded: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareWorkspace).mockResolvedValue(AUTH);
  vi.mocked(startSession).mockResolvedValue(AUTH);
  vi.mocked(startCommandSession).mockResolvedValue(undefined);
});

describe("a launch resolves the account binding before it spawns", () => {
  it("prepares the workspace first, so the spawn command reads a cache", async () => {
    const order: string[] = [];
    vi.mocked(prepareWorkspace).mockImplementation(async () => { order.push("prepare"); return AUTH });
    vi.mocked(startSession).mockImplementation(async () => { order.push("start"); return AUTH });

    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null);

    expect(order).toEqual(["prepare", "start"]);
    expect(prepareWorkspace).toHaveBeenCalledWith("w1");
  });

  // A tile with no workspace has no binding to resolve, and asking would be a
  // round trip for nothing.
  it("asks for nothing when the tile belongs to no workspace", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", null, null);
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(startSession).toHaveBeenCalled();
  });

  // The resolution is an optimisation, not a precondition: the spawn resolves
  // the binding itself when it has to.
  it("still launches when the preparation fails", async () => {
    vi.mocked(prepareWorkspace).mockRejectedValue(new Error("gh is asleep"));
    const panel = new TerminalPanel("s", document.createElement("div"));
    await expect(panel.start("/proj", "w1", null)).resolves.toEqual(AUTH);
    expect(startSession).toHaveBeenCalled();
  });

  it("passes the replacement flag through to the spawn", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null, null, true, null, true);
    expect(startSession).toHaveBeenCalledWith(
      "s", "/proj", "w1", null, null, 80, 24, true, expect.anything(), null, true,
    );
  });
});

describe("keystrokes typed before the process exists", () => {
  it("are held and then delivered, in the order they were typed", async () => {
    const gate = deferred<typeof AUTH>();
    vi.mocked(startSession).mockReturnValue(gate.promise);

    const panel = new TerminalPanel("s", document.createElement("div"));
    const launch = panel.start("/proj", "w1", null);
    // The terminal is on screen and focused while this is in flight.
    (panel as any).term.input("h");
    (panel as any).term.input("i");
    expect(writeSession).not.toHaveBeenCalled();

    gate.resolve(AUTH);
    await launch;

    expect(vi.mocked(writeSession).mock.calls).toEqual([["s", "h"], ["s", "i"]]);
  });

  it("go straight through once the process is there", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null);
    (panel as any).term.input("x");
    expect(writeSession).toHaveBeenCalledWith("s", "x");
  });

  // A launch that failed still has to release what was typed at it: those
  // keystrokes belong to whatever the person does next, and a tile that
  // swallowed input for good would look broken in a way nothing explains.
  it("are released even when the launch fails", async () => {
    vi.mocked(startSession).mockRejectedValue(new Error("claude-not-found"));
    const panel = new TerminalPanel("s", document.createElement("div"));
    await expect(panel.start("/proj", "w1", null)).rejects.toThrow();
    (panel as any).term.input("x");
    expect(writeSession).toHaveBeenCalledWith("s", "x");
  });

  // A restart reuses the panel, and its new process is as absent as a new
  // tile's until the spawn comes back.
  it("are held again across a restart", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null);
    vi.mocked(writeSession).mockClear();

    const gate = deferred<typeof AUTH>();
    vi.mocked(startSession).mockReturnValue(gate.promise);
    const relaunch = panel.start("/proj", "w1", null, null, true, null, true);
    (panel as any).term.input("q");
    expect(writeSession).not.toHaveBeenCalled();

    gate.resolve(AUTH);
    await relaunch;
    expect(writeSession).toHaveBeenCalledWith("s", "q");
  });

  it("are held by a command tile too", async () => {
    const gate = deferred<void>();
    vi.mocked(startCommandSession).mockReturnValue(gate.promise);
    const panel = new TerminalPanel("s", document.createElement("div"), true);
    const launch = panel.startCommand("/proj", "gh auth login");
    (panel as any).term.input("y");
    expect(writeSession).not.toHaveBeenCalled();

    gate.resolve();
    await launch;
    expect(writeSession).toHaveBeenCalledWith("s", "y");
  });
});
