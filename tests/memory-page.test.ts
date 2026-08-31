// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { corpusLine, group, mountMemory, rowScope, rowTitle } from "../src/memory-page";
import type { MemoryNoteEntry, MemoryStatus } from "../src/ipc";

const notes = vi.fn();
const status = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryNotes: () => notes(),
  memoryStatus: () => status(),
}));

const TOTAL = 479_383_128;
const ready = (over: Partial<MemoryStatus> = {}): MemoryStatus => ({
  root: "/r", cache: "/r/.index", state: "ready", files: 12, chunks: 340, dim: 384,
  model: { dir: "/r/.model", state: "present", have: TOTAL, total: TOTAL },
  ...over,
});

const note = (over: Partial<MemoryNoteEntry> = {}): MemoryNoteEntry => ({
  file: "ws-1/Sessions/2026-08/31-the-staging-script.md",
  scope: "ws-1",
  room: null,
  kind: "session",
  when: "2026-08-31",
  title: "2026-08-31 — the staging script",
  size: 900,
  mtime: 1_772_000_000,
  ...over,
});

const lesson = (over: Partial<MemoryNoteEntry> = {}): MemoryNoteEntry => note({
  file: "Diaries/reviewer/2026-08.md",
  scope: "Diaries",
  room: "reviewer",
  kind: "diary",
  when: "2026-08",
  title: "2026-08 — reviewer",
  ...over,
});

/* The order is the argument: this project first, because that is what the person
   is in; lessons next, because they are the reason memory is global at all; other
   projects last. */
