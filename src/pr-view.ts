import type { PrDetail, PullRequest } from "./ipc";
import { wireExternal } from "./external";
import { ghUnavailable, type GhUnavailable } from "./gh-unavailable";
import { renderMarkdown } from "./markdown";
import { ago, canMerge, checksLabel, reviewLabel, sortPrs } from "./pr";

export type PrUnavailable = GhUnavailable;

export interface PrState {
  workspace: string | null;
  /** Non-null when the view cannot work at all — never rendered as an empty list. */
  unavailable: PrUnavailable | null;
  prs: PullRequest[];
  /** Last failure. The list stays on screen beside it. */
  error: string | null;
  /** When `prs` was fetched. Null before the first successful fetch. */
  fetchedAt: number | null;
  /** How many came back, so a capped page can say so. */
  total: number | null;
  /** The read that will replace `prs` is still in flight. Drawn as skeleton rows
   *  only when there is nothing to keep — a list that is a minute old beats grey
   *  boxes, and this view re-reads every 15 s while anything is building. */
  loading: boolean;
}

export interface PrHandlers {
  onLaunch: (pr: PullRequest) => void;
  onMerge: (pr: PullRequest) => void;
  onClose: (pr: PullRequest) => void;
  onReopen: (pr: PullRequest) => void;
  onRefresh: () => void;
  onFixUnavailable: (u: PrUnavailable) => void;
  /** What the pull request holds, fetched when a row is opened and not before.
   *
   *  A promise rather than a second render pass driven from outside: the view is
   *  the only thing that knows which rows are open, so it is the only thing that
   *  can decide what to ask for. Rejection is expected and is drawn inside the
   *  panel — one row failing to expand is not the list failing. */
  onDetail: (pr: PullRequest) => Promise<PrDetail>;
  /** Show this file's diff in the drawer.
   *
   *  The entry point is the file row and not a button on the pull request row.
   *  `.pr-actions` already holds ▶ / Merge / Close / Open in browser, and Merge
   *  is the highest-stakes button in the app; a fifth control there buys a
   *  misclick on it. A "Diff" button with no file chosen would also have to
   *  guess, and file 1 of 62 is rarely the one wanted.
   *
   *  The index is the identity, and `path` rides along only so the drawer can
   *  name what it is fetching before the rows arrive — 2 of 549 measured
   *  responses name the same path twice, so a path is not an identity here. */
  onOpenDiff: (pr: PullRequest, fileIndex: number, path: string) => void;
}

const PAGE_LIMIT = 50;
/** How many grey rows an empty first load draws. */
const SKELETON_ROWS = 4;

/** What is known about one row's contents. Absent from the map means "never
 *  asked"; the three states are what a person needs told apart while waiting. */
type DetailSlot =
  | { state: "loading"; updatedAt: string }
  | { state: "ok"; updatedAt: string; detail: PrDetail }
  | { state: "failed"; updatedAt: string; message: string };

/** Name a control by the role it plays in the list rather than by identity, so
 *  focus can find its replacement after a redraw has destroyed the node it was on.
 *  Read `PrView.render` for why that is needed at all.
 *
 *  Not an `id`: these have to be unique across the whole document, and the same
 *  pull request can be described in more than one place. `data-fk` is scoped to
 *  the mount it is searched in. */
function fk<T extends HTMLElement>(node: T, key: string): T {
  node.dataset.fk = key;
  return node;
}

/** A file row's focus key. Its own function because two places have to agree on
 *  it: the row that carries it and `focusFile`, which has to find that row again
 *  after the drawer closed and the poll rebuilt the list twice in between. */
