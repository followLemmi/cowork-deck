import { listWorkspaces, saveWorkspace, removeWorkspace, loadUiState, saveUiState, type Workspace, type UiState, type Skill } from "./ipc";
import { confirmModal } from "./modal";
import { workspaceForm } from "./forms";
import { iconButton } from "./icons";

/** Confirmation text for deleting a workspace. Deleting one strands every
 *  scenario pinned to it — they stop being runnable, and any schedule on them
 *  quietly stops producing anything — so the count belongs in the question,
 *  not in a surprise afterwards. */
export function describeDeleteImpact(workspaceId: string, skills: Skill[]): string {
  const pinned = skills.filter((s) => s.workspaceId === workspaceId);
  if (pinned.length === 0) return "Delete workspace?";
  const scheduled = pinned.filter((s) => s.schedule?.enabled).length;
  const noun = pinned.length === 1 ? "scenario is" : "scenarios are";
  const tail = scheduled > 0 ? `, ${scheduled} of them scheduled` : "";
  return `Delete workspace? ${pinned.length} ${noun} pinned to it${tail}`
    + " — they will stop running.";
}

/** Russian plural agreement for the open-task badge tooltip: 1 / 2-4 / 5+ each
 *  take a different noun+adjective form ("1 открытая задача", "2 открытые
 *  задачи", "5 открытых задач") — "N открытых задач" is wrong for 1 and for
 *  2-4. The 11-14 exception is genitive plural like 5+, same as in English
 *  "11th" not "11st". */
export function openTaskCountLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} открытая задача`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} открытые задачи`;
  return `${n} открытых задач`;
}

export class WorkspacesPanel {
  /** Scenarios, so deletion can report what it will strand. Injected because
   *  the skills panel owns them and loads independently. */
  private getSkills: () => Skill[] = () => [];
  setSkillsSource(get: () => Skill[]) { this.getSkills = get; }
  private items: Workspace[] = [];
  private activeId: string | null = null;
  /** Открытых задач на пространство; заполняет main.ts. */
  private counts = new Map<string, number>();
  constructor(
    private mount: HTMLElement,
    private onSelect: (ws: Workspace) => void,
    private onChanged?: () => void,
  ) {}

  setCounts(counts: Record<string, number>) {
    this.counts = new Map(Object.entries(counts));
    this.render();
  }

  get active(): Workspace | null {
    return this.items.find((w) => w.id === this.activeId) ?? null;
  }

  get all(): Workspace[] { return this.items; }

  async load() {
    this.items = await listWorkspaces();
    if (!this.activeId && this.items.length) {
      const saved = (await loadUiState()).activeWorkspaceId;
      const pick = saved && this.items.some((w) => w.id === saved) ? saved : this.items[0].id;
      this.select(pick);
    }
    this.render();
  }

  private select(id: string) {
    this.activeId = id;
    saveUiState({ activeWorkspaceId: id }).catch((e) => console.debug("saveUiState failed", e));
    const ws = this.active;
    if (ws) this.onSelect(ws);
    this.render();
  }

  private async add() {
    const res = await workspaceForm();
    if (!res) return;
    const ws: Workspace = { id: crypto.randomUUID(), ...res };
    this.items = await saveWorkspace(ws);
    this.onChanged?.();
    this.select(ws.id);
  }

  private async edit(id: string) {
    const cur = this.items.find((w) => w.id === id);
    if (!cur) return;
    const res = await workspaceForm({ name: cur.name, path: cur.path, color: cur.color, tracker: cur.tracker ?? null });
    if (!res) return;
    this.items = await saveWorkspace({ ...cur, ...res });
    this.onChanged?.();
    this.render();
  }

  private async del(id: string) {
    if (!(await confirmModal(describeDeleteImpact(id, this.getSkills())))) return;
    this.items = await removeWorkspace(id);
    if (this.activeId === id) {
      const next = this.items[0]?.id ?? null;
      this.activeId = null;
      if (next) { this.select(next); return; } // select() fires onSelect + renders
      this.render();
      return;
    }
    // A non-active workspace was deleted: its sessions (if any) are now orphans.
    // Re-notify so the Deck recomputes tile visibility + sidebar grouping.
    const active = this.active;
    if (active) this.onSelect(active);
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Workspaces</h3>";
    for (const w of this.items) {
      const row = document.createElement("div");
      row.className = "ws-row" + (w.id === this.activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = w.color;
      const label = document.createElement("button");
      label.className = "ws-label"; label.textContent = w.name;
      label.onclick = () => this.select(w.id);
      const edit = iconButton("pencil", `Edit workspace: ${w.name}`, "ws-edit");
      edit.onclick = () => this.edit(w.id);
      const x = iconButton("trash", `Delete workspace: ${w.name}`, "ws-del btn--icon--danger");
      x.onclick = () => this.del(w.id);
      row.append(dot, label);
      const n = this.counts.get(w.id) ?? 0;
      if (n > 0) {
        const count = document.createElement("span");
        count.className = "ws-count";
        count.textContent = String(n);
        count.title = openTaskCountLabel(n);
        row.append(count);
      }
      row.append(edit, x);
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ws-add"; addBtn.textContent = "+ workspace";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
