import { describe, it, expect } from "vitest";
import { notifyIdSeed } from "../src/cross-window";

/** Two windows cannot coexist in one jsdom document, and the harness's event bus
 *  has no notion of a target — so cross-window behaviour cannot be tested through
 *  the DOM at all. It is tested here instead, at the seam the decision was
 *  extracted into. The same shape the codebase already uses for
 *  `nextWaitingAcross` and `zoomParticipants`. */

describe("notifyIdSeed", () => {
  /** The sequence started at 1 in every window, so id 3 named a different
   *  session in each: clicking a notification resolved to the wrong tile, in a
   *  window that then raised itself over the one being worked in. */
  it("gives two windows disjoint ranges", () => {
    expect(notifyIdSeed("main")).not.toBe(notifyIdSeed("workspace-w1"));
  });

  /** Wide enough that no window will ever walk into its neighbour's range: a
   *  million notifications in one run is not a thing that happens. */
  it("leaves a million ids between neighbours", () => {
    const seeds = ["main", "workspace-a", "workspace-b", "workspace-c"]
      .map(notifyIdSeed)
      .sort((x, y) => x - y);
    for (let i = 1; i < seeds.length; i++) {
      expect(seeds[i] - seeds[i - 1]).toBeGreaterThanOrEqual(1_000_000);
    }
  });

  /** The label is the only thing a window knows for certain about itself before
   *  any window has spoken to any other, so the seed has to be a function of it
   *  alone — and the same one every time. */
  it("depends on nothing but the label", () => {
    expect(notifyIdSeed("workspace-w1")).toBe(notifyIdSeed("workspace-w1"));
  });
});
