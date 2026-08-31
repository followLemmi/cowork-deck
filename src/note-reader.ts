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
import {
  memoryReadNote, memorySaveNote, memoryWriteNote, revealPath, type MemoryNoteEntry,
} from "./ipc";
import { renderMarkdown } from "./markdown";
import { confirmModal } from "./modal";

/** Why the editor is offered on a note and nowhere else.
 *
 *  `Facts.md` and a diary are append-only line records: a fact is marked rather
 *  than rewritten (ADR-0004), and a free-text editor over either would quietly
 *  undo that. Said where the button would have been, because an absence explains
 *  nothing. */
export const NOT_EDITABLE_NOTICE =
  "Facts and lessons are appended, never rewritten — so they are added through a "
  + "form rather than edited here.";

/** What a save without the section costs, in the sentence that refuses it.
 *
 *  The `## TL;DR` is the indexer's priority chunk: the only one allowed to be
 *  terser than the letter floor, and above the big-file threshold very nearly the
 *  only thing indexed at all. Somebody who deletes it has made their note
 *  unfindable without being told. */
export const TLDR_REQUIRED =
  "A note keeps its `## TL;DR` heading: it is what a search reads first, and a "
  + "note without one does not come back from one.";

/** Whether markdown still carries the heading. The frontend's copy of
 *  `corpus::has_tldr`, so the refusal happens before a round trip — the backend
 *  refuses too, and that is the one that counts. */
