import { describe, expect, it } from "vitest";
import { isNoLocalPath, needsLocalPath, PathPrompts } from "../src/workspace-path";

const ws = (id: string, path: string) => ({ id, path });

describe("a workspace with no folder on this machine", () => {
  it("is recognised by an empty path, whitespace included", () => {
    expect(needsLocalPath(ws("a", ""))).toBe(true);
    expect(needsLocalPath(ws("a", "   "))).toBe(true);
    expect(needsLocalPath(ws("a", "/here/deck"))).toBe(false);
    expect(needsLocalPath(null)).toBe(false);
  });
});

describe("when the question is put", () => {
  it("asks on the first visit and not on the second", () => {
    const p = new PathPrompts();
    expect(p.shouldAsk(ws("a", ""))).toBe(true);
    p.markAsked("a");
    // Re-asking on every click between two workspaces would make "later"
    // meaningless.
    expect(p.shouldAsk(ws("a", ""))).toBe(false);
  });

  it("never asks about a workspace that has a folder", () => {
    const p = new PathPrompts();
    expect(p.shouldAsk(ws("a", "/here/deck"))).toBe(false);
  });

  it("stops asking once a path arrives from anywhere", () => {
    const p = new PathPrompts();
    p.resolved("a");
    expect(p.shouldAsk(ws("a", ""))).toBe(false);
  });

  it("keeps each workspace's answer to itself", () => {
    const p = new PathPrompts();
    p.markAsked("a");
    expect(p.shouldAsk(ws("b", ""))).toBe(true);
  });

  it("forgets across a restart, because a reminder you can lose is not one", () => {
    const first = new PathPrompts();
    first.markAsked("a");
    expect(new PathPrompts().shouldAsk(ws("a", ""))).toBe(true);
  });
});

describe("the refusal a session gets", () => {
  it("is matched on its marker, so the prose can be reworded", () => {
    expect(isNoLocalPath("no-local-path: this workspace has no folder yet.")).toBe(true);
    expect(isNoLocalPath("warning · no-local-path: reworded entirely")).toBe(true);
    expect(isNoLocalPath("claude-not-found")).toBe(false);
    expect(isNoLocalPath(undefined)).toBe(false);
  });
});
