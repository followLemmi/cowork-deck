import type { MigrationOffer, ProviderCapabilities, Task } from "./ipc";
import { isTerminal } from "./board-config";
import { boardColumns, derivedStatus, kindLabel, type TaskSessionLink } from "./tasks";

export interface BoardState {
  project: string;
  caps: ProviderCapabilities | null;
  error: string | null;
  tasks: Task[];
  links: TaskSessionLink[];
  /** Optional so the pre-existing render tests keep compiling; absent means
   *  there is nothing to move. */
  migration?: MigrationOffer | null;
}

export interface BoardHandlers {
  onLaunch: (task: Task) => void;
  onResolve: (task: Task) => void;
  onNew: () => void;
  onConfigure: () => void;
  onMigrate: () => void;
  onDismissMigration: () => void;
}

/** `caps === null` means no tracker is configured — a legal state, not a failure. */
export function emptyStateMessage(
  caps: ProviderCapabilities | null,
  error: string | null,
): { text: string; canConfigure: boolean } {
  if (caps === null) {
    return { text: "No task tracker is configured for this workspace.", canConfigure: true };
  }
  if (error) return { text: error, canConfigure: true };
  return { text: "No tasks.", canConfigure: false };
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
    head.append(el("h3", "tk-title", "Tasks"));
    if (caps?.canCreate) {
      const add = el("button", "tk-new", "+ task");
      add.onclick = () => this.h.onNew();
      head.append(add);
    }
    this.mount.append(head);

    // Before the early return on purpose: when the destination's parent is
    // missing, the error and this banner explain each other.
    if (state.migration) this.mount.append(this.migrationBanner(state.migration));

    if (caps === null || error) {
      const msg = emptyStateMessage(caps, error);
      const box = el("div", "tk-empty");
      box.append(el("p", undefined, msg.text));
      if (msg.canConfigure) {
        const btn = el("button", "tk-configure", "Configure");
        btn.onclick = () => this.h.onConfigure();
        box.append(btn);
      }
      this.mount.append(box);
      return;
    }

    const cols = boardColumns(state.tasks, state.project, caps.board);
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
        `${f.count} card(s) name a different project: ${f.project} — was the workspace renamed?`,
      ));
    }
  }

  /** Cards left at a previous root. Rendered as a banner rather than a modal so
   *  it survives an app restart and does not demand a decision at save time. */
  private migrationBanner(m: MigrationOffer): HTMLElement {
    const box = el("div", "tk-migrate");
    box.append(el(
      "p", "tk-migrate-count",
      `${m.moving} card${m.moving === 1 ? "" : "s"} ${m.moving === 1 ? "is" : "are"} still in the previous location:`,
    ));
    box.append(el("p", "tk-migrate-from", m.from));
    if (m.leavingForeign > 0) {
      box.append(el(
        "p", "tk-migrate-foreign",
        `${m.leavingForeign} card${m.leavingForeign === 1 ? "" : "s"} there belong${m.leavingForeign === 1 ? "s" : ""} to other projects and stay.`,
      ));
    }
    if (m.leavingDamaged > 0) {
      box.append(el(
        "p", "tk-migrate-foreign",
        `${m.leavingDamaged} damaged card${m.leavingDamaged === 1 ? "" : "s"} there stay too — a damaged card in a shared folder may not be ours.`,
      ));
    }

    const acts = el("div", "tk-migrate-acts");
    const go = el("button", "tk-migrate-go", "Move them here");
    go.onclick = () => this.h.onMigrate();
    const skip = el("button", "tk-migrate-skip", "Leave them there");
    skip.onclick = () => this.h.onDismissMigration();
    acts.append(go, skip);
    box.append(acts);

    // Not decoration: after this the cards are outside the effective root and
    // the board will not show them again. Recoverable by hand, but it reads as
    // disappearance, so the button cannot just say "Leave them" and stop.
    box.append(el(
      "p", "tk-migrate-consequence",
      "Left there, they stay on disk but this board will not show them.",
    ));
    if (m.renamingProject) {
      box.append(el(
        "p", "tk-migrate-consequence",
        "Moving them also updates the project name inside each card.",
      ));
    }
    return box;
  }

  private column(label: string, tasks: Task[], state: BoardState, caps: ProviderCapabilities) {
    const col = el("div", "tk-col");
    col.append(el("div", "tk-col-head", label));
    for (const t of tasks) col.append(this.card(t, state, caps));
    return col;
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links, caps.board);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");

    box.append(el("div", "tk-card-title", t.title));

    const meta = el("div", "tk-meta");
    meta.append(el("span", "tk-kind", kindLabel(caps.board, t.kind)));
    if (t.origin === "session") meta.append(el("span", "tk-bot", "session"));
    if (status === "working") meta.append(el("span", "tk-busy", "in progress"));
    box.append(meta);

    if (t.damaged) {
      box.append(el("p", "tk-warn", `damaged: ${t.damaged} · id ${t.id} · ${t.path}`));
    }
    if (t.conflict) {
      box.append(el("p", "tk-warn", `more than one file carries id ${t.id} — fix it by hand`));
    }

    const acts = el("div", "tk-acts");
    // ▶ is hidden while the card reads as "in progress" (a working/waitingInput
    // session). An idle session still linked to the card slips through here —
    // that's fine: the launch guard in Deck.launchFromTask catches it and
    // focuses the existing session instead of starting a second one.
    // A damaged card's `project:` may be missing or wrong (that can be *why*
    // it's damaged), so launching from it either fails or lands in the wrong
    // workspace — hide ▶ the same way ✓ is hidden below.
    if (status === "open" && !t.damaged) {
      const run = el("button", "tk-run", "▶");
      run.title = "Start a session from this task";
      run.setAttribute("aria-label", "Start a session from this task");
      run.onclick = () => this.h.onLaunch(t);
      acts.append(run);
    }
    // A conflicting card is never closed automatically: we will not guess which
    // of two files to write into. A damaged card is never closed either: it may
    // be an ordinary Obsidian note that merely has an `id:` field, and
    // resolving it would rewrite a file we do not own (see fs.rs::resolve).
    // Already in a terminal step: there is nothing for ✓ to do. Asked of the
    // configuration, because which steps those are is board.json's decision.
    if (caps.canResolve && !isTerminal(caps.board, t.status) && !t.conflict && !t.damaged) {
      const done = el("button", "tk-done", "✓");
      done.title = "Close this task";
      done.setAttribute("aria-label", "Close this task");
      done.onclick = () => this.h.onResolve(t);
      acts.append(done);
    }
    if (acts.childElementCount > 0) box.append(acts);
    return box;
  }
}
