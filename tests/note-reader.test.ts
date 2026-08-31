// @vitest-environment jsdom
/** A note read where the deck was, and the deck given back.
 *
 *  #346's own tests are the model, and its sentence is the requirement: a covered
 *  deck that returns with a different layout, a lost zoom or the keyboard in the
 *  wrong place is a worse fault than not covering it at all. What makes that
 *  cheap here is the same thing that makes it cheap for the terminal drawer —
 *  the surface COVERS the deck rather than squeezing it, so there is nothing to
 *  put back. This file asserts that, against the real stylesheet. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import styles from "../src/styles.css?raw";
import { NoteReader } from "../src/note-reader";
import type { MemoryNoteEntry } from "../src/ipc";

const readNote = vi.fn();
const reveal = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryReadNote: (f: string) => readNote(f),
  revealPath: (p: string) => reveal(p),
}));

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

const MARKDOWN = "# a note\n\n## TL;DR\nit read the host triple\n\n## What we did\n- read it\n";

function mount(): { reader: NoteReader; workarea: HTMLElement; deck: HTMLElement } {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><div id="stage">'
    + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
    + "</div></div>";
  const workarea = document.querySelector<HTMLElement>("#workarea")!;
  const reader = new NoteReader({ host: workarea, describe: () => "deck" });
  return { reader, workarea, deck: document.querySelector<HTMLElement>("#deck")! };
}

const fk = (name: string) => document.querySelector<HTMLElement>(`[data-fk="${name}"]`);

describe("reading a note", () => {
  beforeEach(() => {
    readNote.mockReset();
    reveal.mockReset();
    reveal.mockResolvedValue(undefined);
    readNote.mockResolvedValue({ path: "/corpus/ws-1/Sessions/2026-08/31.md", markdown: MARKDOWN });
  });

  it("is not on screen until a note is opened", () => {
    const { reader } = mount();
    expect(reader.isOpen()).toBe(false);
    expect(getComputedStyle(reader.el).display).toBe("none");
  });

  it("renders the note's markdown, named and with its path", async () => {
    const { reader } = mount();
    await reader.open(note());

    expect(reader.isOpen()).toBe(true);
    expect(document.querySelector(".note-reader-title")!.textContent)
      .toBe("2026-08-31 — the staging script");
    expect(document.querySelector(".note-reader-path")!.textContent)
      .toBe("ws-1/Sessions/2026-08/31-the-staging-script.md");
    expect(document.querySelector(".note-reader-where")!.textContent).toContain("deck");
    // Rendered rather than dumped: `renderMarkdown` is what the search dialog's
    // preview used, and a note is the same markdown on a wider surface. Its
    // headings start at `h4` — `HEADING_BASE`, so a note's `#` does not outrank
    // the screen it is rendered into.
    expect(document.querySelectorAll(".note-reader-body .md-head")).toHaveLength(3);
    expect(document.querySelector(".note-reader-body .md-head")!.tagName).toBe("H4");
  });

  /** Read through the command, never by path: `memory_read_note` canonicalises
   *  and checks containment before it reads (#375), and the frontend has no
   *  filesystem of its own to go around it with. */
  it("reads through the command, by the path relative to the corpus", async () => {
    const { reader } = mount();
    await reader.open(note());
    expect(readNote).toHaveBeenCalledWith("ws-1/Sessions/2026-08/31-the-staging-script.md");
  });

  it("reveals the file at the absolute path the command resolved", async () => {
    const { reader } = mount();
    await reader.open(note());
    fk("note-reader-reveal")!.click();
    expect(reveal).toHaveBeenCalledWith("/corpus/ws-1/Sessions/2026-08/31.md");
  });

  it("says so when a note cannot be read", async () => {
    readNote.mockRejectedValue(new Error("that note is not there"));
    const { reader } = mount();
    await reader.open(note());
    expect(document.querySelector(".note-reader-fault")!.textContent).toContain("not there");
  });

  /** The deck is covered, not squeezed — which is what makes giving it back
   *  exact. Asserted against the real stylesheet, because the whole claim is a
   *  `position: absolute` in it. */
  it("covers the deck without changing it, and gives it back exactly", async () => {
    const { reader, deck } = mount();
    const before = { className: deck.className, style: deck.getAttribute("style") };

    await reader.open(note());
    expect(getComputedStyle(reader.el).position).toBe("absolute");
    expect(getComputedStyle(deck).display).toBe("grid");
    expect(deck.className).toBe(before.className);
    expect(deck.getAttribute("style")).toBe(before.style);

    reader.close();
    expect(reader.isOpen()).toBe(false);
    expect(getComputedStyle(reader.el).display).toBe("none");
    expect(getComputedStyle(deck).display).toBe("grid");
    expect(deck.className).toBe(before.className);
    expect(deck.getAttribute("style")).toBe(before.style);
  });

  it("gives the deck back from its own control, and tells whoever asked", async () => {
    const workarea = mount().workarea;
    const closed: number[] = [];
    const reader = new NoteReader({ host: workarea, onClose: () => closed.push(1) });
    await reader.open(note());
    fk("note-reader-close")!.click();
    expect(reader.isOpen()).toBe(false);
    expect(closed).toHaveLength(1);
    // Closing what is already closed is not an event.
    reader.close();
    expect(closed).toHaveLength(1);
  });

  /** A capture writing while somebody is reading, or an edit rewriting the very
   *  file on screen (#386). Stale markdown left on the surface is the one failure
   *  this costs nothing to avoid. */
  it("re-reads the open note when the corpus changes, and nothing when it is shut", async () => {
    const { reader } = mount();
    await reader.open(note());
    readNote.mockResolvedValue({ path: "/corpus/x.md", markdown: "# rewritten\n\n## TL;DR\nnew\n" });
    await reader.reread();
    expect(document.querySelector(".note-reader-body .md-head")!.textContent).toBe("rewritten");

    reader.close();
    const calls = readNote.mock.calls.length;
    await reader.reread();
    expect(readNote.mock.calls).toHaveLength(calls);
  });

  /** Two notes chosen in quick succession: the first read must not paint over the
   *  second. The navigator's arrow keys make this the ordinary case rather than a
   *  race somebody has to try for. */
  it("does not let a slow read paint over the note chosen after it", async () => {
    const { reader } = mount();
    let releaseFirst: (v: unknown) => void = () => {};
    readNote.mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }));
    readNote.mockImplementationOnce(() =>
      Promise.resolve({ path: "/corpus/second.md", markdown: "# second\n\n## TL;DR\nb\n" }));

    const first = reader.open(note());
    const second = reader.open(note({ file: "ws-1/Facts.md", title: "Facts", kind: "facts", when: "" }));
    await second;
    releaseFirst({ path: "/corpus/first.md", markdown: "# first\n\n## TL;DR\na\n" });
    await first;

    expect(document.querySelector(".note-reader-body .md-head")!.textContent).toBe("second");
    expect(reader.current()).toBe("ws-1/Facts.md");
  });
});
