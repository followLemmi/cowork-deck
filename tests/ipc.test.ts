import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import {
  listWorkspaces, startSession, decodeB64Bytes, onOutput, onScheduledFire, scheduleAck, updateTask,
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
      taskId: "01AAA", cols: 80, rows: 24, resume: false, scenario: null,
    });
  });

  // The scenario half of a launch, and the only route by which anything reaches
  // the run journal. A card, an issue or a bare "+ session" sends `null` here,
  // which is what keeps the journal answering "what did my scenarios do" rather
  // than "what did I run yesterday".
  it("startSession carries the scenario a launch came from", async () => {
    vi.mocked(invoke).mockResolvedValue({ account: null, degraded: null });
    await startSession("s1", "/proj", "w1", "go", null, 80, 24, false, {
      runId: "r1", skillId: "sk1", trigger: "manual", params: { branch: "dev" },
      continuesRunId: null,
    });
    expect(invoke).toHaveBeenCalledWith("start_session", expect.objectContaining({
      scenario: {
        runId: "r1", skillId: "sk1", trigger: "manual", params: { branch: "dev" },
        continuesRunId: null,
      },
    }));
  });

  it("startSession forwards the workspace id so the backend can resolve its account", async () => {
    vi.mocked(invoke).mockResolvedValue({ account: "followLemmi", degraded: null });
    const auth = await startSession("s1", "/proj", "w1", null, null, 80, 24, false);
    expect(invoke).toHaveBeenCalledWith("start_session", {
      session: "s1", cwd: "/proj", workspaceId: "w1", initialPrompt: null,
      taskId: null, cols: 80, rows: 24, resume: false, scenario: null,
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
      workspaceId: null,
    });
  });

  // A fire that resolved a workspace and then skipped still happened
  // somewhere, and the `failed-to-launch` record it produces lands on a screen
  // scoped to one workspace.
  it("scheduleAck carries the workspace a skipped fire resolved to", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await scheduleAck("s1", 1_700_000_000_000, "skipped-overlap", "w1");
    expect(invoke).toHaveBeenCalledWith("schedule_ack", expect.objectContaining({
      outcome: "skipped-overlap", workspaceId: "w1",
    }));
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

  it("decodeB64Bytes round-trips utf8 as bytes", () => {
    const str = "héllo";
    const utf8 = new TextEncoder().encode(str);
    const b64 = btoa(String.fromCharCode(...utf8));
    expect(decodeB64Bytes(b64)).toEqual(utf8);
  });

  // The regression this pins is a frame that stops lining up. `pty.rs` cuts the
  // stream on a byte boundary that respects no character, and on Darwin the tty
  // caps a read at 1024 bytes, so it cuts four times as often as on Linux. When
  // this function decoded each event on its own, a glyph split across two of them
  // came back as replacement characters on both sides — one cell became two or
  // three, and the rest of the line was off by that much.
  it("onOutput delivers bytes, so a glyph split across two events survives", async () => {
    const received: Uint8Array[] = [];
    await onOutput((_s, bytes) => { received.push(bytes) });
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: unknown) => void;

    const glyph = new TextEncoder().encode("─");        // e2 94 80, one cell
    const halves = [glyph.subarray(0, 1), glyph.subarray(1)];
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    for (const half of halves) {
      handler({ payload: { session: "s1", dataB64: b64(half) } });
    }

    const joined = new Uint8Array([...received[0], ...received[1]]);
    expect(joined).toEqual(glyph);
    // Intact, so xterm's own stateful decoder can hold the partial sequence and
    // finish the glyph when the second event arrives.
    expect(new TextDecoder().decode(joined)).toBe("─");
    // And what the old string-returning path made of the very same two events:
    // three replacement characters where there was one glyph — the truncated lead
    // byte, then both orphaned continuation bytes. One cell became three, so the
    // rest of that line sat two columns to the right of where it belonged.
    expect(halves.map((h) => new TextDecoder().decode(h)).join("")).toBe("���");
  });
});
