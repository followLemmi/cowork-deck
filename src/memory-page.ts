// Everything ever written down, in one column.
//
// What the rail's fourth button lands on (#380). A person should be able to see
// the whole corpus here and recognise a note without opening it.
//
// # Browsing needs no model; only searching does
//
// `memoryNotes` is a directory walk over a layout `memory::corpus` owns, so this
// page is useful on a machine that has downloaded nothing — which is every
// machine at first run. The one thing it owes in return is a sentence saying what
// searching would *additionally* need, from `searchReadiness` rather than from a
// second opinion about it.
//
// # The list is not the index
//
// A note can be listed here and not be findable by search: a chunk needs 120
// letters to be indexed at all, and a diary's first lesson is about 80 (#375). So
// somebody who sees a note and cannot search for it has met a threshold, not a
// bug — and the head has to have said so before they try. That one sentence is
// what stops the page reading as broken.
//
// # 280–384px
//
// Measured: the rail's column is `clamp(17.5rem, 19vw, 24rem)`. A title, a date
// and a room is already most of it. A snippet does not fit, and a note's body is
// read on the document surface instead (#383).

import { memoryNotes, memoryStatus, type MemoryNoteEntry, type MemoryStatus } from "./ipc";
import { searchReadiness } from "./memory-model";

/** The three groups, in the order the page shows them.
 *
 *  The order is the argument: **this project** first, because that is what the
 *  person is in; **lessons** next, because they are the reason memory is global
 *  at all; **other projects** last. */
export interface Grouped {
  mine: MemoryNoteEntry[];
  lessons: MemoryNoteEntry[];
  others: MemoryNoteEntry[];
}

/** Split the corpus three ways.
 *
 *  A window with no active workspace has no first group — not an empty one with a
 *  zero beside it — so `mine` is empty and the page renders two headers. Its
 *  notes are not lost: with no workspace to be "this project", every project is
 *  another one. */
export function group(notes: MemoryNoteEntry[], workspaceId: string | null): Grouped {
  const mine: MemoryNoteEntry[] = [];
  const lessons: MemoryNoteEntry[] = [];
  const others: MemoryNoteEntry[] = [];
  for (const note of notes) {
    if (note.kind === "diary") lessons.push(note);
    else if (workspaceId !== null && note.scope === workspaceId) mine.push(note);
    else others.push(note);
  }
  return { mine, lessons, others };
}

/** What the corpus holds, in a sentence.
 *
 *  Projects counted by scope rather than by the workspaces the app knows about: a
 *  project deleted from the deck leaves its notes behind, and they are still
 *  notes about a project. */
