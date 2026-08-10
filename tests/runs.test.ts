import { describe, it, expect } from "vitest";
import type { RunRecord, RunStatus } from "../src/ipc";
import {
  agoLabel, chainRuns, durationLabel, emptyHistoryCopy, filterRuns, noResultReason,
  RUN_STATUS_LABEL, RUN_TRIGGER_LABEL, runStatusClass,
} from "../src/runs";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = new Date(2026, 7, 9, 12, 0).getTime();

function rec(o: Partial<RunRecord> & Pick<RunRecord, "runId">): RunRecord {
  return {
    startedAt: NOW - HOUR, closedAt: null, trigger: "manual", status: "ended",
    skillId: "s1", name: "Nightly review", icon: "shield", workspaceId: "w1",
    cwd: "/p", branch: "main", sessionId: "sess", params: {}, prompt: "go",
    continuesRunId: null, transcriptPath: "/t/a.jsonl", cleared: false,
    result: "done", reason: null, tokens: null, resultSource: "transcript",
    ...o,
  };
}

describe("agoLabel", () => {
  it("counts in the unit a person would use", () => {
    expect(agoLabel(NOW - 20_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - MIN, NOW)).toBe("1 minute ago");
    expect(agoLabel(NOW - 12 * MIN, NOW)).toBe("12 minutes ago");
    expect(agoLabel(NOW - 2 * HOUR, NOW)).toBe("2 hours ago");
    expect(agoLabel(NOW - 3 * DAY, NOW)).toBe("3 days ago");
  });

  // Past a week "37 days ago" is arithmetic nobody asked for.
  it("gives up and prints the date past a week", () => {
    expect(agoLabel(NOW - 30 * DAY, NOW)).toBe(new Date(NOW - 30 * DAY).toLocaleDateString());
  });

  // Clocks do move backwards — a DST change, an NTP correction — and a journal
  // entry claiming to be from the future is a distraction, not information.
  it("does not report a record from the future", () => {
    expect(agoLabel(NOW + 3 * MIN, NOW)).toBe("just now");
  });
});

describe("durationLabel", () => {
  it("says nothing at all while a run is still going", () => {
    expect(durationLabel(rec({ runId: "r", closedAt: null }))).toBeNull();
  });
  it("scales the unit with the length", () => {
    expect(durationLabel(rec({ runId: "r", startedAt: 0, closedAt: 42_000 }))).toBe("42s");
    expect(durationLabel(rec({ runId: "r", startedAt: 0, closedAt: 12 * MIN }))).toBe("12m");
    expect(durationLabel(rec({ runId: "r", startedAt: 0, closedAt: 2 * HOUR + 5 * MIN }))).toBe("2h 5m");
  });
});

describe("the five states", () => {
  // Four hues carry five states, because the palette spends hue on state and
  // nothing else. `failed-to-launch` shares the error hue and is told apart by
  // a dashed border and by its own words — states differ by shape, not by
  // colour alone. What must never happen is two states sharing a *class*: the
  // hue would then be the only channel and there would be nothing left to
  // differ by.
  it("gives every status a class of its own", () => {
    const statuses: RunStatus[] = ["running", "ended", "error", "interrupted", "failed-to-launch"];
    const classes = statuses.map(runStatusClass);
    expect(new Set(classes).size).toBe(statuses.length);
    for (const c of classes) expect(c.startsWith("run-state ")).toBe(true);
  });

  it("names each one in words, since the hue cannot carry all five", () => {
    expect(Object.values(RUN_STATUS_LABEL)).toHaveLength(5);
    expect(new Set(Object.values(RUN_STATUS_LABEL)).size).toBe(5);
    // The one status where nothing ran at all reads as what happened, not as
    // what the field is called.
    expect(RUN_STATUS_LABEL["failed-to-launch"]).toBe("did not launch");
  });

  it("tells a scheduled run from a hand-pressed one", () => {
    expect(RUN_TRIGGER_LABEL.schedule).toBe("scheduled");
    expect(RUN_TRIGGER_LABEL.manual).toBe("manual");
    expect(new Set(Object.values(RUN_TRIGGER_LABEL)).size).toBe(4);
  });
});

