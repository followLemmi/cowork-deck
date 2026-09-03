/** A tile's DOM, and nothing about what it does.
 *
 *  Cut out of `Deck.spawnTile` (#463), which built a whole tile in 289 lines: the
 *  elements, seven icon buttons, the search bar, the tools panel, the terminal,
 *  the names, the layout and the focus, in one method — in the file with the
 *  highest churn in the repository, on a class with 78 methods.
 *
 *  The split is where the audit put it: **this returns handles, `Deck` wires
 *  behaviour.** Not one handler is attached here, and that is what makes the seam
 *  hold rather than a matter of taste — almost every handler in `spawnTile` closes
 *  over the `Tile` record, which is built after the DOM and cannot be built
 *  before it. A builder that took callbacks would need one parameter per button
 *  and would still be the same code; a builder that took the tile would be the
 *  same method with an extra hop.
 *
 *  What is here instead is every structural decision, each of which was a comment
 *  buried in a method nothing could reach — and several of which are load-bearing
 *  in a way a rename or a tidy-up would break silently:
 *
 *  · **The title is a class, not a position.** The rule was
 *    `.tile-head span:first-child`, and the broadcast checkbox is inserted in
 *    front of the title on every tile — so the title was never `:first-child` and
 *    never got the `flex: 1` or the ellipsis it was meant to have. A long session
 *    name pushed the badges out of the head instead of truncating.
 *  · **The state lives on `data-state`, not in a class.** `.state-*` already means
 *    "a chip with this fill", and one of those names on the tile would paint a
 *    chip's background across the whole thing.
 *  · **Order in the head is the reading order**, and the action cluster is sorted
 *    by how much it can cost: the pencil first, then the eraser, then restart,
 *    then close. The flexible name keeps one contiguous run of width because the
 *    badges and the chip sit between it and the buttons.
 *  · **Restart is `display: none`, not absent.** It is offered when a session has
 *    ended, and an element that comes and goes is one the tab order loses.
 */
import { activityButton } from "./activity";
import { icon, iconButton } from "./icons";

/** Every element `Deck` has to hold on to. Named rather than queried back out of
 *  the tree: a `querySelector` in `spawnTile` would be this module's structure
 *  restated in a string, in the one place a change to it would not be checked. */
export interface TileParts {
  /** The tile itself. */
  el: HTMLElement;
  head: HTMLElement;
  /** The name. Written only ever by `Deck.applyName`, text and tooltip together
   *  — the tooltip is for the sighted reader of a truncated name and the
   *  accessible name comes from the text, so the two must not drift. */
  title: HTMLElement;
  gitBadge: HTMLElement;
  authBadge: HTMLElement;
  /** The context reading, and a control: it opens the activity panel, because
   *  its tooltip was the only home for the spend and the subagent count and a
   *  tooltip is where information goes to be missed. `Deck` gives it its
   *  handlers; the `role` and the `tabIndex` that make it reachable are here. */
  tokenBadge: HTMLElement;
  label: HTMLElement;
  activityBtn: HTMLButtonElement;
  renameBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  /** Hidden until a session has ended. See the note at the top of this file. */
  restartBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  bcastCheck: HTMLInputElement;
  searchBar: HTMLElement;
  searchInput: HTMLInputElement;
  searchNext: HTMLButtonElement;
  searchPrev: HTMLButtonElement;
  searchClose: HTMLButtonElement;
  /** Where the terminal goes. */
  mount: HTMLElement;
  /** The work row: the terminal, the tools panel, and the strip that opens them.
   *  Returned unfilled past `mount`, because the tools need `mount`'s width and
   *  therefore cannot be built before it. */
  work: HTMLElement;
}

