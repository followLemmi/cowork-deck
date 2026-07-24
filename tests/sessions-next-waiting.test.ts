// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { nextWaitingAcross } from "../src/sessions";
import type { SessionState } from "../src/ipc";

const t = (session: string, state: SessionState, workspaceId?: string) => ({ session, state, workspaceId });

describe("nextWaitingAcross", () => {
  it("returns null when nothing is waiting", () => {
    expect(nextWaitingAcross([t("a", "idle"), t("b", "working")], null)).toBeNull();
  });
  it("finds the first waiting session when none is active", () => {
    const r = nextWaitingAcross([t("a", "idle"), t("b", "waitingInput", "w2")], null);
    expect(r).toEqual({ session: "b", workspaceId: "w2" });
  });
  it("wraps around past the current session", () => {
    const tiles = [t("a", "waitingInput", "w1"), t("b", "idle"), t("c", "waitingInput", "w2")];
    // current = c (last) → next waiting wraps to a
    expect(nextWaitingAcross(tiles, "c")).toEqual({ session: "a", workspaceId: "w1" });
  });
  it("skips the current session even if it is waiting", () => {
    const tiles = [t("a", "waitingInput", "w1"), t("b", "waitingInput", "w2")];
    expect(nextWaitingAcross(tiles, "a")).toEqual({ session: "b", workspaceId: "w2" });
  });
  it("returns the only waiting session (not the current) across workspaces", () => {
    const tiles = [t("a", "working", "w1"), t("b", "waitingInput", "w2")];
    expect(nextWaitingAcross(tiles, "a")).toEqual({ session: "b", workspaceId: "w2" });
  });
});
