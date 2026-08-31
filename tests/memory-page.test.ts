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

const NAMES = new Map([["ws-1", "deck"], ["ws-2", "relay"]]);

/** One heading per project, and one for the lessons.
 *
 *  It does not depend on which project is open. The shape before it did — this
 *  project, the lessons, then everything else in one heap — which made the page
 *  answer a different question every time the workspace changed and hid every
 *  other project behind a single fold. */
describe("the groups", () => {
  it("gives every project a heading of its own, and the lessons the last", () => {
    const mine = note({ mtime: 300 });
    const theirs = note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts", mtime: 200 });
    const learnt = lesson({ mtime: 999 });

    expect(group([mine, theirs, learnt], NAMES)).toEqual([
      { key: "ws-1", title: "deck", notes: [mine] },
      { key: "ws-2", title: "relay", notes: [theirs] },
      // Last whatever its age: the lessons are not a project, and a heading that
      // moved among them would reshuffle the list for no visible reason.
      { key: "Diaries", title: "Lessons, from every project", notes: [learnt] },
    ]);
  });

  /** Newest first, by the most recent note in each — the only ordering the
   *  corpus supports, since the notes carry an mtime and the projects do not. */
  it("puts the project with the most recent note first", () => {
    const older = note({ mtime: 100 });
    const newer = note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts", mtime: 900 });
    expect(group([older, newer], NAMES).map((g) => g.key)).toEqual(["ws-2", "ws-1"]);
  });

  /** The same list whichever project is open: nothing here is passed a workspace. */
  it("names a scope whose workspace is gone as itself, rather than dropping it", () => {
    expect(group([note({ scope: "gone", file: "gone/Facts.md", kind: "facts" })], NAMES))
      .toEqual([{ key: "gone", title: "gone", notes: [expect.anything()] }]);
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
    // Scoped to the list: the capture record at the foot of the page borrows the
    // same header, and it is not one of the note groups (#387).
    const counts = [...fk("memory-list")!.querySelectorAll(".mem-group-count")]
      .map((e) => e.textContent);
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

    const toggle = fk("memory-group-ws-1")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".mem-group-count")!.textContent).toBe("2");
    expect(document.querySelector<HTMLElement>(".mem-rows")!.hidden).toBe(true);
  });

  /** The whole point of the change: the same headings whether a project is open
   *  or not, and a window with none is not a window with less memory. */
  it("lists every project's notes with no workspace active", async () => {
    notes.mockResolvedValue([note(), lesson(), note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts" })]);
    const view = mount(null);
    await view.refresh();
    await flush();

    const titles = [...fk("memory-list")!.querySelectorAll(".mem-group-title")]
      .map((e) => e.textContent);
    expect(titles).toEqual(["deck", "relay", "Lessons, from every project"]);
  });

  it("names a heading after its workspace", async () => {
    notes.mockResolvedValue([note()]);
    const view = mount();
    await view.refresh();
    await flush();
    expect(fk("memory-list")!.querySelector(".mem-group-title")!.textContent).toBe("deck");
  });

  /** A wall of headings with counts is readable; a wall of every note is not. */
  it("opens the first heading and folds the rest", async () => {
    notes.mockResolvedValue([note({ mtime: 900 }), note({ file: "ws-2/Facts.md", scope: "ws-2", kind: "facts", mtime: 100 })]);
    const view = mount();
    await view.refresh();
    await flush();

    const bodies = [...fk("memory-list")!.querySelectorAll<HTMLElement>(".mem-rows")];
    expect(bodies.map((b) => b.hidden)).toEqual([false, true]);
  });

  /** A fold is keyed by the scope, so it survives the repaint a capture causes. */
  it("keeps a group folded across a refresh", async () => {
    notes.mockResolvedValue([note()]);
    const view = mount();
    await view.refresh();
    await flush();

    fk("memory-group-ws-1")!.click();
    expect(document.querySelector<HTMLElement>(".mem-rows")!.hidden).toBe(true);
    await view.refresh();
    await flush();
    expect(document.querySelector<HTMLElement>(".mem-rows")!.hidden).toBe(true);
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
    // One project and the lessons. Only the first heading arrives open, so the
    // lessons are the folded group the arrows must not step into.
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
  /** Type without asking for anything: what a person does before pressing Enter. */
  const type = async (text: string) => {
    const field = fk("memory-search") as HTMLInputElement;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  /** And the gesture that costs a process. */
  const enter = async () => {
    fk("memory-search")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();
  };
  const ask = async (text: string) => { await type(text); await enter(); };

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

    await ask("cross build");
    // Everything, not this project plus the lessons: the list under the field is
    // the whole corpus by project, and a search answering from a narrower one
    // would be the page disagreeing with itself.
    expect(search).toHaveBeenCalledWith("cross build", undefined, 12);
    // One list: no groups while searching, because results are ordered by how
    // well they match and cutting them up would reorder them for no reason.
    expect(document.querySelectorAll(".mem-group")).toHaveLength(0);
    expect(document.querySelectorAll(".mem-row")).toHaveLength(1);

    await type("");
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);
  });

  /** The change that matters most here: a search is a process and a cold model
   *  load (#389), so typing must not start one. */
  it("does not search while a query is being typed", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    for (const s of ["c", "cr", "cro", "cross"]) await type(s);
    expect(search).not.toHaveBeenCalled();

    await enter();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("cross", undefined, 12);
  });

  /** The gesture has to be visible, or a field that does nothing as you type is
   *  a field somebody thinks is broken. */
  it("says how it is run, where there is no button to say it", () => {
    mount();
    expect((fk("memory-search") as HTMLInputElement).placeholder).toContain("Enter");
  });

  /** Seconds of silence after a keypress is a keypress somebody repeats. */
  it("says that it is searching while it is", async () => {
    let release: ((v: unknown) => void) | null = null;
    search.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const view = mount();
    await view.refresh();
    await flush();

    await ask("cross build");
    expect(fk("memory-readiness")!.textContent).toBe("Searching…");
    expect(fk("memory-readiness")!.hidden).toBe(false);

    release!([hit()]);
    await flush();
    expect(fk("memory-readiness")!.hidden).toBe(true);
  });

  it("does not search an empty query, even asked to", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await ask("   ");
    expect(search).not.toHaveBeenCalled();
  });

  it("carries the passage on a result, which is what says why it matched", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await ask("cross build");
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
    await ask("packaging");
    expect(document.querySelector(".mem-row")!.textContent).toContain("a lesson, any project");
  });

  it("says nothing matched only when nothing matched", async () => {
    search.mockResolvedValue([]);
    const view = mount();
    await view.refresh();
    await flush();
    await ask("something absent");
    expect(document.querySelector(".mem-empty")!.textContent).toContain("Nothing matched");
  });

  /** Browsing needs no model and searching does, so the field is the only part
   *  that goes quiet — and it says why rather than emptying a list that works. */
  it("keeps the corpus on screen when searching is not ready, and says what it needs", async () => {
    status.mockResolvedValue(ready({ model: { dir: "/r/.model", state: "absent", have: 0, total: TOTAL } }));
    const view = mount();
    await view.refresh();
    await flush();
    await ask("cross build");

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
    await ask("cross build");
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
    await ask("cross build");

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
    await ask("cross build");

    const field = fk("memory-search") as HTMLInputElement;
    const seen: string[] = [];
    document.addEventListener("keydown", (e) => seen.push(e.key));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(field.value).toBe("");
    expect(seen).toEqual([]);
    expect(document.querySelectorAll(".mem-group")).toHaveLength(2);
  });

  /** A search is a process that loads a 479 MB model, so two in flight are two
   *  model loads competing for one CPU — which is what made typing stutter. The
   *  debounce bounds how often a query is SENT, not how many are running. */
  it("runs one search at a time, and only the last of a burst", async () => {
    let release: ((v: unknown) => void) | null = null;
    search.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    search.mockResolvedValue([hit()]);

    const view = mount();
    await view.refresh();
    await flush();

    await ask("first");
    expect(search).toHaveBeenCalledTimes(1);

    // Two more asked for while the first is still running — Enter pressed again
    // is exactly what a slow search invites.
    await ask("second");
    await ask("third");
    expect(search).toHaveBeenCalledTimes(1);

    release!([]);
    await flush();
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
    // The middle one is never run: it was replaced before its turn came.
    expect(search.mock.calls.map((c) => c[0])).toEqual(["first", "third"]);
  });

  /** Reading the status spawns the sidecar. Asking before each search put a
   *  second process on the path of every query. */
  it("does not re-read the status for every query", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    const reads = status.mock.calls.length;

    await ask("one");
    await ask("two");
    await ask("three");
    expect(status.mock.calls.length).toBe(reads);
  });

  /** Clearing the field asks the sidecar nothing: browsing needs neither the
   *  model nor a process. */
  /** Clearing is the one direction that is free: the list is in memory already,
   *  so it does not wait for Enter and asks nothing of the sidecar. */
  it("goes back to browsing as the field empties, without a call", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    await ask("cross build");
    const calls = search.mock.calls.length;

    await type("");
    expect(search.mock.calls.length).toBe(calls);
    expect(document.querySelectorAll(".mem-group").length).toBeGreaterThan(0);
  });

  it("puts the caret in the field when the palette asks for it", async () => {
    const view = mount();
    await view.refresh();
    await flush();
    view.focusSearch();
    expect(document.activeElement).toBe(fk("memory-search"));
  });
});
