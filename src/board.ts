import type { MigrationOffer, ProviderCapabilities, StepId, Task } from "./ipc";
import { firstTerminal, isTerminal, stepAfter, stepBefore, stepLabel } from "./board-config";
import { ghUnavailable, type GhUnavailable } from "./gh-unavailable";
import {
  bodyExcerpt, canShowMore, countLine, initialPageLimit, needsTotals, rateLimitBanner,
  type TaskSource,
} from "./issues";
import { ago } from "./pr";
import { icon } from "./icons";
import { boardColumns, derivedStatus, isStale, kindLabel, type BoardColumn, type TaskSessionLink } from "./tasks";
import { skeleton } from "./skeleton";

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
  /** Closed issues in the repository, on the same terms. The totals call answers
   *  both in one point, so the second number costs nothing once the first is
   *  worth asking for — and the closed filter needs it for exactly the reason the
   *  open one does. */
  closedTotal?: number | null;
  /** GraphQL points left this hour. Null when the headers said nothing. */
  rateRemaining?: number | null;
  /** The read that will replace `tasks` is still in flight.
   *
   *  Drawn as skeleton rows only when there is nothing to keep: a board that
   *  already has a list keeps it, because replacing true-a-moment-ago rows with
   *  grey boxes every 30 s is a worse screen than a slightly stale one. */
  loading?: boolean;
  /** The page size `tasks` were fetched with, or absent for the provider's own
   *  defaults. Read by "Show more" to decide whether it has anything left to ask
   *  for — a page shorter than what was requested is the whole of that state. */
  pageLimit?: number | null;
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
  /** "Show more": raise the page the source is asked for and read it again. Not
   *  optional for the same reason — the view only draws the button where there is
   *  something behind it, so a no-op handler would strand rows nobody can reach.
   *
   *  `from` is the page size the rows on screen were measured against, which only
   *  the view knows: the two states start at different defaults (50 open, 20
   *  closed) and the filter decides which of them the button is under. Handed over
   *  rather than guessed, so the next page is one step past what is actually
   *  shown. */
  onShowMore: (from: number) => void;
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

/** How many grey rows a first load draws. Enough to read as a list rather than
 *  as one stuck row, few enough not to promise a length nobody knows yet. */
const SKELETON_ROWS = 6;

export class BoardView {
  readonly mount = el("div", "tk-board");
  /** Which step the list is filtered to, or null for "whichever comes first".
   *
   *  View state, not board state: switching between Open and Closed needs no
   *  request, so it must not travel through `refreshBoard` and cannot be reset by
   *  a poll landing under the person's hand. Null rather than `"open"` because the
   *  step ids are the configuration's to choose. */
  private filter: StepId | null = null;
  /** The label filter on the GitHub layout, or `null` for "every label". Kept beside
   *  `filter` rather than in `BoardState`: it is a view preference, it survives a poll
   *  because the view is not rebuilt from scratch, and nothing outside this class has
   *  any use for it. */
  private label: string | null = null;
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
      const edit = el("button", "tk-board-edit");
      /* A wrench, not the sliders the top bar's Settings wears: two identical
         glyphs on one screen meaning two different things is worse than either of
         them being slightly less obvious. This one configures THIS board — its
         steps and its kinds — and the app's own settings are elsewhere. */
      edit.append(icon("wrench", 15));
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
      // "issues", because that is what this board reads when it has a GitHub
      // source at all — the same three states on the pull request view name that
      // view's subject instead.
      const spec = ghUnavailable(state.unavailable, "issues");
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