export function corpusLine(notes: MemoryNoteEntry[]): string {
  if (notes.length === 0) return "Nothing has been written down yet.";
  const projects = new Set<string>();
  const rooms = new Set<string>();
  for (const note of notes) {
    if (note.kind === "diary") { if (note.room) rooms.add(note.room); }
    else projects.add(note.scope);
  }
  const parts = [notes.length === 1 ? "1 note" : `${notes.length} notes`];
  if (projects.size) parts.push(projects.size === 1 ? "1 project" : `${projects.size} projects`);
  if (rooms.size) parts.push(rooms.size === 1 ? "1 diary room" : `${rooms.size} diary rooms`);
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts[0]} across ${parts.slice(1).join(" and ")}.`;
}

/** A note's title as a row should show it.
 *
 *  `Note::render` writes the H1 as `YYYY-MM-DD — topic`, and the row shows the
 *  date beside the title, so passing the heading through would say it twice in
 *  eight characters of column. The listing keeps the title verbatim on purpose —
 *  it is what the file says, and the note a person opens says it too — so the
 *  trimming belongs here, where the duplication is. */
export function rowTitle(note: MemoryNoteEntry): string {
  if (note.when && note.title.startsWith(note.when)) {
    const rest = note.title.slice(note.when.length).replace(/^\s*[—–-]\s*/, "");
    if (rest) return rest;
  }
  return note.title;
}

/** What a row says about where a note came from, beyond its title and its date.
 *
 *  The room for a lesson, because that is what distinguishes one from another;
 *  the project for a note from a workspace that is not the active one. Nothing
 *  for this project's own — the group header above already said it. */
export function rowScope(note: MemoryNoteEntry, names: Map<string, string>): string {
  if (note.kind === "diary") return note.room ?? "";
  return names.get(note.scope) ?? note.scope;
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

export interface MemoryPageOptions {
  /** The active workspace, asked each render rather than held: the page outlives
   *  every workspace switch and the panel's head is what changes under it. */
  workspace: () => { id: string; name: string } | null;
  /** Every workspace the app knows, so a scope can be shown as a name. A scope
   *  with no workspace left is shown as itself — the notes outlive the project. */
  names: () => Map<string, string>;
  /** A note was chosen. #383 puts it on the document surface; until then the row
   *  is still a control, so the keyboard has somewhere to land. */
  onOpen?: (note: MemoryNoteEntry) => void;
}

export interface MemoryView {
  /** The element to put in the panel's page. */
  readonly mount: HTMLElement;
  /** Re-read the corpus and repaint. */
  refresh: () => Promise<void>;
}

/** Which groups a person has folded away. Kept for the life of the window rather
 *  than persisted: it is a glance-scoped preference, and a page that remembered
 *  a collapse from last week would hide notes somebody has forgotten they hid. */
type Fold = Record<keyof Grouped, boolean>;

export function mountMemory(opts: MemoryPageOptions): MemoryView {
  const mount = el("div", "mem");
  const head = el("p", "mem-head");
  head.dataset.fk = "memory-head";
  const readiness = el("p", "mem-readiness");
  readiness.dataset.fk = "memory-readiness";
  const list = el("div", "mem-list");
  list.dataset.fk = "memory-list";
  /* Arrows move between notes and the document follows, so moving from one note
     to the next does not mean going back to the list first. On the container
     rather than on each row: a row is added and removed on every repaint, and a
     listener per row would be a listener per note in a corpus of hundreds.

     Only the rows a person can see. A collapsed group is folded away deliberately,
     and stepping into one would put the reader on a note with no row on screen —
     the selection would appear to vanish. */
  list.onkeydown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".mem-row")]
      .filter((r) => !(r.closest(".mem-rows") as HTMLElement | null)?.hidden);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r === document.activeElement);
    e.preventDefault();
    const next = at < 0
      ? rows[0]
      : rows[(at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
    next.focus();
    next.click();
  };
  mount.append(head, readiness, list);

  const folded: Fold = { mine: false, lessons: false, others: true };
  let notes: MemoryNoteEntry[] = [];
  let selected: string | null = null;

  const paint = () => {
    const ws = opts.workspace();
    const names = opts.names();
    const groups = group(notes, ws?.id ?? null);
    head.textContent = corpusLine(notes);
    list.replaceChildren();

    if (notes.length === 0) {
      // The state every new install is in, and the one place the page has to say
      // what fills it: a corpus that only ever fills itself is a feature nobody
      // can find the switch for.
      list.append(el(
        "p",
        "mem-empty",
        "Closing a session and saying yes to the question is what writes a note. "
        + "Lessons are filed into diary rooms, and travel with you between projects.",
      ));
      return;
    }

    const sections: [key: keyof Grouped, title: string, rows: MemoryNoteEntry[]][] = [
      [
        "mine",
        // The workspace's own name rather than "this project": the panel's head
        // says which workspace the panel is about, and a group that repeated the
        // word instead of the name would be the one line on the page that did not.
        ws ? ws.name : "This project",
        groups.mine,
      ],
      ["lessons", "Lessons, from every project", groups.lessons],
      ["others", "Other projects", groups.others],
    ];

    for (const [key, title, rows] of sections) {
      // No empty group with a zero beside it — most of all the first one, which
      // is absent rather than empty in a window with no active workspace.
      if (rows.length === 0) continue;
      list.append(section(key, title, rows, names));
    }
  };

  const section = (
    key: keyof Grouped,
    title: string,
    rows: MemoryNoteEntry[],
    names: Map<string, string>,
  ): HTMLElement => {
    const box = el("section", "mem-group");
    const toggle = el("button", "mem-group-head");
    toggle.type = "button";
    toggle.dataset.fk = `memory-group-${key}`;
    toggle.setAttribute("aria-expanded", String(!folded[key]));
    toggle.append(
      el("span", "mem-group-title", title),
      // On the header, so a collapsed group still says how much is behind it.
      el("span", "mem-group-count", String(rows.length)),
    );
    const body = el("div", "mem-rows");
    body.hidden = folded[key];
    toggle.onclick = () => {
      folded[key] = !folded[key];
      toggle.setAttribute("aria-expanded", String(!folded[key]));
      body.hidden = folded[key];
    };
    for (const note of rows) body.append(row(note, names));
    box.append(toggle, body);
    return box;
  };

  const row = (note: MemoryNoteEntry, names: Map<string, string>): HTMLElement => {
    const btn = el("button", `notes-row mem-row${note.file === selected ? " selected" : ""}`);
    btn.type = "button";
    btn.dataset.fk = `memory-row-${note.file}`;
    btn.dataset.file = note.file;
    const line = el("div", "notes-row-head");
    line.append(el("span", "notes-row-title", rowTitle(note)));
    if (note.when) line.append(el("span", "notes-row-when", note.when));
    btn.append(line);
    const scope = rowScope(note, names);
    // A lesson says its room; a note from another project says which. This
    // project's own says nothing — the header above it just did.
    if (scope && note.scope !== opts.workspace()?.id) {
      btn.append(el("div", "notes-row-scope", scope));
    }
    btn.onclick = () => {
      selected = note.file;
      for (const other of list.querySelectorAll(".mem-row")) other.classList.remove("selected");
      btn.classList.add("selected");
      opts.onOpen?.(note);
    };
    return btn;
  };

  /** What searching would additionally need, said before anybody tries.
   *
   *  Failing softly on purpose: this page's whole claim is that browsing needs
   *  neither the sidecar nor the model, so a status call that throws must cost
   *  the sentence and not the list. */
  const sayReadiness = async () => {
    let status: MemoryStatus;
    try {
      status = await memoryStatus();
    } catch {
      readiness.textContent = "Searching your notes is not available on this build.";
      readiness.hidden = notes.length === 0;
      return;
    }
    const r = searchReadiness(status);
    readiness.textContent = r.ready ? "" : (r.reason ?? "");
    // On an empty corpus the empty state already says what fills it, and "there
    // are no notes to search yet" underneath it is the same sentence twice.
    readiness.hidden = r.ready || notes.length === 0;
  };

  const refresh = async () => {
    try {
      notes = await memoryNotes();
    } catch (e) {
      notes = [];
      paint();
      head.textContent = `The corpus could not be read (${e}).`;
      readiness.hidden = true;
      return;
    }
    paint();
    await sayReadiness();
  };

  return { mount, refresh };
}
