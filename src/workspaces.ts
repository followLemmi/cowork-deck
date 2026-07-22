import { listWorkspaces, saveWorkspace, removeWorkspace, type Workspace } from "./ipc";

export class WorkspacesPanel {
  private items: Workspace[] = [];
  private activeId: string | null = null;
  constructor(private mount: HTMLElement, private onSelect: (ws: Workspace) => void) {}

  get active(): Workspace | null {
    return this.items.find((w) => w.id === this.activeId) ?? null;
  }

  async load() {
    this.items = await listWorkspaces();
    if (!this.activeId && this.items[0]) this.select(this.items[0].id);
    this.render();
  }

  private select(id: string) {
    this.activeId = id;
    const ws = this.active;
    if (ws) this.onSelect(ws);
    this.render();
  }

  private async add() {
    const name = prompt("Имя пространства")?.trim();
    if (!name) return;
    const path = prompt("Путь к папке проекта")?.trim();
    if (!path) return;
    const ws: Workspace = { id: crypto.randomUUID(), name, path, color: "#3b82f6" };
    this.items = await saveWorkspace(ws);
    this.select(ws.id);
  }

  private async del(id: string) {
    if (!confirm("Удалить пространство?")) return;
    this.items = await removeWorkspace(id);
    if (this.activeId === id) this.activeId = this.items[0]?.id ?? null;
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Пространства</h3>";
    for (const w of this.items) {
      const row = document.createElement("div");
      row.className = "ws-row" + (w.id === this.activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = w.color;
      const label = document.createElement("button");
      label.className = "ws-label"; label.textContent = w.name;
      label.onclick = () => this.select(w.id);
      const x = document.createElement("button");
      x.className = "ws-del"; x.textContent = "✕";
      x.onclick = () => this.del(w.id);
      row.append(dot, label, x);
      this.mount.appendChild(row);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ws-add"; addBtn.textContent = "+ пространство";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
