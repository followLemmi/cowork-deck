/** The board's own state and its two reads.
 *
 *  Cut out of `startApp` (#463). It was 167 lines of a 3206-line closure, sharing
 *  three pieces of mutable state by lexical scope with sixty-eight other nested
 *  functions — and reachable only by booting the whole app behind a mock of
 *  thirteen `ipc` exports, which is why eleven tests could get at any of it.
 *
 *  What moved is the READ half: the two caches, which workspace the screen belongs
 *  to, the refresh, and paging. What stayed in `app.ts` is the ACTION half —
 *  capturing a card, launching from one, moving one, the card modal, the board
 *  editor — because each of those reaches into session launching and the modal
 *  stack, and a context object wide enough to carry those would be the closure
 *  again with a name.
 *
 *  Three things are handed in and nothing else is reachable, which is the whole
 *  point of the cut: this class can be asked to refresh a board without a window.
 */
import type { MigrationOffer, Task } from "./ipc";
import {
  issueTotals, listTasks, taskCapabilities, taskMigrationStatus, taskOpenCounts,
} from "./ipc";
import type { BoardView } from "./board";
import { isTerminal } from "./board-config";
import type { GhUnavailable } from "./gh-unavailable";
import {
  CLOSED_PAGE_LIMIT, needsTotals, nextPageLimit, sourceOf, unavailableFrom,
} from "./issues";
import type { TaskSessionLink } from "./tasks";
import type { WorkspacesPanel } from "./workspaces";

export interface BoardControllerHost {
  /** Which workspace is active. Read per call rather than captured: every read in
   *  here can be overtaken by a switch, and the guard against a late reply
   *  repainting another workspace's board is a comparison against this. */
  workspaces: Pick<WorkspacesPanel, "active">;
  board: Pick<BoardView, "render">;
  /** The live sessions this workspace's cards are linked to. The deck's, and
   *  narrowed to a workspace by the caller: the rules behind "in progress" match
   *  on a card id, and an issue number is unique to one repository. */
  taskLinks(workspaceId: string): TaskSessionLink[];
  /** The open-task counts changed. `app.ts` owns the badge, because the badge is
   *  on the workspace panel's tab and the tab is the panel's. */
  onCounts(counts: Record<string, number>): void;
}

export class BoardController {
  constructor(private h: BoardControllerHost) {}
  /** The last good list per GitHub workspace, so a failed tick keeps the screen
   *  populated. In memory only, and keyed by workspace id: a late reply about a
   *  workspace nobody is looking at must not repaint the current one.
   *
   *  **GitHub only, deliberately — on the read as much as on the write.** The reason
   *  for keeping stale rows is that being offline or rate-limited is a blip in front
   *  of data that is still true, which is a GitHub condition; a file board's failure
   *  is almost always "the folder is gone", where phantom cards would invite actions
   *  that can only fail and would replace the one screen offering `Configure`. The
   *  plan's code kept them for both sources; narrowed here rather than changing a
   *  shipped screen nobody asked about.
   *
   *  Gating only the write was not enough, and the entry outliving the source is the
   *  reason: switching a workspace's source to a folder is a first-class action with
   *  its own confirmation, and it leaves this map holding that workspace's issues
   *  under the same id. An ungated read then handed the file board those issues on
   *  its first failure — phantom cards on a board whose root is gone, `Configure`
   *  withheld because the list was not empty, and a count line about issues that
   *  were never in that folder. */
  private readonly lastGood = new Map<
    string, { tasks: Task[]; fetchedAt: number; total: number | null; closedTotal: number | null }
  >();

  /** How far each GitHub workspace has been paged, or absent for the source's own
   *  defaults (50 open, 20 closed).
   *
   *  Keyed by workspace, so paging one board does not widen another's — and every
   *  poll from then on fetches the larger page, which is the honest cost of showing
   *  rows somebody asked to see. In memory only: a page is a reading position, not a
   *  setting, and a restart landing back on the first fifty is the right default. */
  private readonly pageLimits = new Map<string, number>();

  /** Which workspace the board is currently showing an answer for, whatever that
   *  answer is — rows, an error beside them, or an unavailable box.
   *
   *  The one thing the skeleton needs to know. A loading state is painted only when
   *  this is not the workspace about to be read: the first read of a board, and the
   *  first read after a switch, are the two moments when nothing on screen belongs
   *  to it. A poll tick keeps what is drawn; replacing a screen that is true — or a
   *  box explaining why it cannot be — with grey boxes every 30 s is a flicker
   *  rather than feedback. */
  private showing: string | null = null;

  /** "Show more": one step past the page the rows on screen were measured against,
   *  then read it again. `from` comes from the view because the two states start at
   *  different defaults and only the view knows which filter the button was under. */
  async showMore(from: number): Promise<void> {
    const ws = this.h.workspaces.active;
    if (!ws) return;
    this.pageLimits.set(ws.id, nextPageLimit(from));
    await this.refresh();
  }

