import { describe, it, expect } from "vitest";
import type { AiUsage, LimitState, LimitWindow, UsageSource } from "../src/ipc";
import {
  deckLimit,
  formatReset,
  limitFoot,
  formatTokens,
  LimitNotifier,
  meterFraction,
  primaryWindow,
  readingOf,
  sourceExplanation,
  sourceLabel,
  stateClass,
} from "../src/usage";

const win = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  id: "session", label: "Current session", usedFraction: null, amount: null,
  resetsAt: null, state: "unknown", source: "unknown", note: null, ...over,
});

const snap = (over: Partial<AiUsage> = {}): AiUsage => ({
  provider: "p", label: "P", account: null, plan: null, windows: [],
  source: "unknown", fetchedAt: 0, error: null, probeCommand: null,
  needsCredential: false, ...over,
});

describe("which window a one-line row draws", () => {
  it("puts a refusal before everything else, however full the others look", () => {
    const u = snap({ windows: [
      win({ id: "week", usedFraction: 0.99, state: "near" }),
      win({ id: "session", state: "exhausted" }),
    ] });
    expect(primaryWindow(u)!.id).toBe("session");
  });

  it("puts a nearly-spent window before one with a plain reading", () => {
    const u = snap({ windows: [
      win({ id: "session", usedFraction: 0.2, state: "ok" }),
      win({ id: "week", usedFraction: 0.9, state: "near" }),
    ] });
    expect(primaryWindow(u)!.id).toBe("week");
  });

  it("prefers any reading over none, and the fuller of two readings", () => {
    const known = snap({ windows: [
      win({ id: "session", state: "unknown" }),
      win({ id: "week", amount: { used: 5, limit: null, unit: "tokens" }, state: "unknown" }),
    ] });
    expect(primaryWindow(known)!.id).toBe("week");
    const both = snap({ windows: [
      win({ id: "session", usedFraction: 0.1, state: "ok" }),
      win({ id: "week", usedFraction: 0.4, state: "ok" }),
    ] });
    expect(primaryWindow(both)!.id).toBe("week");
  });

  /** A zero share is a reading. It must not lose to a window with none. */
  it("treats a zero share as a reading rather than as an absence", () => {
    const u = snap({ windows: [
      win({ id: "session", state: "unknown" }),
      win({ id: "week", usedFraction: 0, state: "ok" }),
    ] });
    expect(primaryWindow(u)!.id).toBe("week");
  });

  it("has nothing to draw for a provider with no windows", () => {
    expect(primaryWindow(snap())).toBe(null);
  });
});

describe("what the whole deck is up against", () => {
  it("is not exhausted when nothing is", () => {
    const l = deckLimit([snap({ windows: [win({ usedFraction: 0.5, state: "ok" })] })]);
    expect(l).toEqual({ exhausted: false, resetsAt: null, provider: null });
  });

  /** The rule that is easy to get backwards. Two spent windows do not lift at
   *  the earlier of the two — work resumes when the LAST one lifts. */
  it("takes the latest reset of the spent windows, not the earliest", () => {
    const l = deckLimit([snap({ windows: [
      win({ id: "session", state: "exhausted", resetsAt: 1_000 }),
      win({ id: "week", state: "exhausted", resetsAt: 9_000 }),
    ] })]);
    expect(l.resetsAt).toBe(9_000);
  });

  it("refuses to promise a time when one spent window has none", () => {
    const l = deckLimit([snap({ windows: [
      win({ id: "session", state: "exhausted", resetsAt: 1_000 }),
      win({ id: "week", state: "exhausted", resetsAt: null }),
    ] })]);
    expect(l.exhausted).toBe(true);
    expect(l.resetsAt).toBe(null);
  });

  it("names the one AI that is out, and names none when two are", () => {
    const one = deckLimit([
      snap({ label: "Claude", windows: [win({ state: "exhausted", resetsAt: 5 })] }),
      snap({ label: "Gemini", windows: [win({ state: "ok", usedFraction: 0.1 })] }),
    ]);
    expect(one.provider).toBe("Claude");
    const two = deckLimit([
      snap({ label: "Claude", windows: [win({ state: "exhausted", resetsAt: 5 })] }),
      snap({ label: "Gemini", windows: [win({ state: "exhausted", resetsAt: 7 })] }),
    ]);
    expect(two.provider).toBe(null);
  });
});

