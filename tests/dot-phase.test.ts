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

  it("separates two dots by no more than the time between making them", () => {
    const a = document.createElement("span");
    const b = document.createElement("span");
    const t0 = performance.now();
    syncDotPhase(a);
    syncDotPhase(b);
    const elapsed = performance.now() - t0;
    const ms = (el: HTMLElement) => Number.parseInt(el.style.getPropertyValue("--dot-phase"), 10);
    // Both phases come off ONE epoch, so their gap is exactly the wall-clock gap
    // between the two calls and nothing else — the property that makes a dot
    // built by the poll land on the phase the dots already on screen are at. A
    // pair reading its own epoch would drift without bound and be two dots
    // visibly out of step in the same list.
    //
    // Asserted against time measured here rather than against a fixed tolerance:
    // a constant small enough to mean anything is a constant that reddens CI on
    // a loaded machine, which is what a literal 1ms did.
    expect(Math.abs(ms(a) - ms(b))).toBeLessThanOrEqual(Math.ceil(elapsed) + 1);
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
