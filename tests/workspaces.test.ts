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

/** `ui_state.json` holds one startup workspace for the app, and it is the main
 *  window's answer. A window pinned to one workspace selects that workspace as it
 *  boots — persisting it would rewrite what the main window opens with, so
 *  pulling a workspace out would silently change which project the app starts on
 *  next time. Part of #242. */
describe("remembering the startup workspace", () => {
  const items = [
    { id: "a", name: "A", path: "/a", color: "#111" },
    { id: "b", name: "B", path: "/b", color: "#222" },
  ];

  beforeEach(() => {
    listWorkspacesMock.mockResolvedValue(items);
    loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "a" });
    saveUiStateMock.mockClear();
    saveUiStateMock.mockResolvedValue(undefined);
  });

  it("records the selection in the main window", async () => {
    const panel = new WorkspacesPanel(document.createElement("div"), () => {});
    await panel.load();
    expect(saveUiStateMock).toHaveBeenCalledWith({ activeWorkspaceId: "a" });
  });

  it("records nothing in a window pinned to one workspace", async () => {
    const panel = new WorkspacesPanel(
      document.createElement("div"), () => {}, undefined, () => {}, false,
    );
    await panel.load();
    expect(saveUiStateMock).not.toHaveBeenCalled();
  });

  /** The selection still happens — only the *writing down* of it stops. A pinned
   *  window that had no active workspace would have nothing to show. */
  it("still selects the workspace it did not record", async () => {
    const selected: string[] = [];
    const panel = new WorkspacesPanel(
      document.createElement("div"), (ws) => selected.push(ws.id), undefined, () => {}, false,
    );
    await panel.load();
    expect(panel.active?.id).toBe("a");
    expect(selected).toContain("a");
  });
});

/** A window pulled out to hold one workspace lists that workspace and no other.
 *
 *  Two defects in one call, and the second is the quieter of the two: a pinned
 *  window used to read `ui_state.json` for which workspace to open on — a file
 *  that holds the MAIN window's answer — so the window whose label said `relay`
 *  could open showing `harbor`, with a deck full of sessions belonging to
 *  neither. */
describe("WorkspacesPanel pinned to one workspace", () => {
  const items = [
    { id: "a", name: "A", path: "/a", color: "#111" },
    { id: "b", name: "B", path: "/b", color: "#222" },
  ];
  const mount = () => {
    const el = document.createElement("div");
    document.body.append(el);
    return el;
  };

  beforeEach(() => {
    listWorkspacesMock.mockResolvedValue(items);
    loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "b" });
  });

  it("keeps the one it is pinned to, and drops the rest", async () => {
    const panel = new WorkspacesPanel(mount(), () => {});
    panel.pinTo("a");
    await panel.load();
    expect(panel.all.map((w) => w.id)).toEqual(["a"]);
    expect(panel.active?.id).toBe("a");
  });

  /* The saved id names a workspace this window is not for. Reading it is what
     made a pinned window open on somebody else's project. */
  it("does not open on the workspace ui_state names", async () => {
    const panel = new WorkspacesPanel(mount(), () => {});
    panel.pinTo("a");
    await panel.load();
    expect(panel.active?.id).toBe("a");
    expect(loadUiStateMock).not.toHaveBeenCalled();
  });

  it("still reads it in the main window", async () => {
    const panel = new WorkspacesPanel(mount(), () => {});
    await panel.load();
    expect(panel.active?.id).toBe("b");
  });

  /* Adding a workspace is the app's act: the new one would appear in the main
     window's tree and in no list this window keeps. */
  it("offers no way to add a workspace, and says Sessions over the list", async () => {
    const el = mount();
    const panel = new WorkspacesPanel(el, () => {});
    panel.pinTo("a");
    await panel.load();
    expect(el.querySelector(".ws-add")).toBeNull();
    expect(el.querySelector("h3")?.textContent).toBe("Sessions");
    expect(el.querySelectorAll(".ws-row")).toHaveLength(1);
  });

  it("keeps both in the main window", async () => {
    const el = mount();
    const panel = new WorkspacesPanel(el, () => {});
    await panel.load();
    expect(el.querySelector(".ws-add")).not.toBeNull();
    expect(el.querySelector("h3")?.textContent).toBe("Workspaces and sessions");
    expect(el.querySelectorAll(".ws-row")).toHaveLength(2);
  });

  /* `activate` is how something other than this panel names a workspace — a
     scenario's run, say. One that is not this window's must not be switched to:
     its sessions are in another window and the deck here would empty. */
  it("refuses to activate a workspace it is not pinned to", async () => {
    const panel = new WorkspacesPanel(mount(), () => {});
    panel.pinTo("a");
    await panel.load();
    expect(panel.activate("b")).toBe(false);
    expect(panel.active?.id).toBe("a");
  });
});