export function hasTldr(markdown: string): boolean {
  return markdown.split("\n").some((l) => /^##\s*TL;DR\s*$/i.test(l.trimEnd()));
}

/** Which shapes an editor is offered on. `other` included: a file somebody put
 *  in the corpus themselves is theirs, and it is not one of the two records the
 *  rule is about. */
function editable(note: MemoryNoteEntry): boolean {
  return note.kind === "session" || note.kind === "other";
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "note-reader-row");
  wrap.append(el("span", "note-reader-label", text), control);
  return wrap;
}

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
  /** A note was written or saved, and its path relative to the corpus root. The
   *  page re-reads the corpus on it — the file is the memory (ADR-0004), so the
   *  listing is a walk over what was just written rather than a guess at it. */
  onWrote?: (file: string) => void;
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
  /** The markdown as it was read, which is what the editor starts from and what
   *  a discard compares against. */
  private markdown = "";
  /** The editor, while one is open. Its presence is the mode. */
  private editor: HTMLTextAreaElement | null = null;

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

  /** Whether somebody is typing into a note.
   *
   *  Read by the window's Escape, which must not take the deck back from under
   *  an unsaved edit: a keystroke that discards what you have written is the one
   *  thing this surface must never do by accident. */
  isEditing(): boolean { return this.editor !== null; }

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
      this.markdown = read.markdown;
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
    /* Not while somebody is typing. Re-reading under an open editor would
       replace what they have written with what is on disk, which is the same
       loss the sync design refuses to automate away: "an automatic merge
       produces a plausible paragraph nobody wrote". */
    if (this.isEditing()) return;
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
    this.editor = null;
    this.markdown = "";
    // Nothing is being read any more, so a read still in flight must not paint.
    this.seq += 1;
    this.body.replaceChildren();
    this.opts.onClose?.();
  }

  /** Put the note's markdown into a text area, over the same surface.
   *
   *  The raw markdown rather than a rich editor, and that is the honest shape: a
   *  note IS markdown on disk (ADR-0004), the indexer reads its headings, and an
   *  editor that produced markdown by inference would produce a `## TL;DR` that
   *  was nearly right — which is the failure mode `Note::render` exists to avoid
   *  on the writing side. */
  startEdit(): void {
    if (!this.note || !editable(this.note) || this.editor) return;
    const area = el("textarea", "note-reader-edit");
    area.value = this.markdown;
    area.dataset.fk = "note-reader-editor";
    area.spellcheck = false;
    this.editor = area;
    const fault = el("p", "note-reader-fault");
    fault.dataset.fk = "note-reader-edit-fault";
    fault.hidden = true;
    this.body.replaceChildren(area, fault);
    this.paintHead(this.note, null);
    area.focus();
  }

  /** Save what is in the editor, or refuse and say why. */
  async save(): Promise<void> {
    if (!this.note || !this.editor) return;
    const fault = this.body.querySelector<HTMLElement>('[data-fk="note-reader-edit-fault"]');
    const text = this.editor.value;
    const say = (message: string) => {
      if (!fault) return;
      fault.hidden = false;
      fault.textContent = message;
    };
    /* Refused here as well as in the backend, and the backend's is the one that
       counts. This one exists so the answer arrives while the caret is still in
       the paragraph that caused it. */
    if (!hasTldr(text)) { say(TLDR_REQUIRED); return; }
    const file = this.note.file;
    try {
      await memorySaveNote(file, text);
    } catch (e) {
      say(String(e));
      return;
    }
    this.editor = null;
    this.markdown = text;
    this.opts.onWrote?.(file);
    // Re-read rather than render what was typed: the backend adds a trailing
    // newline and is free to refuse more later, and the surface should show
    // what is on disk.
    await this.open(this.note);
  }

  /** Leave the editor. Asks first when there is something to lose. */
  async discard(): Promise<void> {
    if (!this.note || !this.editor) return;
    if (this.editor.value !== this.markdown) {
      const sure = await confirmModal("Discard the changes to this note?");
      if (!sure) return;
    }
    this.editor = null;
    await this.open(this.note);
  }

  /** Write a note by hand, on the surface that reads them.
   *
   *  Three fields rather than raw markdown, unlike the editor above, and the
   *  asymmetry is deliberate: `memory_write_note` assembles the frontmatter, the
   *  H1 and the exact `## TL;DR` heading, so a note written here cannot be
   *  missing the one section that decides whether it is findable. Editing an
   *  existing note is raw because the note already has that shape and rewriting
   *  it from fields would throw away everything that does not fit them. */
  compose(target: { workspaceId: string; workspaceName: string }): void {
    this.note = null;
    this.editor = null;
    this.markdown = "";
    this.el.hidden = false;
    this.seq += 1;

    const title = el("input", "note-reader-field");
    title.type = "text";
    title.placeholder = "What this note is about";
    title.dataset.fk = "note-compose-title";
    const tldr = el("textarea", "note-reader-field");
    tldr.rows = 3;
    tldr.placeholder = "The one paragraph a search should find";
    tldr.dataset.fk = "note-compose-tldr";
    const body = el("textarea", "note-reader-field note-reader-field--tall");
    body.placeholder = "The rest, in markdown (optional)";
    body.dataset.fk = "note-compose-body";
    const why = el(
      "p",
      "note-reader-rule",
      "The TL;DR is what the index reads first, and above a certain size very "
      + "nearly the only thing it reads — so a note without one does not come back "
      + "from a search. It is written into the note's shape for you.",
    );
    const fault = el("p", "note-reader-fault");
    fault.dataset.fk = "note-compose-fault";
    fault.hidden = true;
    const form = el("div", "note-reader-compose");
    form.append(
      labelled("Title", title),
      labelled("TL;DR", tldr),
      labelled("Body", body),
      why,
      fault,
    );
    this.body.replaceChildren(form);

    const named = el("div", "note-reader-named");
    named.append(
      el("div", "note-reader-title", "A note, by hand"),
      el("div", "note-reader-where", target.workspaceName),
    );
    const acts = el("div", "note-reader-acts");
    const save = el("button", "rooms-add", "Write it");
    save.type = "button";
    save.dataset.fk = "note-compose-save";
    const back = el("button", "note-reader-back");
    back.type = "button";
    back.dataset.fk = "note-reader-close";
    back.title = "Give the deck back (Escape)";
    back.setAttribute("aria-label", "Give the deck back");
    back.append(icon("x", 14));
    back.onclick = () => this.close();
    acts.append(save, back);
    this.head.replaceChildren(named, acts);

    save.onclick = () => {
      void (async () => {
        if (!title.value.trim() || !tldr.value.trim()) {
          fault.hidden = false;
          fault.textContent = "A note needs a title and a TL;DR.";
          return;
        }
        save.disabled = true;
        let file: string;
        try {
          file = await memoryWriteNote(
            target.workspaceId, title.value.trim(), tldr.value.trim(), body.value,
          );
        } catch (e) {
          save.disabled = false;
          fault.hidden = false;
          fault.textContent = String(e);
          return;
        }
        this.opts.onWrote?.(file);
        // Onto the note that was just written, on the surface it was written on.
        await this.open({
          file,
          scope: target.workspaceId,
          room: null,
          kind: "session",
          when: "",
          title: title.value.trim(),
          size: 0,
          mtime: 0,
        });
      })();
    };
    title.focus();
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
    if (this.editor) {
      /* Editing: one control that writes and one that walks away. No "Show the
         file" — what is on disk is not what is on screen, and revealing it would
         show the version being replaced. */
      const save = el("button", "rooms-add", "Save");
      save.type = "button";
      save.dataset.fk = "note-reader-save";
      save.onclick = () => void this.save();
      const discard = el("button", "rooms-add", "Discard");
      discard.type = "button";
      discard.dataset.fk = "note-reader-discard";
      discard.onclick = () => void this.discard();
      acts.append(discard, save);
      const left = el("div", "note-reader-named");
      left.append(title, scope);
      this.head.replaceChildren(left, acts);
      return;
    }
    if (editable(note)) {
      const edit = el("button", "rooms-add", "Edit");
      edit.type = "button";
      edit.dataset.fk = "note-reader-edit";
      edit.onclick = () => this.startEdit();
      acts.append(edit);
    } else {
      // An absence explains nothing, so the sentence goes where the button
      // would have been.
      scope.append(el("span", "note-reader-rule", NOT_EDITABLE_NOTICE));
    }
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
