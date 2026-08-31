// Searching your own notes: the first way a person, rather than an agent, gets
// anything back out of the corpus.
//
// A dialog of its own rather than a mode of the command palette. The palette
// filters commands by title and runs one; this takes a sentence, asks a model to
// embed it, and shows prose. Bending one into the other would make both worse.
//
// # What a hit has to say before it is useful
//
// The sidecar returns a score, a path, a scope, a room and the matching passage.
// None of that is a heading. So the display is derived from **the path**, which
// is ours — `memory::corpus` writes it — rather than from the passage, which is
// the model's chunking and may or may not begin with the note's title. Parsing
// our own layout is a thing we can be right about; guessing where a chunk starts
// is not.
//
// # An empty list is four different things
//
// Only one of them means "nothing matched". The others are: no model, nothing
// indexed yet, and notes too short to index — see `searchReadiness` in
// `memory-model.ts`, which is shared with the settings block precisely so the two
// cannot come to disagree about what is wrong.

import { openDialog } from "./dialog-shell";
import {
  memoryReadNote, memorySearch, memoryStatus, revealPath,
  type MemoryHit, type MemoryStatus,
} from "./ipc";
import { renderMarkdown } from "./markdown";
import { searchReadiness } from "./memory-model";

/** How long after a keystroke the query is sent.
 *
 *  A search spawns a process and embeds the query, so a character is not a
 *  request. Long enough that typing a sentence costs one search, short enough
 *  that stopping feels like an answer. */
const DEBOUNCE_MS = 250;

/** What a hit is called, where it came from and when — read out of its path. */
export interface HitLabel {
  title: string;
  /** `2026-08-31` for a session note, `2026-08` for a diary, empty otherwise. */
  when: string;
  /** The room, for a diary. */
  room?: string;
  /** Whether this is a diary rather than one project's note. */
  global: boolean;
}

/** Describe a hit from its path.
 *
 *  The three shapes are the ones `memory::corpus` writes and
 *  `sync::manifest::ALLOWED` allows, so this is exhaustive by construction rather
 *  than by hope:
 *
 *  - `{ws}/Sessions/YYYY-MM/DD-topic.md`
 *  - `{ws}/Facts.md`
 *  - `Diaries/{room}/YYYY-MM.md`
 *
 *  Anything else is shown by its filename rather than dropped: a corpus is a
 *  directory of markdown and somebody may have put a file in it. */
export function labelHit(hit: MemoryHit): HitLabel {
  const parts = hit.file.split("/");
  if (parts[0] === "Diaries" && parts.length === 3) {
    return {
      title: `${parts[1]} — lessons`,
      when: parts[2].replace(/\.md$/, ""),
      room: hit.room ?? parts[1],
      global: true,
    };
  }
  if (parts.length === 4 && parts[1] === "Sessions") {
    const month = parts[2];
    const file = parts[3].replace(/\.md$/, "");
    const day = file.slice(0, 2);
    const topic = file.slice(3).replace(/-/g, " ");
    return {
      title: topic || file,
      when: /^\d{2}$/.test(day) ? `${month}-${day}` : month,
      global: false,
    };
  }
  if (parts.length === 2 && parts[1] === "Facts.md") {
    return { title: "Facts", when: "", global: false };
  }
  return { title: parts[parts.length - 1].replace(/\.md$/, ""), when: "", global: false };
}

/** The passage, flattened to one paragraph for a list row.
 *
 *  A chunk carries its markdown — headings, bullets, blank lines — and a list row
 *  is one line high. Trimmed rather than truncated mid-word. */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/^#+\s*/gm, "").split(/\s+/).filter(Boolean).join(" ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
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

export interface NoteSearchOptions {
  /** Scopes the search: this workspace's notes plus the global diaries. Absent,
   *  everything — which is what a search with no workspace active means. */
  workspaceId?: string | null;
}

