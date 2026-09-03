// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Poller } from "../src/poll";

/** The board's poll and the pull request list's were the same loop written
 *  twice (#463, #424's sibling finding). What is asserted here is the SHAPE, not
 *  either view: chained rather than an interval, gated on being wanted and on
 *  focus, one handle at a time, and the interval read per tick.
 */
let focused = true;

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  // jsdom always reports focus; the gate is half the point of this module.
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function poller(over: Partial<{ wanted: () => boolean; every: () => number }> = {}) {
  const ticks: number[] = [];
  let n = 0;
  const p = new Poller({
    wanted: over.wanted ?? (() => true),
    every: over.every ?? (() => 1000),
    tick: async () => { ticks.push(++n); },
  });
  return { p, ticks };
}

describe("a view's poll", () => {
  it("arms one tick and no more", () => {
    const { p, ticks } = poller();
    p.arm();
    expect(p.pending).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]);
  });

  /** The whole reason this is not `setInterval`: an interval schedules the next
   *  tick whether or not the previous one came back, which on a slow network
   *  means queued `gh` processes. */
  it("arms the next tick only after the last one has returned", async () => {
    let release: (() => void) | null = null;
    const ticks: string[] = [];
    const p = new Poller({
      wanted: () => true,
      every: () => 1000,
      tick: () => new Promise((r) => { ticks.push("start"); release = () => { ticks.push("end"); r(); }; }),
    });
    p.arm();
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual(["start"]);
    // Nothing is pending while the read is in flight — an interval would have
    // queued a second one by now.
    expect(p.pending).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual(["start"]);
    release!();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.pending).toBe(true);
  });

  it("arms nothing while the view is not wanted", () => {
    const { p } = poller({ wanted: () => false });
    p.arm();
    expect(p.pending).toBe(false);
  });

  /** A window nobody is looking at is a window whose numbers nobody is reading —
   *  and for the GitHub board it is a budget nobody is spending. */
  it("arms nothing while the window has no focus", () => {
    const { p } = poller();
    focused = false;
    p.arm();
    expect(p.pending).toBe(false);
  });

  /** Asked on every arm, never remembered: the pull request list's answer is two
   *  facts already on screen rather than a variable somebody has to keep honest. */
  it("asks whether it is wanted every time, rather than once", () => {
    let on = false;
    const { p } = poller({ wanted: () => on });
    p.arm();
    expect(p.pending).toBe(false);
    on = true;
    p.arm();
    expect(p.pending).toBe(true);
  });

  /** The board's interval is its source's and the pull request list's is its row
   *  count, and both can change between ticks — a poller that captured one would
   *  be wrong the moment a workspace changed its tracker. */
  it("reads the interval per tick, not once", () => {
    let ms = 1000;
    const { p, ticks } = poller({ every: () => ms });
    p.arm();
    vi.advanceTimersByTime(1000);
    expect(ticks.length).toBe(1);
    ms = 30_000;
    p.arm();
    vi.advanceTimersByTime(1000);
    expect(ticks.length).toBe(1);
    vi.advanceTimersByTime(29_000);
    expect(ticks.length).toBe(2);
  });

  /** A manual ↻ in the middle of a wait must not leave a tick behind, and a
   *  caller that arms twice must not end up with two chains — which is the bug a
   *  bare `setTimeout` per call site invites. */
  it("replaces its pending tick rather than racing it", () => {
    const { p, ticks } = poller();
    p.arm();
    p.arm();
    p.arm();
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]);
  });

  it("stops, and stopping twice is not an error", () => {
    const { p, ticks } = poller();
    p.arm();
    p.stop();
    p.stop();
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual([]);
    expect(p.pending).toBe(false);
  });

  /** What a manual refresh and the focus handler both call: read now, then
   *  re-arm — the same path a timer takes, so the two cannot drift. */
  it("reads at once and re-arms, on run", async () => {
    const { p, ticks } = poller();
    await p.run();
    expect(ticks).toEqual([1]);
    expect(p.pending).toBe(true);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(ticks).toEqual([1, 2]);
  });

  it("reads on run even where a tick would not have been armed", async () => {
    // The focus handler's case in reverse: `run` is a deliberate press, and a
    // press is answered whether or not the chain would have re-armed itself.
    const { p, ticks } = poller({ wanted: () => false });
    await p.run();
    expect(ticks).toEqual([1]);
    expect(p.pending).toBe(false);
  });
});
