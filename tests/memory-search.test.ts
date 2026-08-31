// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { excerpt, labelHit, openNoteSearch } from "../src/memory-search";
import type { MemoryHit, MemoryStatus } from "../src/ipc";

const status = vi.fn();
const search = vi.fn();
const readNote = vi.fn();
const reveal = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryStatus: () => status(),
  memorySearch: (q: string, ws?: string, top?: number) => search(q, ws, top),
  memoryReadNote: (f: string) => readNote(f),
  revealPath: (p: string) => reveal(p),
}));

const TOTAL = 479_383_128;
const ready = (): MemoryStatus => ({
  root: "/r", cache: "/r/.index", state: "ready", files: 12, chunks: 340, dim: 384,
  model: { dir: "/r/.model", state: "present", have: TOTAL, total: TOTAL },
});

const hit = (over: Partial<MemoryHit> = {}): MemoryHit => ({
  score: 0.7,
  file: "ws-1/Sessions/2026-08/31-the-staging-script.md",
  scope: "ws-1",
  room: null,
  text: "# a note\n\n## TL;DR\nit read the host triple instead of the tauri one",
  ...over,
});

/* The display comes from the path, which `memory::corpus` writes, rather than
   from the passage, which is the model's chunking. Parsing our own layout is a
   thing we can be right about. */
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
     Showing it by name beats dropping it. */
  it("falls back to a filename for a shape it does not know", () => {
    expect(labelHit(hit({ file: "notes/scratch.md" })).title).toBe("scratch");
    expect(labelHit(hit({ file: "loose.md" })).title).toBe("loose");
  });

  it("does not invent a date from a filename that has none", () => {
    const l = labelHit(hit({ file: "ws-1/Sessions/2026-08/no-day-here.md" }));
    expect(l.when).toBe("2026-08");
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

describe("the search dialog", () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const box = () => document.querySelector(".modal-box") as HTMLElement;
  const fk = <T extends HTMLElement>(n: string) =>
    box().querySelector<T>(`[data-fk="${n}"]`)!;
  const type = async (text: string) => {
    const input = fk<HTMLInputElement>("note-search-input");
    input.value = text;
    input.dispatchEvent(new Event("input"));
    await tick(320);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    status.mockResolvedValue(ready());
    search.mockResolvedValue([hit()]);
    readNote.mockResolvedValue({ path: "/r/ws-1/Sessions/2026-08/31-the-staging-script.md", markdown: "# a note\n\ntext" });
    reveal.mockResolvedValue(undefined);
  });

  /* Reported before anybody types. Otherwise a person searches an empty index
     and reads "no results" as an answer about their notes rather than about the
     machine. */
  it("says what is missing before a single keystroke", async () => {
    status.mockResolvedValue({ ...ready(), model: { dir: "/r/.model", state: "absent", have: 0, total: TOTAL } });
    openNoteSearch();
    await settled();
    expect(fk("note-search-message").textContent).toContain("479 MB");
    expect(search).not.toHaveBeenCalled();
  });

  it("does not search until typing has stopped", async () => {
    openNoteSearch();
    await settled();
    const input = fk<HTMLInputElement>("note-search-input");
    for (const s of ["c", "cr", "cro", "cross"]) {
      input.value = s;
      input.dispatchEvent(new Event("input"));
    }
    await tick(320);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("cross", undefined, 12);
  });

  it("scopes to the workspace it was opened for", async () => {
    openNoteSearch({ workspaceId: "ws-1" });
    await settled();
    await type("cross build");
    expect(search).toHaveBeenCalledWith("cross build", "ws-1", 12);
  });

  it("lists a hit with its title, its date and its passage", async () => {
    openNoteSearch();
    await settled();
    await type("cross build");
    const row = fk("note-search-row-0");
    expect(row.textContent).toContain("the staging script");
    expect(row.textContent).toContain("2026-08-31");
    expect(row.textContent).toContain("host triple");
  });

  /** A lesson from another project turning up is the feature working. */
  it("says when a hit is a lesson rather than this project's note", async () => {
    search.mockResolvedValue([hit({ file: "Diaries/reviewer/2026-08.md", scope: "lessons", room: "reviewer" })]);
    openNoteSearch({ workspaceId: "ws-1" });
    await settled();
    await type("packaging");
    expect(fk("note-search-row-0").textContent).toContain("a lesson, any project");
  });

  it("shows the selected note, and offers to show the file", async () => {
    openNoteSearch();
    await settled();
    await type("cross build");
    await settled();
    expect(readNote).toHaveBeenCalledWith("ws-1/Sessions/2026-08/31-the-staging-script.md");
    expect(fk("note-search-preview").textContent).toContain("text");
    fk<HTMLButtonElement>("note-search-reveal").click();
    expect(reveal).toHaveBeenCalledWith("/r/ws-1/Sessions/2026-08/31-the-staging-script.md");
  });

  it("moves through the list with the arrows", async () => {
    search.mockResolvedValue([hit(), hit({ file: "ws-1/Sessions/2026-08/30-another.md" })]);
    openNoteSearch();
    await settled();
    await type("cross build");
    const input = fk<HTMLInputElement>("note-search-input");
    expect(fk("note-search-row-0").getAttribute("aria-selected")).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(fk("note-search-row-1").getAttribute("aria-selected")).toBe("true");
    // And wraps, rather than stopping at the end with nothing happening.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(fk("note-search-row-0").getAttribute("aria-selected")).toBe("true");
  });

  /* Only reachable with a ready index, which is what lets it say this rather
     than hedging about which of four things went wrong. */
  it("says nothing matched only when nothing matched", async () => {
    search.mockResolvedValue([]);
    openNoteSearch();
    await settled();
    await type("something absent");
    expect(fk("note-search-message").textContent).toContain("Nothing matched");
    expect(fk("note-search-message").textContent).toContain("by meaning");
  });

  it("does not search an empty query", async () => {
    openNoteSearch();
    await settled();
    await type("   ");
    expect(search).not.toHaveBeenCalled();
  });

  it("shows a failed search rather than an empty list", async () => {
    search.mockRejectedValue("the memory sidecar is not installed");
    openNoteSearch();
    await settled();
    await type("cross build");
    expect(fk("note-search-message").textContent).toContain("not installed");
  });

  it("shows a note it could not read where the note would have been", async () => {
    readNote.mockRejectedValue("that note is not there");
    openNoteSearch();
    await settled();
    await type("cross build");
    await settled();
    expect(fk("note-search-preview").textContent).toContain("not there");
  });

  /* Enter is the list's, not the dialog's: a person who types and presses Enter
     out of habit must not have the dialog closed on them. */
  it("does not close on Enter", async () => {
    openNoteSearch();
    await settled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(document.querySelector(".modal-box")).not.toBeNull();
  });

  it("closes on Escape", async () => {
    openNoteSearch();
    await settled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".modal-box")).toBeNull();
  });
});
