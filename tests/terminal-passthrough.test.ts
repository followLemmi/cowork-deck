// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

let captured: ((e: any) => boolean) | null = null;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onResize() {} focus() {} write() {} clear() {} dispose() {}
    attachCustomKeyEventHandler(fn: (e: any) => boolean) { captured = fn; }
    // Faithful on the point the panel depends on: real xterm's `input` feeds
    // the byte to `onData`, which is where the write to the session lives. A
    // mock that swallowed it would let a broken wiring pass.
    private data: ((d: string) => void) | null = null;
    onData(fn: (d: string) => void) { this.data = fn; }
    input(d: string) { this.data?.(d); }
    cols = 80; rows = 24;
    // `setFontSize` reads and writes this, and the constructor now sets `fontSize`
    // from the current scale rather than a literal.
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), writeSession: vi.fn(),
  resizeSession: vi.fn(), prepareWorkspace: vi.fn(),
}));

import { TerminalPanel } from "../src/terminal";
import { writeSession } from "../src/ipc";

/** A panel whose process exists.
 *
 *  The panel holds what is typed at it until its spawn resolves — a
 *  `write_session` for a session the backend has not made yet succeeds and
 *  discards the bytes, so the first keystrokes into a fresh tile used to vanish.
 *  Every case below is about what reaches the session, which means every case
 *  below needs a started panel; an unstarted one would buffer and assert
 *  nothing. `startCommand` is the shorter of the two starts and wants no
 *  workspace.
 */
async function livePanel(keepsRenameKey = false): Promise<TerminalPanel> {
  const panel = new TerminalPanel("s", document.createElement("div"), keepsRenameKey);
  await panel.startCommand("/", "true");
  vi.mocked(writeSession).mockClear();
  return panel;
}


