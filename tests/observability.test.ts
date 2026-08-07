import { describe, it, expect } from "vitest";
import {
  formatContext, formatTokens, spendIn, sumUsage, tokenTooltip, uniqueCwds,
} from "../src/observability";

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

describe("spendIn", () => {
  it("counts the cache fields, which is where a cached prompt actually lands", () => {
    // `input` alone is the uncached delta — a couple of tokens per request — so
    // reading it as \"what went in\" was the original defect.
    expect(spendIn({ input: 2, output: 999, cacheCreation: 124, cacheRead: 82_021 })).toBe(82_147);
  });
});

describe("formatContext", () => {
  it("renders the window", () => { expect(formatContext(83_682)).toBe("ctx 83.7k"); });
  it("shows a dash before the first request, not a zero", () => {
    expect(formatContext(null)).toBe("ctx —");
    expect(formatContext(0)).toBe("ctx 0");
  });
});

describe("tokenTooltip", () => {
  const spend = { input: 86, output: 19_620, cacheCreation: 124_000, cacheRead: 2_293_075 };
  it("carries the bill the badge no longer shows", () => {
    expect(tokenTooltip({ context: 83_682, spend, subagents: 1 })).toBe(
      "spend · 19.6k out · 2.4M in\ncache · 2.3M read · 124.0k written\nsubagents · 1",
    );
  });
  it("omits the subagent line when nothing was delegated", () => {
    expect(tokenTooltip({ context: 83_682, spend, subagents: 0 })).not.toContain("subagents");
  });
});

describe("uniqueCwds", () => {
  it("dedupes by cwd preserving order", () => {
    expect(uniqueCwds([{ cwd: "/a" }, { cwd: "/b" }, { cwd: "/a" }])).toEqual(["/a", "/b"]);
  });
});