describe("colour, and the one that is missing", () => {
  it("gives a hue to spent and nearly-spent, and none at all to healthy", () => {
    expect(stateClass("exhausted")).toBe("lim-out");
    expect(stateClass("near")).toBe("lim-near");
    for (const s of ["ok", "unknown"] as LimitState[]) expect(stateClass(s)).toBe("lim-fine");
  });

  /** The clause with teeth: green already means "working" on every rail in the
   *  window, so a healthy meter must not borrow it. */
  it("has no class that could carry the working green", () => {
    const classes = (["ok", "near", "exhausted", "unknown"] as LimitState[]).map(stateClass);
    expect(new Set(classes).size).toBe(3);
    expect(classes.some((c) => /work|green|good|fine-ok/.test(c) && c !== "lim-fine")).toBe(false);
  });
});

describe("saying where a number came from", () => {
  it("has a word for every tier, and they are all different", () => {
    const tiers: UsageSource[] = ["reported", "observed", "estimated", "unknown"];
    const labels = tiers.map(sourceLabel);
    expect(labels).toEqual(["Reported", "Observed", "Estimated", "Unknown"]);
    expect(new Set(labels).size).toBe(4);
  });

  it("explains unknown as an absence rather than as a zero", () => {
    expect(sourceExplanation("unknown")).toContain("not the same as nothing being spent");
  });

  it("says of the observed tier that it is this app's own sessions", () => {
    expect(sourceExplanation("observed")).toContain("sessions it runs");
  });
});

describe("the reading beside a meter", () => {
  it("prefers a share, and says so as a percentage", () => {
    expect(readingOf(win({ usedFraction: 0.234 }))).toBe("23% used");
  });

  it("falls back to an absolute with no ceiling, which is the observed case", () => {
    expect(readingOf(win({ amount: { used: 1_250_000, limit: null, unit: "tokens" } })))
      .toBe("1.2M tokens");
  });

  it("says of a ceiling when there is one", () => {
    expect(readingOf(win({ amount: { used: 500, limit: 2_000, unit: "requests" } })))
      .toBe("500 of 2k requests");
  });

  it("says there is no reading rather than inventing one", () => {
    expect(readingOf(win())).toBe("no reading");
  });
});

describe("how much of the meter to fill", () => {
  it("fills to the share", () => expect(meterFraction(win({ usedFraction: 0.4 }))).toBe(0.4));

  /** The rule that keeps this app from inventing a denominator. */
  it("draws no meter at all for an absolute with no ceiling", () => {
    expect(meterFraction(win({ amount: { used: 9_000, limit: null, unit: "tokens" } }))).toBe(null);
    expect(meterFraction(win())).toBe(null);
  });

  it("fills a spent window whether or not a number came with it", () => {
    expect(meterFraction(win({ state: "exhausted" }))).toBe(1);
  });

  it("clamps a share the provider overshot", () => {
    expect(meterFraction(win({ usedFraction: 1.4 }))).toBe(1);
    expect(meterFraction(win({ usedFraction: -0.2 }))).toBe(0);
  });
});

describe("tokens, at the precision anybody reads them at", () => {
  it("never rounds up to a figure that has not been reached", () => {
    expect(formatTokens(999_999)).toBe("999k");
    expect(formatTokens(1_099_999)).toBe("1.0M");
  });

  it("leaves small numbers alone", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
  });
});