beforeEach(() => {
  captured = null;
  vi.mocked(writeSession).mockClear();
  // Force macOS so the passthrough guard treats Cmd (not Ctrl) as the app modifier.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

describe("xterm passthrough guard", () => {
  it("passes Ctrl+C through to the terminal (not intercepted)", async () => {
    await livePanel();
    expect(captured).toBeTypeOf("function");
    expect(captured!({ type: "keydown", code: "KeyC", key: "c", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
  });
  it("passes Ctrl+K through on macOS (readline kill-line survives)", async () => {
    await livePanel();
    expect(captured!({ type: "keydown", code: "KeyK", key: "k", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
  });
  it("intercepts app hotkeys like Cmd+K (xterm should not handle)", async () => {
    await livePanel();
    expect(captured!({ type: "keydown", code: "KeyK", key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });

  const f2 = { type: "keydown", code: "F2", key: "F2", metaKey: false, ctrlKey: false, shiftKey: false };

  it("intercepts F2 on a session, so it renames instead of reaching claude", async () => {
    // Both halves matter: returning false is what stops xterm sending `\e[12~`
    // AND what lets the window handler dispatch the command.
    await livePanel();
    expect(captured!(f2)).toBe(false);
  });

  it("a command tile keeps F2 — mc, htop and nano all bind it", async () => {
    await livePanel(true);
    expect(captured!(f2)).toBe(true);
    // Every other hotkey is still the app's, even there.
    expect(captured!({ type: "keydown", code: "KeyK", key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});

// The bytes themselves are `terminal-keys.test.ts`'s subject. What is under test
// here is the wiring: that the panel consults `terminalKeyBytes` only after
// `matchHotkey`, writes what it returns to the session, and stops xterm adding
// its own `\r` on top.
describe("modifier+Enter reaches the session as ESC+CR", () => {
  const enter = (mods: Record<string, boolean>) => ({
    type: "keydown", code: "Enter", key: "Enter",
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault: vi.fn(), ...mods,
  });

  it("writes ESC+CR on Shift+Enter and does not let xterm send CR too", async () => {
    await livePanel();
    const e = enter({ shiftKey: true });
    expect(captured!(e)).toBe(false);
    expect(writeSession).toHaveBeenCalledWith("s", "\x1b\r");
    // Returning false stops xterm; only preventDefault stops the browser
    // dropping a newline into xterm's hidden textarea.
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("treats the keypad Enter as the Enter it is", async () => {
    await livePanel();
    expect(captured!({ ...enter({ shiftKey: true }), code: "NumpadEnter" })).toBe(false);
    expect(writeSession).toHaveBeenCalledWith("s", "\x1b\r");
  });

  // The combination adjacent to zoom: `matchHotkey` does not claim it on macOS,
  // because the app modifier there is bare Cmd. Without the narrow `metaKey`
  // guard it would fall through to xterm as a bare CR and submit.
  it("writes ESC+CR on Cmd+Shift+Enter rather than submitting", async () => {
    await livePanel();
    expect(captured!(enter({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(writeSession).toHaveBeenCalledWith("s", "\x1b\r");
  });

  it("leaves a bare Enter to xterm, which submits", async () => {
    await livePanel();
    const e = enter({});
    expect(captured!(e)).toBe(true);
    expect(writeSession).not.toHaveBeenCalled();
    // Passing the key through means passing the default action through too:
    // the submit is xterm's to encode.
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("never touches the default action of a key it passes through", async () => {
    await livePanel();
    const ctrlC = { ...enter({ ctrlKey: true }), code: "KeyC", key: "c" };
    expect(captured!(ctrlC)).toBe(true);
    expect(ctrlC.preventDefault).not.toHaveBeenCalled();
  });

  // Claiming Enter mid-composition would skip xterm's composition helper — this
  // handler runs before it — and eat the IME's commit.
  //
  // What this case can pin is thin, and worth saying out loud: returning `true`
  // is also what the broken placement of the guard did, so the assertions below
  // hold either way. The whole consequence lives in what xterm does next, which
  // the mock does not model. The case that actually pins the placement is the
  // F6 one below; this one guards the bytes.
  it("leaves Enter to the IME while a composition is open", async () => {
    await livePanel();
    expect(captured!({ ...enter({ shiftKey: true }), isComposing: true })).toBe(true);
    expect(captured!({ ...enter({ shiftKey: true }), keyCode: 229 })).toBe(true);
    expect(writeSession).not.toHaveBeenCalled();
  });

  // The regression this ordering exists to prevent. `F2` and `F6` are bare keys
  // xterm knows how to encode, so passing one through mid-composition makes
  // xterm write `\x1bOQ`/`\x1b[17~` to the pty and then `stopPropagation` the
  // event, which loses the command at the window listener. An app hotkey wins
  // over the composition guard, exactly as it wins over everything else here.
  it("keeps F2 and F6 for the app even while a composition is open", async () => {
    await livePanel();
    for (const code of ["F2", "F6"]) {
      expect(captured!({ ...enter({}), code, key: code, isComposing: true })).toBe(false);
      expect(captured!({ ...enter({}), code, key: code, keyCode: 229 })).toBe(false);
    }
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("keeps Cmd+Enter on zoom — the hotkey is consulted first", async () => {
    await livePanel();
    // False because the command claimed it, and with nothing written to the pty:
    // this is an app action, not input.
    expect(captured!(enter({ metaKey: true }))).toBe(false);
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+Shift+Enter on zoom on Windows and Linux", async () => {
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
    await livePanel();
    expect(captured!(enter({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(writeSession).not.toHaveBeenCalled();
    // Ctrl+Enter without Shift is nobody's hotkey there, so it is the newline.
    expect(captured!(enter({ ctrlKey: true }))).toBe(false);
    expect(writeSession).toHaveBeenCalledWith("s", "\x1b\r");
  });

  it("ignores keyup, so the newline is written once per press", async () => {
    await livePanel();
    expect(captured!({ ...enter({ shiftKey: true }), type: "keyup" })).toBe(true);
    expect(writeSession).not.toHaveBeenCalled();
  });
});
