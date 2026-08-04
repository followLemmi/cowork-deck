// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clampCols, diffAnnouncement, DiffDrawer, DEFAULT_COLS, MAX_COLS, MIN_COLS,
  type DiffDrawerHandlers,
} from "../src/diff-drawer";
import type { DiffFile, Hunk, PrDiff, PullRequest } from "../src/ipc";
import { PrView, type PrHandlers } from "../src/pr-view";

// Geometry is deliberately absent from all of this. jsdom computes no layout —
// `getBoundingClientRect` returns zeros and there is no `ResizeObserver` — so the
// collapse threshold, the sticky gutter and the drag are on the manual checklist
// in `docs/pr-view-manual-check.md`. What is asserted here is structure,
// attributes and which side effects fire, which is where the bugs that matter
// live: a missing `aria-hidden`, an answer applied after it went stale, a body
// rebuilt under a reader.

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 151, title: "the diff drawer", author: "octocat", isDraft: false,
  headRefName: "feat/diff", headRefOid: "a".repeat(40), baseRefName: "main",
  isCrossRepository: false, reviewDecision: null,
  checks: { kind: "passed", total: 2 },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  updatedAt: "2026-08-04T11:45:00Z", url: "https://example.test/pr/151", labels: [],
  ...over,
});

const hunk = (over: Partial<Hunk> = {}): Hunk => ({
  header: "@@ -1,1 +1,1 @@", oldStart: 1, newStart: 1, lines: [], ...over,
});

const file = (over: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/pr-view.ts", previousPath: null, status: "modified",
  additions: 24, deletions: 7,
  blobUrl: "https://github.com/o/r/blob/" + "a".repeat(40) + "/src/pr-view.ts",
  hunks: [], omitted: null, ...over,
});

const diff = (over: Partial<PrDiff> = {}): PrDiff => ({
  headRefOid: "a".repeat(40), files: [file()], totalFiles: 1, ...over,
});

/** A file with one hunk of ordinary content, added and removed lines. */
const changed = (over: Partial<DiffFile> = {}): DiffFile => file({
  hunks: [hunk({
    header: "@@ -8,3 +8,4 @@ fn main() {", oldStart: 8, newStart: 8,
    lines: [" keep", "-gone", "+fresh", "+also"],
  })],
  ...over,
});

/** A promise the test resolves by hand, so an answer can be made to arrive after
 *  another one — which is the only way to test the out-of-order guard. */
function deferred<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { settle = res; fail = rej; });
  return { promise, settle, fail };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
  drawer: DiffDrawer;
  view: HTMLElement;
  list: HTMLElement;
  h: DiffDrawerHandlers;
  answers: ReturnType<typeof deferred<PrDiff>>[];
}

function mk(): Harness {
  const answers: ReturnType<typeof deferred<PrDiff>>[] = [];
  const h: DiffDrawerHandlers = {
    onFetch: vi.fn(() => {
      const d = deferred<PrDiff>();
      answers.push(d);
      return d.promise;
    }),
    onWidth: vi.fn(),
    onClosed: vi.fn(),
  };
  const drawer = new DiffDrawer(h);
  const view = document.createElement("div");
  view.className = "pr-view";
  const list = document.createElement("div");
  list.className = "pr-list";
  view.append(list, drawer.live);
  document.body.replaceChildren(view);
  drawer.attach(view, list);
  return { drawer, view, list, h, answers };
}

/** Open on file 0 and let one answer through. */
async function opened(d: PrDiff = diff({ files: [changed()] })): Promise<Harness> {
  const kit = mk();
  kit.drawer.open(pr(), 0, "src/pr-view.ts");
  kit.answers[0].settle(d);
  await flush();
  return kit;
}

beforeEach(() => { document.body.replaceChildren(); });

