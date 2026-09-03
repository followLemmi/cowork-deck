// @vitest-environment jsdom
/** A tile's DOM, and the structural decisions that were comments inside a method
 *  nothing could reach.
 *
 *  `Deck.spawnTile` built a whole tile in 289 lines, in the file with the highest
 *  churn in the repository, on a class with 78 methods (#463). Every rule below
 *  was already written down in there — and two of them are the record of a bug
 *  that shipped, which is exactly the kind of thing a churny method loses.
 */
import { describe, it, expect } from "vitest";
import { buildTile } from "../src/tile-view";

const parts = (over: Partial<{ scheduled: boolean; broadcasting: boolean }> = {}) =>
  buildTile({ scheduled: false, broadcasting: false, ...over });

/** The head's children by their first class, which is the order a reader meets
 *  them in and the order the tab key does. */
const headOrder = (p: ReturnType<typeof buildTile>) =>
  [...p.head.children].map((c) => (c.className.split(" ")[0] || c.tagName.toLowerCase()));

describe("a tile's shell", () => {
  it("carries its state on a data attribute, not in a class", () => {
    // `.state-*` already means "a chip with this fill", and one of those names on
    // the tile would paint a chip's background across the whole thing.
    const p = parts();
    expect(p.el.dataset.state).toBe("idle");
    expect(p.el.className).toBe("tile");
  });

  it("is head, search bar, work row — in that order", () => {
    const p = parts();
    expect([...p.el.children].map((c) => c.className.split(" ")[0]))
      .toEqual(["tile-head", "tile-search", "tile-work"]);
  });

  /** The tools need `mount`'s measured width and so cannot exist before it, which
   *  is why the row comes back with only the terminal in it. */
  it("leaves the work row open past the terminal", () => {
    const p = parts();
    expect([...p.work.children]).toEqual([p.mount]);
  });
});

describe("the head", () => {
  /** The rule was `.tile-head span:first-child`, and the broadcast checkbox is
   *  inserted in FRONT of the title on every tile — so the title was never
   *  `:first-child` and never got the `flex: 1` or the ellipsis it was meant to
   *  have. A long session name pushed the badges out of the head instead of
   *  truncating. This is that bug, pinned. */
  it("puts the broadcast checkbox before the title, which is why the title is a class", () => {
    const p = parts();
    expect(headOrder(p)[0]).toBe("bcast-check");
    expect(p.title.className).toBe("tile-name");
    expect(p.head.querySelector("span:first-child")).not.toBe(p.title);
  });

  /** Ordered by what an action costs: the pencil first, then the eraser, then
   *  restart, then close. The flexible name keeps one contiguous run of width
   *  because the badges and the chip sit between it and the buttons. */
  it("sorts the action cluster by what each one costs", () => {
    const p = parts();
    const order = headOrder(p);
    const at = (el: Element) => [...p.head.children].indexOf(el);
    expect(at(p.renameBtn)).toBeLessThan(at(p.clearBtn));
    expect(at(p.clearBtn)).toBeLessThan(at(p.restartBtn));
    expect(at(p.restartBtn)).toBeLessThan(at(p.closeBtn));
    // And the name's run of width is unbroken: nothing from the cluster is
    // between the title and the state chip.
    expect(order.slice(order.indexOf("tile-name"), order.indexOf("tile-state") + 1))
      .toEqual(["tile-name", "tile-git", "tile-auth", "tile-tokens", "tile-state"]);
  });

  /** Offered when a session has ended, and an element that comes and goes is one
   *  the tab order loses. */
  it("keeps restart in the DOM and merely out of sight", () => {
    const p = parts();
    expect(p.restartBtn.style.display).toBe("none");
    expect(p.head.contains(p.restartBtn)).toBe(true);
  });

  /** Its tooltip was the only home for the spend and the subagent count, and a
   *  tooltip is where information goes to be missed — so the badge is a control.
   *  A `<span>` with a role rather than a button, because it is a measurement
   *  first and a control second. */
  it("makes the token badge reachable without making it look like a button", () => {
    const p = parts();
    expect(p.tokenBadge.tagName).toBe("SPAN");
    expect(p.tokenBadge.getAttribute("role")).toBe("button");
    expect(p.tokenBadge.tabIndex).toBe(0);
  });

  it("hides the three badges until something fills them", () => {
    const p = parts();
    for (const b of [p.gitBadge, p.authBadge, p.tokenBadge]) {
      expect(b.classList.contains("hidden")).toBe(true);
    }
  });

  it("shows the broadcast checkbox only while the deck is broadcasting", () => {
    expect(parts().bcastCheck.classList.contains("hidden")).toBe(true);
    expect(parts({ broadcasting: true }).bcastCheck.classList.contains("hidden")).toBe(false);
  });
});

describe("a scheduled tile", () => {
  /** Its own icon rather than glued to the title, which gets clipped by
   *  `text-overflow`. And a labelled `img` rather than `aria-hidden`: "started on
   *  a schedule" is a fact about the session, not decoration. */
  it("says so in the head, in words a reader can hear", () => {
    const p = parts({ scheduled: true });
    const mark = p.head.querySelector(".tile-sched-mark")!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("started on a schedule");
    expect(mark.getAttribute("aria-hidden")).toBe("false");
    // First, before even the checkbox: it qualifies the whole tile.
    expect(p.head.firstElementChild).toBe(mark);
  });

  it("and an unscheduled one carries no mark at all", () => {
    expect(parts().head.querySelector(".tile-sched-mark")).toBeNull();
  });
});

describe("the search bar", () => {
  it("starts hidden, with previous before next", () => {
    const p = parts();
    expect(p.searchBar.classList.contains("hidden")).toBe(true);
    expect([...p.searchBar.children]).toEqual([
      p.searchInput, p.searchPrev, p.searchNext, p.searchClose,
    ]);
  });
});

/** The seam itself: this module returns handles and attaches nothing. Almost
 *  every handler closes over the `Tile` record, which is built out of the
 *  terminal panel and therefore after the elements — so a builder that owned the
 *  behaviour would need the tile, and would be `spawnTile` with a hop in it. */
describe("the seam", () => {
  it("wires no behaviour at all", () => {
    const p = parts({ scheduled: true, broadcasting: true });
    const controls = [
      p.renameBtn, p.clearBtn, p.restartBtn, p.closeBtn,
      p.searchNext, p.searchPrev, p.searchClose, p.activityBtn,
    ];
    for (const c of controls) expect(c.onclick).toBeNull();
    expect(p.tokenBadge.onclick).toBeNull();
    expect(p.tokenBadge.onkeydown).toBeNull();
  });
});
