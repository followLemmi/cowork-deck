import { describe, it, expect } from "vitest";
import {
  describeSchedule, nextRun, nextRunLabel, validateSchedule, shouldSkipOverlap, schedulePreview,
  resolveScheduledWorkspace,
} from "../src/schedule";
import type { Skill, Workspace } from "../src/ipc";

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

describe("schedulePreview", () => {
  const now = new Date(2026, 6, 24, 10, 0); // Fri 2026-07-24 10:00

  // The whole point: the form said nothing about what the four controls added
  // up to, so people saved a rule and only found out what it meant later.
  it("spells out the rule and when it will next run", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, null);
    expect(text).toContain("ежедневно 09:00");
    expect(text).toContain("следующий запуск завтра 09:00");
  });

  // Where a run lands is not obvious: an unpinned scenario uses whichever
  // workspace happens to be active when it fires.
  it("names the workspace a pinned scenario will run in", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, "frontend");
    expect(text).toContain("в пространстве «frontend»");
  });

  it("warns that an unpinned scenario follows the active workspace", () => {
    const text = schedulePreview({ kind: "daily", hour: 9, minute: 0 }, now, null);
    expect(text).toContain("в активном пространстве на момент запуска");
  });

  it("reads naturally for the hourly preset, where only minutes matter", () => {
    const text = schedulePreview({ kind: "hourly", minute: 30 }, now, null);
    expect(text).toContain("каждый час в :30");
    expect(text).toContain("следующий запуск сегодня 10:30");
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
  const skill = (workspaceId: string | null): Skill =>
    ({ id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId });

  it("uses the workspace the scenario is pinned to", () => {
    const r = resolveScheduledWorkspace(skill("b"), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: true, workspace: wsB });
  });
  it("falls back to the active workspace when the scenario is not pinned", () => {
    const r = resolveScheduledWorkspace(skill(null), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: true, workspace: wsA });
  });
  it("refuses when the pinned workspace was deleted", () => {
    const r = resolveScheduledWorkspace(skill("gone"), [wsA, wsB], wsA);
    expect(r).toEqual({ ok: false, reason: "no-workspace" });
  });
  it("refuses when not pinned and there is no active workspace", () => {
    const r = resolveScheduledWorkspace(skill(null), [wsA], null);
    expect(r).toEqual({ ok: false, reason: "no-workspace" });
  });
});
