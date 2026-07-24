// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listWorkspacesMock, loadUiStateMock, saveUiStateMock, saveWorkspace, workspaceForm } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(),
  loadUiStateMock: vi.fn(),
  saveUiStateMock: vi.fn(),
  saveWorkspace: vi.fn(),
  workspaceForm: vi.fn(),
}));
vi.mock("../src/ipc", () => ({
  listWorkspaces: listWorkspacesMock,
  saveWorkspace,
  removeWorkspace: vi.fn(),
  loadUiState: loadUiStateMock,
  saveUiState: saveUiStateMock,
}));
vi.mock("../src/forms", () => ({ workspaceForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { WorkspacesPanel } from "../src/workspaces";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  saveUiStateMock.mockResolvedValue(undefined);
  listWorkspacesMock.mockResolvedValue([]);
});

describe("WorkspacesPanel restore", () => {
  const items = [
    { id: "a", name: "A", path: "/a", color: "#111" },
    { id: "b", name: "B", path: "/b", color: "#222" },
  ];
  it("selects the saved active workspace when present", async () => {
    listWorkspacesMock.mockResolvedValue(items);
    loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "b" });
    const selected: string[] = [];
    const p = new WorkspacesPanel(document.createElement("div"), (ws) => selected.push(ws.id));
    await p.load();
    expect(p.active?.id).toBe("b");
    expect(selected).toContain("b");
  });
  it("falls back to first when saved id is absent/unknown", async () => {
    listWorkspacesMock.mockResolvedValue(items);
    loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "gone" });
    const p = new WorkspacesPanel(document.createElement("div"), () => {});
    await p.load();
    expect(p.active?.id).toBe("a");
  });
});

it("creates a workspace from the form result", async () => {
  workspaceForm.mockResolvedValueOnce({ name: "P", path: "/p", color: "#61afef" });
  saveWorkspace.mockResolvedValueOnce([{ id: "x", name: "P", path: "/p", color: "#61afef" }]);
  const mount = document.createElement("div");
  const panel = new WorkspacesPanel(mount, () => {});
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".ws-add")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "P", path: "/p" }));
});
