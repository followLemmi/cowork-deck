/** A chained poll: one tick ahead, gated on being wanted, and never overlapping.
 *
 *  Two views in this app poll — the board and the pull request list — and both
 *  had their own copy of this: a timer handle, a `stop`, a `schedule` that
 *  checked two conditions, and a tick that read and then re-armed. The audit
 *  called the second "almost a copy of the board's poll loop" (#463), which
 *  understates it: they were the same loop with different names, and the shape is
 *  the part that is load-bearing.
 *
 *  **Chained, never an interval.** `setInterval` schedules the next tick whether
 *  or not the previous one came back, which on a slow network means queued `gh`
 *  processes. So the next tick is armed at the END of the last one, and there is
 *  never more than one handle.
 *
 *  **Gated, and the gate is asked every time.** A poll runs only while its view
 *  is on screen AND the window has focus. A GitHub board at five seconds would
 *  spend 14.4% of an hour's GraphQL budget on one workspace, and a window nobody
 *  is looking at is a window whose numbers nobody is reading.
 *
 *  **The interval is the caller's, read per tick.** The board's comes from its
 *  source and the pull request list's from how many rows there are, and both can
 *  change between ticks. A poller that captured an interval once would be wrong
 *  the moment a workspace changed its tracker.
 *
 *  What this deliberately does NOT do is decide when to start. `arm` is called
 *  from wherever the answer to "is this wanted" changes — a page opening, a
 *  window taking focus, a manual refresh returning — and it is idempotent, so a
 *  caller may arm it as often as it likes.
 */
export interface PollSpec {
  /** Whether the poll is wanted at all: the view is on screen. Asked on every
   *  arm, never remembered — for the pull request list it is two facts already on
   *  screen rather than a variable somebody has to keep honest. */
  wanted: () => boolean;
  /** How long until the next tick, in milliseconds. Asked per tick. */
  every: () => number;
  /** One tick. Awaited, so the next is armed only once this has returned —
   *  which is the whole of "never overlapping". */
  tick: () => Promise<void>;
}

export class Poller {
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(private spec: PollSpec) {}

  /** Arm the next tick, or don't, depending on `wanted` and the window's focus.
   *
   *  Always drops the pending handle first. A manual refresh in the middle of a
   *  wait must not leave a tick behind it, and a caller that armed twice must not
   *  end up with two chains — which is the bug a bare `setTimeout` per call site
   *  invites and the reason this is a method rather than a helper. */
  arm(): void {
    this.stop();
    if (!this.spec.wanted() || !document.hasFocus()) return;
    this.handle = setTimeout(() => void this.run(), this.spec.every());
  }

  /** Drop the pending tick. Safe to call when there is none. */
  stop(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  /** Tick now, then arm the next — the manual-refresh path, and the same path a
   *  timer takes. `stop` first for the reason `arm` does it: a press during a
   *  wait replaces the pending tick rather than racing it. */
  async run(): Promise<void> {
    this.stop();
    await this.spec.tick();
    this.arm();
  }

  /** Whether a tick is pending. For tests, and for nothing else: a caller that
   *  branched on this would be keeping a second copy of the state `wanted`
   *  already answers. */
  get pending(): boolean {
    return this.handle !== null;
  }
}
