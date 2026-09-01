import { describe, it, expect } from "vitest";
import {
  describeSchedule, nextRun, nextRunLabel, validateSchedule, shouldSkipOverlap, schedulePreview,
  resolveScheduledWorkspace,
} from "../src/schedule";
import type { Workspace } from "../src/ipc";

describe("describeSchedule", () => {
  it("formats each preset", () => {
    expect(describeSchedule({ preset: { kind: "hourly", minute: 5 }, defaults: {}, enabled: true }))
      .toBe("hourly at :05");
    expect(describeSchedule({ preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true }))
      .toBe("daily at 09:00");
    expect(describeSchedule({ preset: { kind: "weekly", weekday: 1, hour: 8, minute: 30 }, defaults: {}, enabled: true }))
      .toBe("weekly on Mon at 08:30");
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
    expect(nextRunLabel({ kind: "daily", hour: 9, minute: 0 }, now)).toBe("today 09:00");
    expect(nextRunLabel({ kind: "daily", hour: 7, minute: 0 }, now)).toBe("tomorrow 07:00");
  });
  it("falls back to the weekday name further out", () => {
    const now = new Date(2026, 6, 24, 12, 0, 0); // Friday
    expect(nextRunLabel({ kind: "weekly", weekday: 1, hour: 8, minute: 0 }, now)).toBe("Mon 08:00");
  });
});

describe("validateSchedule", () => {
  it("passes when disabled regardless of defaults", () => {
    expect(validateSchedule(false, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {}, "w1").ok).toBe(true);
  });
  it("fails when an enabled schedule has a placeholder without a default", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", {}, "w1");
    expect(r.ok).toBe(false);
  });
  it("fails when a default is only whitespace", () => {
    expect(validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", { name: "   " }, "w1").ok)
      .toBe(false);
  });
  it("passes when all placeholders have non-empty defaults", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi {{name}}", { name: "Bob" }, "w1");
    expect(r.ok).toBe(true);
  });
  it("fails on out-of-range time", () => {
    expect(validateSchedule(true, { kind: "daily", hour: 25, minute: 0 }, "hi", {}, "w1").ok).toBe(false);
    expect(validateSchedule(true, { kind: "hourly", minute: 60 }, "hi", {}, "w1").ok).toBe(false);
  });
  it("fails on a NaN time (empty number input)", () => {
    expect(validateSchedule(true, { kind: "daily", hour: NaN, minute: 0 }, "hi", {}, "w1").ok).toBe(false);
  });
  it("fails on an out-of-range weekday", () => {
    expect(validateSchedule(true, { kind: "weekly", weekday: 7, hour: 8, minute: 0 }, "hi", {}, "w1").ok).toBe(false);
  });

  // The refusal #249 asks for: an unattended run needs to know which repository
  // it works in before it is saved, not when it fires.
  it("refuses an enabled schedule with no workspace to run in", () => {
    const r = validateSchedule(true, { kind: "daily", hour: 9, minute: 0 }, "hi", {}, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("one workspace");
  });

  // Unscheduled scenarios are still offered in every workspace: the requirement
  // belongs to running unattended, not to having a saved prompt.
  it("passes an unscheduled scenario with no workspace", () => {
    expect(validateSchedule(false, { kind: "daily", hour: 9, minute: 0 }, "hi", {}, null).ok).toBe(true);
  });
});

describe("schedulePreview", () => {
  const now = new Date(2026, 6, 24, 10, 0); // Fri 2026-07-24 10:00

  // The whole point: the form said nothing about what the four controls added
  // up to, so people saved a rule and only found out what it meant later.
  it("spells out the rule and when it will next run", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, "frontend");
    expect(text).toContain("daily at 09:00");
    expect(text).toContain("next run tomorrow 09:00");
  });

  // Where a run lands is the one thing a schedule form has to answer, and since
  // #249 there is an answer to give: the workspace it is pinned to.
  it("names the workspace the scenario will run in", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, "frontend");
    expect(text).toContain("in workspace “frontend”");
  });

  // What replaced "in whichever workspace is active at the time": with no
  // workspace at all the sentence asks for one instead of describing a coin flip.
  it("says a workspace is needed rather than naming the active one", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, null);
    expect(text).toContain("needs a workspace");
    expect(text).not.toContain("active at the time");
  });

  it("reads naturally for the hourly preset, where only minutes matter", () => {
    const text = schedulePreview({ kind: "hourly", minute: 30 }, now, "frontend");
    expect(text).toContain("hourly at :30");
    expect(text).toContain("next run today 10:30");
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

  // An interactive `claude` never exits after finishing its task — it returns
  // to the prompt, which is `done`. Treating that as an active run is what
  // made a daily schedule fire once and then go silent until the tile was
  // closed by hand.
  it("does not skip when the previous run finished its task", () => {
    expect(shouldSkipOverlap("done")).toBe(false);
  });
});

describe("resolveScheduledWorkspace", () => {
  const wsA: Workspace = { id: "a", name: "A", path: "/a", color: "#61afef" };
  const wsB: Workspace = { id: "b", name: "B", path: "/b", color: "#98c379" };

  it("resolves the id the fire carries", () => {
    expect(resolveScheduledWorkspace("b", [wsA, wsB])).toEqual({ ok: true, workspace: wsB });
  });

  // The deleted fallback (#249). With no id there is nothing to run in — the
  // active workspace is not a substitute, because "whichever workspace happened
  // to be selected" is how a nightly job landed in the wrong repository.
  it("refuses when the fire carries no workspace", () => {
    expect(resolveScheduledWorkspace(null, [wsA, wsB])).toEqual({ ok: false, reason: "no-workspace" });
  });

  it("refuses when the workspace was deleted", () => {
    expect(resolveScheduledWorkspace("gone", [wsA, wsB])).toEqual({ ok: false, reason: "no-workspace" });
  });
});
