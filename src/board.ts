import type { MigrationOffer, ProviderCapabilities, Task } from "./ipc";
import { isTerminal } from "./board-config";
import { boardColumns, derivedStatus, isStale, kindLabel, type BoardColumn, type TaskSessionLink } from "./tasks";

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

    // The fallback board still draws underneath this: silently keeping a
    // renamed terminal step open would be a worse lie than a banner that says so.
    // Read off `caps.boardError` directly rather than a second field on `state`:
    // `caps` is already non-null here (the early return above caught the other
    // case), so a separate channel for the same value could only disagree with it.
    if (caps.boardError) {
      this.mount.append(el(
        "p", "tk-board-error",
        `board.json could not be used: ${caps.boardError}. The default two-step board is shown instead, ` +
        "so cards may appear in the wrong column. The file was left alone.",
      ));
    }

    const cols = boardColumns(state.tasks, state.project, caps.board);
    const wrap = el("div", "tk-cols");
    for (const c of cols.columns) wrap.append(this.column(c, state, caps));
    if (cols.unknown.length > 0) {
      // `id: ""` on purpose: it is not a configured step, and column() only
      // sets `data-step` for a non-empty id — see the comment there.
      const unknownCol = this.column(
        { step: { id: "", label: "unknown step" }, tasks: cols.unknown, hidden: 0 }, state, caps,
      );
      unknownCol.classList.add("tk-col-unknown");
      wrap.append(unknownCol);
    }
    this.mount.append(wrap);

    if (cols.columns.every((c) => c.tasks.length === 0) && cols.unknown.length === 0) {
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

  /** `col.step.id` lands on `data-step`: task 8 reads it as the drop target,
   *  even though nothing consumes it yet. Never set for the synthetic unknown
   *  column (`id: ""`): it is not a configured step, so a drop there would
   *  write `status: unknown` and leave the card in the same column, corrupt in
   *  a second way — and a real step legitimately named `unknown` would collide
   *  with it. Leaving `data-step` off lets Task 8's `[data-step]` selector
   *  exclude this column without knowing any magic string. */
  private column(col: BoardColumn, state: BoardState, caps: ProviderCapabilities) {
    const node = el("div", "tk-col");
    if (col.step.id) node.dataset.step = col.step.id;
    const heading = col.hidden > 0
      ? `${col.step.label} (${col.tasks.length}+${col.hidden})`
      : `${col.step.label} (${col.tasks.length})`;
    node.append(el("div", "tk-col-head", heading));
    for (const t of col.tasks) node.append(this.card(t, state, caps));
    return node;
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links, caps.board);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");

    box.append(el("div", "tk-card-title", t.title));

    const meta = el("div", "tk-meta");
    const kind = kindLabel(caps.board, t.kind);
    if (kind) meta.append(el("span", "tk-kind", kind));
    if (t.origin === "session") meta.append(el("span", "tk-bot", "session"));
    if (status === "working") meta.append(el("span", "tk-busy", "in progress"));
    if (t.damaged || t.conflict) {
      const reasons: string[] = [];
      if (t.damaged) reasons.push(`damaged: ${t.damaged} · id ${t.id} · ${t.path}`);
      // Names the path too: a conflict is resolved by hand, in a file the
      // person has to be able to find.
      if (t.conflict) reasons.push(`more than one file carries id ${t.id} — fix it by hand · ${t.path}`);
      const warn = el("span", "tk-warn-glyph", "⚠");
      const message = reasons.join(" — ");
      warn.title = message;
      warn.setAttribute("aria-label", message);
      // An aria-label on a bare span is not reliably announced; role="img"
      // makes it so. A damaged card's only remaining signal is this glyph.
      warn.setAttribute("role", "img");
      meta.append(warn);
    }
    if (isStale(t, state.links, caps.board)) {
      const stale = el("span", "tk-stale", "no live session");
      stale.title = "This card sits in the working step, but no session is running on it.";
      meta.append(stale);
    }
    box.append(meta);

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
    // Always present, even empty: this is what makes the fixed card height
    // (styles.css .tk-card) hold — the meta and action rows sit at the same
    // offset whatever the card's own content.
    box.append(acts);
    return box;
  }
}
