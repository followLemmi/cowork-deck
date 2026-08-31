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
//
// # One list, two sources
//
// Searching was a dialog because there was nowhere to put it. There is now, and
// two doors to one set of facts is how they drift — the settings window's own
// words about why its sync section is not a second copy of the sync dialog. So
// the field at the top of this page switches the SAME list between browsing the
// corpus and showing results, and a hit is turned into the same shape a listed
// note has (`hitAsNote`) rather than getting a second kind of row. Two row
// renderers would disagree about some note, and the one people notice would be
// the one that disagreed about theirs.
//
// What came across from the dialog unchanged, because it was already right:
// `labelHit` (a hit carries no heading, so its name is read from the path, which
// is ours), `excerpt` (the passage is the only thing on a result saying WHY it
// matched), the 250ms debounce (a search spawns a process and embeds the query,
// so a character is not a request), and reporting readiness before a keystroke
// (otherwise "no results" reads as an answer about the notes rather than about
// the machine).

import {
  memoryNotes, memorySearch, memoryStatus,
  type MemoryHit, type MemoryNoteEntry, type MemoryStatus,
} from "./ipc";
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
 *  The sidecar returns a score, a path, a scope, a room and the matching passage.
 *  None of that is a heading — so the display comes from **the path**, which
 *  `memory::corpus` writes, rather than from the passage, which is the model's
 *  chunking and may or may not begin with the note's title. Parsing our own
 *  layout is a thing we can be right about; guessing where a chunk starts is not.
 *
 *  The three shapes are the ones `memory::corpus` writes and
 *  `sync::manifest::ALLOWED` allows, so this is exhaustive by construction rather
 *  than by hope. Anything else is shown by its filename rather than dropped: a
 *  corpus is a directory of markdown and somebody may have put a file in it —
 *  the same answer `Corpus::notes` gives on the other side of the IPC. */
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

/** A hit as the same shape a listed note has, so one row renderer serves both.
 *
 *  The size and the mtime are the two facts a hit does not carry and a row does
 *  not show. They are zero rather than optional because everything downstream —
 *  the row, the reader, `memory_read_note` — takes a note, and an optional field
 *  would spread a hit's absence through all of it. */
export function hitAsNote(hit: MemoryHit): MemoryNoteEntry {
  const label = labelHit(hit);
  const parts = hit.file.split("/");
  const kind: MemoryNoteEntry["kind"] = label.global
    ? "diary"
    : parts.length === 4 && parts[1] === "Sessions"
      ? "session"
      : parts.length === 2 && parts[1] === "Facts.md"
        ? "facts"
        : "other";
  return {
    file: hit.file,
    scope: label.global ? "Diaries" : parts[0],
    room: label.room ?? null,
    kind,
    when: label.when,
    title: label.title,
    size: 0,
    mtime: 0,
  };
}

/** The passage, flattened to one paragraph for a list row.
 *
 *  A chunk carries its markdown — headings, bullets, blank lines — and a row in
 *  this column has room for two lines of it. Trimmed rather than truncated
 *  mid-word. */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/^#+\s*/gm, "").split(/\s+/).filter(Boolean).join(" ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

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
   *  every workspace switch and the panel's head is what changes under it.
   *
   *  It scopes the search too: a workspace sees its own notes plus the global
   *  diaries, which is what makes a lesson from another project reachable here. */
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
  /** Put the caret in the search field. Where the palette's "Search your notes…"
   *  lands, which is the whole of what the dialog it replaces was. */
  focusSearch: () => void;
}

/** Which groups a person has folded away. Kept for the life of the window rather
 *  than persisted: it is a glance-scoped preference, and a page that remembered
 *  a collapse from last week would hide notes somebody has forgotten they hid. */
type Fold = Record<keyof Grouped, boolean>;