export function buildTile(opts: { scheduled: boolean; broadcasting: boolean }): TileParts {
  const el = document.createElement("div");
  el.className = "tile";
  // The state rail's carrier. A data attribute rather than a class for the reason
  // the session row documents: `.state-*` already means "a chip with this fill",
  // and one of those names on the tile would paint a chip across the whole thing.
  el.dataset.state = "idle";

  const head = document.createElement("div");
  head.className = "tile-head";

  const title = document.createElement("span");
  title.className = "tile-name";

  const schedMark = opts.scheduled ? icon("clock", 12) : null;
  if (schedMark) {
    schedMark.classList.add("tile-sched-mark");
    schedMark.setAttribute("aria-hidden", "false");
    schedMark.setAttribute("role", "img");
    schedMark.setAttribute("aria-label", "started on a schedule");
  }

  const gitBadge = document.createElement("span");
  gitBadge.className = "tile-git hidden";
  const authBadge = document.createElement("span");
  authBadge.className = "tile-auth hidden";
  const tokenBadge = document.createElement("span");
  tokenBadge.className = "tile-tokens hidden";
  tokenBadge.setAttribute("role", "button");
  tokenBadge.tabIndex = 0;

  const label = document.createElement("span");
  label.className = "tile-state state-idle";

  const activityBtn = activityButton();
  // The pencil leads the action cluster because it is the least destructive of
  // the four, and it sits after the state chip so the flexible name keeps one
  // contiguous run of width. Always in the DOM — so it is in the tab order and
  // reachable by touch — and the stylesheet is what hides it until the tile is
  // hovered, active or holds focus.
  const renameBtn = iconButton("pencil", "Rename session", "tile-close tile-rename");
  const clearBtn = iconButton("eraser", "Clear terminal", "tile-close");
  const closeBtn = iconButton("x", "Close session", "tile-close btn--icon--danger");
  const restartBtn = iconButton("rotate", "Restart session", "tile-close");
  restartBtn.style.display = "none";

  head.append(
    ...(schedMark ? [schedMark] : []),
    title, gitBadge, authBadge, tokenBadge, label, activityBtn, renameBtn, clearBtn, closeBtn,
  );

  const bcastCheck = document.createElement("input");
  bcastCheck.type = "checkbox";
  bcastCheck.className = "bcast-check";
  bcastCheck.classList.toggle("hidden", !opts.broadcasting);
  // In FRONT of the title, which is why the title is reached by class and not by
  // `:first-child` — see the note at the top of this file.
  head.insertBefore(bcastCheck, title);
  // Before the close button: the cluster is ordered by what an action costs, and
  // restarting is the last thing short of ending the session.
  head.insertBefore(restartBtn, closeBtn);

  const searchBar = document.createElement("div");
  searchBar.className = "tile-search hidden";
  const searchInput = document.createElement("input");
  searchInput.className = "tile-search-input";
  searchInput.placeholder = "search…";
  const searchNext = iconButton("chevron", "Next match", "tile-search-btn icon--down");
  const searchPrev = iconButton("chevron", "Previous match", "tile-search-btn icon--up");
  const searchClose = iconButton("x", "Close search", "tile-search-btn");
  // Previous before next, which is the order the two chevrons point in.
  searchBar.append(searchInput, searchPrev, searchNext, searchClose);

  const mount = document.createElement("div");
  mount.className = "tile-body";

  /* The tile's work area is a ROW: the terminal, then the tools that belong to
     this session, then the strip that opens them. The strip is on the right, the
     opposite edge from the app's panel, and that distance is doing real work — it
     is what stops "Files" in here being read as the project's files rather than
     this checkout's. Both are `display: none` until the tile is zoomed. */
  const work = document.createElement("div");
  work.className = "tile-work";
  work.append(mount);

  el.append(head, searchBar, work);

  return {
    el, head, title, gitBadge, authBadge, tokenBadge, label, activityBtn,
    renameBtn, clearBtn, restartBtn, closeBtn, bcastCheck,
    searchBar, searchInput, searchNext, searchPrev, searchClose,
    mount, work,
  };
}
