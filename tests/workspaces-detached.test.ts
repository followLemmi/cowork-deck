// @vitest-environment jsdom
/** A workspace pulled into a window of its own does not vanish from the main
 *  window. The owner's requirement, verbatim: *"we need to show this pulled-out
 *  workspace as disabled in the main window, so the user sees it did not
 *  disappear into the void."*
 *
 *  So the row has a third state beside active and inactive, and it is a state
 *  rather than a disabled control: it still does something, just something
 *  different. Part of #244. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listWorkspacesMock, loadUiStateMock, saveUiStateMock } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(),
  loadUiStateMock: vi.fn(),
  saveUiStateMock: vi.fn(),
}));
vi.mock("../src/ipc", () => ({
  listWorkspaces: listWorkspacesMock,
  saveWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  loadUiState: loadUiStateMock,
  saveUiState: saveUiStateMock,
}));
vi.mock("../src/forms", () => ({ workspaceForm: vi.fn() }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn(), alertModal: vi.fn() }));

import { WorkspacesPanel } from "../src/workspaces";

const items = [
  { id: "a", name: "Alpha", path: "/a", color: "#111" },
  { id: "b", name: "Beta", path: "/b", color: "#222" },
];

async function panelWith(detached: string[], onRaise = vi.fn()) {
  const mount = document.createElement("div");
  const onSelect = vi.fn();
  const panel = new WorkspacesPanel(mount, onSelect, undefined, () => {}, true, null, onRaise);
  await panel.load();
  panel.setDetached(new Set(detached));
  return { mount, panel, onSelect, onRaise };
}

beforeEach(() => {
  listWorkspacesMock.mockResolvedValue(items);
  loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "a" });
  saveUiStateMock.mockResolvedValue(undefined);
  vi.clearAllMocks();
});

describe("a workspace that is open in its own window", () => {
  it("keeps its row, marked as being elsewhere", async () => {
    const { mount } = await panelWith(["b"]);
    const rows = mount.querySelectorAll(".ws-row");
    expect(rows.length).toBe(2);
    expect(rows[1].classList.contains("detached")).toBe(true);
    expect(rows[0].classList.contains("detached")).toBe(false);
  });

  /** Clicking it would otherwise switch this window to a workspace whose tiles
   *  are all somewhere else — an empty deck, and no clue why. */
  it("raises its window instead of switching to it", async () => {
    const { mount, onSelect, onRaise } = await panelWith(["b"]);
    // `load()` selects the startup workspace, so the counter starts at one.
    onSelect.mockClear();
    (mount.querySelectorAll<HTMLElement>(".ws-row")[1]).click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRaise).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  /** `aria-disabled` would be wrong twice over: the control works, and what it
   *  does is not what the other rows do. It stays a real button and its
   *  accessible name carries where the workspace went. */
  it("says where it went, in its accessible name", async () => {
    const { mount } = await panelWith(["b"]);
    const label = mount.querySelectorAll<HTMLElement>(".ws-row .ws-label")[1];
    expect(label.getAttribute("aria-disabled")).toBeNull();
    expect(label.getAttribute("aria-label")).toContain("its own window");
  });

  /** It is out already; offering to pull it out again is offering nothing. */
  it("drops the pull-out control", async () => {
    const mount = document.createElement("div");
    const panel = new WorkspacesPanel(
      mount, vi.fn(), undefined, () => {}, true,
      { icon: "detach", label: (n: string) => `Open ${n}`, run: vi.fn() },
      vi.fn(),
    );
    await panel.load();
    panel.setDetached(new Set(["b"]));
    const rows = mount.querySelectorAll(".ws-row");
    expect(rows[0].querySelector(".ws-detach")).not.toBeNull();
    expect(rows[1].querySelector(".ws-detach")).toBeNull();
  });

  /** The workspace is still being worked on, just not here — so the open-task
   *  badge is not blanked.
   *
   *  It is on the workspace's BOARD row rather than on the workspace's own: the
   *  count is the board's, and beside the waiting count on the row above it was a
   *  number next to a number with neither saying what it counted. */
  it("keeps its open-task count", async () => {
    const { mount, panel } = await panelWith(["b"]);
    panel.setCounts({ b: 3 });
    const nav = mount.querySelector('.ws-nav[data-ws="b"]');
    expect(nav?.querySelector(".ws-page-count")?.textContent).toBe("3");
  });

  /** It cannot also be this window's active workspace: the deck would filter to
   *  a workspace whose tiles are all elsewhere and show nothing. */
  it("is not drawn as active even if it was when it left", async () => {
    const { mount } = await panelWith(["a"]);
    const rows = mount.querySelectorAll(".ws-row");
    expect(rows[0].classList.contains("active")).toBe(false);
    expect(rows[0].classList.contains("detached")).toBe(true);
  });

  /** The bug this test exists for. Nothing removed a window's label when it was
   *  destroyed, so a workspace brought back by closing its window stayed marked
   *  as being elsewhere: the row could not be selected, and clicking it emitted
   *  into a label nothing answers to — the workspace was unreachable until the
   *  app restarted. Rust announces `window://gone` now, and the marker has to
   *  come off when it does. */
  it("becomes an ordinary row again once its window has gone", async () => {
    const { mount, panel, onSelect, onRaise } = await panelWith(["b"]);
    expect(mount.querySelectorAll(".ws-row")[1].classList.contains("detached")).toBe(true);

    panel.setDetached(new Set());

    const row = mount.querySelectorAll<HTMLElement>(".ws-row")[1];
    expect(row.classList.contains("detached")).toBe(false);
    onSelect.mockClear();
    row.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(onRaise).not.toHaveBeenCalled();
  });

  /** And the pull-out control comes back with it, or a workspace could be
   *  returned once and never sent out again. */
  it("gets its pull-out control back", async () => {
    const mount = document.createElement("div");
    const panel = new WorkspacesPanel(
      mount, vi.fn(), undefined, () => {}, true,
      { icon: "detach", label: (n: string) => `Open ${n}`, run: vi.fn() },
      vi.fn(),
    );
    await panel.load();
    panel.setDetached(new Set(["b"]));
    expect(mount.querySelectorAll(".ws-row")[1].querySelector(".ws-detach")).toBeNull();

    panel.setDetached(new Set());
    expect(mount.querySelectorAll(".ws-row")[1].querySelector(".ws-detach")).not.toBeNull();
  });
});