/** Open it. */
export function openNoteSearch(opts: NoteSearchOptions = {}): void {
  const { box, close } = openDialog({
    onCancel: () => close(),
    // Enter belongs to the list, not to the dialog: accepting would close it on
    // the first keystroke of anybody who types and presses Enter out of habit.
    onAccept: () => {},
    labelledBy: "note-search-title",
  });

  const title = el("div", "modal-title", "Search your notes");
  title.id = "note-search-title";
  const input = el("input", "modal-input");
  input.type = "text";
  input.placeholder = "What are you looking for?";
  input.dataset.fk = "note-search-input";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "note-search-list");
  input.setAttribute("aria-expanded", "true");

  const message = el("p", "form-hint");
  message.dataset.fk = "note-search-message";
  const list = el("div", "notes-list");
  list.id = "note-search-list";
  list.setAttribute("role", "listbox");
  const preview = el("div", "notes-preview");
  preview.dataset.fk = "note-search-preview";

  box.append(title, input, message, list, preview);

  let hits: MemoryHit[] = [];
  let sel = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  /* Read once, on the way in, and reported before anybody types. The alternative
     is a person searching an empty index and reading "no results" as an answer
     about their notes rather than about the machine. */
  let status: MemoryStatus | null = null;
  const readiness = async () => {
    try {
      status = await memoryStatus();
    } catch (e) {
      message.textContent = `Memory could not be read (${e}).`;
      input.disabled = true;
      return false;
    }
    const r = searchReadiness(status);
    if (!r.ready) {
      message.textContent = r.reason ?? "";
      // Still typable: the state can change under an open dialog — an index
      // finishes, a download completes — and a disabled field would not notice.
      return false;
    }
    message.textContent = "";
    return true;
  };

  const showPreview = async (hit: MemoryHit | undefined) => {
    preview.replaceChildren();
    if (!hit) return;
    const mine = ++seq;
    try {
      const note = await memoryReadNote(hit.file);
      if (mine !== seq) return;
      const head = el("div", "notes-preview-head");
      const reveal = el("button", "rooms-add", "Show the file");
      reveal.type = "button";
      reveal.dataset.fk = "note-search-reveal";
      reveal.onclick = () => {
        void revealPath(note.path).catch((e) => {
          head.append(el("span", "rooms-fault", String(e)));
        });
      };
      head.append(el("span", "notes-preview-path", hit.file), reveal);
      const body = el("div", "notes-preview-body");
      body.append(renderMarkdown(note.markdown));
      preview.append(head, body);
    } catch (e) {
      if (mine !== seq) return;
      preview.append(el("p", "rooms-fault", String(e)));
    }
  };

  const paint = () => {
    list.replaceChildren();
    hits.forEach((hit, i) => {
      const label = labelHit(hit);
      const row = el("div", `notes-row${i === sel ? " selected" : ""}`);
      row.id = `note-search-item-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));
      row.dataset.fk = `note-search-row-${i}`;
      const head = el("div", "notes-row-head");
      head.append(el("span", "notes-row-title", label.title));
      if (label.when) head.append(el("span", "notes-row-when", label.when));
      // Which corpus this came from, said plainly: a lesson from another project
      // showing up here is the feature working, not a leak.
      if (label.global) head.append(el("span", "notes-row-scope", "a lesson, any project"));
      row.append(head, el("div", "notes-row-text", excerpt(hit.text)));
      row.onclick = () => {
        sel = i;
        paint();
        void showPreview(hits[sel]);
      };
      list.append(row);
    });
    input.setAttribute(
      "aria-activedescendant",
      hits.length ? `note-search-item-${sel}` : "",
    );
  };

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      hits = [];
      paint();
      preview.replaceChildren();
      return;
    }
    if (!(await readiness())) {
      hits = [];
      paint();
      return;
    }
    const mine = ++seq;
    let found: MemoryHit[];
    try {
      found = await memorySearch(query, opts.workspaceId ?? undefined, 12);
    } catch (e) {
      if (mine !== seq) return;
      message.textContent = String(e);
      return;
    }
    if (mine !== seq) return;
    hits = found;
    sel = 0;
    paint();
    if (hits.length === 0) {
      // Only reachable with a ready index, so this really does mean what it says.
      message.textContent = "Nothing matched. The notes are searched by meaning, not by word.";
    } else {
      message.textContent = "";
      void showPreview(hits[0]);
    }
  };

  input.oninput = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void search(), DEBOUNCE_MS);
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!hits.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      paint();
      void showPreview(hits[sel]);
    }
  };

  void readiness();
  input.focus();
}
