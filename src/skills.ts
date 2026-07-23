import { listSkills, saveSkill, removeSkill, type Skill } from "./ipc";
import { promptModal, confirmModal } from "./modal";

export class SkillsPanel {
  private items: Skill[] = [];
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
  ) {}

  async load() { this.items = await listSkills(); this.render(); }

  private visible(): Skill[] {
    const wid = this.getActiveWorkspaceId();
    return this.items.filter((s) => !s.workspaceId || s.workspaceId === wid);
  }

  private async add() {
    const name = (await promptModal("Имя сценария"))?.trim();
    if (!name) return;
    const icon = (await promptModal("Значок (эмодзи)", "▶"))?.trim() || "▶";
    const promptText = (await promptModal("Текст задания (первое сообщение)"))?.trim();
    if (!promptText) return;
    const scope = await confirmModal("Привязать к текущему пространству? (Отмена = общий)");
    const sk: Skill = {
      id: crypto.randomUUID(), name, icon, prompt: promptText,
      workspaceId: scope ? this.getActiveWorkspaceId() : null,
    };
    this.items = await saveSkill(sk);
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
      const x = document.createElement("button");
      x.className = "sk-del"; x.textContent = "✕";
      x.onclick = () => this.del(s.id);
      row.append(run, x);
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "sk-add"; addBtn.textContent = "+ сценарий";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
