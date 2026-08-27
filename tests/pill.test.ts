import { describe, it, expect } from "vitest";
import { pillLabel, pillWanted } from "../src/pill-util";

describe("pillLabel", () => {
  it("reads naturally for 1", () => expect(pillLabel(1)).toBe("1 waiting for input"));
  it("reads naturally for 2", () => expect(pillLabel(2)).toBe("2 waiting for input"));
  it("reads naturally for 5", () => expect(pillLabel(5)).toBe("5 waiting for input"));

  /** The unchanged case, stated explicitly: a limit that is not reached says
   *  nothing, and the count is still the whole story. */
  it("says nothing about a limit that has not been reached", () => {
    expect(pillLabel(3, { exhausted: false, resetsAt: null })).toBe("3 waiting for input");
  });
});

describe("pillLabel when the budget is spent", () => {
  const now = new Date("2026-08-27T13:30:00").getTime();

  it("carries the reset time when one is known", () => {
    const at = new Date("2026-08-27T19:00:00").getTime();
    const label = pillLabel(0, { exhausted: true, resetsAt: at }, now);
    expect(label).toContain("limit · resets");
    expect(label).toMatch(/19|7/);
  });

  it("says plainly that there is no reset time rather than implying one", () => {
    expect(pillLabel(0, { exhausted: true, resetsAt: null }, now))
      .toBe("limit · no reset time known");
  });

  /** The decision this whole file exists to hold. "3 waiting for input" is true
   *  and is the wrong thing to say: nothing is waiting for input, nothing is
   *  waiting for anything, and the sentence sends somebody back to the app to
   *  find three terminals that will not accept a keystroke's worth of progress. */
  it("outranks a non-zero waiting count", () => {
    const at = new Date("2026-08-27T19:00:00").getTime();
    const label = pillLabel(3, { exhausted: true, resetsAt: at }, now);
    expect(label).not.toContain("waiting");
    expect(label).toContain("limit");
  });

  it("carries the day when the reset is not today, because a bare clock reads as tonight", () => {
    const at = new Date("2026-09-01T08:00:00").getTime();
    expect(pillLabel(0, { exhausted: true, resetsAt: at }, now)).toMatch(/Tue|Mon|Sep|\d/);
    expect(pillLabel(0, { exhausted: true, resetsAt: at }, now)).toContain("limit · resets");
  });
});

describe("whether the pill is up at all", () => {
  it("is up while a session waits, as it always was", () => {
    expect(pillWanted(1, null)).toBe(true);
    expect(pillWanted(0, null)).toBe(false);
  });

  /** The point of #305: stepping away from an exhausted deck used to show
   *  nothing, because nothing was waiting for input. */
  it("is up for a spent budget with nothing waiting at all", () => {
    expect(pillWanted(0, { exhausted: true, resetsAt: null })).toBe(true);
  });

  it("is down when neither is true", () => {
    expect(pillWanted(0, { exhausted: false, resetsAt: 5 })).toBe(false);
  });
});
