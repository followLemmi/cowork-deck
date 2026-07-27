import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import { listWorkspaces, startSession, decodeB64 } from "../src/ipc";
import { invoke } from "@tauri-apps/api/core";

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

  it("decodeB64 round-trips utf8", () => {
    const str = "héllo";
    const utf8Bytes = new TextEncoder().encode(str);
    const b64 = btoa(String.fromCharCode(...utf8Bytes));
    expect(decodeB64(b64)).toBe(str);
  });
});
