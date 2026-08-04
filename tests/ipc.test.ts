import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import {
  listWorkspaces, startSession, decodeB64, onScheduledFire, scheduleAck, updateTask,
  boardConfigSave, boardStepRewrite, boardStepUsage, prList, prMerge, prWorktreeAdd,
  issueTotals, issueWorktreeAdd, issueWorktreePath, issueWorktreeRemove, trackerOpenCount,
} from "../src/ipc";
import type { BoardConfig } from "../src/ipc";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

describe("ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listWorkspaces calls the right command", async () => {
    vi.mocked(invoke).mockResolvedValue([{ id: "w1", name: "X", path: "/x", color: "#fff" }]);
    const res = await listWorkspaces();
    expect(invoke).toHaveBeenCalledWith("list_workspaces");
    expect(res[0].id).toBe("w1");
  });

  it("startSession passes all params incl. resume", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await startSession("s1", "/proj", "w1", "do the thing", "01AAA", 80, 24, false);
    expect(invoke).toHaveBeenCalledWith("start_session", {
      session: "s1", cwd: "/proj", workspaceId: "w1", initialPrompt: "do the thing",
      taskId: "01AAA", cols: 80, rows: 24, resume: false,
    });
  });

  it("startSession forwards the workspace id so the backend can resolve its account", async () => {
    vi.mocked(invoke).mockResolvedValue({ account: "followLemmi", degraded: null });
    const auth = await startSession("s1", "/proj", "w1", null, null, 80, 24, false);
    expect(invoke).toHaveBeenCalledWith("start_session", {
      session: "s1", cwd: "/proj", workspaceId: "w1", initialPrompt: null,
      taskId: null, cols: 80, rows: 24, resume: false,
    });
    expect(auth).toEqual({ account: "followLemmi", degraded: null });
  });

  // The occurrence has to survive the round trip: the backend records only
  // that it attempted a fire, and matches the ack against that exact
  // occurrence before it will record a run.
  it("onScheduledFire hands the occurrence to the callback", async () => {
    const cb = vi.fn();
    await onScheduledFire(cb);

    const handler = vi.mocked(listen).mock.calls[0][1] as (e: unknown) => void;
    handler({ payload: { skillId: "s1", occurrenceMs: 1_700_000_000_000, catchUp: true } });

    expect(cb).toHaveBeenCalledWith("s1", 1_700_000_000_000, true);
  });

  it("scheduleAck reports the outcome for that occurrence", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await scheduleAck("s1", 1_700_000_000_000, "no-workspace");
    expect(invoke).toHaveBeenCalledWith("schedule_ack", {
      skillId: "s1", occurrenceMs: 1_700_000_000_000, outcome: "no-workspace",
    });
  });

  it("updateTask sends only the fields named in the patch", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await updateTask("w1", "01K1", { title: "Renamed" });
    expect(invoke).toHaveBeenCalledWith("tasks_update", {
      workspaceId: "w1", id: "01K1", patch: { title: "Renamed" },
    });
  });

  it("boardConfigSave sends the workspace and the draft configuration", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const cfg: BoardConfig = {
      v: 1, steps: [{ id: "todo", label: "To do", terminal: true }], kinds: [{ id: "bug", label: "Bug" }],
    };
    await boardConfigSave("w1", cfg);
    expect(invoke).toHaveBeenCalledWith("board_config_save", { workspaceId: "w1", config: cfg });
  });

  // The fourth argument matters: task 9a's rewrite_step validates `to` against
  // this draft configuration, not the one still on disk, since a rename's
  // target id is not written until after the rewrite runs.
  it("boardStepRewrite sends the draft config alongside from/to", async () => {
    vi.mocked(invoke).mockResolvedValue({ rewritten: 2, skipped: [] });
    const cfg: BoardConfig = {
      v: 1, steps: [{ id: "todo", label: "To do", terminal: true }], kinds: [{ id: "bug", label: "Bug" }],
    };
    const res = await boardStepRewrite("w1", "todo", "doing", cfg);
    expect(invoke).toHaveBeenCalledWith("board_step_rewrite", { workspaceId: "w1", from: "todo", to: "doing", config: cfg });
    expect(res.rewritten).toBe(2);
  });

  it("boardStepUsage calls the right command", async () => {
    vi.mocked(invoke).mockResolvedValue([{ step: "todo", count: 3 }]);
    const res = await boardStepUsage("w1");
    expect(invoke).toHaveBeenCalledWith("board_step_usage", { workspaceId: "w1" });
    expect(res[0].count).toBe(3);
  });

  it("prMerge forwards the pinned head commit", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await prMerge("w1", 7, "squash", "abc123", false);
    expect(invoke).toHaveBeenCalledWith("pr_merge", {
      workspaceId: "w1", number: 7, strategy: "squash",
      headOid: "abc123", deleteBranch: false,
    });
  });

  it("prList asks for one workspace", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await prList("w1");
    expect(invoke).toHaveBeenCalledWith("pr_list", { workspaceId: "w1" });
  });

  it("issueTotals names the command and its workspace", async () => {
    vi.mocked(invoke).mockResolvedValue({ open: 50, closed: 63, rateRemaining: 4873 });
    const t = await issueTotals("w1");
    expect(invoke).toHaveBeenCalledWith("issue_totals", { workspaceId: "w1" });
    expect(t.open).toBe(50);
  });

  it("issueWorktreeAdd passes the issue's number and title, not a branch", async () => {
    vi.mocked(invoke).mockResolvedValue("/tmp/x-issue/42-t");
    await issueWorktreeAdd("w1", 42, "Sidebar badge sticks");
    expect(invoke).toHaveBeenCalledWith("issue_worktree_add", {
      workspaceId: "w1", number: 42, title: "Sidebar badge sticks",
    });
  });

  // The branch is derived in Rust from the number and the title, so the
  // frontend never has to know the naming rule — and cannot get it wrong.
  it("issueWorktreePath and issueWorktreeRemove take the same three arguments", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await issueWorktreePath("w1", 42, "t");
    await issueWorktreeRemove("w1", 42, "t");
    expect(invoke).toHaveBeenNthCalledWith(1, "issue_worktree_path",
      { workspaceId: "w1", number: 42, title: "t" });
    expect(invoke).toHaveBeenNthCalledWith(2, "issue_worktree_remove",
      { workspaceId: "w1", number: 42, title: "t" });
  });

  it("prWorktreeAdd forwards whether the pull request is from a fork", async () => {
    vi.mocked(invoke).mockResolvedValue({ path: "/tmp/x-pr/7-b", reused: false });
    const added = await prWorktreeAdd("w1", 7, "b", true);
    expect(invoke).toHaveBeenCalledWith("pr_worktree_add", {
      workspaceId: "w1", number: 7, branch: "b", crossRepository: true,
    });
    expect(added.reused).toBe(false);
  });

  it("trackerOpenCount may answer nothing at all", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await trackerOpenCount("w1")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("tracker_open_count", { workspaceId: "w1" });
  });

  it("decodeB64 round-trips utf8", () => {
    const str = "héllo";
    const utf8Bytes = new TextEncoder().encode(str);
    const b64 = btoa(String.fromCharCode(...utf8Bytes));
    expect(decodeB64(b64)).toBe(str);
  });
});