describe("chainRuns", () => {
  // A restart is not an unrelated second run, and a flat list makes it look
  // like one: three rows for one piece of work, in reverse order, with nothing
  // saying they belong together.
  it("folds a chain into one entry, newest first", () => {
    const chains = chainRuns([
      rec({ runId: "third", startedAt: 30, continuesRunId: "second", trigger: "resume" }),
      rec({ runId: "second", startedAt: 20, continuesRunId: "first", trigger: "resume" }),
      rec({ runId: "first", startedAt: 10 }),
      rec({ runId: "alone", startedAt: 5 }),
    ]);
    expect(chains).toHaveLength(2);
    expect(chains[0].runs.map((r) => r.runId)).toEqual(["third", "second", "first"]);
    expect(chains[1].runs.map((r) => r.runId)).toEqual(["alone"]);
  });

  // A chain is what is on hand, never a promise about what is missing:
  // retention prunes the oldest runs, and a filter can remove any of them.
  it("keeps a chain whose predecessor has been pruned away", () => {
    const chains = chainRuns([rec({ runId: "survivor", continuesRunId: "long-gone" })]);
    expect(chains).toHaveLength(1);
    expect(chains[0].runs.map((r) => r.runId)).toEqual(["survivor"]);
  });

  // The list arrives newest first, but a filter can hand over a chain met from
  // its middle — and it still has to be ordered and placed by its newest
  // surviving member rather than by whichever one came first.
  it("orders a chain met out of order", () => {
    const chains = chainRuns([
      rec({ runId: "old", startedAt: 10 }),
      rec({ runId: "new", startedAt: 20, continuesRunId: "old" }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0].runs.map((r) => r.runId)).toEqual(["new", "old"]);
  });

  // `continuesRunId` comes off disk. A hand-edited or truncated journal can
  // describe a cycle, and a history that hangs the window is worse than one
  // that shows a short chain.
  it("does not hang on a cycle", () => {
    const chains = chainRuns([
      rec({ runId: "a", continuesRunId: "b" }),
      rec({ runId: "b", continuesRunId: "a" }),
    ]);
    expect(chains.flatMap((c) => c.runs)).toHaveLength(2);
  });
});

describe("filterRuns", () => {
  const rows = [
    rec({ runId: "a", skillId: "s1", trigger: "manual" }),
    rec({ runId: "b", skillId: "s2", trigger: "schedule" }),
    rec({ runId: "c", skillId: "s1", trigger: "schedule" }),
  ];
  const ids = (f: Parameters<typeof filterRuns>[1]) => filterRuns(rows, f).map((r) => r.runId);

  it("narrows by scenario, by trigger, and by both", () => {
    expect(ids({ skillId: null, trigger: null })).toEqual(["a", "b", "c"]);
    expect(ids({ skillId: "s1", trigger: null })).toEqual(["a", "c"]);
    expect(ids({ skillId: null, trigger: "schedule" })).toEqual(["b", "c"]);
    expect(ids({ skillId: "s1", trigger: "schedule" })).toEqual(["c"]);
  });
});

describe("emptyHistoryCopy", () => {
  // Three emptinesses wearing one face, and the next thing to do differs for
  // each. Recording being off is the one that has to be said whatever else is
  // true: an empty history with the switch silently down is a bug report
  // waiting to happen.
  it("says so when recording is off, before anything else", () => {
    const copy = emptyHistoryCopy({
      recording: false, anyRuns: true, workspaceRuns: 3, filtered: true, workspaceName: "relay",
    });
    expect(copy.title).toContain("not being recorded");
    // And says the switch is not an erase button, because that is the fear.
    expect(copy.body).toContain("erases nothing");
  });

  it("tells a new journal from an empty workspace", () => {
    const fresh = emptyHistoryCopy({
      recording: true, anyRuns: false, workspaceRuns: 0, filtered: false, workspaceName: "relay",
    });
    expect(fresh.title).toBe("No scenario runs yet");

    const elsewhere = emptyHistoryCopy({
      recording: true, anyRuns: true, workspaceRuns: 0, filtered: false, workspaceName: "relay",
    });
    expect(elsewhere.title).toBe("No scenario runs in relay");
    expect(elsewhere.body).toContain("Other workspaces");
  });

  it("blames the filters when the filters are what emptied it", () => {
    const copy = emptyHistoryCopy({
      recording: true, anyRuns: true, workspaceRuns: 3, filtered: true, workspaceName: "relay",
    });
    expect(copy.title).toContain("Nothing matches these filters");
  });

  // A filter left on from another workspace must not make an empty workspace
  // read as one whose filters hid something: "none of them match" where there
  // is nothing to match sends the reader to clear a filter doing no work.
  it("does not blame a filter that is hiding nothing", () => {
    const copy = emptyHistoryCopy({
      recording: true, anyRuns: true, workspaceRuns: 0, filtered: true, workspaceName: "atlas",
    });
    expect(copy.title).toBe("No scenario runs in atlas");
  });
});

describe("noResultReason", () => {
  // `result: null` reads as an explicit sentence, never as an empty result: the
  // run happening and the run producing nothing are different facts.
  it("says why there is nothing to read, per case", () => {
    expect(noResultReason(rec({ runId: "r", status: "running" }))).toBe("Still running.");
    // Through `OUTCOME_TEXT`, the same words the line under the scenario's name
    // uses: one record phrased two ways in two places is the disagreement the
    // dot exists to rule out.
    expect(noResultReason(rec({ runId: "r", status: "failed-to-launch", reason: "no-workspace" })))
      .toBe("No session was started — no workspace.");
    expect(noResultReason(rec({ runId: "r", status: "failed-to-launch", reason: "skipped-overlap" })))
      .toBe("No session was started — previous run still active.");
    // A code the frontend has never heard of still shows: a code beats a blank.
    expect(noResultReason(rec({ runId: "r", status: "failed-to-launch", reason: "who-knows" })))
      .toBe("No session was started — who-knows.");
    expect(noResultReason(rec({ runId: "r", status: "failed-to-launch", reason: null })))
      .toBe("No session was started.");
    expect(noResultReason(rec({ runId: "r", status: "ended", transcriptPath: null })))
      .toContain("No transcript was reported");
    // The path was known once and the file is not there any more. Claude Code
    // owns those files' lifetime, so this is ordinary rather than a fault.
    expect(noResultReason(rec({ runId: "r", status: "ended", resultSource: "none" })))
      .toContain("transcript is gone");
  });
});
