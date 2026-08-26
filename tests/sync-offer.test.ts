// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { offerBanner, offerText, shouldOffer } from "../src/sync-offer";

const ws = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ws-${i}` }));
const base = { on: false, workspaces: ws(2), ui: { syncOfferDismissed: false } };

describe("whether the deck mentions sync unprompted", () => {
  it("offers once to somebody who has workspaces and no sync", () => {
    expect(shouldOffer(base)).toBe(true);
  });

  it("says nothing when sync is already running", () => {
    expect(shouldOffer({ ...base, on: true })).toBe(false);
  });

  it("never asks again once waved away", () => {
    // The whole point of the flag. An offer that comes back is not an offer.
    expect(shouldOffer({ ...base, ui: { syncOfferDismissed: true } })).toBe(false);
  });

  it("stays quiet on a fresh install with nothing to sync", () => {
    // Selling a feature before it can do anything is how a first run becomes a
    // queue of notices.
    expect(shouldOffer({ ...base, workspaces: [] })).toBe(false);
  });

  it("keeps quiet on a fresh install even if sync was never declined", () => {
    expect(shouldOffer({ on: false, workspaces: [], ui: { syncOfferDismissed: false } })).toBe(false);
  });
});

describe("what the offer says", () => {
  it("names what does not travel, not only what does", () => {
    const t = offerText(3);
    expect(t).toMatch(/private GitHub repository/i);
    // The half people assume wrong.
    expect(t).toMatch(/stay on this machine/i);
    expect(t).toMatch(/Session layout/i);
  });

  it("counts what is actually at stake", () => {
    expect(offerText(1)).toContain("1 workspace,");
    expect(offerText(4)).toContain("4 workspaces,");
  });
});

describe("the banner itself", () => {
  const build = () => {
    const calls = { setup: 0, dismiss: 0 };
    const b = offerBanner(2, () => calls.setup++, () => calls.dismiss++);
    return { b, calls };
  };

  it("offers exactly two ways out, and no third that means something else", () => {
    // A close cross alongside "Not now" is a decision nobody wanted to make:
    // does it mean "later" or "never"?
    const { b } = build();
    const buttons = [...b.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((x) => x.textContent)).toEqual(["Set it up", "Not now"]);
  });

  it("calls back rather than deciding anything itself", () => {
    const { b, calls } = build();
    const [setup, not] = [...b.querySelectorAll("button")];
    setup.click();
    expect(calls).toEqual({ setup: 1, dismiss: 0 });
    not.click();
    expect(calls).toEqual({ setup: 1, dismiss: 1 });
  });

  it("is a region, not an alert", () => {
    // An alert interrupts a screen reader mid-sentence. This is an offer.
    const { b } = build();
    expect(b.getAttribute("role")).toBe("region");
    expect(b.getAttribute("aria-label")).toBe("Memory sync");
  });
});
