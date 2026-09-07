import { describe, it, expect } from "vitest";
import { workspaceTint, TINT_LUMA } from "../src/tint";
import { COLORS } from "../src/forms";

/** The workspace form's own six, taken from the form rather than copied: this file
 *  measures a claim ABOUT that palette — that all of it reads as comparable weight
 *  — and a copy would go on passing about a palette that had moved. */
const PALETTE = COLORS.map((c) => c.value);

/** The sidebar island the tree is rendered on: `--bg-island`. */
const GROUND = "#161719";

/** Rec. 709 luma on the gamma-ENCODED bytes, which is the space CSS composites
 *  `rgba()` in and the space the solve works in. Written out again on purpose: a
 *  test that imported the module's arithmetic to check the module's arithmetic
 *  would agree with whatever answer it gave. */
function luma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How far this colour's band actually lifts the ground: source-over at the solved
 *  alpha, measured in the same luma. */
function lift(hex: string): number {
  return workspaceTint(hex)!.alpha * (luma(hex) - luma(GROUND));
}

describe("workspaceTint", () => {
  it("reads both hex forms and hands back the channels the stylesheet needs", () => {
    // `rgb(var(--ws-tint) / …)` wants them space-separated and nothing else.
    expect(workspaceTint("#7bd77f")?.rgb).toBe("123 215 127");
    expect(workspaceTint("#fff")?.rgb).toBe("255 255 255");
    expect(workspaceTint("  #7BD77F  ")?.rgb).toBe("123 215 127");
  });

  /* A workspace's colour is a free-form string on the record (`Workspace.color`),
     so this is a real path rather than a defensive one. No tint is the honest
     answer: the group renders as it did before this feature — a group with no
     band, rather than a group with a guessed one. */
  it("declines a colour it cannot read", () => {
    expect(workspaceTint("")).toBeNull();
    expect(workspaceTint("rebeccapurple")).toBeNull();
    expect(workspaceTint("rgb(1, 2, 3)")).toBeNull();
    expect(workspaceTint("#12345")).toBeNull();
    expect(workspaceTint("#000")).toBeNull(); // nothing there to lift a ground with
  });

  /* The reason the alpha is solved at all, and constraint 3 of #511: two of the six
     swatches are near-white and one is a mid-grey, so at ONE alpha chalk's band
     would outweigh slate's by more than half again — one workspace glaring and the
     next invisible. This is that counterfactual, measured, so the next person to
     reach for a constant sees what it costs. */
  it("is solving a problem a fixed alpha would have", () => {
    const atOneAlpha = PALETTE.map((c) => luma(c) - luma(GROUND));
    expect(Math.max(...atOneAlpha) / Math.min(...atOneAlpha)).toBeGreaterThan(1.6);
  });

  it("gives all six palette colours a band of the same weight", () => {
    const lifts = PALETTE.map(lift);
    // ~1.07 as this stands. The residue is the ground term the solve drops on
    // purpose — see the note over `workspaceTint` — and not a tolerance to spend.
    expect(Math.max(...lifts) / Math.min(...lifts)).toBeLessThan(1.1);
  });

  /* The solve's own contract, before the ground it lands on takes its share: the
     band contributes exactly `TINT_LUMA` of its own colour, whichever colour that
     is. The lift measured above is this minus the ground term, which is why the two
     assertions are not the same one twice. */
  it("gives every band the luma the stylesheet was measured against", () => {
    for (const c of PALETTE) {
      expect(workspaceTint(c)!.alpha * luma(c)).toBeCloseTo(TINT_LUMA, 1);
    }
    // And what that comes out as on the island the tree is drawn on.
    for (const c of PALETTE) expect(lift(c)).toBeGreaterThan(TINT_LUMA * 0.8);
  });

  /* Off the palette, where the solve would ask for an alpha it cannot have. A
     colour this dark cannot lift the ground by `TINT_LIFT` at any alpha; the cap is
     what stops it asking for 1.0 and painting the group solid. */
  it("caps the alpha rather than painting a dark colour solid", () => {
    const t = workspaceTint("#0a0a0a")!;
    expect(t.alpha).toBe(0.25);
  });
});
