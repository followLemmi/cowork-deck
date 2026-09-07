/** The pull request diff drawer: the DOM half of `src/diff.ts`.
 *
 *  Every decision below that looks arbitrary has a measurement behind it, and
 *  the comment that states the decision states the measurement with it.
 *
 *  **This does not live inside `PrView`, and that is the load-bearing fact about
 *  the whole module.** `PrView.render` calls `replaceChildren()` on its mount
 *  every 15 s while the window has focus — which is precisely while somebody is
 *  reading. Inside it, a reader would lose their scroll position in a document up
 *  to 63,000px tall, plus any text selection, twice a minute. So `main.ts` owns
 *  this as a sibling of the list, and the poll tick reaches it only through
 *  `onPoll`, which touches the head and never the code.
 *
 *  The same reasoning applies one level down: `render` rebuilds the head on every
 *  call and the body only when the body's own identity changes. Otherwise a poll
 *  that merely re-labels "3 of 62" would throw away the `.dv-file` the reader has
 *  scrolled into, and moving the drawer out of `PrView` would have bought nothing.
 */

import {
  canRefetch, classifyHunk, diffCacheNext, fileNote, hunkHeading, lineMarker,
  type DiffCacheReason, type DiffLine, type DiffLineKind, type DiffSlot,
} from "./diff";
import { wireExternal } from "./external";
import { wireResizer } from "./resize";
import type { DiffFile, PrDiff, PullRequest } from "./ipc";
import { firstFocusable } from "./view";

/** The drawer's width in `ch`, and the value three places have to agree on: the
 *  `width` on `.pr-drawer` in `styles.css` (what is drawn before JS writes a
 *  width) and `default_pr_diff_cols` in `model.rs` (what a store file with no key
 *  yet reads as). */
export const DEFAULT_COLS = 62;
/** Below this the marker and the two number columns crowd out the code, which is
 *  the only thing the pane is for. Mirrors `min-width` on `.pr-drawer`. */
export const MIN_COLS = 40;
/** Not a layout constraint — CSS already caps the drawer at the width of its
 *  parent — but `aria-valuemax` has to be a number, and a separator whose range
 *  has no top is one a screen reader cannot describe. */
export const MAX_COLS = 200;
/** One arrow press. Two columns is small enough to aim with and large enough that
 *  crossing the useful range does not take fifty presses. */
const COLS_STEP = 2;
/** `.pr-drawer-grip`'s hit area, spent out of the drawer's own width. */
const GRIP_PX = 24;
/** How little of the list is still a list, in `rem` so it tracks the text-size
 *  control rather than fighting it. Anchored on `#sidebar`'s own `19.08rem`
 *  floor plus the four action buttons a pull request row carries: narrower than
 *  the sidebar and the list has stopped being one, and at that point
 *  `.pr-view--narrow` gives the whole area to the drawer instead. */
const LIST_FLOOR_REM = 24;

export function clampCols(cols: number): number {
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.round(cols)));
}

/** The word a screen reader says before the code, so a line arrives as
 *  "Added, const x = 1". Context and the no-newline marker get nothing: silence
 *  is the correct announcement for a line that did not change. */
