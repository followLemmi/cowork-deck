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

/** Tooltip for the open-task badge. English needs one distinction rather than
 *  the three the Russian original agreed with, but it still needs that one:
 *  "1 open tasks" reads as a bug in the code, not as a count. */
export function openTaskCountLabel(n: number): string {
  return `${n} open task${n === 1 ? "" : "s"}`;
}

export class WorkspacesPanel {
  /** Scenarios, so deletion can report what it will strand. Injected because
   *  the skills panel owns them and loads independently. */
  private getSkills: () => Skill[] = () => [];
  setSkillsSource(get: () => Skill[]) { this.getSkills = get; }
  private items: Workspace[] = [];
  private activeId: string | null = null;
  /** Open tasks per workspace; filled in by main.ts. */
  private counts = new Map<string, number>();
  constructor(
    private mount: HTMLElement,
    private onSelect: (ws: Workspace) => void,
    private onChanged?: () => void,
    /** Привязка воркспейса к GitHub-аккаунту изменилась: живые сессии этого
     *  воркспейса работают на устаревшем окружении до перезапуска. */
    private onGithubChanged: (workspaceId: string) => void = () => {},
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
    const res = await workspaceForm({
      // The id is what lets the form count the cards still in the old folder
      // before offering to leave them behind.
      id: cur.id, name: cur.name, path: cur.path, color: cur.color,
      github: cur.github ?? null, tracker: cur.tracker ?? null,
    });
    if (!res) return;
    const before = JSON.stringify(cur.github ?? null);
    this.items = await saveWorkspace({ ...cur, ...res });
    if (JSON.stringify(res.github ?? null) !== before) this.onGithubChanged(id);
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
      const isActive = w.id === this.activeId;
      row.className = "ws-row" + (isActive ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = w.color;
      const label = document.createElement("button");
      label.className = "ws-label"; label.textContent = w.name;
      // The one element in the row that truncates was the one without a tooltip,
      // while the two that had them are what caused it. Reaches AT through the
      // button's own text; this is for the sighted user reading "co…".
      label.title = w.name;
      // Which workspace is active was carried by `.ws-row.active`'s tint and inset
      // border alone — nothing a screen reader reports. On the button rather than
      // on the row, because the button is what the person lands on and what a
      // reader announces.
      if (isActive) label.setAttribute("aria-current", "true");
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
      // Appended last because `.ws-account` now wraps onto the row's second
      // line, and the DOM order is what a screen reader follows: `order: 1`
      // would put it last visually while it still read between the name and
      // the count (1.3.2, meaningful sequence).
      if (w.github) {
        const acc = document.createElement("span");
        acc.className = "ws-account";
        acc.textContent = w.github.login;
        acc.title = `GitHub: ${w.github.login}`;
        row.append(acc);
      }
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ws-add"; addBtn.textContent = "+ workspace";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
