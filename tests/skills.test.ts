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
    { id: "s1", name: "Report", icon: "▶", prompt: "go", workspaceId: null,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: {}, enabled: true } },
    { id: "s2", name: "Manual", icon: "▶", prompt: "go", workspaceId: null },
  ]);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => null, () => {}, () => {});
  await panel.load();
  const buttons = mount.querySelectorAll<HTMLButtonElement>(".sk-now");
  expect(buttons).toHaveLength(1); // only the scheduled one
  // The button now says only what it does. What the schedule *is* lives in
  // visible text, because a title attribute is unreachable from the keyboard
  // and went stale between renders.
  expect(buttons[0].title).toContain("Run now");
  const line = mount.querySelector(".sk-sched")!;
  expect(line.textContent).toContain("daily at 09:00");
  expect(line.textContent).toContain("next run");
});

it("clicking ⏰ runs the scenario without triggering the normal launch", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Report", icon: "▶", prompt: "go", workspaceId: null,
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
  listSkills.mockResolvedValueOnce([{ id: "s1", name: "Report", icon: "▶", prompt: "go", workspaceId: null }]);
  const panel = new SkillsPanel(document.createElement("div"), () => null, () => {}, () => {});
  await panel.load();
  expect(panel.find("s1")?.name).toBe("Report");
  expect(panel.find("nope")).toBeUndefined();
});

// #249, at the edit dialog. A scheduled scenario is listed in every workspace,
// so the panel routinely hands the form a scenario pinned somewhere else — and
// what it hands over is the scenario's own pin, not the one on screen.
it("opens the edit form with the scenario's own pin, not the active workspace", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Nightly", icon: "play", prompt: "go", workspaceId: "w2",
      schedule: { preset: { kind: "daily", hour: 3, minute: 0 }, defaults: {}, enabled: true } },
  ]);
  skillForm.mockResolvedValueOnce(null);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => "w1", () => {}, () => {},
    () => ["w1", "w2"], () => "One", () => {}, (id) => (id === "w2" ? "Two" : null));
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-edit")!.click();
  await Promise.resolve();
  expect(skillForm).toHaveBeenCalledWith(
    "w1", expect.objectContaining({ workspaceId: "w2" }), "One", "Two");
});

// The one scenario that arrives unpinned on purpose: its workspace is gone, and
// the row's tooltip sends people to this dialog to pick a live one. Keeping the
// dangling pin would make that impossible.
it("opens an orphan's edit form unpinned so a workspace can be picked", async () => {
  listSkills.mockResolvedValueOnce([
    { id: "s1", name: "Nightly", icon: "play", prompt: "go", workspaceId: "gone" },
  ]);
  skillForm.mockResolvedValueOnce(null);
  const mount = document.createElement("div");
  const panel = new SkillsPanel(mount, () => "w1", () => {}, () => {},
    () => ["w1"], () => "One", () => {}, () => null);
  await panel.load();
  mount.querySelector<HTMLButtonElement>(".sk-edit")!.click();
  await Promise.resolve();
  expect(skillForm).toHaveBeenCalledWith(
    "w1", expect.objectContaining({ workspaceId: null }), "One", null);
});
