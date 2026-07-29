// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { waitingCount } from "../src/sessions";
import type { SessionState } from "../src/ipc";

describe("waitingCount", () => {
  it("counts only waitingInput states", () => {
    const states: SessionState[] = ["idle", "waitingInput", "working", "waitingInput", "error"];
    expect(waitingCount(states)).toBe(2);
  });
  it("returns 0 for none", () => {
    expect(waitingCount(["idle", "working", "ended"])).toBe(0);
  });
});

