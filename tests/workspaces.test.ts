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
  it("uses the singular for exactly 1", () => {
    expect(openTaskCountLabel(1)).toBe("1 open task");
  });
  it("uses the plural for everything else, zero included", () => {
    expect(openTaskCountLabel(0)).toBe("0 open tasks");
    expect(openTaskCountLabel(2)).toBe("2 open tasks");
    expect(openTaskCountLabel(11)).toBe("11 open tasks");
    // 21 ends in 1 but is not 1: only the whole count decides the form.
    expect(openTaskCountLabel(21)).toBe("21 open tasks");
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

// The scenario row's state dot reports a run from whichever workspace it
// happened in, and the history screen shows one workspace at a time. Opening
// the one from the other is the only way the click can land on the run it just
// described.
describe("WorkspacesPanel.activate", () => {
  const items = [
    { id: "a", name: "A", path: "/a", color: "#111" },
    { id: "b", name: "B", path: "/b", color: "#222" },
  ];
  const panel = async () => {
    listWorkspacesMock.mockResolvedValue(items);
    loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "a" });
    const selected: string[] = [];
    const p = new WorkspacesPanel(document.createElement("div"), (ws) => selected.push(ws.id));
    await p.load();
    return { p, selected };
  };

  it("switches to a workspace named by someone else, and says it did", async () => {
    const { p, selected } = await panel();
    expect(p.activate("b")).toBe(true);
    expect(p.active?.id).toBe("b");
    // The deck listens on this: switching workspace behind its back would
    // leave it showing the sessions of the one that is no longer active.
    expect(selected).toContain("b");
  });

  // A record outlives the workspace it names — the journal keeps runs whose
  // workspace has since been deleted. Switching to nothing and reporting
  // success would show the current workspace's list as if it were that one's.
  it("refuses a workspace that no longer exists, and stays where it is", async () => {
    const { p } = await panel();
    expect(p.activate("deleted-since")).toBe(false);
    expect(p.active?.id).toBe("a");
  });

  it("is a no-op on the workspace already active", async () => {
    const { p, selected } = await panel();
    const before = selected.length;
    expect(p.activate("a")).toBe(true);
    expect(selected).toHaveLength(before);
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
