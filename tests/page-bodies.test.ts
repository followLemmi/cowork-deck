import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The app's body exists four times over, and every copy carries a comment
 *  asking that they be kept in step. This is what makes that request enforceable.
 *
 *  They cannot be shared. Vite serves one module graph per page, so a page is a
 *  file; and the harness copies must install their mocks *before* the entry is
 *  imported, because an entry starts booting the moment it is evaluated. What
 *  they can be is checked.
 *
 *  The failure a drift produces is not a warning. `startApp` asserts non-null on
 *  every element it queries — `#sidebar`, `#deck`, `#board`, `#viewbar` — so an
 *  element present in one page and missing from another is a blank window at
 *  boot, in whichever of the four nobody happened to open. Part of #247. */
const PAGES = [
  "index.html",
  "workspace.html",
  "harness/index.html",
  "harness/workspace.html",
];

/** The ids `startApp` queries and asserts non-null on. Named rather than
 *  compared wholesale: the four pages differ in their script tag and their
 *  comments by design, and a test that demanded byte equality would fail for
 *  reasons nobody should have to read past. */
const REQUIRED = ["app", "viewbar", "stage", "sidebar", "workarea", "deck", "terminals", "board"];

const bodyOf = (page: string) => readFileSync(page, "utf8");

describe("the pages that mount the app", () => {
  it.each(PAGES)("%s carries every element startApp queries", (page) => {
    const html = bodyOf(page);
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
    const source = ids(bodyOf("index.html"));
    for (const page of PAGES.slice(1)) {
      const copy = ids(bodyOf(page));
      const missing = [...source].filter((id) => !copy.has(id));
      expect(missing, `${page} is behind index.html`).toEqual([]);
    }
  });

  /** Each page starts its own entry, and mixing them up is not a subtle failure:
   *  the workspace pages would boot as the main window and run every singleton a
   *  second window must not. */
  it("each page loads the entry that belongs to it", () => {
    expect(bodyOf("index.html")).toContain("/src/main.ts");
    expect(bodyOf("workspace.html")).toContain("/src/workspace.ts");
    expect(bodyOf("harness/index.html")).toContain("/src/main.ts");
    expect(bodyOf("harness/workspace.html")).toContain("/src/workspace.ts");
  });

  /** The harness page for the second kind of window has to say which window it
   *  is pretending to be, or `startApp` reads "main" and the page tests nothing
   *  the first harness page does not. */
  it("the workspace harness page pretends to be a workspace window", () => {
    expect(bodyOf("harness/workspace.html")).toMatch(/installMocks\("workspace-[^"]+"\)/);
    expect(bodyOf("harness/index.html")).toContain("installMocks()");
  });
});
