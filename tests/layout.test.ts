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
      .toEqual([{ sessionId: "s1", cwd: "/a", name: "▶ Fix", workspaceId: "w1" }]);
  });
  it("omits workspaceId when absent", () => {
    const result = serializeTiles([{ session: "s2", workspacePath: "/b", name: "N" }]);
    expect(result).toEqual([{ sessionId: "s2", cwd: "/b", name: "N" }]);
    expect(Object.keys(result[0])).not.toContain("workspaceId");
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