const SR_WORD: Record<DiffLineKind, string> = {
  add: "Added, ", del: "Removed, ", ctx: "", meta: "",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always `textContent`: paths, patch lines and error messages all come from
  // the network, and a diff is the one place in this app where the payload is
  // *expected* to contain markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Split a path so the basename can be drawn bright and the directory quiet —
 *  `.pr-drawer-path` styles the bare text node and its one child differently.
 *  The separator stays with the directory, because "src/" reads as a folder and
 *  "src" reads as a file. */
function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? ["", path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** What the `aria-live` region says. Pure, so the sentence can be asserted
 *  without a DOM.
 *
 *  **This is the only feedback a screen-reader user gets**, because focus
 *  deliberately does not move when the drawer opens; drop it and the feature is
 *  silent. Hence a whole sentence rather than a label: where you are, how far
 *  through, and what is there.
 *
 *  Two shapes rather than one. A file with a note has the note read out in place
 *  of a hunk count — the note *is* the content — and an `unreported` file has no
 *  counts read at all, because zeroed counts are the lie that state exists to
 *  name and "0 added, 0 removed" is precisely the sentence it must not produce. */
export function diffAnnouncement(diff: PrDiff, index: number): string {
  const file = diff.files[index];
  if (!file) return "";
  const where = `Diff for ${file.path}, file ${index + 1} of ${diff.totalFiles}.`;
  const counts = file.omitted?.kind === "unreported"
    ? ""
    : ` ${file.additions} added, ${file.deletions} removed.`;
  const note = fileNote(file);
  const body = note !== null
    ? ` ${note}`
    : ` ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}.`;
  return where + counts + body;
}

/** The layout the width code reads: one `ch` in pixels, the root font size, and how
 *  much room the pull request row has. Three numbers in one type because they are
 *  read together, in one place, and — during a drag — not read again. */
interface Metrics {
  ch: number;
  root: number;
  available: number;
}

export interface DiffDrawerHandlers {
  /** Read one pull request's whole diff. One call, one response — see `prDiff`.
   *  Rejection is expected and is drawn inside the drawer. */
  onFetch: (pr: PullRequest) => Promise<PrDiff>;
  /** Remember the width, in `ch`. Called on `pointerup` and `keyup`, never
   *  during a drag: the drag fires at frame rate and this reaches the disk. */
  onWidth: (cols: number) => void;
  /** The drawer closed. The caller puts focus back on the file row that was
   *  showing — the drawer cannot, because it does not own the list. */
  onClosed: (pr: PullRequest, fileIndex: number) => void;
  /** Re-read one file on a page of its own, uncapped. Behind both "Check again"
   *  and "Show anyway", which are the same fetch: see `prFilePatch`. */
  onRefetchFile: (pr: PullRequest, fileIndex: number) => Promise<DiffFile>;
}

export class DiffDrawer {
  /** `<section>` with an `aria-label` *is* `role="region"`, which is what the
   *  design asks for and what the two rejected alternatives are not:
   *  `aria-modal` hides the list from the accessibility tree, which is the
   *  opposite of what someone comparing a path against a diff needs, and
   *  `complementary` claims the detail half of a master–detail is meaningful on
   *  its own. Non-modal throughout — and built by hand rather than on
   *  `dialog-shell.ts`, because that gives every dialog `.modal-overlay` and
   *  `main.ts` disables every hotkey in the app while one exists. */
  readonly mount = el("section", "pr-drawer");
  /** The live region, a sibling of the drawer inside `.pr-view` rather than a
   *  child of it: it has to survive the drawer leaving the DOM on close, and a
   *  region announced into as it is removed announces nothing. */
  readonly live = el("p", "dv-sr");

  private readonly grip = el("div", "pr-drawer-grip");
  private readonly head = el("div", "pr-drawer-head");
  private readonly pathEl = el("span", "pr-drawer-path");
  private readonly countsEl = el("span", "pr-drawer-counts");
  private readonly posEl = el("span", "pr-drawer-pos");
  private readonly prevBtn = el("button", "pr-drawer-prev", "Prev");
  private readonly nextBtn = el("button", "pr-drawer-next", "Next");
  private readonly closeBtn = el("button", "pr-drawer-close", "Close");
  private readonly body = el("div", "pr-drawer-body");
  /** Two zones, so the staleness bar can appear without rebuilding the diff
   *  under a reader who has scrolled into it. */
  private readonly barZone = el("div");
  private readonly contentZone = el("div");

  /** Which pull request is showing, or null when the drawer is closed. */
  private pr: PullRequest | null = null;
  private index = 0;
  /** The path the caller named, used only to label the head while the diff is
   *  still in flight. Dropped the moment real rows arrive: the file's identity
   *  is its index, never its path — 2 of 549 measured responses name the same
   *  path twice. */
  private pending = "";
  /** One slot per pull request number. Kept across a close, so reopening a diff
   *  that is still at the same commit costs nothing. */
  private slots = new Map<number, DiffSlot>();
  /** The commit Reload would fetch, set when a poll finds the branch has moved
   *  under content that is already on screen. */
  private movedTo: string | null = null;
  private cols = DEFAULT_COLS;

  private view: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  /** What the content zone was last built from. Compared rather than trusted:
   *  see the note at the top of the file. */
  private contentKey = "";
  /** One `ch` in pixels, and the root size it was measured at. Re-measured only
   *  when the text size moves, because reading it costs a layout and the narrow
   *  check runs on every resize tick. */
  private chCache: { root: number; ch: number } | null = null;
  /** The layout `metrics` answers from while a drag is in flight, and null the
   *  rest of the time. See `src/drag.ts` for why a gesture reads layout once. */
  private frozen: Metrics | null = null;

  constructor(private h: DiffDrawerHandlers) {
    this.live.setAttribute("aria-live", "polite");
    // Atomic, because the sentence is one thought: without it a reader can be
    // handed "file 4 of 62" with no filename in front of it.
    this.live.setAttribute("aria-atomic", "true");

    this.wireGrip();

    for (const b of [this.prevBtn, this.nextBtn, this.closeBtn]) b.type = "button";
    this.prevBtn.title = "The previous file in this pull request";
    this.nextBtn.title = "The next file in this pull request";
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    this.closeBtn.onclick = () => this.close();

    this.head.append(this.pathEl, this.countsEl, this.posEl,
                     this.prevBtn, this.nextBtn, this.closeBtn);
    this.body.append(this.barZone, this.contentZone);
    this.mount.append(this.grip, this.head, this.body);
    this.applyCols();
  }

  /** Give the drawer the two elements it does not own but has to act on: the
   *  screen it lives in and the list it squeezes.
   *
   *  Escape is bound here, on `.pr-view` and in the bubble phase. Not on the
   *  drawer's own subtree — focus deliberately stays in the list, so the list
   *  would be the one place the key did nothing. Not on `document` in capture
   *  either: that fires ahead of xterm, which legitimately consumes Escape and
   *  sends it to the PTY. */
  attach(view: HTMLElement, list: HTMLElement): void {
    this.view = view;
    this.list = list;
    view.addEventListener("keydown", (e) => {
      // `openDialog` calls `preventDefault` but never `stopPropagation`, so
      // without this a modal's Escape would also close the drawer behind it.
      if (e.defaultPrevented || e.key !== "Escape" || this.pr === null) return;
      e.preventDefault();
      this.close();
    });
    // Undefined in jsdom, which is the whole reason the collapse is on the
    // manual checklist rather than in a test.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.applyNarrow()).observe(view);
    }
  }

  /** The stored width, applied without writing it back. */
  setCols(cols: number): void {
    this.cols = clampCols(cols);
    this.applyCols();
  }

  isOpen(): boolean { return this.pr !== null; }

  contains(node: Node | null): boolean {
    return node !== null && this.mount.contains(node);
  }

  /** Where F6 lands. The head's first enabled button rather than the grip: the
   *  grip is first in the DOM and reachable with one Shift+Tab, but arriving on
   *  a control whose arrow keys resize the window is a poor welcome. */
  focusFirst(): boolean {
    // The chrome outlives a close — the mount is detached, not emptied — so
    // without this the head's buttons are still findable and `focus()` on a
    // detached node silently drops focus to `<body>`.
    if (this.pr === null) return false;
    const target = firstFocusable(this.head);
    if (!target) return false;
    target.focus();
    return true;
  }

  /** Show one file of one pull request.
   *
   *  **Focus does not move.** The loop this serves is 62 files; moving focus into
   *  the drawer would cost a Shift+Tab per file. The `aria-live` sentence is what
   *  replaces it, which is why it is not optional. */
  open(pr: PullRequest, fileIndex: number, path: string): void {
    if (this.view === null) return;
    this.pr = pr;
    this.index = Math.max(0, fileIndex);
    this.pending = path;
    if (!this.mount.isConnected) this.view.append(this.mount);
    // Opening is a width change even though nothing resized: the drawer was not
    // taking any of the row a moment ago. Without this the `ResizeObserver` is
    // the only thing that ever asks, and it last fired when the drawer was shut
    // — measured at a 900px window and the 18.85px text step, where the list
    // stayed on screen as a 24px sliver.
    this.applyNarrow();
    this.want(pr, "open");
    this.render();
    this.announce();
  }

  close(): void { this.shut(true); }

  /** `handBack` is false where there is nothing to hand focus back *to*. Closing
   *  is normally a deliberate act with a row to return to; a workspace switch is
   *  not, and the row under the returned focus belongs to the repository that is
   *  on its way off the screen. Focus would jump out of the sidebar the person
   *  just clicked and into a list about to be replaced. */
  private shut(handBack: boolean): void {
    const pr = this.pr;
    if (pr === null) return;
    const index = this.index;
    this.pr = null;
    this.movedTo = null;
    // Forgotten, not merely stale. The key is a pull request number and an
    // index, and after a workspace switch another repository's #7 file 0 would
    // match it and be handed the previous repository's rows.
    this.contentKey = "";
    this.mount.remove();
    this.applyNarrow();
    if (handBack) this.h.onClosed(pr, index);
  }

  /** A workspace switch. The pull requests on screen belong to the workspace
   *  that was active a moment ago, so a diff of #151 beside another workspace's
   *  list is that same error one level down — and the slots go with it, since
   *  their keys are pull request numbers and two repositories both have a #7. */
  reset(): void {
    this.shut(false);
    this.slots.clear();
  }

  /** A list poll landed. It may carry a new head for the pull request on screen,
   *  and it may not carry the pull request at all — it was merged or closed. */
  onPoll(prs: PullRequest[]): void {
    const open = this.pr;
    if (open === null) return;
    const fresh = prs.find((p) => p.number === open.number);
    if (!fresh) return;
    this.pr = fresh;
    this.want(fresh, "poll");
    this.render();
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  /** Ask `diffCacheNext` what to do, then do it. The decision is pure and lives
   *  in `diff.ts`; everything here is the side effects it names. */
  private want(pr: PullRequest, reason: DiffCacheReason): void {
    const decision = diffCacheNext(this.slots.get(pr.number) ?? null, pr.headRefOid, reason);
    if (decision.action === "offer-reload") {
      this.movedTo = decision.headRefOid;
      return;
    }
    // Cleared on every other answer, "keep" included: a branch force-pushed back
    // to the commit on screen makes the bar a lie, and a bar offering to reload
    // what is already showing never goes away on its own.
    this.movedTo = null;
    if (decision.action === "keep") return;
    const oid = decision.headRefOid;
    const number = pr.number;
    // Stamped with the oid *requested*, which is what the in-flight guard in
    // `diffCacheNext` compares against, and what the check below identifies the
    // answer by.
    this.slots.set(number, { state: "loading", headRefOid: oid });
    void this.h.onFetch(pr).then(
      (diff) => {
        if (!this.awaited(number, oid)) return;
        // Re-keyed on the commit the *response* names, read by the backend out
        // of the rows rather than taken from the request: the files endpoint is
        // addressed by pull request number, so it serves whatever HEAD was when
        // it ran. Falling back to the requested oid when the response names
        // none — a pull request that changes nothing has no row to read it from
        // — because an empty key would look stale against every poll and
        // re-fetch for ever.
        this.slots.set(number, {
          state: "ok", headRefOid: diff.headRefOid || oid, diff,
        });
        if (this.pr?.number === number) {
          // A capped page, a file removed since the row was drawn: land on a
          // file that exists rather than on an empty drawer.
          this.index = Math.min(this.index, Math.max(0, diff.files.length - 1));
          this.render();
          this.announce();
        }
      },
      (e: unknown) => {
        if (!this.awaited(number, oid)) return;
        this.slots.set(number, {
          state: "failed", headRefOid: oid,
          message: String((e as { message?: string })?.message ?? e),
        });
        if (this.pr?.number === number) this.render();
      },
    );
  }

  /** Force the next `render` to rebuild the body even though its key has not
   *  moved. For an edit in place — the only kind is `refetchFile` below. */
  private invalidateBody(): void {
    this.contentKey = "";
  }

  /** Replace the file on screen with an uncapped re-read of it.
   *
   *  Splices into the cached `PrDiff` rather than re-fetching the pull request:
   *  the other 61 files are unchanged and re-reading them would cost a megabyte to
   *  fix one row. The slot's `headRefOid` is left alone — this is the same commit,
   *  asked about more narrowly, so nothing about staleness has changed.
   *
   *  Guarded by the button's own disabled state rather than by a slot, because it
   *  is the only thing that can start one and a second press before the first
   *  lands would splice twice. Failure puts the label back and says so: the file
   *  is exactly as unreadable as it was, which is a recoverable position and not
   *  one worth taking the whole drawer down for. */
  private refetchFile(button: HTMLButtonElement): void {
    const pr = this.pr;
    const slot = pr === null ? undefined : this.slots.get(pr.number);
    if (pr === null || slot?.state !== "ok") return;
    const index = this.index;
    button.disabled = true;
    button.textContent = "Reading…";
    void this.h.onRefetchFile(pr, index).then(
      (file) => {
        const now = this.slots.get(pr.number);
        // The poll replaced the whole diff while this was out, or the reader moved
        // on. Either way the row this was about is gone; dropping it is right.
        if (now?.state !== "ok" || now.diff !== slot.diff) return;
        now.diff.files[index] = file;
        if (this.pr?.number === pr.number && this.index === index) {
          // The body's key is (pull request, fetch, index) and none of the three
          // moved — the file was edited underneath it. Without this the rows would
          // never be drawn and the button would sit on "Reading…" for ever.
          this.invalidateBody();
          this.render();
          this.announce();
        }
      },
      (e: unknown) => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.textContent = "Try again";
        button.title = String((e as { message?: string })?.message ?? e);
      },
    );
  }

  /** Whether this answer is still the one being waited on. Promises settle out
   *  of order, and a second request can be started while a first is out — the
   *  head moving between an `open` and a `reload` is exactly that. Without this
   *  the slower of the two wins by arriving last. */
  private awaited(number: number, oid: string): boolean {
    const slot = this.slots.get(number);
    return slot !== undefined && slot.state === "loading" && slot.headRefOid === oid;
  }

  private step(by: number): void {
    const diff = this.diff();
    if (!diff) return;
    const next = this.index + by;
    // Prev and Next walk every file, including the ones with nothing to show:
    // file 41 of 62 having no diff is information, and skipping it would hide
    // the file rather than the absence.
    if (next < 0 || next >= diff.files.length) return;
    this.index = next;
    this.render();
    this.announce();
  }

  private diff(): PrDiff | null {
    if (this.pr === null) return null;
    const slot = this.slots.get(this.pr.number);
    return slot !== undefined && slot.state === "ok" ? slot.diff : null;
  }

  private announce(): void {
    const diff = this.diff();
    this.live.textContent = diff === null ? "" : diffAnnouncement(diff, this.index);
  }

  // -------------------------------------------------------------------------
  // Width
  // -------------------------------------------------------------------------

  /** The width, and only the width. `aria-valuenow` and `aria-valuetext` moved to
   *  `wireResizer`, which reports every grip's value the same way. */
  private applyCols(): void {
    this.mount.style.width = `${this.cols}ch`;
    this.applyNarrow();
  }

  /** The grip, on the app's one resizer since #424.
   *
   *  This was the most complete of the three implementations and is now the most
   *  demanding caller: it is the reason `wireResizer` has `unitPx`, `valueText`,
   *  `commitOn` and `beginGesture` at all. What each of those is here:
   *
   *  · `unitPx` — the width is in `ch`, not pixels, because the thing being sized
   *    is a grid of characters. One `ch` of the drawer's own font, measured.
   *  · `beginGesture` / `commit` — the metrics snapshot, taken and released as a
   *    pair. `applyCols` writes a width and `applyNarrow` used to read one
   *    straight back, so every `pointermove` forced a synchronous layout of a
   *    grid of up to 10,000 cells: 15–28 ms, measured, against a 6.25 ms frame.
   *    `src/drag.ts`'s note is the long version, and `wireResizer` now routes
   *    every grip through it.
   *  · `commitOn: "keyup"` — a held arrow repeats, and this commit reaches the
   *    disk and refits the pane.
   *  · `valueText` — `aria-valuenow` alone is read as a bare number, and "62" is
   *    not a width. */
  private wireGrip(): void {
    wireResizer({
      grip: this.grip,
      // Dragging LEFT widens the drawer: it is the right-hand column, so the
      // handle moves the way the key points and the drag pulls.
      grow: "left",
      label: "Diff pane width",
      min: MIN_COLS,
      max: () => MAX_COLS,
      step: COLS_STEP,
      commitOn: "keyup",
      unitPx: () => this.metrics().ch,
      beginGesture: () => { this.frozen = this.metrics(); },
      read: () => this.cols,
      write: (cols) => {
        this.cols = clampCols(cols);
        this.applyCols();
      },
      commit: () => {
        this.frozen = null;
        this.h.onWidth(this.cols);
        // Once more with live numbers. `write` has been keeping the collapse in
        // step all along, but from the snapshot — and a window resized mid-drag
        // moves what the snapshot said about the room the list has.
        this.applyNarrow();
      },
      valueText: (cols) => `${Math.round(cols)} columns`,
    });
  }

  /** The layout the width code reads, in one place: one `ch` of the drawer's own
   *  font, the root font size, and the room the row has.
   *
   *  While a drag is in flight this answers from the snapshot the drag took, and
   *  reads nothing. None of the three can move under a pointer that is already
   *  down unless the window itself is resized, and the `ResizeObserver` on
   *  `.pr-view` is what answers for that. */
  private metrics(): Metrics {
    if (this.frozen !== null) return this.frozen;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 0;
    return { root, ch: this.chPx(root), available: this.view?.clientWidth ?? 0 };
  }

  /** One `ch` of the drawer's own font, in pixels. Measured rather than derived:
   *  `ch` is the mono face's real advance and nothing in JS knows it.
   *
   *  Takes the root size rather than reading it, because its one caller has just
   *  read it and a second `getComputedStyle` on the same element in the same breath
   *  is a second style resolution for a number already in hand. */
  private chPx(root: number): number {
    if (this.chCache !== null && this.chCache.root === root) return this.chCache.ch;
    const probe = el("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:1ch";
    this.mount.append(probe);
    const ch = probe.getBoundingClientRect().width;
    probe.remove();
    this.chCache = { root, ch };
    return ch;
  }

  /** Collapse the list when it can no longer keep its floor, rather than letting
   *  the drawer cover it: a drawer over a list whose rows are still focusable
   *  fails SC 2.4.11, and keeping them out of reach behind it would need `inert`
   *  applied at the same instant from the same place.
   *
   *  The `hidden` class on the list is not a second way of hiding it — the
   *  stylesheet's `.pr-view--narrow .pr-list` does that — it is how
   *  `firstFocusable` learns the subtree is gone. That helper tests for the
   *  class and not for layout, because jsdom computes none. */
  private applyNarrow(): void {
    if (this.view === null || this.list === null) return;
    const narrow = this.pr !== null && this.crowded();
    this.view.classList.toggle("pr-view--narrow", narrow);
    this.list.classList.toggle("hidden", narrow);
  }

  private crowded(): boolean {
    const { ch, root, available } = this.metrics();
    // Zero while the screen is hidden, and always in jsdom. Neither is crowded.
    if (available <= 0 || ch <= 0) return false;
    return available - (this.cols * ch + GRIP_PX) < LIST_FLOOR_REM * root;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private render(): void {
    const pr = this.pr;
    if (pr === null) return;
    const slot = this.slots.get(pr.number);
    const diff = slot !== undefined && slot.state === "ok" ? slot.diff : null;
    const file = diff?.files[this.index] ?? null;

    this.renderHead(file, diff);
    this.renderBar(pr);

    // The head is cheap and changes on every poll; the body is up to 2000 rows
    // and must not be rebuilt unless what it says has changed.
    // Deliberately *not* derived from the file's contents. The key answers "is
    // this the same file of the same fetch", which is what the poll can change on
    // its own; anything that edits a file in place has to say so, because a key
    // wide enough to notice an edit would also be a key that rebuilds on noise.
    // `invalidateBody` is that channel and `refetchFile` is its only caller.
    const key = [
      pr.number, slot?.state ?? "none", slot?.headRefOid ?? "", this.index,
    ].join("|");
    if (key === this.contentKey) return;
    this.contentKey = key;
    this.contentZone.replaceChildren(this.content(pr, slot, file));
  }

  private renderHead(file: DiffFile | null, diff: PrDiff | null): void {
    // The path the caller named stands in until the rows arrive, so the drawer
    // says what it is fetching rather than sitting blank for a second.
    const path = file?.path ?? this.pending;
    const [dir, base] = splitPath(path);
    // `previousPath → path` whenever there is a previous path, and that is
    // **independent of whether there is a note**: a rename that also changed
    // content has both a previous path and rows to draw, and its note is null
    // precisely because a sentence above the rows would contradict them.
    const lead = file?.previousPath != null ? `${file.previousPath} → ${dir}` : dir;
    this.pathEl.replaceChildren(document.createTextNode(lead), el("span", undefined, base));
    this.mount.setAttribute("aria-label", path ? `Diff for ${path}` : "Diff");

    this.countsEl.replaceChildren();
    // The zeroed counts of an `unreported` file are the lie that state exists to
    // name, so the head shows none rather than "+0 −0".
    if (file !== null && file.omitted?.kind !== "unreported") {
      this.countsEl.append(
        el("span", "pr-detail-plus", `+${file.additions}`),
        el("span", "pr-detail-minus", `−${file.deletions}`),
      );
    }

    const total = diff?.totalFiles ?? 0;
    this.posEl.textContent = diff === null ? "" : `${this.index + 1} of ${total}`;
    const count = diff?.files.length ?? 0;
    this.prevBtn.disabled = diff === null || this.index <= 0;
    this.nextBtn.disabled = diff === null || this.index >= count - 1;
  }

  /** The staleness bar, in a zone of its own so that it can appear without
   *  taking the diff below it down and back up again.
   *
   *  **This deliberately diverges from the detail panel's auto-refetch.** That
   *  one swaps a diffstat and a description, which is small enough that a redraw
   *  costs nothing. Swapping 2000 lines under a reader who has scrolled into
   *  them loses their place, and a diff that quietly becomes a different diff is
   *  a review of code nobody looked at. */
  private renderBar(pr: PullRequest): void {
    if (this.movedTo === null) {
      this.barZone.replaceChildren();
      return;
    }
    const note = el("p", "dv-note", "The branch moved on since this diff was read.");
    const reload = el("button", "pr-detail-retry", "Reload");
    reload.type = "button";
    reload.onclick = () => {
      this.want(pr, "reload");
      this.render();
    };
    this.barZone.replaceChildren(note, reload);
  }

  private content(pr: PullRequest, slot: DiffSlot | undefined, file: DiffFile | null): HTMLElement {
    const box = el("div");
    if (slot === undefined || slot.state === "loading") {
      box.append(el("p", "dv-note", "Reading the diff…"));
      return box;
    }
    if (slot.state === "failed") {
      box.append(el("p", "dv-note", `Could not read the diff for #${pr.number}: ${slot.message}`));
      const retry = el("button", "pr-detail-retry", "Try again");
      retry.type = "button";
      retry.onclick = () => {
        // Dropped rather than patched, so `diffCacheNext` sees "never asked" and
        // fetches unconditionally — the one reading of a button labelled
        // "Try again" that cannot answer "keep".
        this.slots.delete(pr.number);
        this.want(pr, "open");
        this.render();
      };
      box.append(retry);
      return box;
    }
    if (file === null) {
      box.append(el("p", "dv-note", "This pull request changes no files."));
      return box;
    }

    const note = fileNote(file);
    if (note !== null) {
      box.append(el("p", "dv-note", note));
      // Null when neither way out is available — the note still stands on its
      // own, and an empty row would be a band of padding under it.
      const outs = this.escapes(file);
      if (outs !== null) box.append(outs);
    }
    if (file.hunks.length > 0) box.append(this.fileEl(file));
    return box;
  }

  /** The ways out of a file the drawer cannot draw, or null when there is no way
   *  out to offer. Facts are `fileNote`'s job and buttons are this one's —
   *  baking "Open on GitHub" into the sentence would put a control's name in a
   *  paragraph a reader hears before reaching the control.
   *
   *  **Both buttons are the same fetch.** A page of one resolves `unreported` —
   *  GitHub zeroed the counts because the whole response was too full, and a
   *  smaller response cannot be — and it supplies the text for a file our own cap
   *  dropped. `tooLargeUpstream` never gets one: the bytes never arrived at any
   *  page size, measured, and a button that can only fail is worse than none. */
  private escapes(file: DiffFile): HTMLElement | null {
    const row = el("div", "dv-note");
    if (canRefetch(file.omitted)) {
      const label = file.omitted?.kind === "tooLargeLocal" ? "Show anyway" : "Check again";
      const again = el("button", "pr-detail-retry", label);
      again.type = "button";
      again.onclick = () => this.refetchFile(again);
      row.append(again);
    }
    // An anchor and not a button, and it leaves through the one gate every link
    // out of the app leaves through — see `external.ts`. Appended only if that
    // gate took the URL: `blob_url` reaches us through an `unwrap_or("")` in
    // `gh_pr.rs`, and an anchor the gate refused has neither `href` nor handler.
    // It would still look like a button, would not take focus (`view.ts` finds
    // controls by `a[href]`), and would do nothing when clicked — #252's exact
    // symptom, in the one control that exists to be the way out when the drawer
    // gave up. A missing button says that better than a dead one.
    const link = el("a", "pr-detail-retry", "Open on GitHub");
    if (wireExternal(link, file.blobUrl)) row.append(link);
    return row.childElementCount > 0 ? row : null;
  }

  /** One file's rows.
   *
   *  Built into a fragment and appended in one go, with no chunking and no
   *  virtualisation: measured against the real #151 patches, the largest file is
   *  2507 rows at 30–38 ms, which is two frames on a click. Chunking exists to
   *  break up work that blows a frame budget by an order of magnitude, and this
   *  does not qualify. (Measured in Chromium; WebKitGTK is unverified and is on
   *  the manual checklist.) */
  private fileEl(file: DiffFile): HTMLElement {
    const box = el("div", "dv-file");
    // A scroll container is not keyboard-operable unless it is focusable, and
    // without this a keyboard-only user cannot reach the right-hand end of a
    // long line (SC 2.1.1). Named, because a focus stop with no name is a stop
    // a screen reader cannot describe.
    box.tabIndex = 0;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `${file.path}, scrollable`);

    const rows = document.createDocumentFragment();
    let widest = 0;
    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i];
      // The parsed `@@` as a sentence, never the raw form: read aloud it is
      // noise, and a heading is what makes the reader's heading key the way
      // through a long diff. `h4` because the screen's own title is an `h3`.
      rows.append(el("h4", "dv-hunk-head", hunkHeading(hunk, i, file.hunks.length)));
      for (const line of classifyHunk(hunk)) {
        if (line.old !== null && line.old > widest) widest = line.old;
        if (line.new !== null && line.new > widest) widest = line.new;
        rows.append(this.lineEl(line));
      }
    }
    // The gutter's sticky offsets are the sum of the tracks to a cell's left, and
    // CSS cannot read a `max-content` track's used size. So the module hands over
    // the one number it knows and CSS cannot: how many digits the widest line
    // number in *this* file takes. Left at the stylesheet's default of 5, a file
    // of 80 lines wastes three characters of gutter; set too small, the two number
    // columns overlap while horizontally scrolled.
    box.style.setProperty("--dv-digits", String(String(widest).length));
    box.append(rows);
    return box;
  }

  private lineEl(line: DiffLine): HTMLElement {
    const row = el("div", `dv-line dv-line--${line.kind}`);
    const old = el("span", "dv-old", line.old === null ? "" : String(line.old));
    const now = el("span", "dv-new", line.new === null ? "" : String(line.new));
    // Numbers are for the eye. Read aloud before every line they would triple
    // the length of the diff and say nothing the code does not.
    old.setAttribute("aria-hidden", "true");
    now.setAttribute("aria-hidden", "true");
    // And so is the marker, because `SR_WORD` below says the same thing in
    // words. It stays a real, selectable text node all the same: it is the
    // leading character *relocated* out of the patch line, so a copied selection
    // still reassembles into a valid patch, and under Windows high contrast —
    // where both tints collapse to one system colour — it is the only thing that
    // tells added from removed.
    const mark = el("span", "dv-mark", lineMarker(line.kind));
    mark.setAttribute("aria-hidden", "true");
    const text = el("span", "dv-text");
    const word = SR_WORD[line.kind];
    if (word) text.append(el("span", "dv-sr", word));
    text.append(document.createTextNode(line.text));
    row.append(old, now, mark, text);
    return row;
  }
}
