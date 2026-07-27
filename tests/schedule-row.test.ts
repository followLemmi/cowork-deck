import { describe, it, expect } from "vitest";
import { scheduleRowText } from "../src/schedule";
import type { Schedule, ScheduleRun } from "../src/ipc";

const now = new Date(2026, 6, 24, 10, 0); // Fri 2026-07-24 10:00
const daily: Schedule = { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true };
const at = (h: number, m: number, day = 24) => new Date(2026, 6, day, h, m).getTime();

describe("scheduleRowText", () => {
  // Answers "what, where, when" without hovering anything — the tooltip it
  // replaces was invisible to the keyboard and went stale the moment the
  // panel stopped re-rendering.
  it("states the rule and the next run", () => {
    expect(scheduleRowText(daily, null, now)).toBe("daily at 09:00 · next run tomorrow 09:00");
  });

  it("adds the last successful run once there is one", () => {
    const run: ScheduleRun = { lastAttempt: at(9, 0), lastRun: at(9, 0), lastOutcome: "launched" };
    expect(scheduleRowText(daily, run, now))
      .toBe("daily at 09:00 · next run tomorrow 09:00 · last run today 09:00");
  });

  // A skipped or refused run used to leave no trace anywhere but console.info.
  it("reports why the last attempt produced nothing", () => {
    const run: ScheduleRun = { lastAttempt: at(9, 0), lastRun: at(9, 0, 23), lastOutcome: "no-workspace" };
    expect(scheduleRowText(daily, run, now)).toContain("today 09:00 did not run: no workspace");
  });

  it("explains an overlap skip in the same place", () => {
    const run: ScheduleRun = { lastAttempt: at(9, 0), lastRun: null, lastOutcome: "skipped-overlap" };
    expect(scheduleRowText(daily, run, now)).toContain("previous run still active");
  });

  // Pausing keeps the rule so it can be resumed; the row has to say it is off,
  // otherwise a paused schedule is indistinguishable from none at all.
  it("says a paused schedule is off but keeps its rule visible", () => {
    const paused: Schedule = { ...daily, enabled: false };
    expect(scheduleRowText(paused, null, now)).toBe("schedule is off · daily at 09:00");
  });

  it("says so when a schedule has never run", () => {
    expect(scheduleRowText(daily, { lastAttempt: at(9, 0), lastRun: null, lastOutcome: null }, now))
      .toContain("has not run yet");
  });
});

describe("scheduleRowText — backend as the source of truth", () => {
  // Two implementations of the same rule drift apart silently. The row shows
  // what the side that actually fires says, when it says anything.
  it("prefers the backend's next run over the local calculation", () => {
    const run: ScheduleRun = {
      lastAttempt: at(9, 0), lastRun: at(9, 0), lastOutcome: "launched",
      nextRunMs: new Date(2026, 6, 25, 9, 0).getTime(),
    };
    expect(scheduleRowText(daily, run, now)).toContain("next run tomorrow 09:00");
  });

  it("falls back to the local calculation when the backend says nothing", () => {
    expect(scheduleRowText(daily, null, now)).toContain("next run tomorrow 09:00");
  });
});