    // Before the `caps === null` branch below, and that order is the whole point.
    // The first read of a GitHub board is three `gh` calls deep — a repository
    // lookup and a page per state — and `caps` arrives from a call of its own, so
    // for those seconds the state on screen is "no capabilities yet, no tasks
    // yet". Drawn by the branch below that is "No task tracker is configured for
    // this workspace", which is false and is the one sentence a person acts on by
    // going to look for a setting that is already correct.
    //
    // Only with nothing to keep: a board that already has rows keeps them, with
    // the age line above saying how old they are. Grey boxes every 30 s in place
    // of rows that were true a moment ago is a worse screen than a stale one.
    if (state.loading && state.tasks.length === 0) {
      this.mount.append(this.skeleton());
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

    // One list for an issue source, columns for a folder. Not a preference: an
    // issue has two steps and moving between them *is* closing and reopening it,
    // which the row's own ✓ and arrows already do — so a column pair buys a drag
    // gesture for an action that has a button, at the cost of splitting fifty rows
    // across two narrow strips and capping the second at twenty. A file board's
    // steps are the person's own, as many as they configured, and dragging between
    // them is the whole of how a card advances.
    //
    // `Infinity` because the page, not a column cap, is what decides how much of a
    // paged source is on screen. `boardColumns` is still the one grouping rule:
    // both layouts get the same project filter, the same unknown-step handling and
    // the same sort.
    const list = state.source === "github";
    const cols = boardColumns(state.tasks, state.project, caps.board, list ? Infinity : undefined);
    if (list) this.mount.append(this.list(cols, state, caps, now));
    else {
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
    }

    // From its pure rule, and silent unless it has something to say. Outside the
    // layout branch because a budget nearly spent is a fact about the token, not
    // about which screen is drawn.
    const rate = rateLimitBanner(state.rateRemaining ?? null);
    if (rate) this.mount.append(el("p", "tk-rate", rate));

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

  /** Rows standing in for a list that has not arrived — see `skeleton.ts`, which
   *  draws the same shape for the pull requests. */
  private skeleton(): HTMLElement {
    return skeleton("tk", SKELETON_ROWS);
  }

  /** One list, one state at a time, the way the repository's own issues page
   *  reads: a filter for each step, the rows under it, and "Show more" where the
   *  page it came from was full.
   *
   *  The filter lives on the view (`this.filter`) and the page size on the state,
   *  and that split is not incidental: switching states needs no request and must
   *  survive a poll landing mid-click, while asking for more rows *is* a request
   *  and belongs to whoever owns the fetch. */
  private list(
    cols: ReturnType<typeof boardColumns>, state: BoardState, caps: ProviderCapabilities,
    now: number,
  ): HTMLElement {
    interface Group {
      id: StepId; label: string; tasks: Task[]; terminal: boolean; total: number | null;
    }
    const groups: Group[] = cols.columns.map((c) => ({
      id: c.step.id,
      label: c.step.label,
      tasks: c.tasks,
      terminal: c.step.terminal === true,
      total: (c.step.terminal === true ? state.closedTotal : state.total) ?? null,
    }));
    // Cards naming a step the configuration does not know get a filter of their
    // own rather than being folded into either real one. Unreachable for a GitHub
    // source — `open` and `closed` are the only two statuses the provider writes —
    // and kept because the alternative is a card that exists and cannot be seen.
    // `total: null`: the repository counts open and closed issues, not this.
    if (cols.unknown.length > 0) {
      groups.push({
        id: "", label: "unknown step", tasks: cols.unknown, terminal: false, total: null,
      });
    }

    const wrap = el("div", "tk-list");
    // Falls back to the first group whenever the filter names a step this board
    // no longer has: a board.json edited underneath, or a source switched between
    // renders. Which is also what makes `null` the right initial value — the open
    // step is first by convention, and its id is the configuration's to choose.
    const active = groups.find((g) => g.id === this.filter) ?? groups[0];
    // A configuration with no steps at all and no card naming one: legal — `steps:
    // []` is a shape the fallback board and `taskPrompt` both already handle — and
    // there is no filter to draw and nothing to put under it. Said rather than
    // indexed into: `groups[0]` would be `undefined` and every line below it would
    // throw, taking the head and the banners down with it.
    if (!active) {
      wrap.append(el("div", "tk-empty", "This board has no steps configured."));
      return wrap;
    }
    if (groups.length > 1) {
      const bar = el("div", "tk-filters");
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Which issues to show");
      for (const g of groups) {
        // The repository's own count where it is known, so the chip agrees with
        // GitHub rather than with what a page happened to fit; the count line
        // below says how much of it is on screen.
        const chip = el("button", "tk-filter", `${g.label} (${g.total ?? g.tasks.length})`);
        chip.type = "button";
        const on = g === active;
        if (on) chip.classList.add("selected");
        chip.setAttribute("aria-pressed", String(on));
        // Re-renders the state it was handed, with a fresh `now`: nothing here
        // needs the network, and re-reading would throw away a page somebody
        // pressed for.
        chip.onclick = () => { this.filter = g.id; this.render(state, Date.now()); };
        bar.append(chip);
      }
      wrap.append(bar);
    }

    // Labels, as a filter. GitHub's own list makes them the main way a person finds
    // "everything about payments", and this board rendered them as identical grey
    // chips — so the only way to answer that was to read every row.
    //
    // Derived from the page in view rather than from the repository: these are the
    // labels the rows on screen actually carry, so a chip can never select nothing.
    // A filter naming a label that has since left the page clears itself, the same way
    // the step filter falls back to the first group.
    const labels = [...new Set(active.tasks.flatMap((t) => t.labels))].sort();
    if (this.label !== null && !labels.includes(this.label)) this.label = null;
    if (labels.length > 1) {
      const bar = el("div", "tk-f-kinds");
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "Filter by label");
      for (const name of labels) {
        const n = active.tasks.filter((t) => t.labels.includes(name)).length;
        const chip = el("button", "tk-f-kind", `${name} (${n})`);
        chip.type = "button";
        const on = this.label === name;
        if (on) chip.classList.add("selected");
        chip.setAttribute("aria-pressed", String(on));
        // Toggles rather than only selects: with no "all" chip, pressing the active one
        // is the only way back, and a filter a person cannot clear is a trap.
        chip.onclick = () => { this.label = on ? null : name; this.render(state, Date.now()); };
        bar.append(chip);
      }
      wrap.append(bar);
    }

    const shown = this.label === null
      ? active.tasks
      : active.tasks.filter((t) => t.labels.includes(this.label!));

    const rows = el("div", "tk-rows");
    for (const t of shown) rows.append(this.row(t, state, caps, now));
    if (shown.length === 0) {
      rows.append(el("div", "tk-empty", this.label === null
        ? `No ${active.label.toLowerCase()} issues.`
        : `No ${active.label.toLowerCase()} issues carry \u201c${this.label}\u201d.`));
    }
    wrap.append(rows);

    // What the page was measured against: the size it was actually fetched with,
    // never a constant. Without it a board paged to 150 would compare a full page
    // against 50, decide it was capped, and go on offering "Show more" for rows
    // that are already all of them.
    const limit = state.pageLimit ?? initialPageLimit(active.terminal);
    if (canShowMore(active.tasks.length, active.total, limit)) {
      const more = el("button", "tk-more", "Show more");
      more.type = "button";
      more.onclick = () => this.h.onShowMore(limit);
      wrap.append(more);
    }
    // Silent on a short page — there the list is the whole truth and a line saying
    // so is noise on every render — and never for the unknown group, which the
    // repository counts neither as open nor as closed.
    const count = active.id === ""
      ? null
      : countLine(
        active.tasks.length, active.total, needsTotals(active.tasks.length, limit),
        active.terminal ? "closed issues" : "open issues",
      );
    if (count) wrap.append(el("p", "tk-count", count));
    // The paging above deliberately measures `active.tasks`, not `shown`: "Show more"
    // fetches another page from GitHub, and the repository's total has nothing to say
    // about a label subset. So the label filter gets its own line rather than being
    // folded into a count that would then be comparing two different things.
    if (this.label !== null) {
      wrap.append(el("p", "tk-count",
        `${shown.length} of ${active.tasks.length} on this page carry \u201c${this.label}\u201d.`));
    }
    return wrap;
  }

