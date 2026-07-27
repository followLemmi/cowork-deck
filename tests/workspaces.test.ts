// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listWorkspacesMock, loadUiStateMock, saveUiStateMock, saveWorkspace, removeWorkspaceMock, confirmModalMock, workspaceForm } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(),
  loadUiStateMock: vi.fn(),
  saveUiStateMock: vi.fn(),
  saveWorkspace: vi.fn(),
  removeWorkspaceMock: vi.fn(),
  confirmModalMock: vi.fn(),
  workspaceForm: vi.fn(),
}));
vi.mock("../src/ipc", () => ({
  listWorkspaces: listWorkspacesMock,
  saveWorkspace,
  removeWorkspace: removeWorkspaceMock,
  loadUiState: loadUiStateMock,
  saveUiState: saveUiStateMock,
}));
vi.mock("../src/forms", () => ({ workspaceForm }));
vi.mock("../src/modal", () => ({ confirmModal: confirmModalMock }));

import { WorkspacesPanel, openTaskCountLabel } from "../src/workspaces";

describe("openTaskCountLabel", () => {
  it("uses singular agreement for 1", () => {
    expect(openTaskCountLabel(1)).toBe("1 открытая задача");
    expect(openTaskCountLabel(21)).toBe("21 открытая задача");
  });
  it("uses the 2-4 form", () => {
    expect(openTaskCountLabel(2)).toBe("2 открытые задачи");
    expect(openTaskCountLabel(4)).toBe("4 открытые задачи");
    expect(openTaskCountLabel(23)).toBe("23 открытые задачи");
  });
  it("uses the genitive-plural form for 5+, 0, and the 11-14 exception", () => {
    expect(openTaskCountLabel(5)).toBe("5 открытых задач");
    expect(openTaskCountLabel(0)).toBe("0 открытых задач");
    expect(openTaskCountLabel(11)).toBe("11 открытых задач");
    expect(openTaskCountLabel(12)).toBe("12 открытых задач");
    expect(openTaskCountLabel(14)).toBe("14 открытых задач");
  });
});

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

it("re-notifies onSelect with the still-active workspace when a non-active workspace is deleted", async () => {
  const items = [
    { id: "a", name: "A", path: "/a", color: "#111" },
    { id: "b", name: "B", path: "/b", color: "#222" },
  ];
  listWorkspacesMock.mockResolvedValue(items);
  loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "a" });
  confirmModalMock.mockResolvedValueOnce(true);
  removeWorkspaceMock.mockResolvedValueOnce([items[0]]);
  const selected: string[] = [];
  const mount = document.createElement("div");
  const panel = new WorkspacesPanel(mount, (ws) => selected.push(ws.id));
  await panel.load();
  selected.length = 0; // clear the initial select() notification from load()
  mount.querySelectorAll<HTMLButtonElement>(".ws-del")[1]!.click(); // delete "b", the non-active workspace
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(panel.active?.id).toBe("a");
  expect(selected).toContain("a");
});
