import { listSkills, saveSkill, removeSkill, loadScheduleState, type ScheduleRun, type Skill } from "./ipc";
import { confirmModal } from "./modal";
import { skillForm } from "./forms";
import { scheduleRowText } from "./schedule";

/** A scenario pinned to a workspace that no longer exists. It cannot run —
 *  `resolveScheduledWorkspace` refuses rather than picking the wrong folder —
 *  so it has to stay reachable for the user to repin or delete it.
 *
 *  Nothing is an orphan until at least one workspace is known: workspaces load
 *  asynchronously, and an empty list means "not loaded yet" far more often
 *  than it means "the user has none". */
export function isOrphan(skill: Skill, knownWorkspaceIds: string[]): boolean {
  if (!skill.workspaceId || knownWorkspaceIds.length === 0) return false;
  return !knownWorkspaceIds.includes(skill.workspaceId);
}

/** Which scenarios the sidebar shows: unpinned ones, those pinned to the
 *  active workspace, and orphans — which belong nowhere and would otherwise
 *  be invisible everywhere. */
export function visibleSkills(
  items: Skill[],
  activeWorkspaceId: string | null,
  knownWorkspaceIds: string[],
): Skill[] {
  return items.filter((s) =>
    !s.workspaceId
    || s.workspaceId === activeWorkspaceId
    || s.schedule?.enabled // fires regardless of what is on screen
    || isOrphan(s, knownWorkspaceIds));
}

export class SkillsPanel {
  private items: Skill[] = [];
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
    private onRunScheduled: (skill: Skill) => void,
    /** Ids of the workspaces that currently exist — used to spot scenarios
     *  pinned to a deleted one. Defaults to "unknown", which marks nothing. */
    private getWorkspaceIds: () => string[] = () => [],
    private getActiveWorkspaceName: () => string | null = () => null,
  ) {}

  private runs: Record<string, ScheduleRun> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  async load() {
    this.items = await listSkills();
    await this.refreshRuns();
    // "next run" is a moving target; without this the row would claim
    // "today 09:00" long after 09:00 has passed, which is exactly how the
    // old tooltip misled people.
    if (this.refreshTimer === null) {
      this.refreshTimer = setInterval(() => this.render(), 60_000);
    }
  }

  /** Re-read what the backend knows about past runs, then repaint. Called on
   *  load and after every fire, so an outcome shows up without a restart. */
  async refreshRuns() {
    try {
      this.runs = await loadScheduleState();
    } catch (e) {
      console.debug("loadScheduleState failed", e);
    }
    this.render();
  }

  find(id: string): Skill | undefined { return this.items.find((s) => s.id === id); }
  get all(): Skill[] { return this.items; }

  private visible(): Skill[] {
    return visibleSkills(this.items, this.getActiveWorkspaceId(), this.getWorkspaceIds());
  }

  private async add() {
    const res = await skillForm(this.getActiveWorkspaceId(), undefined, this.getActiveWorkspaceName());
    if (!res) return;
    const sk: Skill = { id: crypto.randomUUID(), ...res };
    this.items = await saveSkill(sk);
    this.render();
  }

  private async edit(id: string) {
    const cur = this.items.find((s) => s.id === id);
    if (!cur) return;
    const res = await skillForm(this.getActiveWorkspaceId(), {
      name: cur.name, icon: cur.icon, prompt: cur.prompt, workspaceId: cur.workspaceId ?? null,
      schedule: cur.schedule ?? null,
    }, this.getActiveWorkspaceName());
    if (!res) return;
    this.items = await saveSkill({ ...cur, ...res });
    this.render();
  }

  private async del(id: string) {
    if (!(await confirmModal("Удалить сценарий?"))) return;
    this.items = await removeSkill(id);
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Сценарии</h3>";
    for (const s of this.visible()) {
      const row = document.createElement("div");
      row.className = "sk-row";
      const orphan = isOrphan(s, this.getWorkspaceIds());
      if (orphan) row.classList.add("sk-orphan");
      const run = document.createElement("button");
      run.className = "sk-run"; run.textContent = `${s.icon} ${s.name}`;
      run.title = orphan
        ? "Пространство этого сценария удалено — запустить нельзя. Откройте изменение и выберите пространство."
        : s.prompt;
      run.disabled = orphan;
      run.onclick = () => this.onLaunch(s);

      // The indicator and the action are separate now. One ⏰ used to be
      // both: it looked like a status badge and launched a real session on
      // click, so reaching for information started a run.
      const sched = s.schedule;
      let now: HTMLButtonElement | null = null;
      if (sched?.enabled && !orphan) {
        now = document.createElement("button");
        now.className = "sk-now"; now.textContent = "⏰";
        now.title = "прогнать сейчас, как это сделало бы расписание";
        now.setAttribute("aria-label", `Прогнать сейчас: ${s.name}`);
        now.onclick = () => this.onRunScheduled(s);
      }

      const edit = document.createElement("button");
      edit.className = "sk-edit"; edit.textContent = "✎"; edit.title = "изменить";
      edit.onclick = () => this.edit(s.id);
      const x = document.createElement("button");
      x.className = "sk-del"; x.textContent = "✕";
      x.onclick = () => this.del(s.id);
      row.append(run, ...(now ? [now] : []), edit, x);
      this.mount.appendChild(row);
      if (sched) {
        // Visible text, not a title attribute: a tooltip is unreachable from
        // the keyboard and does not survive a stale render.
        const line = document.createElement("div");
        line.className = sched.enabled ? "sk-sched" : "sk-sched sk-sched-off";
        line.textContent = scheduleRowText(sched, this.runs[s.id] ?? null, new Date());
        this.mount.appendChild(line);
      }
      if (orphan) {
        // Says why the row is dead and what to do; without it the scenario
        // just looks broken.
        const note = document.createElement("div");
        note.className = "sk-orphan-note";
        note.textContent = "пространство удалено — перепривяжите или удалите";
        this.mount.appendChild(note);
      }
    }
    const addBtn = document.createElement("button");
    addBtn.className = "sk-add"; addBtn.textContent = "+ сценарий";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