  /** One issue as a row. Everything the card shows, in a shape that reads down a
   *  page instead of across two strips — and with the issue's number, which is
   *  the name a person actually uses for it. */
  private row(t: Task, state: BoardState, caps: ProviderCapabilities, now: number): HTMLElement {
    const status = derivedStatus(t, state.links, caps.board);
    const row = el("div", `tk-row ${status}`);
    if (t.damaged) row.classList.add("damaged");
    this.makeOpenable(row, t);

    // `#42` from the card's own id, which for this source *is* the issue number
    // (`gh_issues.rs`'s `row_to_task`). A file card would print `#01J…` here, which is
    // why the row is reached only from the GitHub layout.
    //
    // A column of its own now, rather than the first word of a wrapping line: the
    // number is the name a person actually uses for an issue, and a ragged left edge
    // of numbers cannot be scanned. Tabular figures do the rest.
    row.append(el("span", "tk-row-number", `#${t.id}`));

    const main = el("div", "tk-row-main");
    main.append(el("span", "tk-row-title", t.title));
    // One line of the body, which is fetched already — the card dialog uses it — and
    // was being dropped here. A list of bare titles cannot be triaged.
    const excerpt = bodyExcerpt(t.body);
    if (excerpt) main.append(el("span", "tk-row-excerpt", excerpt));

    // Everything that is not the title, on a line of its own. It used to share the
    // title's line, so three labels pushed the title into a wrap and the row's height
    // depended on how many labels somebody had added.
    const meta = el("div", "tk-row-meta");
    meta.append(...this.chips(t, status, state, caps));
    // Which timestamp is the honest one depends on the step: a closed issue's
    // `created` is the least interesting date on it, and `resolved` is null for an open
    // one, so neither field can serve both.
    const when = t.resolved ? `closed ${ago(t.resolved, now)}` : `opened ${ago(t.created, now)}`;
    meta.append(el("span", "tk-row-when", when));
    main.append(meta);

    row.append(main);
    row.append(this.actions(t, status, caps));
    return row;
  }

