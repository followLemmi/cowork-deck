import type { ProviderCapabilities, Task } from "./ipc";
import { boardColumns, derivedStatus, kindLabel, type TaskSessionLink } from "./tasks";

export interface BoardState {
  project: string;
  caps: ProviderCapabilities | null;
  error: string | null;
  tasks: Task[];
  links: TaskSessionLink[];
}

export interface BoardHandlers {
  onLaunch: (task: Task) => void;
  onResolve: (task: Task) => void;
  onNew: () => void;
  onConfigure: () => void;
}

/** `caps === null` means no tracker is configured — a legal state, not a failure. */
export function emptyStateMessage(
  caps: ProviderCapabilities | null,
  error: string | null,
): { text: string; canConfigure: boolean } {
  if (caps === null) {
    return { text: "Трекер не настроен для этого пространства.", canConfigure: true };
  }
  if (error) return { text: error, canConfigure: true };
  return { text: "Задач нет.", canConfigure: false };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always textContent: titles and bodies come from files written by the user
  // or by an agent, and must never be parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

export class BoardView {
  readonly mount = el("div", "tk-board");
  constructor(private h: BoardHandlers) {}

  render(state: BoardState) {
    this.mount.replaceChildren();
    const { caps, error } = state;

    const head = el("div", "tk-head");
    head.append(el("h3", "tk-title", "Задачи"));
    if (caps?.canCreate) {
      const add = el("button", "tk-new", "+ задача");
      add.onclick = () => this.h.onNew();
      head.append(add);
    }
    this.mount.append(head);

    if (caps === null || error) {
      const msg = emptyStateMessage(caps, error);
      const box = el("div", "tk-empty");
      box.append(el("p", undefined, msg.text));
      if (msg.canConfigure) {
        const btn = el("button", "tk-configure", "Настроить");
        btn.onclick = () => this.h.onConfigure();
        box.append(btn);
      }
      this.mount.append(box);
      return;
    }

    const cols = boardColumns(state.tasks, state.project);
    const wrap = el("div", "tk-cols");
    wrap.append(
      this.column(`open (${cols.open.length})`, cols.open, state, caps),
      this.column(
        cols.doneHidden > 0 ? `done (${cols.done.length}+${cols.doneHidden})` : `done (${cols.done.length})`,
        cols.done, state, caps,
      ),
    );
    this.mount.append(wrap);

    if (cols.open.length === 0 && cols.done.length === 0) {
      this.mount.append(el("div", "tk-empty", emptyStateMessage(caps, null).text));
    }

    for (const f of cols.foreign) {
      this.mount.append(el(
        "p", "tk-foreign",
        `${f.count} карточк(и) с другим project: ${f.project} — переименовано пространство?`,
      ));
    }
  }

  private column(label: string, tasks: Task[], state: BoardState, caps: ProviderCapabilities) {
    const col = el("div", "tk-col");
    col.append(el("div", "tk-col-head", label));
    for (const t of tasks) col.append(this.card(t, state, caps));
    return col;
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");

    box.append(el("div", "tk-card-title", t.title));

    const meta = el("div", "tk-meta");
    meta.append(el("span", "tk-kind", kindLabel(t.kind)));
    if (t.origin === "session") meta.append(el("span", "tk-bot", "сессия"));
    if (status === "working") meta.append(el("span", "tk-busy", "в работе"));
    box.append(meta);

    if (t.damaged) {
      box.append(el("p", "tk-warn", `повреждена: ${t.damaged} · id ${t.id} · ${t.path}`));
    }
    if (t.conflict) {
      box.append(el("p", "tk-warn", `несколько файлов с id ${t.id} — исправьте вручную`));
    }

    const acts = el("div", "tk-acts");
    // No ▶ while a session for this card is alive: a second one would duplicate
    // the work, exactly as a scheduled scenario skips an overlapping run.
    if (status === "open") {
      const run = el("button", "tk-run", "▶");
      run.title = "Запустить сессию из задачи";
      run.onclick = () => this.h.onLaunch(t);
      acts.append(run);
    }
    // A conflicting card is never closed automatically: we will not guess which
    // of two files to write into.
    if (caps.canResolve && t.status === "open" && !t.conflict) {
      const done = el("button", "tk-done", "✓");
      done.title = "Закрыть задачу";
      done.onclick = () => this.h.onResolve(t);
      acts.append(done);
    }
    if (acts.childElementCount > 0) box.append(acts);
    return box;
  }
}