describe("diffAnnouncement", () => {
  // The only feedback a screen-reader user gets, because focus deliberately does
  // not move. The whole sentence is asserted rather than its parts: what makes it
  // work is that it is one utterance.
  it("names the file, the position, the counts and the hunks", () => {
    const d = diff({
      files: [changed({ additions: 24, deletions: 7, hunks: [hunk(), hunk(), hunk()] })],
      totalFiles: 62,
    });
    expect(diffAnnouncement(d, 0))
      .toBe("Diff for src/pr-view.ts, file 1 of 62. 24 added, 7 removed. 3 hunks.");
  });

  it("says hunk, not hunks, when there is one", () => {
    expect(diffAnnouncement(diff({ files: [changed()] }), 0)).toContain("1 hunk.");
  });

  // A file with nothing to draw has the note read out where the hunk count would
  // be: the note *is* the content, and "0 hunks" says nothing about why.
  it("reads the note instead of a hunk count when there is nothing to draw", () => {
    const d = diff({ files: [file({ additions: 5290, deletions: 0, omitted: { kind: "tooLargeUpstream" } })] });
    expect(diffAnnouncement(d, 0)).toBe(
      "Diff for src/pr-view.ts, file 1 of 1. 5290 added, 0 removed."
      + " GitHub sent no diff for this file: +5290 −0 is more than it will return.",
    );
  });

  // The regression this guards is the whole reason `Unreported` exists: its
  // counts are zeroed by GitHub, so reading them out would tell somebody that
  // nothing changed in a file with 166 changes.
  it("reads no counts at all for an unreported file", () => {
    const d = diff({ files: [file({ additions: 0, deletions: 0, omitted: { kind: "unreported" } })] });
    expect(diffAnnouncement(d, 0)).not.toContain("0 added");
    expect(diffAnnouncement(d, 0)).toContain("so what changed here is not known.");
  });

  it("says nothing about a file that is not there", () => {
    expect(diffAnnouncement(diff(), 4)).toBe("");
  });
});

describe("clampCols", () => {
  it("holds the floor, the ceiling and whole columns", () => {
    expect(clampCols(10)).toBe(MIN_COLS);
    expect(clampCols(9999)).toBe(MAX_COLS);
    expect(clampCols(61.6)).toBe(62);
  });
});

