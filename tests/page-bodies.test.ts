import { describe, it, expect } from "vitest";
// `?raw`, not `node:fs`: that is how this project reads a file it must not
// duplicate — `node:fs` does not typecheck under the narrowed `types`, and
// `src/icons.ts` records the same constraint for the same reason.
import appPage from "../index.html?raw";
import workspacePage from "../workspace.html?raw";
import harnessMain from "../harness/index.html?raw";
import harnessWorkspace from "../harness/workspace.html?raw";

/** The app's body exists four times over, and every copy carries a comment
 *  asking that they be kept in step. This is what makes that request enforceable.
 *
 *  They cannot be shared. Vite serves one module graph per page, so a page is a
 *  file; and the harness copies must install their mocks *before* the entry is
 *  imported, because an entry starts booting the moment it is evaluated. What
 *  they can be is checked.
 *
 *  The failure a drift produces is not a warning. `startApp` asserts non-null on
 *  every element it queries — `#sidebar`, `#deck`, `#board`, `#rail` — so an
 *  element present in one page and missing from another is a blank window at
 *  boot, in whichever of the four nobody happened to open. Part of #247. */
const PAGES: [name: string, html: string][] = [
  ["index.html", appPage],
  ["workspace.html", workspacePage],
  ["harness/index.html", harnessMain],
  ["harness/workspace.html", harnessWorkspace],
];

/** The ids `startApp` queries and asserts non-null on. Named rather than
 *  compared wholesale: the four pages differ in their script tag and their
 *  comments by design, and a test that demanded byte equality would fail for
 *  reasons nobody should have to read past. */
const REQUIRED = [
  "app", "stage", "sidebar", "workarea", "deck", "terminals", "board",
  // The shell's own four. `#viewbar` left this list with the segmented control it
  // held: the rail selects what the panel shows, the ledger says what wants a
  // person, and the panel is a head over a stack of pages.
  "rail", "ledger", "panel-head", "panel-stack",
  // The workspace panel, and the two boxes inside it that `startApp` queries with a
  // non-null assertion. `#board` above moved INTO it: the board is one
  // repository's, and the left panel is a column of names.
  "wspanel", "wsp-head", "wsp-body",
];

describe("the pages that mount the app", () => {
  it.each(PAGES)("%s carries every element startApp queries", (page, html) => {
    for (const id of REQUIRED) {
      expect(html, `${page} is missing #${id}`).toContain(`id="${id}"`);
    }
  });

  /** The three that are copies of `index.html` must not fall behind it. A new id
   *  added to the app's own page and nowhere else is exactly the drift the
   *  standing comments ask about, and exactly the one nobody notices until a
   *  window comes up blank. */
  it("has no id in the app's page that the copies lack", () => {
    const ids = (html: string) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const source = ids(appPage);
    for (const [page, html] of PAGES.slice(1)) {
      const copy = ids(html);
      const missing = [...source].filter((id) => !copy.has(id));
      expect(missing, `${page} is behind index.html`).toEqual([]);
    }
  });

  /** Each page starts its own entry, and mixing them up is not a subtle failure:
   *  the workspace pages would boot as the main window and run every singleton a
   *  second window must not. */
  it("each page loads the entry that belongs to it", () => {
    expect(appPage).toContain("/src/main.ts");
    expect(workspacePage).toContain("/src/workspace.ts");
    expect(harnessMain).toContain("/src/main.ts");
    expect(harnessWorkspace).toContain("/src/workspace.ts");
  });

  /** The harness page for the second kind of window has to say which window it
   *  is pretending to be, or `startApp` reads "main" and the page tests nothing
   *  the first harness page does not. */
  it("the workspace harness page pretends to be a workspace window", () => {
    expect(harnessWorkspace).toMatch(/installMocks\("workspace-[^"]+"\)/);
    expect(harnessMain).toContain("installMocks()");
  });
});
