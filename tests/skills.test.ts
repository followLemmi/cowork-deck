// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from "vitest";

const { saveSkill, skillForm } = vi.hoisted(() => ({ saveSkill: vi.fn(), skillForm: vi.fn() }));
vi.mock("../src/ipc", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
  saveSkill,
  removeSkill: vi.fn(),
}));
vi.mock("../src/forms", () => ({ skillForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { SkillsPanel } from "../src/skills";

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

it("creates a skill from the form result", async () => {
  skillForm.mockResolvedValueOnce({ name: "Fix", icon: "▶", prompt: "do", workspaceId: null });
  saveSkill.mockResolvedValueOnce([{ id: "s", name: "Fix", icon: "▶", prompt: "do", workspaceId: null }]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {});
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-add")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "Fix", prompt: "do" }));
});
