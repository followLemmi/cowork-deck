// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyScale, BASE_PX, broadcastScale, clampScale, currentScale, DEFAULT_SCALE, nextScale,
  prevScale, rootFontPx, SCALE_STEPS, scaleLabel, TERMINAL_BASE_PX, terminalFontPx, UI_SCALE_EVENT,
} from "../src/ui-scale";

// Module state, so every test starts from the default rather than from whatever the
// previous one left behind.
beforeEach(() => applyScale(DEFAULT_SCALE, document.documentElement));

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

  it("rounds the case that would otherwise be fractional", () => {
    // 14 * 1.15 is 16.1 exactly — the example the plan names.
    expect(TERMINAL_BASE_PX * 1.15).toBeCloseTo(16.1, 5);
    expect(terminalFontPx(1.15)).toBe(16);
  });

  it("leaves the default at the terminal's own base", () => {
    expect(terminalFontPx(DEFAULT_SCALE)).toBe(TERMINAL_BASE_PX);
  });

  it("never goes backwards as the scale rises", () => {
    const sizes = SCALE_STEPS.map(terminalFontPx);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
  });
});

describe("rootFontPx", () => {
  it("is the declared base at the default scale", () => {
    expect(rootFontPx(DEFAULT_SCALE)).toBe(BASE_PX);
  });

  it("rounds off binary floating-point noise", () => {
    // 13 * 1.3 is 16.900000000000002, and that string would end up in an inline style
    // for anyone inspecting the element to read. 1.15 is *not* an example — 13 * 1.15
    // is exactly 14.95 — which is why the invariant below is the one worth asserting.
    expect(BASE_PX * 1.3).not.toBe(16.9);
    expect(rootFontPx(1.3)).toBe(16.9);
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
    expect(scaleLabel(1.3)).toContain("16.9px");
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
    expect(detail).toBe(16);
  });
});
