// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

import { skeleton } from "../src/skeleton";

const rows = (el: HTMLElement, kind: string) =>
  [...el.querySelectorAll<HTMLElement>(`.${kind}-skeleton-row`)];

describe("the loading placeholder", () => {
  it("keeps the class names the two screens' tests address", () => {
    const tk = skeleton("tk", 6);
    expect(tk.className).toBe("tk-skeleton");
    expect(tk.querySelector(".tk-skeleton-text")?.textContent).toBe("Loading…");
    expect(rows(tk, "tk")).toHaveLength(6);

    const pr = skeleton("pr", 4);
    expect(pr.className).toBe("pr-skeleton");
    expect(rows(pr, "pr")).toHaveLength(4);
  });

  /* The whole animation hangs off this one property: the entry stagger, the
     sweep's offset and the fade down the list are all `calc()` on `--i`. A row
     that ships without it animates in lockstep with the first row and at full
     opacity, which is exactly the shape this replaced. */
  it("numbers every row for the stylesheet to stagger from", () => {
    const tk = skeleton("tk", 6);
    expect(rows(tk, "tk").map((r) => r.style.getPropertyValue("--i")))
      .toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("draws the issue row's excerpt line and the pull request's buttons", () => {
    const tk = skeleton("tk", 1);
    expect(tk.querySelector(".skel-text")).not.toBeNull();
    expect(tk.querySelector(".skel-acts")).toBeNull();

    const pr = skeleton("pr", 1);
    expect(pr.querySelector(".skel-text")).toBeNull();
    expect(pr.querySelectorAll(".skel-acts .skel-btn")).toHaveLength(3);
  });

  /* Six shapes of nothing are six pieces of nothing to a screen reader, and the
     sentence beside them is the whole of what they say to anyone else. */
  it("hides the shapes from assistive technology, and not the sentence", () => {
    const tk = skeleton("tk", 3);
    expect(tk.querySelector(".tk-skeleton-rows")?.getAttribute("aria-hidden")).toBe("true");
    expect(tk.querySelector(".tk-skeleton-text")?.hasAttribute("aria-hidden")).toBe(false);
  });

  /* A placeholder that reshuffles its own widths between two paints is a
     placeholder that flickers, so the ragged edge is a fixed cycle. */
  it("gives the same row the same width every time", () => {
    const widths = () => rows(skeleton("tk", 6), "tk")
      .map((r) => r.querySelector<HTMLElement>(".skel-title")!.style.width);
    expect(widths()).toEqual(widths());
    expect(new Set(widths()).size).toBeGreaterThan(1);
  });

  /* More rows than the width cycle is not a crash and not a repeat of row one's
     layout at the wrong index: it wraps. */
  it("wraps its width cycle past the sixth row", () => {
    const eight = rows(skeleton("tk", 8), "tk");
    expect(eight).toHaveLength(8);
    const w = (i: number) => eight[i].querySelector<HTMLElement>(".skel-title")!.style.width;
    expect(w(6)).toBe(w(0));
    expect(eight[7].style.getPropertyValue("--i")).toBe("7");
  });
});
