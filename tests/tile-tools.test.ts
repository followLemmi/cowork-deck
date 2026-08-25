import { describe, it, expect } from "vitest";
import { fileTree, wouldSqueeze } from "../src/tile-tools";

/** The rule the tool panel exists to keep. This app has already shipped the bug
 *  it guards against — the filmstrip resized a PTY to about 22 columns by 3 rows —
 *  and the panel is a second box that can do the same thing on every open. */
describe("the 80-column floor", () => {
  it("lets the panel squeeze a terminal that stays above 80 columns", () => {
    // 1200px at 10px a cell is 120 columns; minus the panel's 304px, 89 left.
    expect(wouldSqueeze(1200, 120)).toBe(false);
  });

  it("floats instead when the panel would take it under 80", () => {
    // 900px at 10px a cell is 90 columns; minus 304px, 59 left — a re-wrap.
    expect(wouldSqueeze(900, 90)).toBe(true);
  });

  it("floats at exactly 80, because the floor is a floor and not a target", () => {
    // 1104px at 10px a cell: (1104 - 304) / 10 = 80 exactly, which is not "under".
    expect(wouldSqueeze(1104, 110.4)).toBe(false);
    expect(wouldSqueeze(1103, 110.3)).toBe(true);
  });

  /** A terminal that has not laid out yet cannot be measured, and the safe answer
   *  is to float: covering output is recoverable, re-wrapping a transcript is not. */
  it("floats when there is nothing to measure", () => {
    expect(wouldSqueeze(0, 0)).toBe(true);
    expect(wouldSqueeze(1200, 0)).toBe(true);
  });

  /** The panel's width is a parameter so the test can state the arithmetic rather
   *  than depend on the stylesheet agreeing with it. */
  it("takes the panel's own width into account", () => {
    expect(wouldSqueeze(1000, 100, 100)).toBe(false); // 90 columns left
    expect(wouldSqueeze(1000, 100, 400)).toBe(true); // 60 columns left
  });
});

describe("the file tree", () => {
  it("nests paths into folders", () => {
    const tree = fileTree(["src/app.ts", "src/ui/view.ts", "README.md"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = tree[0];
    expect(src.dir).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["ui", "app.ts"]);
    expect(src.children[0].children[0].path).toBe("src/ui/view.ts");
  });

  /** Folders first, then files, each in name order. `git ls-files` sorts by full
   *  path, which interleaves a directory's files with the directories beside it
   *  once the names share a prefix — and a tree that is nearly sorted reads worse
   *  than one that is not, because the eye stops trusting it. */
  it("puts folders before files at every level", () => {
    const tree = fileTree(["src/z.ts", "src/a/b.ts", "a.ts", "z/y.ts"]);
    expect(tree.map((n) => `${n.dir ? "/" : ""}${n.name}`)).toEqual(["/src", "/z", "a.ts"]);
    expect(tree[0].children.map((n) => `${n.dir ? "/" : ""}${n.name}`)).toEqual(["/a", "z.ts"]);
  });

  it("holds a file and a folder of the same name apart", () => {
    // `git ls-files` can return both `docs` and `docs/index.md` in a repository
    // that tracks a file called `docs` in another directory. Two nodes, not one.
    const tree = fileTree(["docs/index.md", "docs"]);
    expect(tree.map((n) => n.dir)).toEqual([true, false]);
  });

  it("is empty for an empty checkout", () => {
    expect(fileTree([])).toEqual([]);
  });
});
