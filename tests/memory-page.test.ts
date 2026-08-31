// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  corpusLine, excerpt, group, hitAsNote, labelHit, mountMemory, rowScope, rowTitle,
} from "../src/memory-page";
import type { MemoryHit, MemoryNoteEntry, MemoryStatus } from "../src/ipc";

const notes = vi.fn();
const status = vi.fn();
const search = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryNotes: () => notes(),
  memoryStatus: () => status(),
  memorySearch: (q: string, ws?: string, top?: number) => search(q, ws, top),
}));
// The three forms have their own file (`memory-write.test.ts`); what this one
// asserts is which of them the page offers, and when.
const addFact = vi.fn();
const replaceFact = vi.fn();
const addLesson = vi.fn();
vi.mock("../src/memory-write", async (orig) => ({
  ...(await orig() as object),
  addFactForm: (t: unknown) => addFact(t),
  replaceFactForm: (t: unknown) => replaceFact(t),
  addLessonForm: (t: unknown) => addLesson(t),
}));

const hit = (over: Partial<MemoryHit> = {}): MemoryHit => ({
  score: 0.7,
  file: "ws-1/Sessions/2026-08/31-the-staging-script.md",
  scope: "ws-1",
  room: null,
  text: "# a note\n\n## TL;DR\nit read the host triple instead of the tauri one",
  ...over,
});

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

/* A hit carries a score, a path, a scope, a room and a passage — and no heading.
   So its name comes from the PATH, which `memory::corpus` writes, rather than from
   the passage, which is the model's chunking. Parsing our own layout is a thing we
   can be right about. Moved here with the search itself (#384): one label, not
   two, or a note would be called one thing browsing and another searching. */
describe("what a hit is called", () => {
  it("reads a session note's day and topic out of its path", () => {
    expect(labelHit(hit())).toEqual({
      title: "the staging script",
      when: "2026-08-31",
      global: false,
    });
  });

  it("names a diary by its room, and says it is not this project's", () => {
    const l = labelHit(hit({ file: "Diaries/reviewer/2026-08.md", scope: "lessons", room: "reviewer" }));
    expect(l.title).toBe("reviewer — lessons");
    expect(l.when).toBe("2026-08");
    expect(l.room).toBe("reviewer");
    expect(l.global).toBe(true);
  });

  it("names a workspace's facts", () => {
    expect(labelHit(hit({ file: "ws-1/Facts.md" }))).toEqual({
      title: "Facts", when: "", global: false,
    });
  });

  /* A corpus is a directory of markdown and somebody may have put a file in it.
     Showing it by name beats dropping it — the same answer `Corpus::notes` gives
     on the other side of the IPC. */
  it("falls back to a filename for a shape it does not know", () => {
    expect(labelHit(hit({ file: "notes/scratch.md" })).title).toBe("scratch");
    expect(labelHit(hit({ file: "loose.md" })).title).toBe("loose");
  });

  it("does not invent a date from a filename that has none", () => {
    expect(labelHit(hit({ file: "ws-1/Sessions/2026-08/no-day-here.md" })).when).toBe("2026-08");
  });
});

/** One row renderer for two sources, which is what makes them agree. */
describe("a hit as a note", () => {
  it("gives a hit the shape a listed note has", () => {
    expect(hitAsNote(hit())).toEqual({
      file: "ws-1/Sessions/2026-08/31-the-staging-script.md",
      scope: "ws-1",
      room: null,
      kind: "session",
      when: "2026-08-31",
      title: "the staging script",
      size: 0,
      mtime: 0,
    });
  });

  it("reads the kind of every shape the corpus writes", () => {
    expect(hitAsNote(hit({ file: "ws-1/Facts.md" })).kind).toBe("facts");
    expect(hitAsNote(hit({ file: "Diaries/reviewer/2026-08.md", room: "reviewer" })).kind).toBe("diary");
    expect(hitAsNote(hit({ file: "ws-1/scratch.md" })).kind).toBe("other");
  });
});

