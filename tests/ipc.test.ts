import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import { listWorkspaces, startSession, decodeB64, onScheduledFire, scheduleAck, updateTask } from "../src/ipc";
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
    await startSession("s1", "/proj", "w1", "do the thing", 80, 24, false);
    expect(invoke).toHaveBeenCalledWith("start_session", {
      session: "s1", cwd: "/proj", workspaceId: "w1", initialPrompt: "do the thing", cols: 80, rows: 24, resume: false,
    });
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

  it("decodeB64 round-trips utf8", () => {
    const str = "héllo";
    const utf8Bytes = new TextEncoder().encode(str);
    const b64 = btoa(String.fromCharCode(...utf8Bytes));
    expect(decodeB64(b64)).toBe(str);
  });
});
