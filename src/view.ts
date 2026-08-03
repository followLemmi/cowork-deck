/** The three screens: terminals, the task board, and pull requests. Which
 *  sidebar blocks belong to the terminals screen is the caller's business —
 *  this module only hides them. */
export type ViewName = "deck" | "board" | "pr";

export interface ViewElements {
  deck: HTMLElement;
  board: HTMLElement;
  pr: HTMLElement;
  termBtn: HTMLElement;
  boardBtn: HTMLElement;
  prBtn: HTMLElement;
  /** Sidebar blocks that lead nowhere off the terminals screen: the scenario
   *  list, "+ session", and the session list. Workspaces stay — every screen
   *  shows one workspace at a time and switching between them is the point. */
  terminalsOnly: HTMLElement[];
}

/** Show one screen. DOM only: no IPC and no timers, so it can be tested against
 *  the real stylesheet, which is where the bug this replaces lived — `#deck`
 *  is an id selector and outweighs a class, so the deck needs `tk-hidden`
 *  rather than the plain `hidden` the others use. */
export function applyView(el: ViewElements, view: ViewName): void {
  el.deck.classList.toggle("tk-hidden", view !== "deck");
  el.board.classList.toggle("hidden", view !== "board");
  el.pr.classList.toggle("hidden", view !== "pr");
  mark(el.termBtn, view === "deck");
  mark(el.boardBtn, view === "board");
  mark(el.prBtn, view === "pr");
  for (const node of el.terminalsOnly) node.classList.toggle("tk-hidden", view !== "deck");
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
 *  two classes are the only two ways this app hides a subtree — `hidden` for the
 *  board and the pull request screen, `tk-hidden` for the deck and the sidebar
 *  blocks that belong to it. */
export function firstFocusable(root: HTMLElement): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!el.closest(".tk-hidden, .hidden")) return el;
  }
  return null;
}

/** Which screen is showing, for a reader as well as for the eye.
 *
 *  `aria-current="page"` rather than the `role="tablist"`/`aria-selected` the plan
 *  asked for, and the reason is what these three things are. `role="tab"` promises
 *  a tab widget: arrow-key traversal, a roving tabindex, and panels — and the panel
 *  for the terminals screen is `<main id="deck">`. Putting `role="tabpanel"` on it
 *  overwrites the document's only `main` landmark, which is a worse trade than any
 *  gain from the role; leaving the panels out makes the `tab` roles a promise the
 *  markup does not keep. These are the app's primary screens, reached from a `nav`,
 *  and `aria-current` is what navigation uses. It is also the same reading the
 *  workspace list and the session list now give, which is worth more than three
 *  patterns for one idea.
 *
 *  Removed rather than set to "false": `aria-current="false"` is announced by some
 *  readers, and the absent state here is simply "not this one". */
function mark(btn: HTMLElement, selected: boolean): void {
  btn.classList.toggle("active", selected);
  if (selected) btn.setAttribute("aria-current", "page");
  else btn.removeAttribute("aria-current");
}
