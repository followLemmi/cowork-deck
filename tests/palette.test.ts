// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openPalette, filterCommands } from "../src/palette";
import type { Command } from "../src/commands";

beforeEach(() => { document.body.innerHTML = ""; });

const cmds = (): Command[] => [
  { id: "a", title: "New session", run: vi.fn() },
  { id: "b", title: "Close active", run: vi.fn() },
];

describe("filterCommands", () => {
  it("filters by case-insensitive substring of title", () => {
    const r = filterCommands(cmds(), "clos");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("b");
  });
  it("returns all for empty query", () => {
    expect(filterCommands(cmds(), "")).toHaveLength(2);
  });
});

describe("openPalette", () => {
  it("runs the command on click and closes", () => {
    const list = cmds();
    openPalette(list);
    const first = document.querySelector<HTMLElement>(".palette-item")!;
    first.click();
    expect(list[0].run).toHaveBeenCalled();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});
