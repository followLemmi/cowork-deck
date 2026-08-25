// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import styles from "../src/styles.css?raw";
import {
  applyPanel, applyWorkspacePanel, firstFocusable,
  PANEL_PAGES, PANEL_TITLE, WORKSPACE_PAGES, WORKSPACE_TITLE,
  type PanelElements, type PanelPage,
  type WorkspacePage, type WorkspacePanelElements,
} from "../src/view";

/** Mirrors the four pages that mount the app: the rail, the left panel as a head
 *  over a stack of pages, the deck OUTSIDE that stack, and the workspace panel on
 *  the other side of the deck. The deck's position is the whole point of the file —
 *  this is the one test that reads the real stylesheet, and a harness that put the
 *  deck inside a panel could not catch the regression the shell exists to make
 *  impossible.
 *
 *  Two panels now, and the split is the subject: three pages on the left are the
 *  APP's — every workspace's tree, every run's journal, every scenario — and the
 *  two on the right are ONE repository's. */
function mount(): PanelElements & {
  deck: HTMLElement;
  wsp: WorkspacePanelElements;
  wspEl: HTMLElement;
} {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><div id="ledger"></div><div id="stage">' +
    '<nav id="rail"></nav>' +
    '<aside id="sidebar"><div id="panel-head"></div><div id="panel-stack">' +
    '<div id="ws-page" class="panel-page"></div>' +
    '<div id="history" class="panel-page hidden"></div>' +
    '<div id="sk-page" class="panel-page hidden"></div>' +
    '</div></aside>' +
    '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>' +
    '<aside id="wspanel" hidden><div id="wsp-head"></div>' +
    '<div class="wsp-tabs" role="tablist">' +
    '<button class="wsp-tab" role="tab" data-page="board"></button>' +
    '<button class="wsp-tab" role="tab" data-page="pr"></button>' +
    '</div>' +
    '<div id="wsp-body">' +
    '<div id="board" class="panel-page hidden"></div>' +
    '<div id="pr" class="pr-view panel-page hidden"></div>' +
    '</div></aside>' +
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
      sessions: pick("#ws-page"), history: pick("#history"), scenarios: pick("#sk-page"),
    },
    buttons,
    deck: pick("#deck"),
    wspEl: pick("#wspanel"),
    wsp: {
      pages: { board: pick("#board"), pr: pick("#pr") },
      tabs: {
        board: pick('.wsp-tab[data-page="board"]'),
        pr: pick('.wsp-tab[data-page="pr"]'),
      },
    },
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

  /** The pages that declare their `display` with an id selector need their
   *  `hidden` declared with one too: a grouped class rule would leave
   *  `display: flex` winning and two pages on screen at once. jsdom's
   *  getComputedStyle is what makes this checkable — and also what makes the
   *  grouping trap real, since it applies a group's highest specificity to every
   *  selector in it. */
  it.each(["sessions", "scenarios"] as PanelPage[])(
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
    applyPanel(el, "history");
    applyPanel(el, "sessions");
    // `aria-current="false"` is announced by some readers; the absent state here
    // is "not this one", which is what no attribute means.
    expect(el.buttons.history.hasAttribute("aria-current")).toBe(false);
  });

  it("carries a title for every page, because a rail of icons cannot", () => {
    for (const page of PANEL_PAGES) expect(PANEL_TITLE[page]).toBeTruthy();
  });

  /** The left panel has no wide mode any more, and this is the assertion that
   *  keeps it from growing one back. It had one because the kanban lived here, in a
   *  column sized for names — so every visit to a board took the deck's width and
   *  dropped it into its filmstrip. The board has its own panel now; what is left
   *  on this side is three lists of names, and none of them wants the deck's
   *  room. */
  it("never asks for the deck's width, on any page", () => {
    for (const page of PANEL_PAGES) {
      applyPanel(el, page);
      const side = document.querySelector<HTMLElement>("#sidebar")!;
      expect(side.classList.contains("is-wide")).toBe(false);
    }
    expect(styles).not.toContain("#sidebar.is-wide");
  });
});

