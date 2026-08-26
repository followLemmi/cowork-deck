// @vitest-environment jsdom
/** Every control on a workspace row survives the tear-out gesture.
 *
 *  The gesture captures the pointer on the ROW, and a captured pointer retargets
 *  the compatibility mouse events with the pointer ones — `click` included. So
 *  ✎, 🗑, the pull-out control and the `board · PRs · journal` chip were all dead
 *  wherever the platform can place a window (macOS, Windows, X11 — everything but
 *  Wayland): the press arrived at the row, which folded the sessions instead.
 *
 *  Read against the panel's REAL render rather than against hand-written markup,
 *  because the thing that rots is the class names: a control added to the row, or
 *  one renamed, is exactly the case a fixture cannot notice. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listWorkspacesMock, loadUiStateMock } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(),
  loadUiStateMock: vi.fn(),
}));
vi.mock("../src/ipc", () => ({
  listWorkspaces: listWorkspacesMock,
  saveWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  loadUiState: loadUiStateMock,
  saveUiState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/forms", () => ({ workspaceForm: vi.fn() }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn(), alertModal: vi.fn() }));

import { WorkspacesPanel } from "../src/workspaces";
import { pressStartsOnControl } from "../src/tear-out";

const items = [{ id: "a", name: "Alpha", path: "/a", color: "#111" }];

/** The main window's panel: an active row with every control it can carry — the
 *  pull-out control appears only where there is a `moveAction`, and the chip only
 *  on the active row. */
async function activeRow() {
  const mount = document.createElement("div");
  const panel = new WorkspacesPanel(
    mount, vi.fn(), undefined, () => {}, true,
    { icon: "detach", label: (n) => `Pull ${n} out`, run: vi.fn(), drag: vi.fn() },
  );
  panel.setTreeHooks({ reselect: vi.fn(), rendered: vi.fn(), openPage: vi.fn() });
  await panel.load();
  return mount.querySelector<HTMLElement>(".ws-row.active")!;
}

beforeEach(() => {
  listWorkspacesMock.mockResolvedValue(items);
  loadUiStateMock.mockResolvedValue({ activeWorkspaceId: "a" });
});

describe("a press on a workspace row's own control", () => {
  it("is left alone, for every control the row carries", async () => {
    const row = await activeRow();
    for (const sel of [".ws-scope", ".ws-edit", ".ws-del", ".ws-detach"]) {
      const control = row.querySelector<HTMLElement>(sel);
      expect(control, sel).not.toBeNull();
      expect(pressStartsOnControl(control), sel).toBe(true);
      // And through a glyph inside it, which is what a pointer actually lands on.
      const inner = control!.firstElementChild;
      if (inner) expect(pressStartsOnControl(inner), `${sel} > glyph`).toBe(true);
    }
  });

  /** The name is the handle, not a control: dragging a workspace by the thing that
   *  names it is the gesture, and the label's click bubbles to the row on purpose. */
  it("does not include the name, or the row itself", async () => {
    const row = await activeRow();
    expect(pressStartsOnControl(row.querySelector(".ws-label"))).toBe(false);
    expect(pressStartsOnControl(row)).toBe(false);
    expect(pressStartsOnControl(row.querySelector(".ws-caret"))).toBe(false);
    expect(pressStartsOnControl(null)).toBe(false);
  });
});
