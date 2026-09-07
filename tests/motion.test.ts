// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { tokenMs, settleMs, holdRefits, refitsHeld } from "../src/motion";

/** Declare the duration tokens on the root, the way the stylesheet does.
 *
 *  jsdom resolves custom properties off an inline `style` but does not load
 *  `styles.css`, so a test that wants a token has to put one there. That is also
 *  what makes the 0 branch reachable: with nothing declared, this is exactly the
 *  environment the fallback exists for. */
function declare(props: Record<string, string>) {
  for (const [k, v] of Object.entries(props)) {
    document.documentElement.style.setProperty(k, v);
  }
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  holdRefits(false);
});

describe("tokenMs", () => {
  it("reads a declared duration token, unit stripped", () => {
    declare({ "--dur-3": "340ms" });
    expect(tokenMs("--dur-3")).toBe(340);
  });

  it("is 0 for a token that is not declared", () => {
    expect(tokenMs("--dur-3")).toBe(0);
  });

  it("is 0 rather than NaN for a value that is not a number", () => {
    declare({ "--dur-3": "none" });
    expect(tokenMs("--dur-3")).toBe(0);
  });

  it("reads a fractional value", () => {
    declare({ "--breath-working": "3.6s" });
    expect(tokenMs("--breath-working")).toBeCloseTo(3.6);
  });
});

describe("settleMs", () => {
  it("is the morph plus the smallest duration as its margin", () => {
    declare({ "--dur-3": "340ms", "--dur-1": "120ms" });
    expect(settleMs()).toBe(460);
  });

  /* The property that matters, stated as one: a cleanup that lands before the
     motion it is cleaning up after wipes a transform mid-flight. That was the
     bug — a 220ms cleanup outliving the 180ms morph it was the margin on — so it
     is asserted rather than left to the arithmetic above. */
  it("outlasts the morph it waits out", () => {
    declare({ "--dur-3": "340ms", "--dur-1": "120ms" });
    expect(settleMs()).toBeGreaterThan(tokenMs("--dur-3"));
  });

  it("is 0 with no stylesheet, so a test waits for nothing", () => {
    expect(settleMs()).toBe(0);
  });
});

describe("the refit hold", () => {
  /* Off to begin with, and that is the property worth asserting rather than the
     setter working: a module that started out HELD would leave every terminal
     deaf to its box until something happened to release it, which is the failure
     mode the doc comment calls worse than the jank. */
  it("is off until something holds it", () => {
    expect(refitsHeld()).toBe(false);
  });

  it("holds and releases", () => {
    holdRefits(true);
    expect(refitsHeld()).toBe(true);
    holdRefits(false);
    expect(refitsHeld()).toBe(false);
  });
});
