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
    // `setFontSize` reads and writes this, and the constructor now sets `fontSize`
    // from the current scale rather than a literal.
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../src/ipc", () => ({ startSession: vi.fn(), writeSession: vi.fn(), resizeSession: vi.fn() }));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => {
  captured = null;
  // Force macOS so the passthrough guard treats Cmd (not Ctrl) as the app modifier.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

describe("xterm passthrough guard", () => {
  it("passes Ctrl+C through to the terminal (not intercepted)", () => {
    new TerminalPanel("s", document.createElement("div"));
    expect(captured).toBeTypeOf("function");
    expect(captured!({ type: "keydown", code: "KeyC", key: "c", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
  });
  it("passes Ctrl+K through on macOS (readline kill-line survives)", () => {
    new TerminalPanel("s", document.createElement("div"));
    expect(captured!({ type: "keydown", code: "KeyK", key: "k", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
  });
  it("intercepts app hotkeys like Cmd+K (xterm should not handle)", () => {
    new TerminalPanel("s", document.createElement("div"));
    expect(captured!({ type: "keydown", code: "KeyK", key: "k", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});
