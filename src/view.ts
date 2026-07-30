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
  el.termBtn.classList.toggle("active", view === "deck");
  el.boardBtn.classList.toggle("active", view === "board");
  el.prBtn.classList.toggle("active", view === "pr");
  for (const node of el.terminalsOnly) node.classList.toggle("tk-hidden", view !== "deck");
}
