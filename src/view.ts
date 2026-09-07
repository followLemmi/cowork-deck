/** The one panel, and what it is holding.
 *
 *  What this replaces was a switch between four SCREENS: picking "Board" hid the
 *  deck, and the deck is the reason the app exists. Two things followed from
 *  that, and both were shipped rather than argued about — a floating pill that
 *  counted blocked sessions, because the window could not show the deck and
 *  anything else at once, and four tab labels that were not a structure but four
 *  states of one window. Both are gone: the tabs with this file, and the pill with
 *  #394, which had this layout as its whole justification.
 *
 *  So: the rail on the left selects what the PANEL beside it holds, and the deck
 *  never moves. `applyPanel` is the whole of that — DOM only, no IPC and no
 *  timers, so it can be tested against the real stylesheet, which is where the
 *  bug its predecessor existed for lived (`#board` declares `display: flex` with
 *  an id selector, so a page needs a rule that outweighs a class).
 *
 *  Gone with the screens: the `terminalsOnly` list. The scenario list, the
 *  session list and the terminal drawer used to hide when the deck did, because
 *  they belonged to one screen out of four. There is one stage now and it is
 *  always the deck, so the drawer under it always belongs.
 */
export type PanelPage = "sessions" | "history" | "scenarios" | "memory";

export const PANEL_PAGES: PanelPage[] = ["sessions", "history", "scenarios", "memory"];

/** What each page is called in the panel's own head. The rail says it in an
 *  accessible name; the head says it in words, because a rail of icons cannot. */
export const PANEL_TITLE: Record<PanelPage, string> = {
  sessions: "Workspaces and sessions",
  history: "Journal",
  scenarios: "Scenarios",
  /* Not "Session notes", which is what the settings section is called: that one
     is the switch that decides whether closing a tile writes one, and this is
     everything ever written. The two would read as one thing under one name, and
     the settings section is where a person goes to change a setting. */
  memory: "Memory",
};

/** The two pages that are NOT the app's — see `WORKSPACE_TITLE`. */
export type WorkspacePage = "board" | "pr";

export const WORKSPACE_PAGES: WorkspacePage[] = ["board", "pr"];

/** What the workspace panel's two tabs are called.
 *
 *  They were three words in the rail beside the journal and the scenarios, which
 *  made them read as the app's own pages — and then they changed subject in
 *  silence every time the workspace changed. They are the same two words here,
 *  under a head that names the repository, which is the whole fix. */
export const WORKSPACE_TITLE: Record<WorkspacePage, string> = {
  board: "Board",
  pr: "Pull requests",
};

export interface PanelElements {
  /** The page each rail button shows. */
  pages: Record<PanelPage, HTMLElement>;
  /** The rail's buttons, which carry which page is current. */
  buttons: Record<PanelPage, HTMLElement>;
}

/** Show one page in the panel. */
export function applyPanel(el: PanelElements, page: PanelPage): void {
  for (const name of PANEL_PAGES) {
    el.pages[name]?.classList.toggle("hidden", name !== page);
    mark(el.buttons[name], name === page);
  }
}

export interface WorkspacePanelElements {
  pages: Record<WorkspacePage, HTMLElement>;
  tabs: Record<WorkspacePage, HTMLElement>;
}

/** Show one of the workspace panel's two pages.
 *
 *  `aria-selected` here and `aria-current` in `applyPanel`, and the difference is
 *  not cosmetic: the rail is navigation between pages of one panel, while these
 *  two ARE a tab widget — two controls over one region, implemented with
 *  `role="tablist"` and arrow keys in `app.ts`. Claiming the pattern is only
 *  allowed when the pattern is there. */
export function applyWorkspacePanel(el: WorkspacePanelElements, page: WorkspacePage): void {
  for (const name of WORKSPACE_PAGES) {
    el.pages[name]?.classList.toggle("hidden", name !== page);
    const tab = el.tabs[name];
    if (!tab) continue;
    const on = name === page;
    tab.setAttribute("aria-selected", String(on));
    // A roving tabindex, which is the half of the pattern people forget: one stop
    // for the whole tablist, and the arrows move within it.
    tab.tabIndex = on ? 0 : -1;
  }
}

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** First focusable descendant that is not inside something the app has hidden.
 *
 *  The hidden check is by class rather than by layout on purpose. jsdom computes
 *  no layout, so `offsetParent` is null for every element and a visibility test
 *  written that way would reject every candidate in the tests covering this. The
 *  two classes are the only two ways this app hides a subtree — `hidden` for a
 *  panel page, `tk-hidden` for a form row that does not apply. */
export function firstFocusable(root: HTMLElement): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!el.closest(".tk-hidden, .hidden")) return el;
  }
  return null;
}

/** Which page the panel is holding, for a reader as well as for the eye.
 *
 *  `aria-current="page"` rather than `role="tab"`/`aria-selected`, and the reason
 *  survives the change from tabs to a rail unchanged: `role="tab"` promises a tab
 *  widget — arrow-key traversal, a roving tabindex, and panels — and this rail
 *  does not implement one. It is navigation inside a `nav`, and `aria-current` is
 *  what navigation uses. It is also the reading the workspace list and the session
 *  list already give, which is worth more than three patterns for one idea.
 *
 *  Removed rather than set to "false": `aria-current="false"` is announced by some
 *  readers, and the absent state here is simply "not this one".
 */
function mark(btn: HTMLElement | undefined, selected: boolean): void {
  if (!btn) return;
  btn.classList.toggle("active", selected);
  if (selected) btn.setAttribute("aria-current", "page");
  else btn.removeAttribute("aria-current");
}
