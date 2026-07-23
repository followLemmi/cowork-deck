// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

let captured: ((e: any) => boolean) | null = null;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onData() {} onResize() {} focus() {} write() {} clear() {} dispose() {}
    attachCustomKeyEventHandler(fn: (e: any) => boolean) { captured = fn; }
    cols = 80; rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../src/ipc", () => ({ startSession: vi.fn(), writeSession: vi.fn(), resizeSession: vi.fn() }));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => { captured = null; });

describe("xterm passthrough guard", () => {
  it("passes Ctrl+C through to the terminal (not intercepted)", () => {
    new TerminalPanel("s", document.createElement("div"));
    expect(captured).toBeTypeOf("function");
    expect(captured!({ type: "keydown", key: "c", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
  });
  it("intercepts app hotkeys like Cmd+K (xterm should not handle)", () => {
    new TerminalPanel("s", document.createElement("div"));
    expect(captured!({ type: "keydown", key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});