function fileKey(prNumber: number, fileIndex: number): string {
  return `file-${prNumber}-${fileIndex}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always textContent: titles, branches and logins come from the network.
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PrView {
  /** The list column, **not the screen**. `.pr-view` is a flex row owned by
   *  `main.ts` holding this and the diff drawer side by side, and the drawer has
   *  to be a sibling rather than a child: `render` below empties this mount every
   *  15 s, which inside it would cost the reader their scroll position in a
   *  document up to 63,000px tall, and their text selection with it. The
   *  `overflow` and the padding live here now for the same reason — on the row
   *  they would scroll the drawer up out of the window along with the list. */
  readonly mount = el("div", "pr-list");
  /** Which rows are open, by number.
   *
   *  View state, not `PrState`: opening a row needs no list read, and a poll
   *  landing every 15 s must not fold it shut under the person reading it. */
  private expanded = new Set<number>();
  /** What has been fetched for each row, and whether it is still current.
   *
   *  Keyed by number and stamped with the `updatedAt` it was fetched at: a push to
   *  the branch changes the description and the diffstat both, and a panel left
   *  showing the previous commit's numbers beside a row that says "just now" is the
   *  kind of wrong that is worse than empty. A poll that brings a newer `updatedAt`
   *  therefore re-fetches whatever is still open, and nothing else. */
  private details = new Map<number, DetailSlot>();
  /** The last thing rendered, so an answer arriving later — or a disclosure being
   *  clicked — can redraw without a list read. */
  private last: PrState | null = null;
  /** Which file row the drawer is showing, so the list can mark it. Null when the
   *  drawer is closed — the drawer owns that fact and tells us. */
  private showing: { number: number; index: number } | null = null;
  /** The one file row per pull request that is in the tab order.
   *
   *  A roving tabindex, because 62 file rows are 62 tab stops otherwise and the
   *  list is meant to be walked, not tabbed through. Kept here rather than read
   *  off the DOM because the DOM is rebuilt every 15 s. */
  private roving = new Map<number, number>();
  constructor(private h: PrHandlers) {}

  /** Mark the row whose diff is on screen, or clear the mark. Called by whoever
   *  owns the drawer: the list cannot know, and guessing would leave the mark on
   *  after an Escape. */
  setOpenDiff(prNumber: number | null, fileIndex: number | null): void {
    this.showing = prNumber === null || fileIndex === null
      ? null
      : { number: prNumber, index: fileIndex };
    this.redraw();
  }

  /** Put focus back on a file row — what the drawer's close does, since focus
   *  never moved into it and there is a specific row to come back to. Silent
   *  when the row has gone: the pull request was merged away while the diff was
   *  open, and there is nowhere to return to. */
  focusFile(prNumber: number, fileIndex: number): void {
    this.roving.set(prNumber, fileIndex);
    for (const node of this.mount.querySelectorAll<HTMLElement>("[data-fk]")) {
      if (node.dataset.fk === fileKey(prNumber, fileIndex)) { node.focus(); return; }
    }
  }

  /** Draw the list, keeping the reader's place.
   *
   *  `draw` below empties the mount and builds every node again, and the poll calls
   *  it every 15 s while the window has focus (`schedulePrPoll` in `main.ts`) — which
   *  is precisely while somebody is reading. Without the two restores here, the
   *  focused control is destroyed and focus falls to `<body>`, and the scroll
   *  position goes to zero because emptying the scroll container collapses it.
   *
   *  Restoring by `data-fk` rather than by holding the node: the node the person was
   *  on no longer exists after `replaceChildren`, so the only thing that can survive
   *  a redraw is a name for its *role* in the list. Every control that can hold focus
   *  carries one — see `fk` below. A control that has gone (the row it belonged to
   *  was merged away) matches nothing and focus is left where the browser put it,
   *  which is the honest outcome: there is nowhere to go back to. */
  render(state: PrState, now: number) {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && this.mount.contains(active)
      ? active.dataset.fk ?? null
      : null;
    const scroll = this.mount.scrollTop;

    this.draw(state, now);

    this.mount.scrollTop = scroll;
    if (key === null) return;
    for (const node of this.mount.querySelectorAll<HTMLElement>("[data-fk]")) {
      if (node.dataset.fk !== key) continue;
      // `preventScroll`, because the scroll position was just put back deliberately
      // and focusing must not overrule it. Scanning rather than a `[data-fk="…"]`
      // selector so a key never has to be escaped — file paths will be keys once the
      // diff drawer lands.
      node.focus({ preventScroll: true });
      return;
    }
  }

  private draw(state: PrState, now: number) {
    this.last = state;
    this.mount.replaceChildren();

    const head = el("div", "pr-head");
    head.append(el("h3", "pr-title-head", "Pull requests"));
    const refresh = fk(el("button", "pr-refresh", "↻"), "refresh");
    refresh.title = "Refresh";
    refresh.onclick = () => this.h.onRefresh();
    head.append(refresh);
    // Shown on every render, not only on failure: data that can be stale has
    // to say how stale.
    head.append(el("span", "pr-age",
      state.fetchedAt === null ? "never loaded" : `updated ${ago(new Date(state.fetchedAt).toISOString(), now)}`));
    this.mount.append(head);

    if (state.unavailable) {
      // This view's own noun, not the shared file's: the sentence says what
      // cannot be read, and here that is pull requests.
      const spec = ghUnavailable(state.unavailable, "pull requests");
      const box = el("div", "pr-unavailable");
      box.append(el("p", "pr-unavailable-text", spec.text));
      if (spec.action) {
        const fix = fk(el("button", "pr-fix", spec.action), "fix");
        const u = state.unavailable;
        fix.onclick = () => this.h.onFixUnavailable(u);
        box.append(fix);
      }
      this.mount.append(box);
      return;
    }

    if (state.error) this.mount.append(el("p", "pr-error", state.error));

    // Before the empty state, which is a claim about the repository: an empty list
    // that has not been read yet is not "no open pull requests", and one `gh pr
    // list` on a slow network is long enough for that sentence to be read and
    // believed. A list already on screen keeps it, with its age above.
    if (state.loading && state.prs.length === 0) {
      this.mount.append(this.skeleton());
      return;
    }

    if (state.prs.length === 0) {
      this.mount.append(el("div", "pr-empty", "No open pull requests."));
      return;
    }

    for (const pr of sortPrs(state.prs)) this.mount.append(this.row(pr, now));

    if (state.total !== null && state.total >= PAGE_LIMIT) {
      this.mount.append(el("p", "pr-capped",
        `Showing the first ${PAGE_LIMIT} — the repository has more open.`));
    }
  }

  /** Grey rows standing in for a list that has not arrived. `aria-hidden`, with
   *  one live sentence beside them: to a screen reader four empty boxes are four
   *  pieces of nothing. */
  private skeleton(): HTMLElement {
    const wrap = el("div", "pr-skeleton");
    wrap.append(el("p", "pr-skeleton-text", "Loading…"));
    const rows = el("div", "pr-skeleton-rows");
    rows.setAttribute("aria-hidden", "true");
    for (let i = 0; i < SKELETON_ROWS; i++) rows.append(el("div", "pr-skeleton-row"));
    wrap.append(rows);
    return wrap;
  }

  /** Redraw from the state already on screen. No list read: everything that calls
   *  this changed only what the view knows about itself. */
  private redraw() {
    if (this.last) this.render(this.last, Date.now());
  }

  /** Open or close a row, fetching its contents the first time — and again when
   *  the row has moved on since they were fetched. */
  private toggle(pr: PullRequest) {
    if (this.expanded.has(pr.number)) {
      this.expanded.delete(pr.number);
      this.redraw();
      return;
    }
    this.expanded.add(pr.number);
    this.fetchIfStale(pr);
    this.redraw();
  }

  /** One request per row per commit, and never one already in flight. */
  private fetchIfStale(pr: PullRequest) {
    const have = this.details.get(pr.number);
    if (have && have.updatedAt === pr.updatedAt) return;
    this.details.set(pr.number, { state: "loading", updatedAt: pr.updatedAt });
    void this.h.onDetail(pr).then(
      (detail) => {
        this.details.set(pr.number, { state: "ok", updatedAt: pr.updatedAt, detail });
        this.redraw();
      },
      (e: unknown) => {
        this.details.set(pr.number, {
          state: "failed",
          updatedAt: pr.updatedAt,
          message: String((e as { message?: string })?.message ?? e),
        });
        this.redraw();
      },
    );
  }

  /** What the row holds, under it. Three states, because "still loading" and
   *  "could not be read" are different things to be told and neither of them is an
   *  empty panel. */
  private panel(pr: PullRequest): HTMLElement {
    const box = el("div", "pr-detail");
    const slot = this.details.get(pr.number);
    if (!slot || slot.state === "loading") {
      box.append(el("p", "pr-detail-note", "Loading…"));
      return box;
    }
    if (slot.state === "failed") {
      // The row above stays exactly as it was: one panel that cannot be read is
      // not the list failing, and the merge button beside it is still good.
      box.append(el("p", "pr-detail-error", `Could not read #${pr.number}: ${slot.message}`));
      const retry = fk(el("button", "pr-detail-retry", "Try again"), `retry-${pr.number}`);
      retry.type = "button";
      retry.onclick = () => {
        this.details.delete(pr.number);
        this.fetchIfStale(pr);
        this.redraw();
      };
      box.append(retry);
      return box;
    }

    const d = slot.detail;
    box.append(el(
      "p", "pr-detail-stat",
      `${d.changedFiles} file${d.changedFiles === 1 ? "" : "s"} changed · `
      + `+${d.additions} −${d.deletions}`,
    ));
    // Parsed now, into nodes rather than into HTML. The comment that used to be here
    // said the two honest options were plain text and a dependency, and that a
    // hand-rolled subset turning `[x](javascript:…)` into an anchor was not a third.
    // It was right about the danger and wrong about the count — see `markdown.ts`,
    // which uses a real lexer and builds the tree with `createElement`/`textContent`,
    // so there is no HTML string for a sanitiser to have to get right. Markup in a
    // description still arrives as characters, exactly as it did in the <pre>.
    // The description and the file list side by side rather than stacked. Both are
    // capped in `ch` for readability — 80 and 72 — so stacking them left a 1970px
    // window mostly empty to the right of a column of text, which is what the owner
    // saw as everything being glued to the left edge. The cap is right and stays;
    // what changes is that the width it does not use now holds the file list instead
    // of nothing. They wrap back to a column when the row is too narrow for both.
    const panels = el("div", "pr-detail-panels");
    if (d.body.trim()) {
      const body = el("div", "pr-detail-body");
      body.append(renderMarkdown(d.body));
      panels.append(body);
    } else {
      panels.append(el("p", "pr-detail-note", "No description."));
    }

    if (d.files.length) panels.append(this.fileList(pr, d));
    box.append(panels);

    // `changedFiles` is GitHub's count and `files` is a page of its own, so the
    // two can legitimately disagree on a very large pull request. Saying so beats
    // a list that quietly stops. Below the pair rather than inside it: it is a
    // sentence about the list, and a third flex item would be laid out beside it.
    if (d.files.length && d.files.length < d.changedFiles) {
      box.append(el(
        "p", "pr-detail-note",
        `Listing ${d.files.length} of ${d.changedFiles} changed files.`,
      ));
    }
    return box;
  }

  /** The changed files, as the way into the diff.
   *
   *  Buttons and not text, and this is the list's one keyboard widget: **one tab
   *  stop with a roving tabindex**, Arrow/Home/End to move within it, and
   *  activation on Enter, Space or a click and never on an arrow. The last part
   *  is not a style preference — each file is an IPC round trip, so arrowing
   *  through 62 rows on an activate-on-focus list would be 62 `gh` processes.
   *
   *  Rows with nothing to show stay ordinary enabled buttons. `disabled` would
   *  take them out of the tab order and take their explanation with them, which
   *  is the mistake `.pr-merge` above already had corrected: the drawer is where
   *  the reason lives, and a row you cannot reach cannot tell you one. */
  private fileList(pr: PullRequest, d: PrDetail): HTMLElement {
    const files = el("ul", "pr-detail-files");
    const rove = Math.min(this.roving.get(pr.number) ?? 0, d.files.length - 1);
    d.files.forEach((f, i) => {
      const li = el("li");
      const btn = fk(el("button", "pr-detail-file"), fileKey(pr.number, i));
      btn.type = "button";
      // Exactly one row per list is tabbable; the rest are reached with arrows.
      btn.tabIndex = i === rove ? 0 : -1;
      if (this.showing?.number === pr.number && this.showing.index === i) {
        // `aria-current` rather than `aria-selected`: these are not the options
        // of a listbox, they are places, and one of them is the one on screen.
        btn.setAttribute("aria-current", "true");
      }
      btn.append(el("span", "pr-detail-path", f.path));
      btn.append(el("span", "pr-detail-plus", `+${f.additions}`));
      btn.append(el("span", "pr-detail-minus", `−${f.deletions}`));
      btn.onclick = () => {
        this.roving.set(pr.number, i);
        this.h.onOpenDiff(pr, i, f.path);
      };
      // Tabbing into the list, or clicking a row, moves the single tab stop with
      // the person rather than sending them back to row 1 next time.
      btn.addEventListener("focus", () => this.rove(files, pr.number, i, false));
      li.append(btn);
      files.append(li);
    });
    files.addEventListener("keydown", (e) => this.fileKeys(e, files, pr.number, d.files.length));
    return files;
  }

  /** Move the tab stop, and optionally the focus with it. Written against the
   *  live nodes rather than by redrawing: a redraw here would rebuild the button
   *  under the very `focus()` call that is moving to it. */
  private rove(list: HTMLElement, prNumber: number, to: number, move: boolean): void {
    this.roving.set(prNumber, to);
    const buttons = list.querySelectorAll<HTMLButtonElement>(".pr-detail-file");
    buttons.forEach((b, i) => { b.tabIndex = i === to ? 0 : -1; });
    if (move) buttons[to]?.focus();
  }

  private fileKeys(e: KeyboardEvent, list: HTMLElement, prNumber: number, count: number): void {
    const at = this.roving.get(prNumber) ?? 0;
    const to =
      e.key === "ArrowDown" ? Math.min(count - 1, at + 1)
      : e.key === "ArrowUp" ? Math.max(0, at - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? count - 1
      : null;
    if (to === null) return;
    // Stopped here rather than left to bubble: ArrowUp and ArrowDown scroll the
    // panel, and a list that moves the focus *and* the page moves neither by the
    // amount the person asked for.
    e.preventDefault();
    this.rove(list, prNumber, to, true);
  }

  private row(pr: PullRequest, now: number): HTMLElement {
    const row = el("div", "pr-row");
    // The state rail's carrier, and the one thing worth railing on a pull request:
    // whether its checks are red. The kind was already on a meta span as coloured
    // text, which means reading four lines of every row to find the one that needs
    // you — the same problem the session list had before its rail.
    row.dataset.checks = pr.checks.kind;

    const open = this.expanded.has(pr.number);
    // A row that is open re-fetches when the pull request itself has moved on. Done
    // on render rather than only on the click, because the thing that moves it on is
    // the poll: a push lands, the row's `updatedAt` changes, and the panel under it
    // is describing the previous commit until something notices.
    if (open) this.fetchIfStale(pr);

    const main = el("div", "pr-main");
    // The disclosure, first in the row so its position does not move with the
    // title's length. A button, not a bare glyph: it is operable from the keyboard,
    // and `aria-expanded` is what makes its state audible.
    const toggle = fk(el("button", "pr-toggle", open ? "▾" : "▸"), `toggle-${pr.number}`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? `Hide #${pr.number}` : `Show #${pr.number}`);
    toggle.title = open ? "Hide the description and the changed files" : "Show the description and the changed files";
    toggle.onclick = () => this.toggle(pr);
    main.append(toggle);
    main.append(el("span", "pr-number", `#${pr.number}`));
    main.append(el("span", "pr-title", pr.title));
    if (pr.isDraft) main.append(el("span", "pr-draft", "draft"));
    row.append(main);

    const meta = el("div", "pr-meta");
    meta.append(el("span", "pr-author", pr.author || "unknown author"));
    meta.append(el("span", "pr-branches", `${pr.headRefName} → ${pr.baseRefName}`));
    meta.append(el("span", `pr-checks pr-checks--${pr.checks.kind}`, checksLabel(pr.checks)));
    const review = reviewLabel(pr.reviewDecision);
    if (review) meta.append(el("span", "pr-review", review));
    meta.append(el("span", "pr-updated", ago(pr.updatedAt, now)));
    for (const l of pr.labels) meta.append(el("span", "pr-label", l));
    row.append(meta);

    const actions = el("div", "pr-actions");

    const launch = fk(el("button", "pr-launch", "▶"), `launch-${pr.number}`);
    launch.title = "Start a session on this branch, in a worktree of its own";
    launch.onclick = () => this.h.onLaunch(pr);
    actions.append(launch);

    const verdict = canMerge(pr);
    const merge = fk(el("button", "pr-merge", "Merge"), `merge-${pr.number}`);
    merge.disabled = !verdict.ok;
    // The refusal used to live in `title` alone. This is the highest-stakes button
    // in the app, and a `title` is reachable by neither keyboard nor touch — the
    // two ways of using it that most need to know why it will not work. It is a
    // visible line below the row now, tied to the button by `aria-describedby` so
    // a screen reader reads the reason with the button rather than after hunting
    // for it. `title` is left carrying only the affirmative case: duplicating the
    // visible text there would have some readers announce it twice.
    if (verdict.ok) merge.title = "Merge this pull request";
    else merge.setAttribute("aria-describedby", `pr-refusal-${pr.number}`);
    merge.onclick = () => { if (verdict.ok) this.h.onMerge(pr); };
    actions.append(merge);

    const close = fk(el("button", "pr-close", "Close"), `close-${pr.number}`);
    close.onclick = () => this.h.onClose(pr);
    actions.append(close);

    // An anchor, because that is what it is — but one that opens the URL through
    // the opener plugin rather than by navigating. `target="_blank"` is what this
    // used to be, and it did nothing whatsoever: see `external.ts`.
    //
    // Absent rather than dead when the gate refuses the URL. `url` comes out of
    // `gh_pr.rs` through an `unwrap_or("")`, and a refused anchor keeps neither
    // `href` nor handler: it would look like the other three controls, ignore
    // every click, and — since `view.ts` finds controls by `a[href]` — refuse
    // focus, which would also make the focus key below restore focus to nothing
    // after a poll redraw. The row's other three actions still work.
    const link = fk(el("a", "pr-open", "Open in browser"), `open-${pr.number}`);
    if (wireExternal(link, pr.url)) actions.append(link);

    row.append(actions);
    // Under the buttons rather than beside them: the reason is a sentence, and a
    // sentence in a row of three short controls sets the row's width.
    if (!verdict.ok) {
      const refusal = el("p", "pr-refusal", verdict.reason);
      refusal.id = `pr-refusal-${pr.number}`;
      row.append(refusal);
    }
    // Inside the row, not after it: the panel belongs to this pull request, and a
    // sibling would drift away from it the moment the list re-sorts.
    if (open) row.append(this.panel(pr));
    return row;
  }
}
