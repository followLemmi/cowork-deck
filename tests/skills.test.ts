// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from "vitest";

const { saveSkill, skillForm, listSkills } = vi.hoisted(() => ({
  saveSkill: vi.fn(), skillForm: vi.fn(), listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/ipc", () => ({
  listSkills,
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

it("marks a scheduled scenario with ⏰ and describes it in the tooltip", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
    { id: "s2", name: "Ручной", icon: "▶", prompt: "go", workspaceId: null },
  ]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {});
  await panel.load();
  const marks = mount.querySelectorAll(".sk-sched");
  expect(marks).toHaveLength(1); // only the scheduled one
  expect(marks[0].parentElement!.textContent).toContain("Отчёт");
  expect((marks[0] as HTMLElement).title).toContain("ежедневно 09:00");
  expect((marks[0] as HTMLElement).title).toContain("след.:");
});

it("find() resolves a scenario by id for scheduled fires", async () => {
  listSkills.mockResolvedValueOnce([{ id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null }]);
  const panel = new SkillsPanel(document.createElement("div"), () => null, () => {});
  await panel.load();
  expect(panel.find("s1")?.name).toBe("Отчёт");
  expect(panel.find("nope")).toBeUndefined();
});
