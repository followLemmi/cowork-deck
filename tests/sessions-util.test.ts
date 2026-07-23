// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { waitingCount, waitingVerb } from "../src/sessions";
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

describe("waitingVerb", () => {
  it("uses singular form for 1", () => {
    expect(waitingVerb(1)).toBe("ждёт");
  });
  it("uses plural form for 2", () => {
    expect(waitingVerb(2)).toBe("ждут");
  });
  it("uses plural form for 5", () => {
    expect(waitingVerb(5)).toBe("ждут");
  });
  it("uses plural form for 11", () => {
    expect(waitingVerb(11)).toBe("ждут");
  });
  it("uses singular form for 21", () => {
    expect(waitingVerb(21)).toBe("ждёт");
  });
});