describe("a reset time", () => {
  const now = new Date("2026-08-27T13:30:00").getTime();

  it("is a bare clock when it is today", () => {
    const at = new Date("2026-08-27T19:00:00").getTime();
    expect(formatReset(at, now)).not.toContain("Aug");
    expect(formatReset(at, now)).toMatch(/19|7/);
  });

  /** "19:00" on a Wednesday five days away reads as tonight, which is the
   *  failure this exists to prevent. */
  it("carries the day once it is not today", () => {
    expect(formatReset(new Date("2026-08-28T09:00:00").getTime(), now)).toContain("tomorrow");
    expect(formatReset(new Date("2026-09-01T08:00:00").getTime(), now)).toMatch(/Sep|1/);
  });
});

describe("telling somebody who is not looking at the window", () => {
  it("fires once on the way in, however many times the state is re-emitted", () => {
    const n = new LimitNotifier();
    const out = { exhausted: true, resetsAt: 1_000, provider: "Claude" };
    expect(n.next(out)).not.toBe(null);
    expect(n.next(out)).toBe(null);
    expect(n.next(out)).toBe(null);
  });

  /** The one nothing else can tell you. */
  it("fires on the reset, and says you can work again", () => {
    const n = new LimitNotifier();
    n.next({ exhausted: true, resetsAt: 1_000, provider: "Claude" });
    const back = n.next({ exhausted: false, resetsAt: null, provider: null });
    expect(back!.title).toContain("work again");
  });

  /** A notification about something the person never saw happen is a
   *  notification about nothing. */
  it("does not announce a reset it never saw an exhaustion for", () => {
    const n = new LimitNotifier();
    const fine = { exhausted: false, resetsAt: null, provider: null };
    expect(n.next(fine)).toBe(null);
    expect(n.next(fine)).toBe(null);
  });

  it("carries the reset time when there is one and says plainly when there is not", () => {
    const at = new Date("2026-08-27T19:00:00").getTime();
    const now = new Date("2026-08-27T13:30:00").getTime();
    const withTime = new LimitNotifier().next({ exhausted: true, resetsAt: at, provider: "Claude" }, now);
    expect(withTime!.body).toContain("Claude");
    expect(withTime!.body).toContain("nothing will move until");
    const without = new LimitNotifier().next({ exhausted: true, resetsAt: null, provider: null }, now);
    expect(without!.body).toContain("no reset time is known");
  });
});

/** The line under a reading. Shared by the limits block and the status-area
 *  menu, which is why it is a rule in this file rather than a branch in either
 *  of them — see ADR-0011. */
describe("what a row says under its reading", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  const at = Date.parse("2026-08-27T19:00:00Z");

  it("says nothing moves, and until when", () => {
    expect(limitFoot(win({ state: "exhausted", resetsAt: at }), null, now))
      .toBe(`nothing moves until ${formatReset(at, now)}`);
  });

  /** A window known to be spent whose reset the provider did not say. Not the
   *  same as an unknown window, and it must not read like one. */
  it("says a spent window has no known reset rather than implying one", () => {
    expect(limitFoot(win({ state: "exhausted" }), null, now))
      .toBe("nothing moves — no reset time known");
  });

  it("carries a reset time on a window that is not spent", () => {
    expect(limitFoot(win({ state: "ok", usedFraction: 0.2, resetsAt: at }), null, now))
      .toBe(`resets ${formatReset(at, now)}`);
  });

  /** An error is what an unreadable row has to add. "Not known" would repeat
   *  the reading beside it, and two ways of saying nothing read as two facts. */
  it("falls back to the error, and to nothing at all without one", () => {
    expect(limitFoot(win(), "claude is not on the PATH", now)).toBe("claude is not on the PATH");
    expect(limitFoot(win(), null, now)).toBeNull();
  });

  /** A reset time outranks an error: the number is readable, so the caveat
   *  about reading it is not the useful half. */
  it("prefers a reset time to an error when it has both", () => {
    expect(limitFoot(win({ usedFraction: 0.5, resetsAt: at }), "stale", now))
      .toBe(`resets ${formatReset(at, now)}`);
  });
});
