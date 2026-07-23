// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveWorkspace, workspaceForm } = vi.hoisted(() => ({ saveWorkspace: vi.fn(), workspaceForm: vi.fn() }));
vi.mock("../src/ipc", () => ({
  listWorkspaces: vi.fn().mockResolvedValue([]),
  saveWorkspace,
  removeWorkspace: vi.fn(),
}));
vi.mock("../src/forms", () => ({ workspaceForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { WorkspacesPanel } from "../src/workspaces";

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

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