describe("DiffDrawer, opening", () => {
  it("mounts as a sibling of the list, inside the view and after it", async () => {
    const { view, list } = await opened();
    const drawerEl = view.querySelector(".pr-drawer")!;
    expect(drawerEl.parentElement).toBe(view);
    // DOM order is list then drawer, so reading order matches visual order.
    expect(list.compareDocumentPosition(drawerEl) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  // Non-modal and named. `aria-modal` would hide the list from the accessibility
  // tree, which is the opposite of what someone comparing a path against a diff
  // needs, and `.modal-overlay` would disable every hotkey in the app.
  it("is a named region and never a modal", async () => {
    const { view } = await opened();
    const drawerEl = view.querySelector(".pr-drawer")!;
    expect(drawerEl.tagName).toBe("SECTION");
    expect(drawerEl.getAttribute("aria-label")).toBe("Diff for src/pr-view.ts");
    expect(drawerEl.hasAttribute("aria-modal")).toBe(false);
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("does not move focus", async () => {
    const { view } = await opened();
    expect(view.contains(document.activeElement)).toBe(false);
  });

  it("announces on open", async () => {
    const { drawer } = await opened();
    expect(drawer.live.getAttribute("aria-live")).toBe("polite");
    expect(drawer.live.textContent).toContain("Diff for src/pr-view.ts, file 1 of 1.");
  });

  // The path the row named, so the head says what it is fetching rather than
  // sitting blank for the second the request takes.
  it("names the file before the diff has arrived", () => {
    const { drawer, view } = mk();
    drawer.open(pr(), 3, "docs/a-long-name.md");
    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("docs/a-long-name.md");
    expect(view.querySelector(".pr-drawer-body")!.textContent).toContain("Reading the diff…");
  });
});

describe("DiffDrawer, the head", () => {
  it("splits the directory from the basename, quiet then bright", async () => {
    const { view } = await opened();
    const path = view.querySelector(".pr-drawer-path")!;
    // The directory is the bare text node and the basename the one child, which
    // is what `.pr-drawer-path > *` styles.
    expect(path.firstChild!.textContent).toBe("src/");
    expect(path.children).toHaveLength(1);
    expect(path.children[0].textContent).toBe("pr-view.ts");
  });

  // Two rules that are easy to get backwards, and this is the one that matters:
  // a rename **with** content changes has a previous path *and* hunks, and its
  // note is null precisely because there are rows to draw.
  it("shows previousPath → path even when there is a diff and no note", async () => {
    const { view } = await opened(diff({
      files: [changed({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" })],
    }));
    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("src/old.ts → src/new.ts");
    expect(view.querySelector(".dv-note")).toBeNull();
    expect(view.querySelector(".dv-file")).not.toBeNull();
  });

  it("puts the counts in the container the file list already colours", async () => {
    const { view } = await opened();
    const counts = view.querySelector(".pr-drawer-counts")!;
    expect(counts.querySelector(".pr-detail-plus")!.textContent).toBe("+24");
    expect(counts.querySelector(".pr-detail-minus")!.textContent).toBe("−7");
  });

  it("shows no counts for an unreported file, because the zeroed ones are the lie", async () => {
    const { view } = await opened(diff({
      files: [file({ additions: 0, deletions: 0, omitted: { kind: "unreported" } })],
    }));
    expect(view.querySelector(".pr-drawer-counts")!.textContent).toBe("");
  });

  it("counts the position against the pull request's own total, not the page", async () => {
    const { view } = await opened(diff({ files: [changed(), file()], totalFiles: 62 }));
    expect(view.querySelector(".pr-drawer-pos")!.textContent).toBe("1 of 62");
  });
});

describe("DiffDrawer, the rows", () => {
  it("emits four cells per line, with the kind on the row", async () => {
    const { view } = await opened();
    const rows = view.querySelectorAll(".dv-line");
    expect(rows).toHaveLength(4);
    expect([...rows].map((r) => r.className)).toEqual([
      "dv-line dv-line--ctx", "dv-line dv-line--del",
      "dv-line dv-line--add", "dv-line dv-line--add",
    ]);
    const cells = [...rows[1].children].map((c) => c.className);
    expect(cells).toEqual(["dv-old", "dv-new", "dv-mark", "dv-text"]);
  });

  it("puts the running numbers in their own columns and hides them from a reader", async () => {
    const { view } = await opened();
    const rows = view.querySelectorAll(".dv-line");
    const nums = [...rows].map((r) => [
      r.querySelector(".dv-old")!.textContent, r.querySelector(".dv-new")!.textContent,
    ]);
    expect(nums).toEqual([["8", "8"], ["9", ""], ["", "9"], ["", "10"]]);
    for (const r of rows) {
      expect(r.querySelector(".dv-old")!.getAttribute("aria-hidden")).toBe("true");
      expect(r.querySelector(".dv-new")!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  // The marker is a real, selectable text node so that a copied selection still
  // reassembles into a valid patch — and it is the only channel that survives
  // Windows high contrast, where both tints collapse to one system colour.
  it("keeps the marker as text and says the same thing in words for a reader", async () => {
    const { view } = await opened();
    const rows = view.querySelectorAll(".dv-line");
    expect([...rows].map((r) => r.querySelector(".dv-mark")!.textContent))
      .toEqual([" ", "-", "+", "+"]);
    expect(rows[1].querySelector(".dv-mark")!.getAttribute("aria-hidden")).toBe("true");
    expect(rows[1].querySelector(".dv-sr")!.textContent).toBe("Removed, ");
    expect(rows[2].querySelector(".dv-sr")!.textContent).toBe("Added, ");
    // Silence is the correct announcement for a line that did not change.
    expect(rows[0].querySelector(".dv-sr")).toBeNull();
  });

  it("draws the patch text with its marker removed", async () => {
    const { view } = await opened();
    const rows = view.querySelectorAll(".dv-line");
    // The cell holds the visually-hidden word and then the code, in that order,
    // which is what makes the reader say "Removed, gone".
    expect(rows[1].querySelector(".dv-text")!.textContent).toBe("Removed, gone");
    expect(rows[1].querySelector(".dv-text")!.lastChild!.textContent).toBe("gone");
    expect(rows[0].querySelector(".dv-text")!.textContent).toBe("keep");
  });

  // A patch line is the one payload in this app that is *expected* to contain
  // markup, so this is where "always textContent" earns its keep.
  it("never parses a patch line as HTML", async () => {
    const { view } = await opened(diff({
      files: [file({ hunks: [hunk({ lines: ["+<img src=x onerror=alert(1)>"] })] })],
    }));
    expect(view.querySelector(".dv-file img")).toBeNull();
    expect(view.querySelector(".dv-text")!.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("heads each hunk with a sentence and never with the raw @@", async () => {
    const { view } = await opened();
    const head = view.querySelector(".dv-hunk-head")!;
    expect(head.tagName).toBe("H4");
    expect(head.textContent).toBe("Hunk 1 of 1, lines 8 to 10");
    expect(view.querySelector(".dv-file")!.textContent).not.toContain("@@");
  });

  // The sticky gutter's offsets are the sum of the tracks to a cell's left, and
  // CSS cannot read a `max-content` track's used size — so the module hands over
  // the digit count. Too small and the two number columns overlap while
  // horizontally scrolled.
  it("sets --dv-digits from the widest line number the file actually drew", async () => {
    const { view } = await opened(diff({
      files: [file({ hunks: [hunk({ oldStart: 998, newStart: 998, lines: [" a", " b", " c"] })] })],
    }));
    expect(view.querySelector<HTMLElement>(".dv-file")!.style.getPropertyValue("--dv-digits"))
      .toBe("4");
  });

  // A scroll container is not keyboard-operable unless it is focusable, and
  // without a name it is a focus stop a screen reader cannot describe (SC 2.1.1).
  it("makes the file's scroll container focusable and named", async () => {
    const { view } = await opened();
    const box = view.querySelector<HTMLElement>(".dv-file")!;
    expect(box.tabIndex).toBe(0);
    expect(box.getAttribute("aria-label")).toBe("src/pr-view.ts, scrollable");
  });
});

describe("DiffDrawer, files with nothing to draw", () => {
  it("explains an upstream omission and offers only the link", async () => {
    const { view } = await opened(diff({
      files: [file({ additions: 5290, deletions: 0, omitted: { kind: "tooLargeUpstream" } })],
    }));
    expect(view.querySelector(".dv-note")!.textContent)
      .toContain("more than it will return");
    // The bytes never arrived, so a second fetch could only fail.
    expect(view.textContent).not.toContain("Show anyway");
    expect(view.textContent).not.toContain("Check again");
    expect(view.querySelector<HTMLAnchorElement>("a")!.textContent).toBe("Open on GitHub");
  });

  it("offers Show anyway only where a second fetch could work", async () => {
    const { view } = await opened(diff({
      files: [file({ omitted: { kind: "tooLargeLocal", lines: 2507 } })],
    }));
    expect(view.textContent).toContain("2507 lines of diff");
    expect(view.textContent).toContain("Show anyway");
  });

  it("offers Check again for a file GitHub said nothing about", async () => {
    const { view } = await opened(diff({
      files: [file({ additions: 0, deletions: 0, omitted: { kind: "unreported" } })],
    }));
    expect(view.textContent).toContain("Check again");
    // Names no counts: the zeroed ones are exactly what is not to be believed.
    expect(view.querySelector(".dv-note")!.textContent).not.toContain("0");
  });

  it("names both paths for a rename with no content change", async () => {
    const { view } = await opened(diff({
      files: [file({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" })],
    }));
    expect(view.querySelector(".dv-note")!.textContent)
      .toBe("Renamed from src/old.ts. The contents did not change.");
    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("src/old.ts → src/new.ts");
  });
});

describe("DiffDrawer, walking the files", () => {
  const two = diff({
    files: [changed(), file({ path: "docs/x.md", omitted: { kind: "unreported" } })],
    totalFiles: 2,
  });

  it("disables Prev at the first file and Next at the last", async () => {
    const { view, drawer } = await opened(two);
    const prev = view.querySelector<HTMLButtonElement>(".pr-drawer-prev")!;
    const next = view.querySelector<HTMLButtonElement>(".pr-drawer-next")!;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    expect(drawer.live.textContent).toContain("file 2 of 2");
  });

  // File 41 of 62 having nothing to show is information, so the walk does not
  // step over it.
  it("does not skip a file with no diff", async () => {
    const { view } = await opened(two);
    view.querySelector<HTMLButtonElement>(".pr-drawer-next")!.click();
    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("docs/x.md");
    expect(view.querySelector(".dv-note")!.textContent).toContain("not known");
  });
});

describe("DiffDrawer, closing", () => {
  it("leaves the DOM and hands the caller the row to go back to", async () => {
    const { view, h, drawer } = await opened();
    view.querySelector<HTMLButtonElement>(".pr-drawer-close")!.click();
    expect(view.querySelector(".pr-drawer")).toBeNull();
    expect(drawer.isOpen()).toBe(false);
    expect(h.onClosed).toHaveBeenCalledWith(expect.objectContaining({ number: 151 }), 0);
  });

  // Bound on `.pr-view` and in the bubble phase, so it works while focus is
  // still in the list — which is where it deliberately stays.
  it("closes on Escape pressed anywhere on the screen, list included", async () => {
    const { view, list, drawer } = await opened();
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.isOpen()).toBe(false);
  });

  // `openDialog` calls `preventDefault` but never `stopPropagation`, so without
  // the guard a modal's Escape would also close the drawer behind it.
  it("ignores an Escape another handler has already answered", async () => {
    const { list, drawer } = await opened();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    e.preventDefault();
    list.dispatchEvent(e);
    expect(drawer.isOpen()).toBe(true);
  });

  it("keeps what it fetched, so reopening the same commit costs no request", async () => {
    const { view, drawer, h } = await opened();
    view.querySelector<HTMLButtonElement>(".pr-drawer-close")!.click();
    drawer.open(pr(), 0, "src/pr-view.ts");
    await flush();
    expect(h.onFetch).toHaveBeenCalledTimes(1);
    expect(view.querySelector(".dv-file")).not.toBeNull();
  });

  // Two repositories both have a #7, and the slots are keyed by number.
  it("drops everything on a workspace switch", async () => {
    const { drawer, h } = await opened();
    drawer.reset();
    drawer.open(pr(), 0, "src/pr-view.ts");
    await flush();
    expect(h.onFetch).toHaveBeenCalledTimes(2);
  });

  // Closing is normally a deliberate act with a row to go back to. A workspace
  // switch is not: the row belongs to the repository leaving the screen, and
  // handing focus to it would pull it out of the sidebar the person just clicked.
  it("hands focus back on a close and never on a workspace switch", async () => {
    const first = await opened();
    first.view.querySelector<HTMLButtonElement>(".pr-drawer-close")!.click();
    expect(first.h.onClosed).toHaveBeenCalledTimes(1);

    const second = await opened();
    second.drawer.reset();
    expect(second.drawer.isOpen()).toBe(false);
    expect(second.h.onClosed).not.toHaveBeenCalled();
  });
});

describe("DiffDrawer, the poll", () => {
  it("leaves a diff at the same commit completely alone", async () => {
    const { drawer, view, h } = await opened();
    const before = view.querySelector(".dv-file");
    drawer.onPoll([pr()]);
    expect(h.onFetch).toHaveBeenCalledTimes(1);
    // The same node, not an equal one: rebuilding it would throw away the
    // reader's scroll position in a document that can be 63,000px tall.
    expect(view.querySelector(".dv-file")).toBe(before);
  });

  // This deliberately diverges from the detail panel, which re-fetches on a
  // newer `updatedAt` and swaps itself out. Swapping 2000 lines under a reader
  // who has scrolled into them is a review of code nobody looked at.
  it("offers a Reload rather than swapping the diff when the branch moves", async () => {
    const { drawer, view, h } = await opened();
    const before = view.querySelector(".dv-file");
    drawer.onPoll([pr({ headRefOid: "b".repeat(40) })]);
    expect(h.onFetch).toHaveBeenCalledTimes(1);
    expect(view.textContent).toContain("The branch moved on since this diff was read.");
    expect(view.querySelector(".dv-file")).toBe(before);
  });

  it("fetches the new commit only when Reload is pressed", async () => {
    const { drawer, view, h, answers } = await opened();
    drawer.onPoll([pr({ headRefOid: "b".repeat(40) })]);
    view.querySelector<HTMLButtonElement>(".pr-detail-retry")!.click();
    expect(h.onFetch).toHaveBeenCalledTimes(2);
    answers[1].settle(diff({ headRefOid: "b".repeat(40), files: [changed({ path: "src/z.ts" })] }));
    await flush();
    expect(view.textContent).not.toContain("The branch moved on");
    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("src/z.ts");
  });

  it("says nothing about a pull request that has left the list", async () => {
    const { drawer, view } = await opened();
    drawer.onPoll([]);
    expect(view.querySelector(".dv-file")).not.toBeNull();
    expect(drawer.isOpen()).toBe(true);
  });
});

describe("DiffDrawer, answers that arrive late", () => {
  // Promises settle out of order, and a second request can be started while a
  // first is still out. Without the guard the slower of the two wins by arriving
  // last, and the drawer shows a diff of a commit nobody asked about.
  it("drops an answer the slot is no longer waiting on", async () => {
    const { drawer, view, answers } = mk();
    drawer.open(pr(), 0, "src/pr-view.ts");
    drawer.onPoll([pr({ headRefOid: "b".repeat(40) })]);
    expect(answers).toHaveLength(2);

    answers[1].settle(diff({ headRefOid: "b".repeat(40), files: [changed({ path: "src/new.ts" })] }));
    await flush();
    answers[0].settle(diff({ headRefOid: "a".repeat(40), files: [changed({ path: "src/old.ts" })] }));
    await flush();

    expect(view.querySelector(".pr-drawer-path")!.textContent).toBe("src/new.ts");
  });

  // Keyed on what the response says it describes, read by the backend out of the
  // rows — not on what was asked for. The files endpoint is addressed by number,
  // so it serves whatever HEAD was when it ran.
  it("keys the slot on the commit the answer names, so a poll at that commit is quiet", async () => {
    const { drawer, view, answers, h } = mk();
    drawer.open(pr(), 0, "src/pr-view.ts");
    // Asked at `a`, answered at `b`: the branch moved between the two.
    answers[0].settle(diff({ headRefOid: "b".repeat(40), files: [changed()] }));
    await flush();
    drawer.onPoll([pr({ headRefOid: "b".repeat(40) })]);
    expect(h.onFetch).toHaveBeenCalledTimes(1);
    expect(view.textContent).not.toContain("The branch moved on");
  });

  it("draws a failure in the drawer and retries on demand", async () => {
    const { drawer, view, answers, h } = mk();
    drawer.open(pr(), 0, "src/pr-view.ts");
    answers[0].fail(new Error("gh: not found"));
    await flush();
    expect(view.querySelector(".dv-note")!.textContent)
      .toBe("Could not read the diff for #151: gh: not found");
    view.querySelector<HTMLButtonElement>(".pr-detail-retry")!.click();
    expect(h.onFetch).toHaveBeenCalledTimes(2);
    answers[1].settle(diff({ files: [changed()] }));
    await flush();
    expect(view.querySelector(".dv-file")).not.toBeNull();
  });
});

describe("DiffDrawer, the resize handle", () => {
  it("is a keyboard-operable separator that describes its own value", async () => {
    const { view } = await opened();
    const grip = view.querySelector<HTMLElement>(".pr-drawer-grip")!;
    expect(grip.getAttribute("role")).toBe("separator");
    expect(grip.getAttribute("aria-orientation")).toBe("vertical");
    expect(grip.tabIndex).toBe(0);
    expect(grip.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COLS));
    expect(grip.getAttribute("aria-valuetext")).toBe(`${DEFAULT_COLS} columns`);
  });

  // In `ch` and never in pixels: `ui-scale.ts` moves the root between 11.05px and
  // 18.85px, and a pixel pane shows *fewer* code columns at 145%.
  it("writes the width in ch", async () => {
    const { view, drawer } = await opened();
    drawer.setCols(80);
    expect(view.querySelector<HTMLElement>(".pr-drawer")!.style.width).toBe("80ch");
  });

  it("moves with the arrow keys in the direction they point", async () => {
    const { view } = await opened();
    const grip = view.querySelector<HTMLElement>(".pr-drawer-grip")!;
    // Left widens the drawer, because the drawer is the right-hand column.
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(grip.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COLS + 2));
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(grip.getAttribute("aria-valuenow")).toBe(String(MIN_COLS));
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(grip.getAttribute("aria-valuenow")).toBe(String(MAX_COLS));
  });

  // Written once the gesture is over, never during it: a held arrow repeats and
  // a drag fires at frame rate, and this reaches the disk.
  it("persists when the key comes up and not while it is down", async () => {
    const { view, h } = await opened();
    const grip = view.querySelector<HTMLElement>(".pr-drawer-grip")!;
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(h.onWidth).not.toHaveBeenCalled();
    grip.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    expect(h.onWidth).toHaveBeenCalledWith(DEFAULT_COLS + 2);
  });

  it("applies a stored width without writing it straight back", () => {
    const { drawer, h } = mk();
    drawer.setCols(96);
    expect(h.onWidth).not.toHaveBeenCalled();
  });
});

describe("DiffDrawer, F6", () => {
  it("is not a region until it is open", async () => {
    const { drawer } = mk();
    expect(drawer.isOpen()).toBe(false);
    expect(drawer.focusFirst()).toBe(false);
  });

  // The head's first enabled button rather than the grip, which is first in the
  // DOM: arriving on a control whose arrow keys resize the window is a poor
  // welcome, and one Shift+Tab reaches it.
  it("lands on the head and reports where focus is", async () => {
    const { drawer, view } = await opened(diff({ files: [changed(), file()], totalFiles: 2 }));
    expect(drawer.focusFirst()).toBe(true);
    expect(document.activeElement).toBe(view.querySelector(".pr-drawer-next"));
    expect(drawer.contains(document.activeElement)).toBe(true);
  });
});

// The single structural claim the whole module rests on, wired to the real
// `PrView` rather than to a stand-in `div`. `PrView.render` opens with
// `replaceChildren()` on its mount and the poll calls it every 15 s while the
// window has focus — which is precisely while somebody is reading a diff. The
// drawer survives that only because it is a *sibling* of that mount.
describe("the poll cannot reach the drawer", () => {
  const listHandlers = (): PrHandlers => ({
    onLaunch: vi.fn(), onMerge: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
    onRefresh: vi.fn(), onFixUnavailable: vi.fn(), onOpenDiff: vi.fn(),
    onDetail: vi.fn().mockResolvedValue({
      body: "", additions: 0, deletions: 0, changedFiles: 1,
      files: [{ path: "src/pr-view.ts", additions: 24, deletions: 7 }],
    }),
  });

  const listState = (prs: PullRequest[]) => ({
    workspace: "cowork-deck", unavailable: null as null, prs,
    error: null as null, fetchedAt: 1, total: prs.length, loading: false,
  });

  it("survives PrView.render with its nodes and its scroll position intact", async () => {
    const list = new PrView(listHandlers());
    const answer = deferred<PrDiff>();
    const drawer = new DiffDrawer({
      onFetch: () => answer.promise, onWidth: vi.fn(), onClosed: vi.fn(),
    });
    const view = document.createElement("div");
    view.className = "pr-view";
    view.append(list.mount, drawer.live);
    document.body.replaceChildren(view);
    drawer.attach(view, list.mount);

    list.render(listState([pr()]), 1);
    drawer.open(pr(), 0, "src/pr-view.ts");
    answer.settle(diff({ files: [changed()] }));
    await flush();

    const drawerEl = view.querySelector(".pr-drawer")!;
    const fileEl = view.querySelector(".dv-file")!;
    // jsdom stores `scrollTop` as a plain number and never resets it, so this
    // asserts nothing about layout — only that nothing *reassigns* it. The real
    // check is on the manual list.
    (fileEl as HTMLElement).scrollTop = 4200;

    // Five ticks: a minute and a quarter of somebody reading.
    for (let i = 0; i < 5; i++) list.render(listState([pr()]), 1);

    expect(list.mount.contains(drawerEl)).toBe(false);
    expect(view.querySelector(".pr-drawer")).toBe(drawerEl);
    expect(view.querySelector(".dv-file")).toBe(fileEl);
    expect((fileEl as HTMLElement).scrollTop).toBe(4200);
    expect(view.querySelector(".dv-line")).not.toBeNull();
  });
});