export function mountMemory(opts: MemoryPageOptions): MemoryView {
  const mount = el("div", "mem");
  /* The field switches the list between two sources rather than opening
     anything. `role="searchbox"` is not claimed: this is a plain text input that
     filters what is below it, and the list it filters is not a listbox either —
     every row is a button a person presses. */
  const field = el("input", "mem-search");
  field.type = "search";
  field.placeholder = "Search your notes…";
  field.setAttribute("aria-label", "Search your notes");
  field.dataset.fk = "memory-search";
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
  mount.append(field, head, readiness, list);

  const folded: Fold = { mine: false, lessons: false, others: true };
  let notes: MemoryNoteEntry[] = [];
  let selected: string | null = null;
  /** The results, or `null` while the field is empty and the list is the corpus.
   *  Null rather than an empty array, because "searched and found nothing" and
   *  "not searching" are two different lists with two different sentences. */
  let hits: { note: MemoryNoteEntry; text: string }[] | null = null;
  /** The last status read, so the head can say what searching needs without
   *  asking again on every keystroke. */
  let status: MemoryStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Which search is the current one: a slow answer must not land on a query
   *  somebody has already replaced. */
  let seq = 0;

  const paint = () => {
    const ws = opts.workspace();
    const names = opts.names();
    /* Whichever list is showing: it is what memory HOLDS, and somebody reading a
       result still wants to know it is one of forty notes rather than one of four
       hundred. */
    head.textContent = corpusLine(notes);
    if (hits !== null) { paintHits(); return; }
    const groups = group(notes, ws?.id ?? null);
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

  /** The same list, from the other source.
   *
   *  Ungrouped on purpose: results are ordered by how well they match, and
   *  cutting them into "this project" and "the rest" would put a weaker hit above
   *  a stronger one for a reason nobody asked for. A row still says when a note
   *  is a lesson from every project, which is the one thing the grouping said
   *  that a result still needs. */
  const paintHits = () => {
    const names = opts.names();
    list.replaceChildren();
    if (hits!.length === 0) {
      // Only reachable with a ready index — `searchReadiness` has already spoken
      // for every other kind of nothing — so this really does mean what it says.
      list.append(el(
        "p",
        "mem-empty",
        "Nothing matched. The notes are searched by meaning, not by word.",
      ));
      return;
    }
    const rows = el("div", "mem-rows");
    for (const hit of hits!) rows.append(row(hit.note, names, hit.text));
    list.append(rows);
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

  const row = (note: MemoryNoteEntry, names: Map<string, string>, text?: string): HTMLElement => {
    const btn = el("button", `notes-row mem-row${note.file === selected ? " selected" : ""}`);
    btn.type = "button";
    btn.dataset.fk = `memory-row-${note.file}`;
    btn.dataset.file = note.file;
    const line = el("div", "notes-row-head");
    line.append(el("span", "notes-row-title", rowTitle(note)));
    if (note.when) line.append(el("span", "notes-row-when", note.when));
    btn.append(line);
    const scope = rowScope(note, names);
    /* A lesson says its room; a note from another project says which. This
       project's own says nothing while browsing — the header above it just did —
       but a result has no header above it, so there it always says. A lesson
       from another project turning up is the feature working, not a leak. */
    if (scope && (text !== undefined || note.scope !== opts.workspace()?.id)) {
      btn.append(el("div", "notes-row-scope", note.kind === "diary" && text !== undefined
        ? `${scope} — a lesson, any project`
        : scope));
    }
    /* The passage, on a result only. It is the one thing on a row that says WHY
       this note came back, and without it a result is a filename with extra
       steps. Two lines, clamped by the stylesheet: this column is 280–384px. */
    if (text !== undefined) btn.append(el("div", "notes-row-text", excerpt(text)));
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
    try {
      status = await memoryStatus();
    } catch {
      status = null;
      readiness.textContent = "Searching your notes is not available on this build.";
      readiness.hidden = notes.length === 0;
      field.disabled = true;
      return;
    }
    const r = searchReadiness(status);
    readiness.textContent = r.ready ? "" : (r.reason ?? "");
    // On an empty corpus the empty state already says what fills it, and "there
    // are no notes to search yet" underneath it is the same sentence twice.
    readiness.hidden = r.ready || notes.length === 0;
    /* Left typable while it is merely not ready: the state can change under an
       open page — an index finishes, a download completes — and a field disabled
       on the way in would not notice. Disabled only where there is no search at
       all, which is a build with no sidecar staged. */
    field.disabled = false;
  };

  /** Run the query, or go back to browsing when there is none.
   *
   *  The readiness check is what keeps an empty result honest: without it, "no
   *  results" is returned for a missing model, an index that has not been built,
   *  and notes too short to index — three states with three different next steps,
   *  and only one of them is about the notes. */
  const search = async () => {
    const query = field.value.trim();
    if (!query) {
      hits = null;
      paint();
      await sayReadiness();
      return;
    }
    await sayReadiness();
    if (status === null || !searchReadiness(status).ready) {
      // The list stays on the corpus rather than emptying: browsing works, the
      // sentence above says what searching would need, and blanking what does
      // work would say the opposite.
      hits = null;
      paint();
      readiness.hidden = false;
      return;
    }
    const mine = ++seq;
    let found: MemoryHit[];
    try {
      found = await memorySearch(query, opts.workspace()?.id ?? undefined, 12);
    } catch (e) {
      if (mine !== seq) return;
      readiness.textContent = String(e);
      readiness.hidden = false;
      return;
    }
    if (mine !== seq) return;
    hits = found.map((h) => ({ note: hitAsNote(h), text: h.text }));
    paint();
  };

  field.oninput = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void search(), DEBOUNCE_MS);
  };
  /* Escape clears the field and gives the corpus back — the one gesture the
     dialog had that a page still owes, since there is no longer anything to
     close. It stops there rather than bubbling to the window's own Escape, which
     would put the deck back from under a note somebody is reading. */
  field.onkeydown = (e) => {
    if (e.key !== "Escape" || field.value === "") return;
    e.preventDefault();
    e.stopPropagation();
    field.value = "";
    if (timer) clearTimeout(timer);
    void search();
  };

  const refresh = async () => {
    try {
      notes = await memoryNotes();
    } catch (e) {
      notes = [];
      hits = null;
      paint();
      head.textContent = `The corpus could not be read (${e}).`;
      readiness.hidden = true;
      return;
    }
    paint();
    await sayReadiness();
  };

  return {
    mount,
    refresh,
    focusSearch: () => { field.focus(); field.select(); },
  };
}
