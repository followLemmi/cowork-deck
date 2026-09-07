/** The three formatters that were written twice each.
 *
 *  Why the whole file is here rather than the cases living beside each caller:
 *  the cases DID live beside each caller, in `tests/observability.test.ts`,
 *  `tests/usage.test.ts`, `tests/runs.test.ts` and `tests/sync-copy.test.ts`,
 *  and every one of them passed while the two implementations of `formatTokens`
 *  disagreed and the two of `agoLabel` took different units (#463). A test per
 *  copy is what let the copies drift.
 */
import { describe, it, expect } from "vitest";
import { agoLabel, formatTokens, plural } from "../src/format";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-02T12:00:00Z");

describe("formatTokens", () => {
  it("leaves a number a person can read alone", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("scales to k and M at one decimal", () => {
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(45_230)).toBe("45.2k");
    expect(formatTokens(83_700)).toBe("83.7k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  /** A ceiling is written round — 2 000 requests, 500 000 tokens — and
   *  `2.0k requests` is a stray zero where `2k requests` is the number. A live
   *  count is never round in practice, which is why one function serves both. */
  it("drops a bare .0, so a round ceiling reads as one", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(2_000)).toBe("2k");
    expect(formatTokens(412_000)).toBe("412k");
    expect(formatTokens(1_000_000)).toBe("1M");
  });

  /** The rule the `usage.ts` copy had and the `observability.ts` copy did not.
   *  A reading that rounds up states a threshold that was not crossed, which on
   *  a limits row is the difference between "nearly spent" and "spent". */
  it("never rounds up to a figure that has not been reached", () => {
    expect(formatTokens(999_999)).toBe("999.9k");
    expect(formatTokens(1_099_999)).toBe("1M");
    expect(formatTokens(1_999_999)).toBe("1.9M");
    // The fault the `toFixed` copy had: `(83682 / 1000).toFixed(1)` is `83.7`.
    expect(formatTokens(83_682)).toBe("83.6k");
  });

});

describe("plural", () => {
  it("takes both forms, because a plural is not always a suffix", () => {
    expect(plural(1, "session is", "sessions are")).toBe("1 session is");
    expect(plural(2, "session is", "sessions are")).toBe("2 sessions are");
    expect(plural(0, "other session", "other sessions")).toBe("0 other sessions");
  });
});

describe("agoLabel", () => {
  it("counts in the unit a person would use", () => {
    expect(agoLabel(NOW - 20_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - MIN, NOW)).toBe("1 minute ago");
    expect(agoLabel(NOW - 12 * MIN, NOW)).toBe("12 minutes ago");
    expect(agoLabel(NOW - HOUR, NOW)).toBe("1 hour ago");
    expect(agoLabel(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
    expect(agoLabel(NOW - 3 * DAY, NOW)).toBe("3 days ago");
  });

  it("says 'never' rather than pretending to a time", () => {
    expect(agoLabel(null, NOW)).toBe("never");
  });

  /** Clocks do move backwards — a DST change, an NTP correction — and a record
   *  claiming to be from the future is a distraction rather than information. */
  it("does not report a record from the future", () => {
    expect(agoLabel(NOW + 3 * MIN, NOW)).toBe("just now");
  });

  describe("past a week, which is the one rule the two callers disagree about", () => {
    /** The journal's: "37 days ago" is arithmetic nobody asked for, and a run
     *  from last month is looked up by when it happened. */
    it("prints the date by default", () => {
      expect(agoLabel(NOW - 30 * DAY, NOW))
        .toBe(new Date(NOW - 30 * DAY).toLocaleDateString());
    });

    /** The sync line's: the age of the last push is the one number that says
     *  whether sync is working at all, and a sync broken for three weeks looks
     *  exactly like a working one until a disk dies. */
    it("keeps counting days when asked to", () => {
      expect(agoLabel(NOW - 21 * DAY, NOW, "days")).toBe("21 days ago");
      expect(agoLabel(NOW - 400 * DAY, NOW, "days")).toBe("400 days ago");
    });

    /** Both modes agree everywhere inside a week — the parameter is one branch,
     *  not a second vocabulary. */
    it("says the same thing either way inside a week", () => {
      for (const d of [30_000, MIN, 5 * MIN, HOUR, 12 * HOUR, DAY, 6 * DAY]) {
        expect(agoLabel(NOW - d, NOW, "days")).toBe(agoLabel(NOW - d, NOW, "date"));
      }
    });
  });
});

/** The agreement the audit asked for, as a test rather than as a convention.
 *
 *  Both callers of `formatTokens` import it from here, so the only way they can
 *  disagree again is a second definition — which is what this asserts is absent
 *  by asserting that the two surfaces print the same string for the same number.
 */
describe("one number, one string, on every surface", () => {
  it("formats a context size the same in a tile badge and a limits row", async () => {
    const { formatContext } = await import("../src/observability");
    const { readingOf } = await import("../src/usage");
    const n = 83_712;
    expect(formatContext(n)).toBe(`ctx ${formatTokens(n)}`);
    expect(readingOf({
      id: "session", label: "Current session", usedFraction: null,
      amount: { used: n, limit: null, unit: "tokens" },
      state: "ok", resetsAt: null, source: "observed", note: null,
    })).toContain(formatTokens(n));
  });
});
