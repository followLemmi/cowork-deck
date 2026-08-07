// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

const written: unknown[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onData() {} onResize() {} focus() {} clear() {} dispose() {}
    attachCustomKeyEventHandler() {}
    // Records the argument as it arrives: the point of these tests is that the
    // panel hands xterm exactly what it was given, so a mock that normalised the
    // type would test nothing.
    write(data: unknown) { written.push(data); }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), writeSession: vi.fn(), resizeSession: vi.fn(),
}));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => { written.length = 0 });

describe("TerminalPanel.write", () => {
  /** Agent output has to reach xterm as bytes. Only xterm's own decoder holds a
   *  partial UTF-8 sequence across a pty read boundary — decode it any earlier and
   *  a split glyph becomes replacement characters, which is a line drifting by a
   *  column or two. Converting to a string anywhere on this path would put the bug
   *  back, so the type is asserted, not just the content. */
  it("passes bytes through to xterm untouched", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    const bytes = new TextEncoder().encode("─│⏺");
    panel.write(bytes);
    expect(written).toHaveLength(1);
    // `toBeInstanceOf` cannot be used here: jsdom is a second realm, so the
    // `Uint8Array` this file sees is not the constructor the value was built with.
    // `ArrayBuffer.isView` answers the question that matters — a view, not text —
    // and answers it across realms.
    expect(ArrayBuffer.isView(written[0])).toBe(true);
    expect(written[0]).toEqual(bytes);
  });

  /** The app's own status lines — `[restarting session...]`, the launch failures —
   *  are written as strings by `sessions.ts` and must keep working. */
  it("still accepts a string, for the app's own messages", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.write("\r\n[restarting session...]\r\n");
    expect(written).toEqual(["\r\n[restarting session...]\r\n"]);
  });
});
