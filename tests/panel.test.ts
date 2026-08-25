// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import styles from "../src/styles.css?raw";
import {
  applyPanel, firstFocusable, PANEL_PAGES, PANEL_TITLE, PANEL_WIDE,
  type PanelElements, type PanelPage,
} from "../src/view";

/** Mirrors the four pages that mount the app: the rail, the panel as a head over a
 *  stack of pages, and the deck OUTSIDE that stack. The last part is the whole
 *  point of the file — this is the one test that reads the real stylesheet, and a
 *  harness that put the deck inside the panel could not catch the regression the
 *  shell exists to make impossible. */
function mount(): PanelElements & { deck: HTMLElement } {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><div id="ledger"></div><div id="stage">' +
    '<nav id="rail"></nav>' +
    '<aside id="sidebar"><div id="panel-head"></div><div id="panel-stack">' +
    '<div id="ws-page" class="panel-page"></div>' +
    '<div id="board" class="panel-page hidden"></div>' +
    '<div id="pr" class="pr-view panel-page hidden"></div>' +
    '<div id="history" class="panel-page hidden"></div>' +
    '<div id="sk-page" class="panel-page hidden"></div>' +
    '</div></aside>' +
    '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>' +
    "</div></div>";
  const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  const rail = pick("#rail");
  const buttons = {} as Record<PanelPage, HTMLElement>;
  for (const page of PANEL_PAGES) {
    const b = document.createElement("button");
    b.className = "rail-btn";
    b.dataset.page = page;
    rail.append(b);
    buttons[page] = b;
  }
  return {
    pages: {
      sessions: pick("#ws-page"), board: pick("#board"), pr: pick("#pr"),
      history: pick("#history"), scenarios: pick("#sk-page"),
    },
    buttons,
    deck: pick("#deck"),
  };
}

const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";

describe("applyPanel", () => {
  let el: ReturnType<typeof mount>;
  beforeEach(() => { el = mount(); });

  it("shows exactly one page at a time", () => {
    for (const page of PANEL_PAGES) {
      applyPanel(el, page);
      expect(PANEL_PAGES.filter((p) => shown(el.pages[p]))).toEqual([page]);
    }
  });

  /** The regression the whole shell exists to make impossible. What this replaces
   *  hid the deck to show the board — which is why the app shipped an always-on-top
   *  pill counting blocked sessions: the window could not show the deck and
   *  anything else at once. Asserted against the real stylesheet, on every page,
   *  because `#deck { display: grid }` is an id selector and a class cannot take it
   *  down by accident. */
  it("never hides the deck, whichever page is showing", () => {
    for (const page of PANEL_PAGES) {
      applyPanel(el, page);
      expect(getComputedStyle(el.deck).display).toBe("grid");
    }
  });

  /** Three of the five pages declare their `display` with an id selector, so their
   *  `hidden` has to as well: a grouped class rule would leave `display: flex`
   *  winning and two pages on screen at once. jsdom's getComputedStyle is what
   *  makes this checkable — and also what makes the grouping trap real, since it
   *  applies a group's highest specificity to every selector in it. */
  it.each(["board", "pr", "sessions", "scenarios"] as PanelPage[])(
    "hides #%s against the real stylesheet",
    (page) => {
      applyPanel(el, "history");
      expect(getComputedStyle(el.pages[page]).display).toBe("none");
      expect(shown(el.pages.history)).toBe(true);
    },
  );

  it("marks exactly one rail button, and names it for a reader", () => {
    for (const page of PANEL_PAGES) {
      applyPanel(el, page);
      const current = PANEL_PAGES.filter(
        (p) => el.buttons[p].getAttribute("aria-current") === "page",
      );
      expect(current).toEqual([page]);
      expect(el.buttons[page].classList.contains("active")).toBe(true);
    }
  });

  it("drops aria-current instead of setting it to false", () => {
    applyPanel(el, "board");
    applyPanel(el, "sessions");
    // `aria-current="false"` is announced by some readers; the absent state here
    // is "not this one", which is what no attribute means.
    expect(el.buttons.board.hasAttribute("aria-current")).toBe(false);
  });

  it("carries a title for every page, because a rail of icons cannot", () => {
    for (const page of PANEL_PAGES) expect(PANEL_TITLE[page]).toBeTruthy();
  });

  /** Which page takes the deck's width ON ARRIVAL — one, and it is the kanban,
   *  whose columns all have to be on screen at once. The pull request page can take
   *  it too but does not ask until a diff is opened in it: the list beside the diff
   *  is four rows of text, and a panel that took the deck's width for those would be
   *  the full-width screens back under another name. */
  it("gives the deck's width to the kanban and to nothing else on arrival", () => {
    expect(PANEL_PAGES.filter((p) => PANEL_WIDE[p])).toEqual(["board"]);
  });
});

/** F6's second region used to be "whichever screen is showing", so from a board row
 *  it called `focus()` on an xterm inside a `display: none` `#deck` — a no-op,
 *  leaving focus where it was. The region is the deck unconditionally now, and this
 *  is the part of the old fix that still earns its keep: what counts as focusable
 *  has to exclude anything the app has hidden. */
describe("firstFocusable", () => {
  let el: ReturnType<typeof mount>;
  beforeEach(() => { el = mount(); });

  it("finds nothing inside the page that is hidden", () => {
    el.pages.sessions.innerHTML = '<button id="row">a session row</button>';
    el.pages.board.innerHTML = '<button id="card">a board card</button>';
    applyPanel(el, "board");
    expect(firstFocusable(el.pages.sessions)).toBeNull();
    expect(firstFocusable(el.pages.board)?.id).toBe("card");

    applyPanel(el, "sessions");
    expect(firstFocusable(el.pages.sessions)?.id).toBe("row");
    expect(firstFocusable(el.pages.board)).toBeNull();
  });

  it("skips a hidden block and keeps looking rather than stopping at it", () => {
    // Both of the app's hide classes, and the candidate it must reach is after
    // them: returning the first match and testing it afterwards would hand back a
    // control that cannot take focus.
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="tk-hidden"><button id="a">no</button></div>' +
      '<div class="hidden"><button id="b">also no</button></div>' +
      '<div><button id="c">yes</button></div>';
    expect(firstFocusable(root)?.id).toBe("c");
  });

  it("ignores a disabled control, which cannot take focus", () => {
    el.pages.board.innerHTML = '<button disabled>no</button><button id="yes">yes</button>';
    applyPanel(el, "board");
    expect(firstFocusable(el.pages.board)?.id).toBe("yes");
  });

  it("returns null when there is genuinely nothing, so the caller can fall back", () => {
    el.pages.board.innerHTML = "<p>an empty board</p>";
    applyPanel(el, "board");
    expect(firstFocusable(el.pages.board)).toBeNull();
  });
});
