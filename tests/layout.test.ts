// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core");
vi.mock("@tauri-apps/api/event");

import { loadLayout, saveLayout } from "../src/ipc";
import { serializeTiles } from "../src/sessions";
import { invoke } from "@tauri-apps/api/core";

beforeEach(() => vi.clearAllMocks());

describe("layout ipc", () => {
  it("loadLayout calls load_layout", async () => {
    vi.mocked(invoke).mockResolvedValue([{ sessionId: "s1", cwd: "/a", name: "N" }]);
    const res = await loadLayout();
    expect(invoke).toHaveBeenCalledWith("load_layout");
    expect(res[0].sessionId).toBe("s1");
  });
  it("saveLayout passes sessions", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await saveLayout([{ sessionId: "s1", cwd: "/a", name: "N" }]);
    expect(invoke).toHaveBeenCalledWith("save_layout", { sessions: [{ sessionId: "s1", cwd: "/a", name: "N" }] });
  });
});

describe("serializeTiles", () => {
  it("maps tile fields to SessionEntry shape, carrying workspaceId", () => {
    expect(serializeTiles([{ session: "s1", workspacePath: "/a", name: "▶ Fix", workspaceId: "w1" }]))
      .toEqual([{ sessionId: "s1", cwd: "/a", name: "▶ Fix", workspaceId: "w1", nameKind: "context" }]);
  });
  it("omits workspaceId when absent", () => {
    const result = serializeTiles([{ session: "s2", workspacePath: "/b", name: "N" }]);
    expect(result).toEqual([{ sessionId: "s2", cwd: "/b", name: "N", nameKind: "context" }]);
    expect(Object.keys(result[0])).not.toContain("workspaceId");
  });
  it("persists the launch name, not the transcript title", () => {
    // The caller hands over the launch name; there is no slot here for the
    // resolved one, which is what keeps a title out of the file by construction.
    const result = serializeTiles([
      { session: "s1", workspacePath: "/a", name: "session · relay", nameKind: "placeholder" },
    ]);
    expect(result[0].name).toBe("session · relay");
  });
  it("persists a hand-typed name in its own field", () => {
    const result = serializeTiles([
      {
        session: "s1", workspacePath: "/a", name: "session · relay",
        nameKind: "placeholder", userName: "the one I must not close",
      },
    ]);
    expect(result[0].userName).toBe("the one I must not close");
    expect(result[0].name).toBe("session · relay");
  });
  it("records whether the persisted name is a context name or a placeholder", () => {
    const result = serializeTiles([
      { session: "s1", workspacePath: "/a", name: "☑ Fix", nameKind: "context" },
      { session: "s2", workspacePath: "/a", name: "session · relay", nameKind: "placeholder" },
    ]);
    expect(result.map((e) => e.nameKind)).toEqual(["context", "placeholder"]);
  });
  // The field the activity registry dispatches on. Written only when it is not
  // the default, so every layout file on disk stays byte-identical: an absent
  // key already says "claude", and a key that repeats it is a key to keep in
  // step.
  it("leaves the default CLI out of the file, since its absence already says it", () => {
    const result = serializeTiles([
      { session: "s1", workspacePath: "/a", name: "N", cliKind: "claude" },
      { session: "s2", workspacePath: "/a", name: "N" },
    ]);
    expect(Object.keys(result[0])).not.toContain("cliKind");
    expect(Object.keys(result[1])).not.toContain("cliKind");
  });

  it("persists a CLI that is not the default", () => {
    const result = serializeTiles([
      { session: "s1", workspacePath: "/a", name: "N", cliKind: "copilot" },
    ]);
    expect(result[0].cliKind).toBe("copilot");
  });

  it("omits a hand-typed name that was cleared", () => {
    const result = serializeTiles([
      { session: "s1", workspacePath: "/a", name: "session · relay", userName: null },
    ]);
    expect(Object.keys(result[0])).not.toContain("userName");
  });
  it("никогда не сохраняет служебные тайлы команд", () => {
    // Восстановление такого тайла молча перезапустило бы sudo-команду установки.
    const result = serializeTiles([
      { session: "s1", workspacePath: "/w", name: "проект", workspaceId: "w1" },
      { session: "cmd1", workspacePath: "/w", name: "установка gh", workspaceId: "w1", kind: "command" },
    ]);
    expect(result.map((e) => e.sessionId)).toEqual(["s1"]);
  });
});