/** The workspace panel: two tabs over one region, about one repository.
 *
 *  These two were pages of the left panel and then rows inside every workspace of
 *  the tree. Both failed the same way — the first made a 300px column hold a
 *  kanban, the second charged two rows per workspace forever — and the fix is one
 *  panel that names its subject in its own head. */
describe("applyWorkspacePanel", () => {
  let el: ReturnType<typeof mount>;
  beforeEach(() => { el = mount(); });

  it("shows exactly one of the two at a time", () => {
    for (const page of WORKSPACE_PAGES) {
      applyWorkspacePanel(el.wsp, page);
      expect(WORKSPACE_PAGES.filter((p) => shown(el.wsp.pages[p]))).toEqual([page]);
    }
  });

  /** Both pages declare `display` with an id selector — `#board { display: flex }`
   *  is the rule this project has already been bitten by twice — so the hiding has
   *  to outweigh an id. Read against the real stylesheet for that reason. */
  it.each(["board", "pr"] as WorkspacePage[])(
    "hides #%s against the real stylesheet",
    (page) => {
      const other: WorkspacePage = page === "board" ? "pr" : "board";
      applyWorkspacePanel(el.wsp, other);
      expect(getComputedStyle(el.wsp.pages[page]).display).toBe("none");
      expect(shown(el.wsp.pages[other])).toBe(true);
    },
  );

  /** A real tab widget, so it owes the whole pattern: one selected tab, and a
   *  roving tabindex so the tablist is ONE stop on the way round rather than one
   *  stop per tab. `aria-selected="false"` stays on the unselected one — unlike
   *  `aria-current`, it is part of the pattern and readers expect both halves. */
  it("selects exactly one tab and moves the tab stop with it", () => {
    for (const page of WORKSPACE_PAGES) {
      applyWorkspacePanel(el.wsp, page);
      const on = WORKSPACE_PAGES.filter(
        (p) => el.wsp.tabs[p].getAttribute("aria-selected") === "true",
      );
      expect(on).toEqual([page]);
      expect(WORKSPACE_PAGES.map((p) => (el.wsp.tabs[p] as HTMLButtonElement).tabIndex))
        .toEqual(WORKSPACE_PAGES.map((p) => (p === page ? 0 : -1)));
    }
  });

  it("carries a title for each of the two", () => {
    for (const page of WORKSPACE_PAGES) expect(WORKSPACE_TITLE[page]).toBeTruthy();
  });

  /** The panel is hidden with the attribute, and `display: grid` in its own rule
   *  would outrank the UA's `[hidden] { display: none }` — the same trap
   *  `#board.hidden` documents. This is that rule's test. */
  it("is not on screen while hidden, against the real stylesheet", () => {
    expect(getComputedStyle(el.wspEl).display).toBe("none");
    el.wspEl.hidden = false;
    expect(getComputedStyle(el.wspEl).display).toBe("grid");
  });

  /** Switching tabs does not ask for width. Only a diff does, and it asks from the
   *  drawer that opens it — a panel that arrived wide because it was wide last time
   *  would be the full-width screens back under another name. */
  it("leaves the width alone", () => {
    el.wspEl.hidden = false;
    for (const page of WORKSPACE_PAGES) {
      applyWorkspacePanel(el.wsp, page);
      expect(el.wspEl.classList.contains("is-wide")).toBe(false);
    }
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
    el.pages.history.innerHTML = '<button id="run">a run</button>';
    applyPanel(el, "history");
    expect(firstFocusable(el.pages.sessions)).toBeNull();
    expect(firstFocusable(el.pages.history)?.id).toBe("run");

    applyPanel(el, "sessions");
    expect(firstFocusable(el.pages.sessions)?.id).toBe("row");
    expect(firstFocusable(el.pages.history)).toBeNull();
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
    el.wsp.pages.board.innerHTML = '<button disabled>no</button><button id="yes">yes</button>';
    applyWorkspacePanel(el.wsp, "board");
    expect(firstFocusable(el.wsp.pages.board)?.id).toBe("yes");
  });

  it("returns null when there is genuinely nothing, so the caller can fall back", () => {
    el.wsp.pages.board.innerHTML = "<p>an empty board</p>";
    applyWorkspacePanel(el.wsp, "board");
    expect(firstFocusable(el.wsp.pages.board)).toBeNull();
  });
});
