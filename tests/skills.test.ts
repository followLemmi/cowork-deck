// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from "vitest";

const { saveSkill, skillForm, listSkills } = vi.hoisted(() => ({
  saveSkill: vi.fn(), skillForm: vi.fn(), listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/ipc", () => ({
  listSkills,
  saveSkill,
  removeSkill: vi.fn(),
  loadScheduleState: vi.fn().mockResolvedValue({}),
}));
vi.mock("../src/forms", () => ({ skillForm }));
vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));

import { SkillsPanel } from "../src/skills";

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

it("creates a skill from the form result", async () => {
  skillForm.mockResolvedValueOnce({ name: "Fix", icon: "▶", prompt: "do", workspaceId: null });
  saveSkill.mockResolvedValueOnce([{ id: "s", name: "Fix", icon: "▶", prompt: "do", workspaceId: null }]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {}, () => {});
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-add")!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "Fix", prompt: "do" }));
});

it("gives a scheduled scenario a run-now button and a visible schedule line", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
    { id: "s2", name: "Ручной", icon: "▶", prompt: "go", workspaceId: null },
  ]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {}, () => {});
  await panel.load();
  const buttons = mount.querySelectorAll<HTMLButtonElement>(".sk-now");
  expect(buttons).toHaveLength(1); // only the scheduled one
  // The button now says only what it does. What the schedule *is* lives in
  // visible text, because a title attribute is unreachable from the keyboard
  // and went stale between renders.
  expect(buttons[0].title).toContain("прогнать сейчас");
  const line = mount.querySelector(".sk-sched")!;
  expect(line.textContent).toContain("ежедневно 09:00");
  expect(line.textContent).toContain("следующий запуск");
});

it("clicking ⏰ runs the scenario without triggering the normal launch", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
  ]);
  const onLaunch = vi.fn();
  const onRunScheduled = vi.fn();
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, onLaunch, onRunScheduled);
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-now")!.click();
  expect(onRunScheduled).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  expect(onLaunch).not.toHaveBeenCalled();
});

it("find() resolves a scenario by id for scheduled fires", async () => {
  listSkills.mockResolvedValueOnce([{ id: "s1", name: "Отчёт", icon: "▶", prompt: "go", workspaceId: null }]);
  const panel = new SkillsPanel(document.createElement("div"), () => null, () => {}, () => {});
  await panel.load();
  expect(panel.find("s1")?.name).toBe("Отчёт");
  expect(panel.find("nope")).toBeUndefined();
});
