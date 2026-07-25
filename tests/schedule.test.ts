import { describe, it, expect } from "vitest";
import { describeSchedule, nextRun, nextRunLabel, validateSchedule, shouldSkipOverlap } from "../src/schedule";

describe("describeSchedule", () => {
  it("formats each preset in Russian", () => {
    expect(describeSchedule({ preset: { kind: "hourly", minute: 5 }, defaults: {}, enabled: true }))
      .toBe("каждый час в :05");
    expect(describeSchedule({ preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true }))
      .toBe("ежедневно 09:00");
    expect(describeSchedule({ preset: { kind: "weekly", weekday: 1, hour: 8, minute: 30 }, defaults: {}, enabled: true }))
      .toBe("еженедельно пн 08:30");
  });
});

describe("nextRun", () => {
  it("daily rolls over to tomorrow when time has passed", () => {
    const now = new Date(2026, 6, 24, 10, 0, 0); // Fri 10:00
    const n = nextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(n.getDate()).toBe(25);
    expect(n.getHours()).toBe(9);
  });
  it("daily is today when time is still ahead", () => {
    const now = new Date(2026, 6, 24, 8, 0, 0);
    const n = nextRun({ kind: "daily", hour: 9, minute: 0 }, now);
    expect(n.getDate()).toBe(24);
  });
  it("hourly picks this hour or the next", () => {
    const now = new Date(2026, 6, 24, 10, 15, 0);
    expect(nextRun({ kind: "hourly", minute: 30 }, now).getHours()).toBe(10);
    expect(nextRun({ kind: "hourly", minute: 5 }, now).getHours()).toBe(11);
  });
  it("weekly lands on the requested weekday, strictly ahead", () => {
    const now = new Date(2026, 6, 24, 12, 0, 0); // Friday
    const n = nextRun({ kind: "weekly", weekday: 1, hour: 8, minute: 0 }, now);
    expect(n.getDay()).toBe(1);
    expect(n.getDate()).toBe(27); // next Monday
  });
});

describe("nextRunLabel", () => {
  it("labels today/tomorrow", () => {
    const now = new Date(2026, 6, 24, 8, 0, 0);
    expect(nextRunLabel({ kind: "daily", hour: 9, minute: 0 }, now)).toBe("сегодня 09:00");
    expect(nextRunLabel({ kind: "daily", hour: 7, minute: 0 }, now)).toBe("завтра 07:00");
  });
  it("falls back to the weekday name further out", () => {
    const now = new Date(2026, 6, 24, 12, 0, 0); // Friday
    expect(nextRunLabel({ kind: "weekly", weekday: 1, hour: 8, minute: 0 }, now)).toBe("пн 08:00");
  });
});

describe("validateSchedule", () => {
  it("passes when disabled regardless of defaults", () => {
    expect(validateSchedule(false, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {}).ok).toBe(true);
  });
  it("fails when an enabled schedule has a placeholder without a default", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {});
    expect(r.ok).toBe(false);
  });
  it("fails when a default is only whitespace", () => {
    expect(validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", { name: "   " }).ok)
      .toBe(false);
  });
  it("passes when all placeholders have non-empty defaults", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", { name: "Bob" });
    expect(r.ok).toBe(true);
  });
  it("fails on out-of-range time", () => {
    expect(validateSchedule(true, { kind: "daily", hour: 25, minute: 0 }, "hi", {}).ok).toBe(false);
    expect(validateSchedule(true, { kind: "hourly", minute: 60 }, "hi", {}).ok).toBe(false);
  });
  it("fails on a NaN time (empty number input)", () => {
    expect(validateSchedule(true, { kind: "daily", hour: NaN, minute: 0 }, "hi", {}).ok).toBe(false);
  });
  it("fails on an out-of-range weekday", () => {
    expect(validateSchedule(true, { kind: "weekly", weekday: 7, hour: 8, minute: 0 }, "hi", {}).ok).toBe(false);
  });
});

describe("shouldSkipOverlap", () => {
  it("skips only when previous is still active", () => {
    expect(shouldSkipOverlap("working")).toBe(true);
    expect(shouldSkipOverlap("waitingInput")).toBe(true);
    expect(shouldSkipOverlap("ended")).toBe(false);
    expect(shouldSkipOverlap("error")).toBe(false);
    expect(shouldSkipOverlap("idle")).toBe(false);
    expect(shouldSkipOverlap(null)).toBe(false);
  });
});
