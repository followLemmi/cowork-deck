import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import { listWorkspaces, launchSession, getSettings } from "../src/ipc";
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

  it("launchSession passes session, cwd and initialPrompt", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await launchSession("s1", "/p", "do it");
    expect(invoke).toHaveBeenCalledWith("launch_session", {
      session: "s1", cwd: "/p", initialPrompt: "do it",
    });
  });

  it("getSettings calls the right command", async () => {
    vi.mocked(invoke).mockResolvedValue({ terminalCommand: "" });
    const res = await getSettings();
    expect(invoke).toHaveBeenCalledWith("get_settings");
    expect(res.terminalCommand).toBe("");
  });
});
