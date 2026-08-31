// A note read where the deck was, and the deck given back.
//
// The navigator lists (#382); this reads. A note's body is markdown with a
// `## TL;DR` and sections, sometimes a screenful, and the rail's column is
// 280–384px — so reading is a deliberate second step onto a surface with real
// width.
//
// # Why the deck's place
//
// The precedent is #346, and its sentence is the whole argument: "the terminals
// take the deck's place, from a control that gives it back". Nothing about a
// session dies when the deck is covered — the PTYs carry on and the tiles come
// back — and it is the only surface in this app with the width a document wants.
//
// It covers rather than squeezes, for the reason `.term-drawer.is-full` records:
// a deck squeezed to nothing draws its zoomed filmstrip out of a box with no room
// for it, and its padding floors it at a band of empty ground. Out of flow, over
// a deck that keeps its layout — which is also what makes giving it back exact,
// since nothing was taken.
//
// Deliberately not the modal the search dialog uses. That was right for a preview
// beside a result list and is wrong for reading: a long note in a 620px box with
// no list beside it is worse than either.

import { icon } from "./icons";
import { memoryReadNote, revealPath, type MemoryNoteEntry } from "./ipc";
import { renderMarkdown } from "./markdown";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export interface NoteReaderOptions {
  /** Where to put the cover. `#workarea`, which is the column the deck is in and
   *  is already `position: relative` for the terminal drawer's own full mode. */
  host: HTMLElement;
  /** The deck is back. The caller repaints whatever it hid — see `app.ts`. */
  onClose?: () => void;
  /** How a scope is named for a reader: a workspace's name rather than its id,
   *  and a room for a lesson. */
  describe?: (note: MemoryNoteEntry) => string;
}

export class NoteReader {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly opts: NoteReaderOptions;
  private note: MemoryNoteEntry | null = null;
  /** Which read is the current one. A second note chosen while the first is
   *  still being read must not have its markdown arrive on top of the second. */
  private seq = 0;

  constructor(opts: NoteReaderOptions) {
    this.opts = opts;
    this.el = el("div", "note-reader");
    this.el.id = "mem-reader";
    this.el.hidden = true;
    // A region rather than a dialog: it does not trap focus and the panel beside
    // it stays usable, which is the whole point of covering the deck rather than
    // opening a modal over the window.
    this.el.setAttribute("role", "region");
    this.head = el("div", "note-reader-head");
    this.body = el("div", "note-reader-body");
    this.el.append(this.head, this.body);
    opts.host.append(this.el);
  }

  isOpen(): boolean { return !this.el.hidden; }

  /** Which note is on screen, by its path relative to the corpus root. */
  current(): string | null { return this.note?.file ?? null; }

  /** Put a note on the surface, reading it through the command.
   *
   *  **Through the command, never by path.** `memory_read_note` canonicalises and
   *  checks containment before it reads (#375), and the frontend has no filesystem
   *  of its own to go around it with. */
  async open(note: MemoryNoteEntry): Promise<void> {
    this.note = note;
    this.el.hidden = false;
    const mine = ++this.seq;
    this.body.replaceChildren(el("p", "note-reader-wait", "Reading…"));
    this.paintHead(note, null);
    try {
      const read = await memoryReadNote(note.file);
      if (mine !== this.seq) return;
      this.paintHead(note, read.path);
      this.body.replaceChildren(renderMarkdown(read.markdown));
      this.body.scrollTop = 0;
    } catch (e) {
      if (mine !== this.seq) return;
      this.body.replaceChildren(el("p", "note-reader-fault", String(e)));
    }
  }

  /** Read the open note again.
   *
   *  For `memory://changed`: a capture can write while somebody is reading, and
   *  an edit (#386) rewrites the very file on screen. Stale markdown left on the
   *  surface is the one failure this costs nothing to avoid. */
  async reread(): Promise<void> {
    if (!this.isOpen() || !this.note) return;
    await this.open(this.note);
  }

  /** Give the deck back.
   *
   *  Exact by construction rather than by restoring anything: the deck was
   *  covered, not resized, so there is no layout to put back and no zoom to
   *  remember. */
  close(): void {
    if (!this.isOpen()) return;
    this.el.hidden = true;
    this.note = null;
    // Nothing is being read any more, so a read still in flight must not paint.
    this.seq += 1;
    this.body.replaceChildren();
    this.opts.onClose?.();
  }

  private paintHead(note: MemoryNoteEntry, path: string | null) {
    const where = this.opts.describe?.(note) ?? note.scope;
    const title = el("div", "note-reader-title", note.title);
    const scope = el("div", "note-reader-where");
    scope.append(el("span", "", where));
    if (note.when) scope.append(el("span", "note-reader-when", note.when));
    // The path, because "which file is this" is the question a person asks
    // before they go looking for it in a terminal, and the corpus is a directory
    // of markdown they are allowed to open themselves.
    scope.append(el("span", "note-reader-path", note.file));

    const acts = el("div", "note-reader-acts");
    const reveal = el("button", "rooms-add", "Show the file");
    reveal.type = "button";
    reveal.dataset.fk = "note-reader-reveal";
    // Only once the note has actually been read: `memory_read_note` is what
    // resolves the absolute path, and a button that revealed a guess would
    // reveal a wrong one.
    reveal.disabled = path === null;
    reveal.onclick = () => {
      if (path === null) return;
      void revealPath(path).catch((e) => {
        acts.append(el("span", "rooms-fault", String(e)));
      });
    };
    const back = el("button", "note-reader-back");
    back.type = "button";
    back.dataset.fk = "note-reader-close";
    /* One control, and it says what it gives rather than what it closes: what is
       behind this cover is the deck, and "Close" would leave a person guessing
       what they are about to get back. Escape does the same, which is the
       keyboard's version of the same promise. */
    back.title = "Give the deck back (Escape)";
    back.setAttribute("aria-label", "Give the deck back");
    back.append(icon("x", 14));
    back.onclick = () => this.close();
    acts.append(reveal, back);

    const left = el("div", "note-reader-named");
    left.append(title, scope);
    this.head.replaceChildren(left, acts);
  }
}
