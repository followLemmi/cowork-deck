import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import {
  listWorkspaces, startSession, decodeB64, onScheduledFire, scheduleAck, updateTask,
  boardConfigSave, boardStepRewrite, boardStepUsage,
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

  it("decodeB64 round-trips utf8", () => {
    const str = "héllo";
    const utf8Bytes = new TextEncoder().encode(str);
    const b64 = btoa(String.fromCharCode(...utf8Bytes));
    expect(decodeB64(b64)).toBe(str);
  });
});
