/** The two screens: terminals and the board. Which sidebar blocks belong to the
 *  terminals screen is the caller's business — this module only hides them. */
export interface ViewElements {
  deck: HTMLElement;
  board: HTMLElement;
  termBtn: HTMLElement;
  boardBtn: HTMLElement;
  /** Sidebar blocks that lead nowhere on the board screen: the scenario list,
   *  "+ session", and the session list. Workspaces stay — the board shows one
   *  workspace at a time and switching between them is the point. */
  terminalsOnly: HTMLElement[];
}

/** Show one screen or the other. DOM only: no IPC and no timers, so it can be
 *  tested against the real stylesheet, which is where the bug this replaces
 *  lived. */
export function applyView(el: ViewElements, showBoard: boolean): void {
  el.deck.classList.toggle("tk-hidden", showBoard);
  el.board.classList.toggle("hidden", !showBoard);
  el.termBtn.classList.toggle("active", !showBoard);
  el.boardBtn.classList.toggle("active", showBoard);
  for (const node of el.terminalsOnly) node.classList.toggle("tk-hidden", showBoard);
}