  /** Open on a click anywhere that is not a control.
   *
   *  The title used to be the only target, which made a card a thin strip of text
   *  in a box that otherwise did nothing. It stays a `<button>` — that is what
   *  makes it reachable and operable from the keyboard, and its click bubbles to
   *  here, so there is one handler and no way for the two to disagree.
   *
   *  `.tk-acts` is excluded because every control in it means something other than
   *  "open this": ▶ starts a session, ✓ closes the issue, the arrows move it. A
   *  click there that also opened the card would put a modal over the thing the
   *  person just did. Matched with `closest` rather than by identity so a glyph
   *  *inside* a button counts as that button. */
  private makeOpenable(node: HTMLElement, t: Task) {
    node.classList.add("tk-openable");
    node.onclick = (e) => {
      if ((e.target as Element | null)?.closest(".tk-acts")) return;
      this.h.onOpen(t);
    };
  }

  /** The chips: kind, labels, and whatever the card's own state is worth saying.
   *  Shared by the card and the row so the two cannot drift about what an issue
   *  looks like. */
  private chips(
    t: Task, status: "open" | "done" | "working", state: BoardState, caps: ProviderCapabilities,
  ): HTMLElement[] {
    const out: HTMLElement[] = [];
    const kind = kindLabel(caps.board, t.kind);
    if (kind) out.push(el("span", "tk-kind", kind));
    // An issue's labels, and never its kind: an issue can carry two labels where
    // `kind` is a single value, which is why a GitHub card has no kind at all.
    // Chips through `el`, so a label naming itself `<img src=x onerror=…>` — and
    // anyone who can open an issue on a readable repository chooses that text —
    // arrives as characters rather than as markup.
    for (const l of t.labels) out.push(el("span", "tk-label", l));
    if (t.origin === "session") out.push(el("span", "tk-bot", "session"));
    if (status === "working") out.push(el("span", "tk-busy", "in progress"));
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
      out.push(warn);
    }
    if (isStale(t, state.links, caps.board)) {
      const stale = el("span", "tk-stale", "no live session");
      stale.title = "This card sits in the working step, but no session is running on it.";
      out.push(stale);
    }
    return out;
  }

  /** The card's four actions, on the same rules in both layouts.
   *
   *  Glyphs from the app's own set rather than the characters `‹ ▶ ✓ ›` this used
   *  to draw. Two reasons and both are the design system's: a text character is
   *  whatever the platform's font makes of it — `▶` arrives as an emoji on some
   *  systems and as a triangle on others — and the rest of the app is one 1.5px
   *  outline hand. The accessible name is unchanged and is still what says where
   *  an arrow goes; only the picture is. */
  private actions(
    t: Task, status: "open" | "done" | "working", caps: ProviderCapabilities,
  ): HTMLElement {
    const acts = el("div", "tk-acts");
    // The same condition card-modal.ts's `canWrite` applies to the whole
    // modal: a damaged card's fields may be unreadable and a conflicting card's
    // file is ambiguous, so a step write is refused server-side either way (see
    // fs.rs's update guards). Offering a control that can only ever error is
    // worse than not offering it.
    const canWrite = !t.damaged && !t.conflict;

    // The keyboard equivalent of a drag, and not a fallback for it: xterm eats
    // Tab inside a tile, and every other action here already carries an
    // aria-label. `null` (first step, last step, or a step board.json does not
    // know) means no neighbour, so the arrow is simply not rendered — no
    // separate check for the unknown step, `stepBefore`/`stepAfter` already
    // say "no neighbour" for it. Withheld from a damaged or conflicting card
    // for the same reason `draggable` is: the write would only ever be refused.
    // Where ✓ would send this card, and whether it is offered at all. Both are needed
    // below: the › arrow is withheld when it would perform the transition ✓ already
    // performs, and that is only knowable by asking what ✓ does.
    const showDone = caps.canResolve && !isTerminal(caps.board, t.status)
      && !t.conflict && !t.damaged;
    const closesTo = showDone ? firstTerminal(caps.board) : null;

    const prevStep = stepBefore(caps.board, t.status);
    if (prevStep !== null && canWrite) {
      const prev = el("button", "tk-prev icon--left");
      prev.append(icon("chevron", 15));
      // Names the destination. "Move to the previous step" is board vocabulary, and on
      // a two-step board — which is what the GitHub source synthesizes — it names
      // nothing a person can act on: the whole board is "open" and "closed", so "the
      // previous step" is a riddle whose answer is "reopen it". `stepLabel` falls back
      // to the id, so a card naming a step the configuration lost still reads.
      const label = `Move to ${stepLabel(caps.board, prevStep)}`;
      prev.title = label;
      prev.setAttribute("aria-label", label);
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
      const run = el("button", "tk-run");
      run.append(icon("play", 14));
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
    if (showDone) {
      const done = el("button", "tk-done");
      done.append(icon("check", 15));
      done.title = "Close this task";
      done.setAttribute("aria-label", "Close this task");
      done.onclick = () => this.h.onResolve(t);
      acts.append(done);
    }
    const nextStep = stepAfter(caps.board, t.status);
    // **Withheld when it would only do what ✓ does.** This reverses an earlier decision
    // that gave the list layout both, on the grounds that ‹ and › "carry the whole of
    // reopen and close beside ✓" — which is true of ‹ and false of ›. On a GitHub board
    // the steps are `open` and `closed`, so on an open issue the next step IS the
    // closing step: › and ✓ called two different handlers to reach the same end, and
    // one of them was labelled in vocabulary that named nothing on a two-step board.
    // Both paths ask for a reason (`moveTask` checks `needsCloseConfirmation`), so
    // nothing was being bypassed — it was two buttons for one action, which is its own
    // defect.
    // Stated generally rather than as a GitHub special case, because it is general: on
    // any board, a card standing in the last non-terminal step has a › that closes it,
    // and ✓ is the control that says so.
    const nextIsClose = nextStep !== null && closesTo !== null && nextStep === closesTo;
    if (nextStep !== null && canWrite && !nextIsClose) {
      const next = el("button", "tk-next");
      next.append(icon("chevron", 15));
      const label = `Move to ${stepLabel(caps.board, nextStep)}`;
      next.title = label;
      next.setAttribute("aria-label", label);
      next.onclick = () => this.h.onMove(t, nextStep);
      acts.append(next);
    }
    return acts;
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links, caps.board);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");
    this.makeOpenable(box, t);

    // A damaged card's fields may be unreadable and a conflicting card's file is
    // ambiguous, so a step write is refused server-side either way — which makes
    // dragging one an action that can only ever error.
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

    // Still a button, and still the card's own grid child: `.tk-card-title`
    // carries the line clamp, so wrapping a button inside it would put the clamp
    // on the div and the keyboard target on something else. What changed is that
    // it no longer owns the click — `makeOpenable` above does, and this bubbles
    // into it, so one handler serves the pointer and the keyboard alike.
    const openBtn = el("button", "tk-card-title tk-card-open", t.title);
    openBtn.type = "button";
    openBtn.setAttribute("aria-label", `Open card: ${t.title}`);
    // The `aria-label` above already carries the full title to AT; the two-line
    // clamp cuts it for everyone else, and this is the half of the truncation
    // that only a sighted user hits.
    openBtn.title = t.title;
    box.append(openBtn);

    const meta = el("div", "tk-meta");
    meta.append(...this.chips(t, status, state, caps));
    box.append(meta);

    // Always present, even empty: the meta and action rows sit at the same offset
    // whatever the card's own content, which is what makes a column read as a grid.
    box.append(this.actions(t, status, caps));
    return box;
  }
}
