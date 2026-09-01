// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { syncDotPhase } from "../src/dot-phase";

/** The property is read by CSS as `animation-delay`, where a NEGATIVE value
 *  seeks into a running loop and a positive one postpones its start. Getting the
 *  sign wrong would not throw and would not look broken in a screenshot — it
 *  would leave a fresh dot dark for several seconds and then start it blinking
 *  against its neighbours, which is the bug this exists to close. So the sign is
 *  worth a test of its own. */
describe("syncDotPhase", () => {
  it("writes a non-positive delay in milliseconds", () => {
    const el = document.createElement("span");
    syncDotPhase(el);
    const v = el.style.getPropertyValue("--dot-phase");
    expect(v).toMatch(/^-?\d+ms$/);
    expect(Number.parseInt(v, 10)).toBeLessThanOrEqual(0);
  });

  it("hands two dots made at the same moment the same phase", () => {
    const a = document.createElement("span");
    const b = document.createElement("span");
    syncDotPhase(a);
    syncDotPhase(b);
    const ms = (el: HTMLElement) => Number.parseInt(el.style.getPropertyValue("--dot-phase"), 10);
    // Rounded to whole milliseconds, so two calls in one turn cannot differ by
    // more than the turn takes. A pair that drifted would be two dots visibly
    // out of step in the same list.
    expect(Math.abs(ms(a) - ms(b))).toBeLessThanOrEqual(1);
  });

  it("moves backwards as time passes, so a later dot seeks further in", async () => {
    const early = document.createElement("span");
    syncDotPhase(early);
    await new Promise((r) => setTimeout(r, 20));
    const late = document.createElement("span");
    syncDotPhase(late);
    const ms = (el: HTMLElement) => Number.parseInt(el.style.getPropertyValue("--dot-phase"), 10);
    expect(ms(late)).toBeLessThan(ms(early));
  });

  it("is idempotent enough to be called on a re-render", () => {
    const el = document.createElement("span");
    syncDotPhase(el);
    syncDotPhase(el);
    expect(el.style.getPropertyValue("--dot-phase")).toMatch(/ms$/);
  });
});
