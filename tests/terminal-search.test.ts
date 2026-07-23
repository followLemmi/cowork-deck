// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

const findNext = vi.fn();
const findPrevious = vi.fn();
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class { findNext = findNext; findPrevious = findPrevious; },
}));
// xterm сам по себе тяжёл для jsdom — мокаем минимально:
const clear = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() {} onResize() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    clear = clear;
    write() {}
    dispose() {}
    cols = 80; rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../src/ipc", () => ({ startSession: vi.fn(), writeSession: vi.fn(), resizeSession: vi.fn() }));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => vi.clearAllMocks());

describe("terminal search & clear", () => {
  it("search delegates to the search addon", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.search("foo");
    expect(findNext).toHaveBeenCalledWith("foo");
    panel.findPrevious();
    expect(findPrevious).toHaveBeenCalled();
  });

  it("clear delegates to term.clear", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.clear();
    expect(clear).toHaveBeenCalled();
  });
});
