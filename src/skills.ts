import { listSkills, saveSkill, removeSkill, type Skill } from "./ipc";
import { confirmModal } from "./modal";
import { skillForm } from "./forms";
import { describeSchedule, nextRunLabel } from "./schedule";

export class SkillsPanel {
  private items: Skill[] = [];
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
    private onRunScheduled: (skill: Skill) => void,
  ) {}

  async load() { this.items = await listSkills(); this.render(); }

  find(id: string): Skill | undefined { return this.items.find((s) => s.id === id); }

  private visible(): Skill[] {
    const wid = this.getActiveWorkspaceId();
    return this.items.filter((s) => !s.workspaceId || s.workspaceId === wid);
  }

  private async add() {
    const res = await skillForm(this.getActiveWorkspaceId());
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
    });
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
      const run = document.createElement("button");
      run.className = "sk-run"; run.textContent = `${s.icon} ${s.name}`;
      run.title = s.prompt;
      run.onclick = () => this.onLaunch(s);

      // Doubles as the schedule indicator: the rule and next run live in its
      // tooltip, so a scheduled scenario carries exactly one ⏰.
      const sched = s.schedule;
      let now: HTMLButtonElement | null = null;
      if (sched?.enabled) {
        now = document.createElement("button");
        now.className = "sk-now"; now.textContent = "⏰";
        now.title = `прогнать сейчас · ${describeSchedule(sched)} · след.: ${nextRunLabel(sched.preset, new Date())}`;
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
    }
    const addBtn = document.createElement("button");
    addBtn.className = "sk-add"; addBtn.textContent = "+ сценарий";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
