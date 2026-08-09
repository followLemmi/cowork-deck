// @vitest-environment jsdom
//
// The scenario row's state dot. It is an indicator and nothing else — this row
// has learned that lesson once already, when one ⏰ was both a status badge and
// a real launch and reaching for information started a session.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRecord, Skill } from "../src/ipc";

vi.mock("../src/ipc", () => ({
  listSkills: vi.fn(),
  saveSkill: vi.fn(),
  removeSkill: vi.fn(),
  loadScheduleState: vi.fn().mockResolvedValue({}),
  listRuns: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn().mockResolvedValue(false) }));
vi.mock("../src/forms", () => ({ skillForm: vi.fn().mockResolvedValue(null) }));

import { SkillsPanel } from "../src/skills";
import { listRuns, listSkills } from "../src/ipc";

const NOW = Date.now();
const SKILL: Skill = { id: "s1", name: "Nightly review", icon: "shield", prompt: "go", workspaceId: null };

function run(o: Partial<RunRecord> & Pick<RunRecord, "runId">): RunRecord {
  return {
    startedAt: NOW - 3_600_000, closedAt: NOW - 3_500_000, trigger: "schedule", status: "ended",
    skillId: "s1", name: "Nightly review", icon: "shield", workspaceId: "w1", cwd: "/p",
    branch: "main", sessionId: "sess", params: {}, prompt: "go", continuesRunId: null,
    transcriptPath: null, cleared: false, result: null, reason: null, tokens: null,
    resultSource: "none",
    ...o,
  };
}

async function panel(runs: RunRecord[], onHistory = vi.fn(), onLaunch = vi.fn()) {
  vi.mocked(listSkills).mockResolvedValue([SKILL]);
  vi.mocked(listRuns).mockResolvedValue(runs);
  const mount = document.createElement("div");
  document.body.replaceChildren(mount);
  const p = new SkillsPanel(
    mount, () => "w1", onLaunch, vi.fn(), () => ["w1"], () => "relay", onHistory,
  );
  await p.load();
  return { mount, onHistory, onLaunch };
}

const dot = () => document.querySelector<HTMLButtonElement>(".sk-dot");

describe("the scenario row's state dot", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // A dot with no state to show would be a decoration.
  it("is absent until the scenario has actually run", async () => {
    await panel([]);
    expect(dot()).toBeNull();
  });

  it("carries the last run's state, whichever workspace it ran in", async () => {
    await panel([run({ runId: "r", status: "interrupted", workspaceId: "somewhere-else" })]);
    expect(dot()!.className).toContain("run-interrupted");
  });

  // Newest first is what `list_runs` promises, so the first record naming a
  // scenario is its latest run — a dot showing the oldest would be worse than
  // no dot at all.
  it("takes the newest record, not the first one it meets afterwards", async () => {
    await panel([
      run({ runId: "new", status: "error", startedAt: NOW - 60_000 }),
      run({ runId: "old", status: "ended", startedAt: NOW - 600_000 }),
    ]);
    expect(dot()!.className).toContain("run-error");
  });

  it("opens the history and never launches anything", async () => {
    const { onHistory, onLaunch } = await panel([run({ runId: "r" })]);
    dot()!.click();
    expect(onHistory).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  // The dot and ▶ are separate controls with separate accessible names, or the
  // split that made them two things would exist only for the eye.
  it("names itself as an indicator for a reader too", async () => {
    await panel([run({ runId: "r", status: "failed-to-launch" })]);
    const label = dot()!.getAttribute("aria-label") ?? "";
    expect(label).toContain("did not launch");
    expect(label).toContain("history");
    expect(dot()!.previousElementSibling!.className).toContain("sk-run");
  });

  // `schedule_state.json` stays the scheduler's gate — when the next occurrence
  // is — but what actually happened now comes from the journal, which is wider
  // than `lastOutcome` ever was: a scenario run by hand left no trace in it.
  it("survives the journal being unreadable", async () => {
    vi.mocked(listRuns).mockRejectedValue(new Error("no journal"));
    vi.mocked(listSkills).mockResolvedValue([SKILL]);
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    const p = new SkillsPanel(mount, () => "w1", vi.fn(), vi.fn(), () => ["w1"], () => "relay", vi.fn());
    await p.load();
    expect(document.querySelectorAll(".sk-row")).toHaveLength(1);
    expect(dot()).toBeNull();
  });
});
