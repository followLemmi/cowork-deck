import { describe, it, expect } from "vitest";
import { formatTokens, sumUsage, uniqueCwds } from "../src/observability";

describe("formatTokens", () => {
  it("passes through small numbers", () => { expect(formatTokens(0)).toBe("0"); expect(formatTokens(999)).toBe("999"); });
  it("uses k for thousands", () => { expect(formatTokens(1200)).toBe("1.2k"); expect(formatTokens(45230)).toBe("45.2k"); });
  it("uses M for millions", () => { expect(formatTokens(2_500_000)).toBe("2.5M"); });
});

describe("sumUsage", () => {
  it("sums field-wise", () => {
    const r = sumUsage([
      { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
      { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 },
    ]);
    expect(r).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
  });
  it("empty is all-zero", () => { expect(sumUsage([])).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }); });
});

describe("uniqueCwds", () => {
  it("dedupes by cwd preserving order", () => {
    expect(uniqueCwds([{ cwd: "/a" }, { cwd: "/b" }, { cwd: "/a" }])).toEqual(["/a", "/b"]);
  });
});
