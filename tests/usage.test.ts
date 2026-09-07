import { describe, it, expect } from "vitest";
import type { AiUsage, LimitWindow, UsageSource } from "../src/ipc";
import {
  alarmOf,
  alarmPhrase,
  BRANDS,
  deckLimit,
  dialAlert,
  dialLineup,
  glanceWindow,
  formatReset,
  limitFoot,
  LimitNotifier,
  meterFraction,
  NEAR_FROM,
  OUT_FROM,
  primaryWindow,
  readingOf,
  sourceBadge,
  sourceExplanation,
  sourceLabel,
  zoneClass,
  zoneOf,
  rankedAis,
  tierNote,
  usageGlance,
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

/** The one ordering both surfaces take. The strip names the first of these and
 *  the rows are drawn in this order, which is what makes "the strip cannot name an
 *  AI that is not at the top of the list it opens" a fact rather than a hope. */
describe("the order every connected AI is ranked in", () => {
  it("has nothing to rank when nothing is connected", () => {
    expect(rankedAis([])).toEqual([]);
  });

  it("puts a refusal first, then nearly spent, then a reading, then no reading", () => {
    const order = rankedAis([
      snap({ provider: "unreadable", windows: [win({ state: "unknown" })] }),
      snap({ provider: "healthy", windows: [win({ usedFraction: 0.3, state: "ok" })] }),
      snap({ provider: "spent", windows: [win({ state: "exhausted" })] }),
      snap({ provider: "nowindows", windows: [] }),
      snap({ provider: "near", windows: [win({ usedFraction: 0.9, state: "near" })] }),
    ]).map((r) => r.snap.provider);
    expect(order).toEqual(["spent", "near", "healthy", "unreadable", "nowindows"]);
  });

  it("pairs each AI with the window its own row draws", () => {
    const [first] = rankedAis([
      snap({ windows: [win({ id: "week", usedFraction: 0.1, state: "ok" }), win({ id: "day", state: "exhausted" })] }),
    ]);
    expect(first.window!.id).toBe("day");
  });

  /** The strip is the head of this list, and nothing may come between them. */
  it("agrees with the AI the strip names, whatever order they arrived in", () => {
    const snaps = [
      snap({ provider: "a", windows: [win({ usedFraction: 0.2, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.5, state: "ok" })] }),
      snap({ provider: "c", windows: [win({ state: "exhausted" })] }),
    ];
    expect(rankedAis(snaps)[0].snap.provider).toBe(usageGlance(snaps)!.snap.provider);
  });
});

describe("what the one line at the foot of the panel names", () => {
  it("has nothing to say about no AI at all", () => {
    expect(usageGlance([])).toBe(null);
  });

  /** The same ordering the rows use, one level up: the strip must name the AI at
   *  the top of the list it opens, or the two surfaces disagree about "worst". */
  it("names the AI that is refusing work, whatever order they arrived in", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [win({ usedFraction: 0.99, state: "near" })] }),
      snap({ provider: "b", windows: [win({ state: "exhausted" })] }),
    ])!;
    expect(g.snap.provider).toBe("b");
    expect(g.window!.state).toBe("exhausted");
  });

  it("prefers a nearly-spent AI to a merely full one", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [win({ usedFraction: 0.5, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.8, state: "near" })] }),
    ])!;
    expect(g.snap.provider).toBe("b");
  });

  it("names the fullest of a healthy set, because that is the one to watch", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.6, state: "ok" })] }),
      snap({ provider: "c", windows: [win({ usedFraction: 0.3, state: "ok" })] }),
    ])!;
    expect(g.snap.provider).toBe("b");
    expect(g.others).toBe(2);
  });

  /** An AI nobody can read is not the worst news, it is no news — and a strip
   *  that named it would be hiding a real reading behind an absence. */
  it("puts an AI with no reading behind every AI that has one", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [win({ state: "unknown" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.2, state: "ok" })] }),
    ])!;
    expect(g.snap.provider).toBe("b");
  });

  it("puts an AI with no windows at all behind one that at least says it cannot tell", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [] }),
      snap({ provider: "b", windows: [win({ state: "unknown" })] }),
    ])!;
    expect(g.snap.provider).toBe("b");
    expect(g.others).toBe(1);
  });

  /** The two counts the line has room for, and they are the two that change what
   *  a person does next. */
  it("counts how many of the others are near their limit and how many are spent", () => {
    const g = usageGlance([
      snap({ provider: "a", windows: [win({ state: "exhausted" })] }),
      snap({ provider: "b", windows: [win({ state: "exhausted" })] }),
      snap({ provider: "c", windows: [win({ usedFraction: 0.95, state: "near" })] }),
      snap({ provider: "d", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
    ])!;
    expect(g.others).toBe(3);
    expect(g.othersSpent).toBe(1);
    expect(g.othersNear).toBe(1);
  });

  it("counts nothing beside a single connected AI", () => {
    const g = usageGlance([snap({ windows: [win({ usedFraction: 0.4, state: "ok" })] })])!;
    expect(g.others).toBe(0);
    expect(g.othersNear).toBe(0);
    expect(g.othersSpent).toBe(0);
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

describe("the three bands", () => {
  /** The arithmetic, at both edges of both bands. Stated as inequalities against
   *  the exported thresholds rather than as literals, so a threshold that moves
   *  moves the test with it and a threshold that moves in only one of the two
   *  places does not. */
  it("is green below three quarters, amber to nine tenths, red past it", () => {
    expect(zoneOf(win({ usedFraction: 0, state: "ok" }))).toBe("fine");
    expect(zoneOf(win({ usedFraction: NEAR_FROM - 0.01, state: "ok" }))).toBe("fine");
    expect(zoneOf(win({ usedFraction: NEAR_FROM, state: "ok" }))).toBe("near");
    expect(zoneOf(win({ usedFraction: OUT_FROM - 0.01, state: "ok" }))).toBe("near");
    expect(zoneOf(win({ usedFraction: OUT_FROM, state: "ok" }))).toBe("out");
    expect(zoneOf(win({ usedFraction: 1, state: "ok" }))).toBe("out");
  });

  /** A refusal is the end of the road whether or not anybody divided it by a
   *  ceiling — the same case `meterFraction` fills a bar for without a number. */
  it("paints a refusal red with no share at all", () => {
    expect(zoneOf(win({ state: "exhausted" }))).toBe("out");
    expect(zoneOf(win({ usedFraction: 0.1, state: "exhausted" }))).toBe("out");
  });

  /** The bands add urgency the provider did not declare; they never take away
   *  urgency it did. A limit counted in requests, a ceiling that moved — it knows
   *  things this app does not. */
  it("never overrules a provider downward", () => {
    expect(zoneOf(win({ usedFraction: 0.2, state: "near" }))).toBe("near");
    expect(zoneOf(win({ state: "near" }))).toBe("near");
  });

  /** No share and nothing wrong: an absolute with no ceiling, or a reading
   *  nobody has. A hue there would be this app inventing the denominator it has
   *  just said it does not have. */
  it("gives no band at all where there is nothing to divide", () => {
    expect(zoneOf(win({ state: "ok" }))).toBeNull();
    expect(zoneOf(win({ amount: { used: 412_000, limit: null, unit: "tokens" }, state: "ok" }))).toBeNull();
    expect(zoneClass(null)).toBe("");
  });

  it("has one class per band and they are all different", () => {
    const classes = (["fine", "near", "out"] as const).map(zoneClass);
    expect(classes).toEqual(["lim-fine", "lim-near", "lim-out"]);
    expect(new Set(classes).size).toBe(3);
  });
});

describe("an alarm about windows a surface is not drawing", () => {
  it("takes the worst band and says whether anything has actually stopped", () => {
    expect(alarmOf([win({ usedFraction: 0.1, state: "ok" })])).toBeNull();
    expect(alarmOf([])).toBeNull();
    expect(alarmOf([win({ usedFraction: 0.8, state: "ok" })])).toEqual({ zone: "near", spent: false });
    expect(alarmOf([
      win({ usedFraction: 0.8, state: "ok" }),
      win({ id: "week", usedFraction: 0.95, state: "ok" }),
    ])).toEqual({ zone: "out", spent: false });
    expect(alarmOf([win({ state: "exhausted" })])).toEqual({ zone: "out", spent: true });
  });

  /** The distinction the two fields exist for: red is red either way, and the
   *  WORDS must not claim work has stopped where it has not. */
  it("says spent only where something is refusing work", () => {
    expect(alarmPhrase({ zone: "out", spent: true })).toBe("spent");
    expect(alarmPhrase({ zone: "out", spent: false })).toBe("over 90% spent");
    expect(alarmPhrase({ zone: "near", spent: false })).toBe("over 75% spent");
  });

  /** The phrase quotes the thresholds rather than restating them, so the
   *  sentence and the hue cannot come to disagree about where amber starts. */
  it("quotes the thresholds it was painted with", () => {
    expect(alarmPhrase({ zone: "near", spent: false })).toContain(String(NEAR_FROM * 100));
    expect(alarmPhrase({ zone: "out", spent: false })).toContain(String(OUT_FROM * 100));
  });
});

describe("saying where a number came from", () => {
  it("has a word for every tier, and they are all different", () => {
    const tiers: UsageSource[] = ["reported", "observed", "estimated", "unknown"];
    const labels = tiers.map(sourceLabel);
    expect(labels).toEqual(["Reported", "Observed", "Estimated", "Unknown"]);
    expect(new Set(labels).size).toBe(4);
  });

  /** What the DIALOG prints, which is the two names worth teaching and not the
   *  third — ADR-0009's second amendment. `sourceLabel` still knows every name;
   *  what changed is which of them reaches a surface. */
  it("prints no tier at all over the account's own figure", () => {
    expect(sourceBadge("reported")).toBeNull();
    expect(sourceBadge("observed")).toBe("Observed");
    expect(sourceBadge("estimated")).toBe("Estimated");
    expect(sourceBadge("unknown")).toBe("Unknown");
  });

  /** What a ROW says, which is no longer the tier's name — see ADR-0009's
   *  amendment. The dialog uses `sourceBadge` above; this is the row. */
  it("says nothing beside the account's own figure", () => {
    expect(tierNote(win({ usedFraction: 0.23, source: "reported" }))).toBeNull();
  });

  /** The failure ADR-0009 exists to prevent runs one way: this app's own
   *  narrower count being read as the account's. Labelling that direction is
   *  what keeps the protection while the strong tier goes quiet. */
  it("says what a weaker number is, in words a person can act on", () => {
    expect(tierNote(win({ usedFraction: 0.5, source: "observed" }))).toBe("this app only");
    expect(tierNote(win({ usedFraction: 0.5, source: "estimated" }))).toBe("estimate");
  });

  /** `readingOf` has already said "no reading", and two ways of saying nothing
   *  read as two facts — the rule `limitFoot` keeps about an absent reset. */
  it("adds nothing to a window that has no reading at all", () => {
    expect(tierNote(win({ source: "unknown" }))).toBeNull();
  });

  it("does say so if a quantity ever turns up with no known source", () => {
    expect(tierNote(win({ usedFraction: 0.4, source: "unknown" }))).toBe("source not known");
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

// `formatTokens` and its cases moved to `src/format.ts` — see there.

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

describe("the lineup of dials", () => {
  const week = (over: Partial<LimitWindow> = {}) =>
    win({ id: "week", label: "Current week", ...over });

  /** The five hours, not the week: a glance is read while working rather than
   *  while planning, and the five hours is the window that decides whether the
   *  next prompt is answered. The week gets the dot and the second block of the
   *  card instead. */
  it("draws the five-hour window where a provider declares one", () => {
    const u = snap({ windows: [win({ usedFraction: 0.9 }), week({ usedFraction: 0.2 })] });
    expect(glanceWindow(u)?.id).toBe("session");
    // Declared order does not decide it — the id does.
    const backwards = snap({ windows: [week({ usedFraction: 0.2 }), win({ usedFraction: 0.9 })] });
    expect(glanceWindow(backwards)?.id).toBe("session");
  });

  /** No table of provider names in this file: a provider with no window called
   *  "session" gets its FIRST declared one, and both providers in the tree
   *  declare theirs shortest first. */
  it("falls back to the narrowest window a provider declared", () => {
    const gemini = snap({ windows: [win({ id: "rpm" }), win({ id: "rpd" })] });
    expect(glanceWindow(gemini)?.id).toBe("rpm");
    expect(glanceWindow(snap())).toBeNull();
  });

  it("marks the worst window the ring is not already showing", () => {
    const u = snap({ windows: [win({ state: "ok" }), week({ state: "exhausted" })] });
    expect(dialAlert(u, glanceWindow(u))).toEqual({ zone: "out", spent: true });
  });

  /** The bands reach the dot too: a week deep into its own band with a provider
   *  that has not called it anything yet is exactly the case the ring cannot
   *  carry. */
  it("marks a window that only the bands call urgent", () => {
    const u = snap({ windows: [win({ usedFraction: 0.1, state: "ok" }), week({ usedFraction: 0.8, state: "ok" })] });
    expect(dialAlert(u, glanceWindow(u))).toEqual({ zone: "near", spent: false });
  });

  /** Nothing to add where the ring is already the worst of them, and nothing to
   *  add for a healthy window — a mark that appeared for every reading would
   *  stop meaning "act on this". */
  it("marks nothing the ring already says, and nothing that is fine", () => {
    const worst = snap({ windows: [win({ state: "exhausted" }), week({ usedFraction: 0.1, state: "ok" })] });
    expect(dialAlert(worst, glanceWindow(worst))).toBeNull();
    const fine = snap({ windows: [
      win({ usedFraction: 0.1, state: "ok" }),
      week({ usedFraction: 0.1, state: "ok" }),
    ] });
    expect(dialAlert(fine, glanceWindow(fine))).toBeNull();
  });

  it("draws every brand in a fixed order whatever answered", () => {
    expect(dialLineup([]).map((d) => d.provider)).toEqual(BRANDS.map((b) => b.provider));
    expect(dialLineup([snap({ provider: "claude" })]).map((d) => d.provider))
      .toEqual(BRANDS.map((b) => b.provider));
  });

  /** A held brand is a claim about the roadmap and not about the machine, so a
   *  snapshot for one is dropped on the floor: Gemini's provider can answer
   *  nothing without a credential this app will not take, and a permanent row of
   *  unknowns dressed as a live reading is worse than saying it is not ready. */
  it("keeps a held brand held even when the backend reported it", () => {
    const held = dialLineup([snap({ provider: "gemini", windows: [week({ usedFraction: 0.5 })] })])
      .find((d) => d.provider === "gemini")!;
    expect(held.soon).toBe(true);
    expect(held.snap).toBeNull();
    expect(held.ring).toBeNull();
  });

  /** The registry is provider-agnostic on purpose (#308), so a provider added in
   *  Rust must reach the screen without this file learning its name. */
  it("adds anything that answered and is not among the brands", () => {
    const out = dialLineup([snap({ provider: "copilot", label: "Copilot" })]);
    expect(out.map((d) => d.provider)).toEqual([...BRANDS.map((b) => b.provider), "copilot"]);
    expect(out[out.length - 1].soon).toBe(false);
  });

  /** The provider's own words for itself, so a relabelled account is not
   *  overruled by this file's table. */
  it("prefers the label the snapshot came with", () => {
    const out = dialLineup([snap({ provider: "claude", label: "Claude (work)" })]);
    expect(out[0].label).toBe("Claude (work)");
    expect(dialLineup([])[0].label).toBe("Claude");
  });
});
