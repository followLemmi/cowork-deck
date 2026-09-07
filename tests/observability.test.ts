import { describe, it, expect } from "vitest";
import {
  formatContext, spendIn, sumUsage, tokenTooltip, uniqueCwds,
} from "../src/observability";

// `formatTokens` moved to `src/format.ts` and its cases to `tests/format.test.ts`.
// This file's own copy of it disagreed with `usage.ts`'s — see the note there.

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
  /** `83.6k`, and it read `83.7k` until #463. `(83682 / 1000).toFixed(1)` rounds
   *  UP, which on this surface is only a tenth and on a limits row is the
   *  difference between "nearly spent" and "spent" — so the shared `formatTokens`
   *  floors, and the badge follows it. */
  it("renders the window without rounding up", () => {
    expect(formatContext(83_682)).toBe("ctx 83.6k");
  });
  it("shows a dash before the first request, not a zero", () => {
    expect(formatContext(null)).toBe("ctx —");
    expect(formatContext(0)).toBe("ctx 0");
  });
});

describe("tokenTooltip", () => {
  const spend = { input: 86, output: 19_620, cacheCreation: 124_000, cacheRead: 2_293_075 };
  it("carries the bill the badge no longer shows", () => {
    // `2.2M read`, not `2.3M`: 2 293 075 has not reached 2.3M — see
    // `formatTokens`, which floors rather than rounding. And `124k`, not
    // `124.0k`: 124 000 IS round at this scale, and a bare `.0` is dropped.
    expect(tokenTooltip({ context: 83_682, spend, subagents: 1 })).toBe(
      "spend · 19.6k out · 2.4M in\ncache · 2.2M read · 124k written\nsubagents · 1",
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
