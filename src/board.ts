import type { MigrationOffer, ProviderCapabilities, StepId, Task } from "./ipc";
import { isTerminal, stepAfter, stepBefore } from "./board-config";
import { countLine, needsTotals, rateLimitBanner, type TaskSource } from "./issues";
import { ago } from "./pr";
import { GH_UNAVAILABLE, type GhUnavailable } from "./pr-view";
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
  /** The five below are optional for the same reason `migration` is: the file
   *  board's own suites build `BoardState` literals in a dozen places, and a
   *  required field would fail `tsc` in files this has no business touching.
   *  Absent is also the honest default — a file board has none of them. */
  source?: TaskSource;
  /** When `tasks` was read. Null before the first successful fetch. */
  fetchedAt?: number | null;
  /** Non-null when the source cannot be read at all — never drawn as an empty
   *  board, from which a broken token is indistinguishable from a quiet
   *  repository. */
  unavailable?: GhUnavailable | null;
  /** Open issues in the repository, when a capped page made the number worth
   *  asking for. */
  total?: number | null;
  /** GraphQL points left this hour. Null when the headers said nothing. */
  rateRemaining?: number | null;
}

export interface BoardHandlers {
  onLaunch: (task: Task) => void;
  onResolve: (task: Task) => void;
  onNew: () => void;
  onConfigure: () => void;
  onMigrate: () => void;
  onDismissMigration: () => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, step: StepId) => void;
  onEditBoard: () => void;
  /** The one addition that cannot be optional: a box offering a button that does
   *  nothing is worse than no box. */
  onFixUnavailable: (u: GhUnavailable) => void;
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

  /** `now` is a parameter, not a `Date.now()` inside, so the age line is
   *  assertable; defaulted for the callers that predate it. */
  render(state: BoardState, now: number = Date.now()) {
    this.mount.replaceChildren();
    const { caps, error } = state;
    const fetchedAt = state.fetchedAt ?? null;

    const head = el("div", "tk-head");
    head.append(el("h3", "tk-title", "Tasks"));
    if (caps?.canCreate) {
      const add = el("button", "tk-new", "+ task");
      add.onclick = () => this.h.onNew();
      head.append(add);
    }
    // Shown whenever the board is the person's to configure, even while
    // `caps.boardError` is set: main.ts::editBoard tells them about that before
    // opening the form, rather than hiding the only way to fix it. Withheld for
    // a synthesized board — there is no `board.json` to write, and one synthetic
    // kind is not a choice.
    if (caps?.boardEditable) {
      const edit = el("button", "tk-board-edit", "⚙");
      edit.setAttribute("aria-label", "Configure the board");
      edit.onclick = () => this.h.onEditBoard();
      head.append(edit);
    }
    // In the head, so it survives every early return below: data that can be
    // stale has to say how stale on every render, not only on the happy one.
    head.append(el("span", "tk-age",
      fetchedAt === null ? "never loaded" : `updated ${ago(new Date(fetchedAt).toISOString(), now)}`));
    this.mount.append(head);

    // Before the early return on purpose: when the destination's parent is
    // missing, the error and this banner explain each other.
    if (state.migration) this.mount.append(this.migrationBanner(state.migration));

    // An unavailable source is not an empty board, and drawing it as one makes a
    // broken token look like a repository with no issues.
    if (state.unavailable) {
      const spec = GH_UNAVAILABLE[state.unavailable];
      const box = el("div", "tk-unavailable");
      box.append(el("p", "tk-unavailable-text", spec.text));
      if (spec.action) {
        const fix = el("button", "tk-fix", spec.action);
        const u = state.unavailable;
        fix.onclick = () => this.h.onFixUnavailable(u);
        box.append(fix);
      }
      this.mount.append(box);
      return;
    }

    // A failure with a last good list keeps it — offline and rate-limited are not
    // their own screens (see below). A failure with nothing to show is still this
    // screen: empty columns under an error read as a folder with no cards in
    // them, and this is also the only place `Configure` is offered for a root
    // that cannot be read.
    if (caps === null || (error !== null && state.tasks.length === 0)) {
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

    // The last good list stays on screen beside the failure, with its age above
    // it, exactly as the pull request view does.
    if (error !== null) this.mount.append(el("p", "tk-error", error));

    // The fallback board still draws underneath this: silently keeping a
    // renamed terminal step open would be a worse lie than a banner that says so.
    // Read off `caps.boardError` directly rather than a second field on `state`:
    // `caps` is already non-null here (the early return above caught the other
    // case), so a separate channel for the same value could only disagree with it.
    if (caps.boardError) {
      // The message says what is wrong; the wrapper only says what the board did
      // about it, and only the file-backed case has a `board.json` or a fallback
      // board to describe. A second sender arrived with the GitHub source — an
      // unreadable source, a full sentence of its own — and every clause of the
      // wrapper was false for it, the interpolated full stop included.
      const detail = state.source === "github"
        ? caps.boardError
        : `board.json could not be used: ${caps.boardError}. The default two-step board is shown ` +
          "instead, so cards may appear in the wrong column. The file was left alone.";
      this.mount.append(el("p", "tk-board-error", detail));
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

    // Both from their pure rules, and both silent unless they have something to
    // say. The count is measured against the non-terminal column rather than
    // `state.tasks`: closed issues come down the same list and are not what
    // "of 63 open" counts. Found by predicate, not by index — a board's first
    // step is the open one by convention, not by construction.
    const rate = rateLimitBanner(state.rateRemaining ?? null);
    if (rate) this.mount.append(el("p", "tk-rate", rate));
    // Gated on the source as well as on the numbers: "of 63 open issues" is a
    // statement about a repository, and a file board has none. A `total` can reach
    // one — the last-good list is keyed by workspace and survives a source switch
    // — so the gate is here rather than left to whoever fills the field.
    const openCol = cols.columns.find((c) => c.step.terminal !== true);
    const shown = openCol?.tasks.length ?? 0;
    // `needsTotals` is the same predicate `main.ts` asks before the totals call —
    // a page at the cap is a capped page — so the sentence and the call that feeds
    // it cannot disagree about which pages have more behind them.
    const count = state.source === "github"
      ? countLine(shown, state.total ?? null, needsTotals(shown))
      : null;
    if (count) this.mount.append(el("p", "tk-count", count));

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
    if (col.step.id) {
      node.dataset.step = col.step.id;
      this.makeDropTarget(node, col.step.id, state);
    }
    const heading = col.hidden > 0
      ? `${col.step.label} (${col.tasks.length}+${col.hidden})`
      : `${col.step.label} (${col.tasks.length})`;
    node.append(el("div", "tk-col-head", heading));
    for (const t of col.tasks) node.append(this.card(t, state, caps));
    return node;
  }

  /** Only called for a column carrying `data-step` — see the comment above
   *  `column()` for why the unknown column never reaches here. */
  private makeDropTarget(node: HTMLElement, step: StepId, state: BoardState) {
    node.ondragover = (e) => {
      // Without this a drop never fires at all — it is the browser's default.
      e.preventDefault();
      // The cursor otherwise shows the browser's default badge — a copy `+` —
      // on what is a move.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      node.classList.add("tk-col-over");
    };
    node.ondragleave = () => node.classList.remove("tk-col-over");
    node.ondrop = (e) => {
      e.preventDefault();
      node.classList.remove("tk-col-over");
      const id = e.dataTransfer?.getData("text/plain");
      const task = id ? state.tasks.find((t) => t.id === id) : undefined;
      // Not redundant with `draggable` above: that is decided when the card is
      // rendered, but this looks the task up in the freshest `state.tasks` —
      // deliberately, so a drop acts on the card as it is now. On a board that
      // re-polls every five seconds those two moments can differ: a card
      // writable at `dragstart` can be damaged or conflicting by the time the
      // drop lands, and only this check sees that. A drop into the card's own
      // column is likewise not a move: no write, no refresh.
      if (task && !task.damaged && !task.conflict && task.status !== step) this.h.onMove(task, step);
    };
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links, caps.board);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");

    // The same condition card-modal.ts's `canWrite` applies to the whole
    // modal, and `▶`/`✓` apply below: a damaged card's fields may be
    // unreadable and a conflicting card's file is ambiguous, so a step write
    // is refused server-side either way (see fs.rs's update guards). Offering
    // a control that can only ever error is worse than not offering it.
    const canWrite = !t.damaged && !t.conflict;

    // Native drag needs the id on the wire, and a visual cue while it's in
    // flight; `dragend` fires whether the drop was accepted or not, so it is
    // the one place to take `tk-dragging` back off.
    box.draggable = canWrite;
    box.ondragstart = (e) => {
      e.dataTransfer?.setData("text/plain", t.id);
      // Paired with `makeDropTarget`'s `dropEffect` above: same reason, same badge.
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      box.classList.add("tk-dragging");
    };
    box.ondragend = () => box.classList.remove("tk-dragging");

    // The grid child Task 6 placed, not a child of it: `.tk-card-title` carries
    // `grid-row: 1` and the two-line clamp, so it becomes the button itself —
    // wrapping a button inside it would put the clamp on the div and the click
    // target on something else.
    const openBtn = el("button", "tk-card-title tk-card-open", t.title);
    openBtn.type = "button";
    openBtn.setAttribute("aria-label", `Open card: ${t.title}`);
    openBtn.onclick = () => this.h.onOpen(t);
    box.append(openBtn);

    const meta = el("div", "tk-meta");
    const kind = kindLabel(caps.board, t.kind);
    if (kind) meta.append(el("span", "tk-kind", kind));
    // An issue's labels, and never its kind: an issue can carry two labels where
    // `kind` is a single value, which is why a GitHub card has no kind at all.
    // Chips through `el`, so a label naming itself `<img src=x onerror=…>` — and
    // anyone who can open an issue on a readable repository chooses that text —
    // arrives as characters rather than as markup.
    for (const l of t.labels) meta.append(el("span", "tk-label", l));
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
    // The keyboard equivalent of a drag, and not a fallback for it: xterm eats
    // Tab inside a tile, and every other action here already carries an
    // aria-label. `null` (first step, last step, or a step board.json does not
    // know) means no neighbour, so the arrow is simply not rendered — no
    // separate check for the unknown step, `stepBefore`/`stepAfter` already
    // say "no neighbour" for it. Withheld from a damaged or conflicting card
    // for the same reason `draggable` is above: the write would only ever be
    // refused.
    const prevStep = stepBefore(caps.board, t.status);
    if (prevStep !== null && canWrite) {
      const prev = el("button", "tk-prev", "‹");
      prev.title = "Move to the previous step";
      prev.setAttribute("aria-label", "Move to the previous step");
      prev.onclick = () => this.h.onMove(t, prevStep);
      acts.append(prev);
    }
    // ▶ is hidden while the card reads as "in progress" (a working/waitingInput
    // session). An idle session still linked to the card slips through here —
    // that's fine: the launch guard catches it and focuses the existing session
    // instead of starting a second one. True of both paths now: the file path
    // checks inside `Deck.launchFromTask`, and the issue path checks in `main.ts`
    // *before* preparing a worktree, since a guard behind a fallible IPC call is
    // no guard in the case that needs it.
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
    const nextStep = stepAfter(caps.board, t.status);
    if (nextStep !== null && canWrite) {
      const next = el("button", "tk-next", "›");
      next.title = "Move to the next step";
      next.setAttribute("aria-label", "Move to the next step");
      next.onclick = () => this.h.onMove(t, nextStep);
      acts.append(next);
    }
    // Always present, even empty: this is what makes the fixed card height
    // (styles.css .tk-card) hold — the meta and action rows sit at the same
    // offset whatever the card's own content.
    box.append(acts);
    return box;
  }
}
