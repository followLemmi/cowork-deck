/** The pull request list's state and its one read.
 *
 *  The symmetric half of `board-controller.ts`, and cut for the same reason
 *  (#463): 106 lines of a 3206-line closure, sharing two pieces of mutable state
 *  by lexical scope with sixty-eight other nested functions.
 *
 *  The audit called this view "almost a copy of the board's poll loop". The LOOP
 *  is `poll.ts` now and shared outright — what is left here is not a copy of
 *  anything, and the differences are the interesting part:
 *
 *  · `prShowing` is not derivable from the state, where the board's is not either
 *    but for a different reason. `workspace` alone says which workspace the state
 *    is ABOUT, and pairing it with `fetchedAt === null` was wrong in the case
 *    that matters most — a first read that fails leaves both set that way, so
 *    every tick from then on would blank the error, or the unavailable box and
 *    its only button, for grey boxes and then put it back.
 *  · There is no last-good cache. `pr_list` asks for one page and the view keeps
 *    whatever it last drew IN the state, so a failure leaves the rows there with
 *    the age line above them. The board needs a map because its rows are keyed by
 *    workspace and it has two sources; this has one.
 *  · Two states do not poll at all — no workspace and no bound account — and both
 *    still have to stop the previous state polling. Nothing will change in either
 *    without a human editing a workspace.
 *
 *  What stayed in `app.ts` is the same half as the board's: the poll (the panel
 *  arms it, and `prVisible` is two DOM facts that belong to the panel), and every
 *  action — launching from a row, merging, closing, reopening, the worktree
 *  cleanup. Each of those reaches into session launching and the modal stack.
 */
import type { PullRequest } from "./ipc";
import { prList } from "./ipc";
import type { PrState, PrView } from "./pr-view";
import { unavailableFrom } from "./issues";
import type { WorkspacesPanel } from "./workspaces";

export interface PrControllerHost {
  /** Which workspace is active, read per call: every read here can be overtaken
   *  by a switch, and the guard against a late reply repainting another
   *  workspace's rows is a comparison against this. */
  workspaces: Pick<WorkspacesPanel, "active">;
  prView: Pick<PrView, "render">;
  /** A list was drawn. The diff drawer re-reads the head of whichever pull
   *  request it is showing and offers a Reload if the branch has moved — it never
   *  swaps the diff out from under a reader. Called after the render and after
   *  both late-reply guards, so the drawer is never told about a workspace whose
   *  answer was discarded. */
  onPolled(prs: PullRequest[]): void;
}

export class PrController {
  constructor(private h: PrControllerHost) {}
  /** Which workspace the pull request view is showing an answer for — rows, an error
   *  beside them, or an unavailable box. The board's `boardShowing`, for the same
   *  reason and with the same rule: a skeleton is painted only where nothing on
   *  screen belongs to the workspace about to be read.
   *
   *  Not derivable from `this.state`. `workspace` alone says which workspace the state is
   *  *about*, and pairing it with `fetchedAt === null` was wrong in the case that
   *  matters most: a first read that fails leaves both set that way, so every tick
   *  from then on would blank the error — or the unavailable box and its only button —
   *  for grey boxes and then put it back. */
  private showing: string | null = null;
  private state: PrState = {
    workspace: null, unavailable: null, prs: [], error: null, fetchedAt: null, total: null,
    loading: false,
  };

  /** Re-read the list.
   *
   *  Not the poll's entry point — `prPoll.run()` is, and it drops the pending
   *  tick before this runs and arms the next after it. This is only the read, so
   *  a manual ↻ and a timer take exactly the same path. */
  async read(): Promise<void> {
    const ws = this.h.workspaces.active;
    if (!ws) {
      this.state = {
        ...this.state, workspace: null, unavailable: "no-account", prs: [], loading: false,
      };
      this.h.prView.render(this.state, Date.now());
      // No workspace is nobody's answer, so the next one read gets a skeleton rather
      // than inheriting this screen.
      this.showing = null;
      return;
    }
    if (!ws.github) {
      this.state = {
        ...this.state, workspace: ws.name, unavailable: "no-account", prs: [], loading: false,
      };
      this.h.prView.render(this.state, Date.now());
      this.showing = ws.id;
      // Nothing will change here without a human editing the workspace, so this
      // state does not poll — but it also must not leave the previous one polling.
      return;
    }
    const wsId = ws.id;
    // Only where there is nothing of this workspace's to keep: a poll tick every 15 s
    // keeps the rows it already has, with the age line above saying how old they are.
    if (this.showing !== wsId) {
      this.state = {
        workspace: ws.name, unavailable: null, prs: [], error: null, fetchedAt: null,
        total: null, loading: true,
      };
      this.h.prView.render(this.state, Date.now());
    }
    try {
      const prs = await prList(wsId);
      // The workspace may have been switched while we waited on IPC: a late reply
      // must not repaint the view with another workspace's pull requests.
      if (this.h.workspaces.active?.id !== wsId) return;
      this.state = {
        workspace: ws.name, unavailable: null, prs,
        error: null, fetchedAt: Date.now(),
        // What came back, and nothing more: `pr_list` asks for one page, so the
        // number of open pull requests the repository has is not knowable from
        // here (see #115).
        total: prs.length,
        loading: false,
      };
    } catch (e) {
      if (this.h.workspaces.active?.id !== wsId) return;
      const msg = String((e as { message?: string })?.message ?? e);
      // Known unavailabilities become their own screen; everything else — a
      // missing `repo` scope, the rate limit, an offline machine — keeps the last
      // good list on screen beside the error, with its age. The mapping itself now
      // lives in `issues.ts` and is read by the board too: it used to be an
      // if-chain here, which was one place for the two GitHub views to disagree
      // about what "no repository" looks like.
      const known = unavailableFrom(msg);
      if (known !== null) this.state = { ...this.state, unavailable: known, loading: false };
      else this.state = { ...this.state, error: msg, loading: false };
    }
    this.h.prView.render(this.state, Date.now());
    // After the render and after the two late-reply guards, so the drawer is never
    // told about a workspace whose answer was discarded. It re-reads the head of
    // whichever pull request it is showing and offers a Reload if the branch has
    // moved — it never swaps the diff out from under a reader.
    this.h.onPolled(this.state.prs);
    // Whatever it ended up drawing, it is this workspace's answer — so the next tick
    // keeps it. After the render, and after the two late-reply guards above, so a
    // reply that was discarded does not claim the screen.
    this.showing = wsId;
  }

  /** The rows on screen, for the poll's own interval: a list of thirty is worth
   *  asking about less often than a list of three (`pollIntervalMs`). Read rather
   *  than held by the caller, so there is one copy of this state. */
  get prs(): PullRequest[] {
    return this.state.prs;
  }

  /** Forget which workspace the screen belongs to, so the next read paints a
   *  skeleton rather than inheriting what is there. For the caller that knows the
   *  screen has stopped being an answer without going through a read. */
  forget(): void {
    this.showing = null;
  }
}
