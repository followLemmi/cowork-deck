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
// xterm itself is heavy for jsdom — mock the bare minimum:
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
    // See the note in terminal-passthrough.test.ts: the panel reads and writes
    // `options.fontSize` now.
    options: Record<string, unknown> = {};
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

  it("searchPrev delegates to the addon's findPrevious", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.searchPrev("foo");
    expect(findPrevious).toHaveBeenCalledWith("foo");
  });

  it("an empty search term does not reset lastSearch", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.search("foo");
    panel.search("");
    findNext.mockClear();
    panel.findNext();
    expect(findNext).toHaveBeenCalledWith("foo");
  });

  it("clear delegates to term.clear", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.clear();
    expect(clear).toHaveBeenCalled();
  });
});
