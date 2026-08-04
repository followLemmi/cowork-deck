// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyScale, BASE_PX, broadcastScale, clampScale, currentScale, DEFAULT_SCALE, nextScale,
  prevScale, rootFontPx, SCALE_STEPS, scaleLabel, TERMINAL_BASE_PX, terminalFontPx, UI_SCALE_EVENT,
} from "../src/ui-scale";

// Module state, so every test starts from the default rather than from whatever the
// previous one left behind.
beforeEach(() => applyScale(DEFAULT_SCALE, document.documentElement));

describe("DEFAULT_SCALE", () => {
  it("is one of the steps", () => {
    // `clampScale` returns it for a non-finite input, and `nextScale`/`prevScale`
    // find their position with `indexOf`. An off-step default would return -1 there,
    // making "larger" jump to the second step and "smaller" to the last one.
    expect(SCALE_STEPS).toContain(DEFAULT_SCALE);
  });

  it("is not the bottom of the ladder, so smaller is always available", () => {
    expect(prevScale(DEFAULT_SCALE)).toBeLessThan(DEFAULT_SCALE);
    expect(nextScale(DEFAULT_SCALE)).toBeGreaterThan(DEFAULT_SCALE);
  });
});

describe("clampScale", () => {
  it("returns the steps unchanged", () => {
    for (const s of SCALE_STEPS) expect(clampScale(s)).toBe(s);
  });

  it("snaps a value between steps onto the nearest one", () => {
    // Not clamped to the ends: `nextScale`/`prevScale` look the value up by index, so
    // anything off-step would leave the larger/smaller commands doing nothing.
    // The midpoint of 1.15 and 1.3 is 1.225, which is what these straddle.
    expect(clampScale(1.2)).toBe(1.15);
    expect(clampScale(1.22)).toBe(1.15);
    expect(clampScale(1.24)).toBe(1.3);
    expect(SCALE_STEPS).toContain(clampScale(1.07));
  });

  it("pulls a value outside the range back to the nearest end", () => {
    expect(clampScale(0.1)).toBe(SCALE_STEPS[0]);
    expect(clampScale(9)).toBe(SCALE_STEPS[SCALE_STEPS.length - 1]);
  });

  it("falls back to the default for anything that is not a number", () => {
    // A hand-edited ui_state.json, or a field that arrives as null through JSON.
    expect(clampScale(NaN)).toBe(DEFAULT_SCALE);
    expect(clampScale(Infinity)).toBe(DEFAULT_SCALE);
    expect(clampScale(undefined as unknown as number)).toBe(DEFAULT_SCALE);
  });

  it("treats a zero as the smallest step, not as a zero", () => {
    // What a `f32` field would hold if `serde`'s default were ever derived instead of
    // written: a scale of 0 is an invisible interface.
    expect(clampScale(0)).toBe(SCALE_STEPS[0]);
  });
});

describe("stepping", () => {
  it("walks up and down through the steps", () => {
    expect(nextScale(SCALE_STEPS[0])).toBe(SCALE_STEPS[1]);
    expect(prevScale(SCALE_STEPS[1])).toBe(SCALE_STEPS[0]);
  });

  it("saturates instead of wrapping", () => {
    const top = SCALE_STEPS[SCALE_STEPS.length - 1];
    // A "larger" command that suddenly makes everything small reads as a bug.
    expect(nextScale(top)).toBe(top);
    expect(prevScale(SCALE_STEPS[0])).toBe(SCALE_STEPS[0]);
  });

  it("steps from an off-step value by snapping first", () => {
    expect(nextScale(1.2)).toBe(1.3);
    expect(prevScale(1.2)).toBe(1);
  });

  it("reaches both ends by stepping, so no step is unreachable", () => {
    let s: number = SCALE_STEPS[0];
    const seen = [s];
    for (let i = 0; i < SCALE_STEPS.length + 2; i++) {
      const up = nextScale(s);
      if (up === s) break;
      s = up;
      seen.push(s);
    }
    expect(seen).toEqual([...SCALE_STEPS]);
  });
});