  /** Redraw the active workspace's board. Every IPC call is isolated: one failing
   *  handle must not take the whole tick down. */
  async refresh(): Promise<void> {
    const ws = this.h.workspaces.active;
    if (!ws) {
      this.h.board.render({ project: "", caps: null, error: null, tasks: [], links: [], source: "fs" });
      // No workspace is nobody's answer, so the next board to be read gets a
      // skeleton rather than inheriting this screen's emptiness.
      this.showing = null;
      return;
    }
    const wsId = ws.id;
    const source = sourceOf(ws.tracker ?? null);
    const pageLimit = this.pageLimits.get(wsId) ?? null;
    let caps = null;
    try { caps = await taskCapabilities(wsId); } catch (e) { console.debug("caps failed", e); }

    // Until now this window drew nothing at all: `setPanel("board")` called this, and
    // the first render came after every await below — so opening a GitHub board left an
    // empty pane for as long as a repository lookup plus a page per state takes.
    //
    // Painted after `taskCapabilities` and not before it, and the few milliseconds are
    // affordable because that call is a local read by construction — `provider_for`
    // does no I/O, which is what keeps the three unavailable states reachable. What it
    // buys is a head drawn with this board's real `+ task` and `⚙` rather than one
    // that grows buttons a moment later. It is not what keeps "No task tracker is
    // configured" off the screen: the skeleton branch in `board.ts` sits ahead of that
    // one deliberately, and the comment there is the reason.
    if (this.showing !== wsId && this.h.workspaces.active?.id === wsId) {
      this.h.board.render({
        project: ws.name, caps, error: null, tasks: [], links: this.h.taskLinks(wsId),
        source, unavailable: null, fetchedAt: null, total: null, closedTotal: null,
        rateRemaining: null, loading: true, pageLimit,
      }, Date.now());
    }

    let tasks: Task[] = [];
    let error: string | null = null;
    let unavailable: GhUnavailable | null = null;
    let total: number | null = null;
    let closedTotal: number | null = null;
    let rateRemaining: number | null = null;
    let fetchedAt: number | null = null;

    if (caps) {
      const cfg = caps.board;
      try {
        tasks = await listTasks(wsId, pageLimit ?? undefined);
        fetchedAt = Date.now();
        const open = tasks.filter((t) => !isTerminal(cfg, t.status)).length;
        const closed = tasks.length - open;
        // Only when it can change the answer: a page shorter than what was asked for
        // *is* the total, so in a repository under fifty open issues this never
        // fires. Measured against the page actually requested rather than against
        // the constant — a board paged to 150 would otherwise ask for totals it
        // already has on screen, every 30 s.
        //
        // Either state being at its cap is reason enough: the closed filter needs its
        // own total for the same reason the open one does, and both come back in the
        // one point this call costs.
        if (source === "github"
            && (needsTotals(open, pageLimit ?? undefined)
              || needsTotals(closed, pageLimit ?? CLOSED_PAGE_LIMIT))) {
          const t = await issueTotals(wsId).catch(() => null);
          if (t) { total = t.open; closedTotal = t.closed; rateRemaining = t.rateRemaining; }
        }
        if (source === "github") this.lastGood.set(wsId, { tasks, fetchedAt, total, closedTotal });
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        // The three states in which the source cannot be read at all become their
        // own screen; everything else — offline, rate-limited, a missing scope —
        // keeps the last good list on screen beside the error, with its age. Asked
        // only of a GitHub source: none of those markers can come out of a folder,
        // and a file board's own errors already say what is wrong.
        const known = source === "github" ? unavailableFrom(msg) : null;
        if (known !== null) unavailable = known;
        else error = msg;
        // Read under the same condition it is written under: the map is keyed by
        // workspace id and outlives a source switch, so an ungated read is how a
        // file board ends up drawing the issues that workspace had while it was
        // GitHub-backed.
        const kept = source === "github" ? this.lastGood.get(wsId) : undefined;
        if (kept) {
          tasks = kept.tasks;
          fetchedAt = kept.fetchedAt;
          total = kept.total;
          closedTotal = kept.closedTotal;
        }
      }
    }
    let migration: MigrationOffer | null = null;
    // Asked only where it can be answered: a GitHub workspace has no previous
    // folder, and the backend refuses the command rather than inventing one.
    if (source === "fs") {
      try { migration = await taskMigrationStatus(wsId); }
      catch (e) { console.debug("migration status failed", e); }
    }
    // The workspace may have been switched while we waited on IPC: a late reply
    // must not repaint the board with another workspace's data over the current one.
    if (this.h.workspaces.active?.id !== wsId) return;
    this.h.board.render({
      // This workspace's links, never the app's: the rules behind "in progress" and
      // "no live session" match on the card id, and an issue number is unique to one
      // repository. A session on another workspace's #42 must not speak for this
      // board's — it would read as in progress and lose its ▶.
      project: ws.name, caps, error, tasks, links: this.h.taskLinks(wsId), migration,
      source, unavailable, fetchedAt, total, closedTotal, rateRemaining, pageLimit,
    }, Date.now());
    // Whatever the board ended up drawing, it is this workspace's answer — so the
    // next tick keeps it rather than blanking it. Set after the render, and after the
    // late-reply guard above, so a reply that was discarded does not claim the screen.
    this.showing = wsId;
  }

  /** Open tasks per workspace, and the one number that gets shown: the active
   *  workspace's, on the board's own tab.
   *
   *  It used to be a badge in the tree — first beside the waiting count on the
   *  workspace's own line, where "12" beside "1 waiting" said neither what it
   *  counted, then on a "Board" row of its own under every workspace. On the tab
   *  it sits beside the page it counts, which is the only place it needs no
   *  explaining. */
  async refreshCounts(): Promise<void> {
    try {
      this.h.onCounts(await taskOpenCounts());
    } catch (e) { console.debug("taskOpenCounts failed", e); }
  }

  /** Forget which workspace the screen belongs to, so the next read paints a
   *  skeleton rather than inheriting what is there.
   *
   *  For the one caller that knows the screen has stopped being an answer without
   *  going through a read: closing the panel. */
  forget(): void {
    this.showing = null;
  }
}