describe("the three groups", () => {
  it("splits a corpus by what it is about", () => {
    const all = [note(), lesson(), note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts" })];
    expect(group(all, "ws-1")).toEqual({
      mine: [all[0]],
      lessons: [all[1]],
      others: [all[2]],
    });
  });

  /** A window with no active workspace has no first group. Its notes are not
   *  lost — with no project to be "this" one, every project is another. */
  it("has no first group without a workspace, and loses nothing", () => {
    const g = group([note(), lesson()], null);
    expect(g.mine).toEqual([]);
    expect(g.others).toHaveLength(1);
    expect(g.lessons).toHaveLength(1);
  });
});

describe("what the corpus holds, in a sentence", () => {
  it("counts notes, projects and rooms", () => {
    expect(corpusLine([note(), note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts" }), lesson()]))
      .toBe("3 notes across 2 projects and 1 diary room.");
  });

  it("says it in the singular where it is one", () => {
    expect(corpusLine([note()])).toBe("1 note across 1 project.");
  });

  it("says nothing has been written when nothing has", () => {
    expect(corpusLine([])).toBe("Nothing has been written down yet.");
  });

  /** Projects are counted by scope rather than by the workspaces the app knows
   *  about: a project deleted from the deck leaves its notes behind, and they are
   *  still notes about a project. */
  it("counts a project whose workspace is gone", () => {
    expect(corpusLine([note({ scope: "deleted-ws", file: "deleted-ws/Facts.md", kind: "facts" })]))
      .toBe("1 note across 1 project.");
  });
});

/** `Note::render` writes the H1 as `YYYY-MM-DD — topic`, and the row shows the
 *  date beside the title. The listing keeps the heading verbatim on purpose, so
 *  the trimming belongs where the duplication is. */
describe("what a row is called", () => {
  it("does not say the date twice", () => {
    expect(rowTitle(note())).toBe("the staging script");
    expect(rowTitle(lesson())).toBe("reviewer");
  });

  it("leaves a title that does not begin with its date alone", () => {
    expect(rowTitle(note({ title: "the staging script" }))).toBe("the staging script");
  });

  /** A hand-written note with no heading is named by its stem, and a stem that
   *  happens to be the date is all there is — trimming it to nothing would leave
   *  a row with no name at all. */
  it("keeps a title that is only its date", () => {
    expect(rowTitle(note({ title: "2026-08-31" }))).toBe("2026-08-31");
  });

  it("names a lesson by its room and a note by its project", () => {
    const names = new Map([["ws-2", "relay"]]);
    expect(rowScope(lesson(), names)).toBe("reviewer");
    expect(rowScope(note({ scope: "ws-2" }), names)).toBe("relay");
  });

  it("shows a scope with no workspace left as itself", () => {
    expect(rowScope(note({ scope: "gone" }), new Map())).toBe("gone");
  });
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const mount = (workspace: { id: string; name: string } | null = { id: "ws-1", name: "deck" }) => {
  const view = mountMemory({
    workspace: () => workspace,
    names: () => new Map([["ws-1", "deck"], ["ws-2", "relay"]]),
  });
  document.body.replaceChildren(view.mount);
  return view;
};

const fk = (name: string) => document.querySelector<HTMLElement>(`[data-fk="${name}"]`);

describe("the page", () => {
  beforeEach(() => {
    notes.mockReset();
    status.mockReset();
    status.mockResolvedValue(ready());
  });

  it("lists every note the corpus holds, grouped and counted", async () => {
    notes.mockResolvedValue([note(), lesson(), note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts" })]);
    const view = mount();
    await view.refresh();
    await flush();

    expect(fk("memory-head")!.textContent).toBe("3 notes across 2 projects and 1 diary room.");
    const counts = [...document.querySelectorAll(".mem-group-count")].map((e) => e.textContent);
    expect(counts).toEqual(["1", "1", "1"]);
    expect(document.querySelectorAll(".mem-row")).toHaveLength(3);
  });

  /** A collapsed group still says how much is behind it — the count is on the
   *  header, not inside the body it folds away. */
  it("keeps the count visible when a group is collapsed", async () => {
    notes.mockResolvedValue([note(), note({ file: "ws-1/Facts.md", kind: "facts", when: "" })]);
    const view = mount();
    await view.refresh();
    await flush();

    const toggle = fk("memory-group-mine")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".mem-group-count")!.textContent).toBe("2");
    expect(document.querySelector<HTMLElement>(".mem-rows")!.hidden).toBe(true);
  });

  it("renders no group for a workspace that is not there", async () => {
    notes.mockResolvedValue([lesson()]);
    const view = mount(null);
    await view.refresh();
    await flush();

    const titles = [...document.querySelectorAll(".mem-group-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Lessons, from every project"]);
  });

  it("names the first group after the workspace, which the head above it names too", async () => {
    notes.mockResolvedValue([note()]);
    const view = mount();
    await view.refresh();
    await flush();
    expect(document.querySelector(".mem-group-title")!.textContent).toBe("deck");
  });

  it("says what fills an empty corpus", async () => {
    notes.mockResolvedValue([]);
    const view = mount();
    await view.refresh();
    await flush();

    expect(document.querySelector(".mem-empty")!.textContent)
      .toContain("Closing a session and saying yes");
    // And not a second sentence about there being nothing to search: the empty
    // state has already said it.
    expect(fk("memory-readiness")!.hidden).toBe(true);
  });

  /** The one sentence that stops the page reading as broken. A note can be listed
   *  and not be findable: a chunk needs 120 letters, and a diary's first lesson is
   *  about 80 (#375). */
  it("says in the head why a listed note may not be searchable", async () => {
    notes.mockResolvedValue([lesson()]);
    status.mockResolvedValue(ready({ state: "ready", files: 1, chunks: 0 }));
    const view = mount();
    await view.refresh();
    await flush();

    expect(fk("memory-readiness")!.hidden).toBe(false);
    expect(fk("memory-readiness")!.textContent).toContain("too short to index");
  });

  /** The page's whole claim: browsing needs neither the sidecar nor the model. A
   *  status call that throws costs the sentence, not the list. */
  it("lists the corpus with no sidecar and no model", async () => {
    notes.mockResolvedValue([note(), lesson()]);
    status.mockRejectedValue(new Error("memory is not wired up"));
    const view = mount();
    await view.refresh();
    await flush();

    expect(document.querySelectorAll(".mem-row")).toHaveLength(2);
    expect(fk("memory-readiness")!.textContent).toContain("not available");
  });

  it("says so when the corpus itself cannot be read", async () => {
    notes.mockRejectedValue(new Error("the root is gone"));
    const view = mount();
    await view.refresh();
    await flush();
    expect(fk("memory-head")!.textContent).toContain("could not be read");
  });

  it("hands the chosen note to whoever opens it", async () => {
    notes.mockResolvedValue([note()]);
    const opened: string[] = [];
    const view = mountMemory({
      workspace: () => ({ id: "ws-1", name: "deck" }),
      names: () => new Map(),
      onOpen: (n) => opened.push(n.file),
    });
    document.body.replaceChildren(view.mount);
    await view.refresh();
    await flush();

    document.querySelector<HTMLButtonElement>(".mem-row")!.click();
    expect(opened).toEqual(["ws-1/Sessions/2026-08/31-the-staging-script.md"]);
    expect(document.querySelector(".mem-row")!.classList.contains("selected")).toBe(true);
  });
});