describe("terminalFontPx", () => {
  it("is always a whole number", () => {
    // xterm measures its character grid from the font size, so a fractional size
    // gives fractional cells and every glyph lands off the pixel grid.
    for (const s of SCALE_STEPS) expect(Number.isInteger(terminalFontPx(s))).toBe(true);
  });

  it("rounds the steps that would otherwise be fractional", () => {
    // 16 * 1.15 is 18.4 and 16 * 1.45 is 23.2. Either would give xterm a fractional
    // character cell, every glyph would land off the device pixel grid, and the
    // whole terminal would go soft.
    expect(TERMINAL_BASE_PX * 1.15).toBeCloseTo(18.4, 5);
    expect(terminalFontPx(1.15)).toBe(18);
    expect(terminalFontPx(1.45)).toBe(23);
  });

  it("leaves an unscaled interface at the terminal's own base", () => {
    // 1, not DEFAULT_SCALE. The two were the same until the default became 1.15 and
    // are the same again now that it is back to 1 — kept apart deliberately, so the
    // day the default moves off 100% this test still says which value it is about.
    expect(terminalFontPx(1)).toBe(TERMINAL_BASE_PX);
  });

  it("puts the shipped default on a whole pixel", () => {
    // 16, which is the size the terminal already shipped at: the old pair was a
    // 14px base and a 1.15 default, and `round(14 * 1.15)` is 16. The base absorbed
    // the multiplier rather than the terminal changing size.
    expect(terminalFontPx(DEFAULT_SCALE)).toBe(16);
  });

  it("never goes backwards as the scale rises", () => {
    const sizes = SCALE_STEPS.map(terminalFontPx);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
  });
});

describe("rootFontPx", () => {
  it("is the declared base at 100%", () => {
    expect(rootFontPx(1)).toBe(BASE_PX);
  });

  it("is the declared base at the shipped default", () => {
    // This assertion is the inverse of the one it replaces, and deliberately so.
    // The app used to open at 14.95px off a declared 13px base, so the declared base
    // was a size nobody ever saw and every step had to be read twice. The raise now
    // lives in BASE_PX, which frees the multiplier to mean what its name says.
    expect(rootFontPx(DEFAULT_SCALE)).toBe(BASE_PX);
    expect(rootFontPx(DEFAULT_SCALE)).toBe(16);
  });

  it("keeps its rounding guard even though no current step needs one", () => {
    // The rounding exists because `13 * 1.15` is 14.949999999999999, and that string
    // ended up in an inline style for anyone inspecting the element to read. At a
    // power-of-two base there is no such case left: multiplying by 16 only shifts a
    // float's exponent, so every step comes out exactly representable. The guard
    // stays — the base is a judgement, and the next one need not be a power of two.
    for (const s of SCALE_STEPS) expect(rootFontPx(s)).toBe(BASE_PX * s);
    expect(rootFontPx(1.3)).toBe(20.8);
  });

  it("never produces more than two decimals, whatever the step", () => {
    for (const s of SCALE_STEPS) {
      const px = rootFontPx(s);
      expect(px).toBe(Math.round(px * 100) / 100);
      expect(String(px)).toMatch(/^\d+(\.\d{1,2})?$/);
    }
  });
});

describe("applyScale", () => {
  it("writes the root's inline font size", () => {
    const root = document.createElement("div");
    applyScale(1.3, root);
    expect(root.style.fontSize).toBe(`${rootFontPx(1.3)}px`);
  });

  it("records the applied scale, which is what new terminals read", () => {
    applyScale(1.3, document.createElement("div"));
    expect(currentScale()).toBe(1.3);
  });

  it("records the snapped value, not the one it was given", () => {
    applyScale(1.2, document.createElement("div"));
    expect(currentScale()).toBe(1.15);
  });
});

describe("scaleLabel", () => {
  it("names the percentage and what it means in pixels", () => {
    expect(scaleLabel(1.3)).toContain("130%");
    expect(scaleLabel(1.3)).toContain("20.8px");
  });

  it("marks the default so a person can get back to it", () => {
    expect(scaleLabel(DEFAULT_SCALE)).toContain("default");
    expect(scaleLabel(1.3)).not.toContain("default");
  });
});

describe("broadcastScale", () => {
  it("carries pixels rather than the scale, which is what xterm's option takes", () => {
    const target = new EventTarget();
    let detail: number | null = null;
    target.addEventListener(UI_SCALE_EVENT, (e) => { detail = (e as CustomEvent<number>).detail; });
    broadcastScale(1.15, target);
    expect(detail).toBe(terminalFontPx(1.15));
    // The literal is here so the test fails if the payload silently becomes the
    // scale: `1.15` would also satisfy the line above if `terminalFontPx` were the
    // identity. 18 is `round(16 * 1.15)`.
    expect(detail).toBe(18);
  });
});
