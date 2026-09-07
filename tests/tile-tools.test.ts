// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/ipc", () => ({
  worktreeFiles: vi.fn().mockResolvedValue([]),
  gitChanges: vi.fn().mockResolvedValue({ branch: null, files: [] }),
  revealPath: vi.fn().mockResolvedValue(undefined),
}));

import { TileTools, fileTree, wouldSqueeze, type TileToolsHost } from "../src/tile-tools";
import { gitChanges, revealPath, worktreeFiles } from "../src/ipc";

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

/** #508: the panel is a reading OF a directory, and which directory that is has
 *  to be asked at every read.
 *
 *  It used to be a string handed over once, at construction — so a session that
 *  moved kept a panel listing the files of the folder it was launched in, diffing
 *  that folder's branch, naming that folder in its scope line, and revealing that
 *  folder's paths on a click. Four displays, one frozen field. These tests move
 *  the host's answer between reads, which is the only thing the panel can notice.
 */
describe("the tools panel reads its scope at every read", () => {
  const LAUNCHED = "/p/deck";
  const MOVED = "/p/deck-issue/508-a-bug";

  /** A host whose directory can be moved between reads, the way a session's is. */
  function host(): TileToolsHost & { at: string } {
    return {
      at: LAUNCHED,
      cwd() { return this.at; },
      cols: () => 200,
      termWidth: () => 2000,
      source: () => ({ kind: "person", detail: null, prompt: null }),
      onWidth: () => {},
    };
  }

  /** `show` is private: the rail's buttons are what a person presses, and the
   *  panel's behaviour is what is under test rather than its access modifiers. */
  const open = (t: TileTools, id: "files" | "changes") =>
    (t as unknown as { show(tool: unknown): Promise<void> })
      .show({ id, icon: id === "files" ? "folder" : "git-branch", name: id });

  /** One row of the file tree, by the name it shows. */
  const row = (t: TileTools, name: string): HTMLElement => {
    const found = [...t.panel.querySelectorAll<HTMLElement>(".tree-row")]
      .find((r) => r.textContent === name);
    if (!found) throw new Error(`no tree row named ${name}`);
    return found;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeFiles).mockResolvedValue([]);
    vi.mocked(gitChanges).mockResolvedValue({ branch: null, files: [] });
  });

  it("lists the files of the folder the session is in now", async () => {
    const h = host();
    const tools = new TileTools(h);
    await open(tools, "files");
    expect(worktreeFiles).toHaveBeenLastCalledWith(LAUNCHED);

    h.at = MOVED;
    await open(tools, "files");
    expect(worktreeFiles).toHaveBeenLastCalledWith(MOVED);
  });

  it("diffs the folder the session is in now, and names it beside its branch", async () => {
    const h = host();
    const tools = new TileTools(h);
    h.at = MOVED;
    vi.mocked(gitChanges).mockResolvedValue({ branch: "issue-508", files: [] });

    await open(tools, "changes");

    expect(gitChanges).toHaveBeenLastCalledWith(MOVED);
    const scope = tools.panel.querySelector(".tool-scope")!;
    // The last segment plus the branch, which is what the column has room for;
    // the whole path is in the tooltip.
    expect(scope.textContent).toBe("…/508-a-bug · issue-508");
    expect(scope.getAttribute("title")).toBe(`${MOVED} · issue-508`);
  });

  it("names the folder the session is in now in its scope line", async () => {
    const h = host();
    const tools = new TileTools(h);
    h.at = MOVED;
    await open(tools, "files");
    expect(tools.panel.querySelector(".tool-scope")!.getAttribute("title")).toBe(MOVED);
  });

  /** The one that could reveal the WRONG FILE rather than merely a missing one:
   *  two worktrees of a repository hold the same paths, so a row drawn before the
   *  session moved would open the same-named file in the other checkout. Rows are
   *  therefore resolved at click time, not at draw time. */
  it("reveals a file against the folder the session is in when it is clicked", async () => {
    const h = host();
    const tools = new TileTools(h);
    vi.mocked(worktreeFiles).mockResolvedValue(["src/app.ts"]);
    await open(tools, "files");
    // The tree draws one level at a time, so the folder is opened first — which
    // is also the gesture that keeps `expanded` across the re-read.
    row(tools, "src").click();
    await new Promise((r) => setTimeout(r, 0));

    h.at = MOVED;
    row(tools, "app.ts").click();

    expect(revealPath).toHaveBeenCalledWith(`${MOVED}/src/app.ts`);
  });

  it("reveals a changed file the same way", async () => {
    const h = host();
    const tools = new TileTools(h);
    vi.mocked(gitChanges).mockResolvedValue({
      branch: "issue-508",
      files: [{ mark: "M", path: "src/sessions.ts", added: 12, removed: 3 }],
    });
    await open(tools, "changes");

    h.at = MOVED;
    tools.panel.querySelector<HTMLElement>(".chg-row")!.click();

    expect(revealPath).toHaveBeenCalledWith(`${MOVED}/src/sessions.ts`);
  });

  /** A folder that is no repository says so, rather than keeping the branch of
   *  wherever the session came from on screen. */
  it("says there is nothing to compare in a folder that is not a checkout", async () => {
    const tools = new TileTools(host());
    vi.mocked(gitChanges).mockResolvedValue({ branch: null, files: [] });
    await open(tools, "changes");
    expect(tools.panel.querySelector(".tool-note")!.textContent)
      .toContain("Not a git checkout");
  });
});