describe("the excerpt", () => {
  it("flattens a passage's markdown into one line", () => {
    expect(excerpt("# a note\n\n## TL;DR\nit  read   the triple"))
      .toBe("a note TL;DR it read the triple");
  });

  it("trims on a word rather than mid-word", () => {
    const long = `${"alpha ".repeat(40)}omega`;
    const out = excerpt(long, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/alph…$/);
    expect(out.length).toBeLessThanOrEqual(41);
  });

  it("leaves a short passage alone", () => {
    expect(excerpt("short enough")).toBe("short enough");
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
    search.mockReset();
    status.mockResolvedValue(ready());
    search.mockResolvedValue([hit()]);
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

  /** Arrows move the selection and the document follows, so moving between notes
   *  does not mean going back to the list first. */
  it("steps between notes with the arrows, opening each", async () => {
    notes.mockResolvedValue([note(), note({ file: "ws-1/Facts.md", kind: "facts", when: "", title: "Facts" })]);
    const opened: string[] = [];
    const view = mountMemory({
      workspace: () => ({ id: "ws-1", name: "deck" }),
      names: () => new Map(),
      onOpen: (n) => opened.push(n.file),
    });
    document.body.replaceChildren(view.mount);
    await view.refresh();
    await flush();

    const list = fk("memory-list")!;
    const down = () => list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    down();
    down();
    expect(opened).toEqual([
      "ws-1/Sessions/2026-08/31-the-staging-script.md",
      "ws-1/Facts.md",
    ]);
  });

  /** A collapsed group is folded away deliberately: stepping into one would put
   *  the reader on a note with no row on screen, and the selection would appear
   *  to vanish. */
  it("does not step into a group somebody has folded away", async () => {
    notes.mockResolvedValue([note(), lesson()]);
    const opened: string[] = [];
    const view = mountMemory({
      workspace: () => ({ id: "ws-1", name: "deck" }),
      names: () => new Map(),
      onOpen: (n) => opened.push(n.file),
    });
    document.body.replaceChildren(view.mount);
    await view.refresh();
    await flush();

    fk("memory-group-lessons")!.click();
    const list = fk("memory-list")!;
    for (let i = 0; i < 3; i++) {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }
    expect(new Set(opened)).toEqual(new Set(["ws-1/Sessions/2026-08/31-the-staging-script.md"]));
  });

  it("does not offer a search on a build with no sidecar", async () => {
    notes.mockResolvedValue([note()]);
    status.mockRejectedValue(new Error("memory is not wired up"));
    const view = mount();
    await view.refresh();
    await flush();
    expect((fk("memory-search") as HTMLInputElement).disabled).toBe(true);
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

/** Writing by hand, from the page that lists what is written (#385). */
describe("the writing controls", () => {
  beforeEach(() => {
    notes.mockReset();
    status.mockReset();
    addFact.mockReset();
    replaceFact.mockReset();
    addLesson.mockReset();
    notes.mockResolvedValue([note()]);
    status.mockResolvedValue(ready());
    addFact.mockResolvedValue(false);
    replaceFact.mockResolvedValue(false);
    addLesson.mockResolvedValue(false);
  });

  it("offers all three against the active workspace", async () => {
    const view = mount();
    await view.refresh();
    await flush();

    fk("memory-add-fact")!.click();
    fk("memory-replace-fact")!.click();
    fk("memory-add-lesson")!.click();
    const target = { workspaceId: "ws-1", workspaceName: "deck" };
    expect(addFact).toHaveBeenCalledWith(target);
    expect(replaceFact).toHaveBeenCalledWith(target);
    expect(addLesson).toHaveBeenCalledWith(target);
  });

  /** A fact belongs to a project and a lesson does not — so a window with no
   *  active workspace offers a sentence rather than two buttons that fail. */
  it("offers only the lesson without a workspace, and says why", async () => {
    const view = mount(null);
    await view.refresh();
    await flush();

    // A note is written under a project's `Sessions/`, which is what gives it a
    // scope at all — so it goes with the two facts.
    expect(fk("memory-write-note")!.hidden).toBe(true);
    expect(fk("memory-add-fact")!.hidden).toBe(true);
    expect(fk("memory-replace-fact")!.hidden).toBe(true);
    expect(fk("memory-add-lesson")!.hidden).toBe(false);
    expect(fk("memory-write-scope")!.textContent).toContain("belong to a project");
  });

  /** Why the two shapes get forms and a note gets an editor, said where somebody
   *  looks for the button that is missing (#386). */
  it("says why a fact and a lesson are not edited", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    expect(document.querySelector(".mem-write")!.textContent)
      .toContain("appended, never rewritten");
  });

  it("re-reads the corpus after something is written", async () => {
    addFact.mockResolvedValue(true);
    const view = mount();
    await view.refresh();
    await flush();
    const reads = notes.mock.calls.length;

    fk("memory-add-fact")!.click();
    await flush();
    expect(notes.mock.calls.length).toBe(reads + 1);
  });

  it("does not re-read when a form was cancelled", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    const reads = notes.mock.calls.length;

    fk("memory-add-fact")!.click();
    await flush();
    expect(notes.mock.calls.length).toBe(reads);
  });
});

/** Search moved onto the page and its dialog went (#384). One list, two sources:
 *  typing switches it from browsing the corpus to showing results, and clearing
 *  the field gives the corpus back. What came across unchanged is the part that
 *  was already right — the debounce, the readiness reported before a keystroke,
 *  and the label read off the path. */
describe("searching from the page", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const type = async (text: string) => {
    const field = fk("memory-search") as HTMLInputElement;
    field.value = text;
    field.dispatchEvent(new Event("input"));
    await tick(320);
    await flush();
  };

  beforeEach(() => {
    notes.mockReset();
    status.mockReset();
    search.mockReset();
    notes.mockResolvedValue([note(), lesson()]);
    status.mockResolvedValue(ready());
    search.mockResolvedValue([hit()]);
  });

  it("switches the list to results, and back when the field is cleared", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);

    await type("cross build");
    expect(search).toHaveBeenCalledWith("cross build", "ws-1", 12);
    // One list: no groups while searching, because results are ordered by how
    // well they match and cutting them up would reorder them for no reason.
    expect(document.querySelectorAll(".mem-group")).toHaveLength(0);
    expect(document.querySelectorAll(".mem-row")).toHaveLength(1);

    await type("");
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);
  });

  it("does not search until typing has stopped", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    const field = fk("memory-search") as HTMLInputElement;
    for (const s of ["c", "cr", "cro", "cross"]) {
      field.value = s;
      field.dispatchEvent(new Event("input"));
    }
    await tick(320);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("cross", "ws-1", 12);
  });

  it("does not search an empty query", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await type("   ");
    expect(search).not.toHaveBeenCalled();
  });

  it("carries the passage on a result, which is what says why it matched", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await type("cross build");
    const row = document.querySelector(".mem-row")!;
    expect(row.textContent).toContain("the staging script");
    expect(row.textContent).toContain("2026-08-31");
    expect(row.textContent).toContain("host triple");
  });

  /** A lesson from another project turning up is the feature working, not a
   *  leak — and a result has no group header above it to have said so. */
  it("says when a result is a lesson rather than this project's note", async () => {
    search.mockResolvedValue([hit({ file: "Diaries/reviewer/2026-08.md", scope: "lessons", room: "reviewer" })]);
    const view = mount();
    await view.refresh();
    await flush();
    await type("packaging");
    expect(document.querySelector(".mem-row")!.textContent).toContain("a lesson, any project");
  });

  it("says nothing matched only when nothing matched", async () => {
    search.mockResolvedValue([]);
    const view = mount();
    await view.refresh();
    await flush();
    await type("something absent");
    expect(document.querySelector(".mem-empty")!.textContent).toContain("Nothing matched");
  });

  /** Browsing needs no model and searching does, so the field is the only part
   *  that goes quiet — and it says why rather than emptying a list that works. */
  it("keeps the corpus on screen when searching is not ready, and says what it needs", async () => {
    status.mockResolvedValue(ready({ model: { dir: "/r/.model", state: "absent", have: 0, total: TOTAL } }));
    const view = mount();
    await view.refresh();
    await flush();
    await type("cross build");

    expect(search).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);
    expect(fk("memory-readiness")!.hidden).toBe(false);
    expect(fk("memory-readiness")!.textContent).toContain("479 MB");
  });

  it("shows a failed search rather than an empty list", async () => {
    search.mockRejectedValue("the memory sidecar is not installed");
    const view = mount();
    await view.refresh();
    await flush();
    await type("cross build");
    expect(fk("memory-readiness")!.textContent).toContain("not installed");
  });

  it("opens a result on the document surface, as a listed note does", async () => {
    const opened: string[] = [];
    const view = mountMemory({
      workspace: () => ({ id: "ws-1", name: "deck" }),
      names: () => new Map(),
      onOpen: (n) => opened.push(n.file),
    });
    document.body.replaceChildren(view.mount);
    await view.refresh();
    await flush();
    await type("cross build");

    document.querySelector<HTMLButtonElement>(".mem-row")!.click();
    expect(opened).toEqual(["ws-1/Sessions/2026-08/31-the-staging-script.md"]);
  });

  /** Escape clears the field and gives the corpus back — the one gesture the
   *  dialog had that a page still owes. It must not bubble: the window's own
   *  Escape puts the deck back from under a note somebody is reading. */
  it("clears the field on Escape without letting it reach the window", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await type("cross build");

    const field = fk("memory-search") as HTMLInputElement;
    const seen: string[] = [];
    document.addEventListener("keydown", (e) => seen.push(e.key));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(320);
    await flush();

    expect(field.value).toBe("");
    expect(seen).toEqual([]);
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);
  });

  it("puts the caret in the field when the palette asks for it", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    view.focusSearch();
    expect(document.activeElement).toBe(fk("memory-search"));
  });
});
