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
// # A heading per project, and it does not depend on which one is open
//
// The first shape here grouped by "this project, the lessons, everything else",
// which made the page answer a different question every time the workspace
// changed and hid every other project's notes behind one fold. Memory spans
// projects, and somebody looking at it is looking ACROSS them — so the list is a
// heading per project with its notes under it, ordered by the most recent note in
// each, and the lessons last. Only the first heading arrives open: a corpus
// across a dozen projects is a wall either way, and a wall of headings with
// counts is one a person can read.
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
import { addFactForm, addLessonForm, APPEND_ONLY_NOTICE, replaceFactForm } from "./memory-write";
import { mountCaptureRecord } from "./memory-jobs";

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

/** One heading in the list, and everything filed under it. */
export interface Group {
  /** The scope it stands for: a workspace id, or `Diaries`. Stable across
   *  repaints, which is what lets a fold survive one. */
  key: string;
  /** What the heading says. A workspace's name where the app still knows it, the
   *  scope itself where it does not. */
  title: string;
  notes: MemoryNoteEntry[];
}

/** The reserved scope of the diaries, as `memory::corpus` writes it. */
const DIARIES = "Diaries";

/** Split the corpus by what it is about: one group per project, and one for the
 *  lessons.
 *
 *  **It does not depend on which project is open.** The previous shape did — this
 *  project, then the lessons, then everything else in one heap — and it made the
 *  page answer a different question every time the workspace changed, while
 *  hiding every other project's notes behind a single fold called "Other
 *  projects". Memory spans projects; a person looking at it is looking across
 *  them, not out from one.
 *
 *  Ordered by the most recent note in each group, newest first, because that is
 *  the only ordering the corpus itself supports — the notes carry an mtime and
 *  the projects carry nothing. The lessons sit last whatever their age: they are
 *  not a project, and a heading that moved between the projects and the end
 *  depending on when somebody last filed a lesson would be a list that reshuffles
 *  for no reason a person can see. */
export function group(notes: MemoryNoteEntry[], names: Map<string, string>): Group[] {
  const byScope = new Map<string, MemoryNoteEntry[]>();
  const lessons: MemoryNoteEntry[] = [];
  for (const note of notes) {
    if (note.kind === "diary") { lessons.push(note); continue; }
    const at = byScope.get(note.scope);
    if (at) at.push(note);
    else byScope.set(note.scope, [note]);
  }
  const groups: Group[] = [...byScope.entries()].map(([key, rows]) => ({
    key,
    // A scope whose workspace has been deleted is shown as itself: the notes
    // outlive the project, and hiding them under an id nobody recognises beats
    // dropping them.
    title: names.get(key) ?? key,
    notes: rows,
  }));
  groups.sort((a, b) => {
    const recent = (g: Group) => Math.max(...g.notes.map((n) => n.mtime));
    return recent(b) - recent(a) || a.title.localeCompare(b.title);
  });
  if (lessons.length) {
    groups.push({ key: DIARIES, title: "Lessons, from every project", notes: lessons });
  }
  return groups;
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
  /** Write a note by hand. On the document surface rather than in a form here: a
   *  note is the shape with a body, and this column is 280–384px. */
  onCompose?: () => void;
}

export interface MemoryView {
  /** The element to put in the panel's page. */
  readonly mount: HTMLElement;
  /** Re-read the corpus and repaint. The capture record with it: one read per
   *  `memory://changed`, rather than a subscription per section. */
  refresh: () => Promise<void>;
  /** Unfold the capture record. Where the palette's "Memory: what has been
   *  captured…" lands, now that there is no dialog for it to open. */
  revealCaptures: () => void;
  /** Put the caret in the search field. Where the palette's "Search your notes…"
   *  lands, which is the whole of what the dialog it replaces was. */
  focusSearch: () => void;
  /** What the page knows, for the surface beside it to say while no note is
   *  open. Read rather than pushed: the surface is shown on entering the page,
   *  which is not when the corpus was last read. */
  summary: () => { corpus: string; readiness: string | null };
}

/** Which groups a person has folded away, by scope. Kept for the life of the
 *  window rather than persisted: it is a glance-scoped preference, and a page
 *  that remembered a collapse from last week would hide notes somebody has
 *  forgotten they hid.
 *
 *  A scope absent from the map has never been touched, and takes the default
 *  below — which is why this is a `Map` of what a person DID rather than a
 *  record of every group's state. */
type Fold = Map<string, boolean>;

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
  /* Writing by hand, under the list rather than over it: what a person opens this
     page for is what is already written. Three acts, and the two shapes they write
     into are append-only line records — which is why they are forms and not an
     editor, said in the sentence beside them rather than left to be discovered as
     a missing button (#385, #386). */
  const write = el("div", "mem-write");
  const writeActs = el("div", "mem-write-acts");
  const factBtn = el("button", "rooms-add", "Record a fact");
  factBtn.type = "button";
  factBtn.dataset.fk = "memory-add-fact";
  const replaceBtn = el("button", "rooms-add", "Replace a fact");
  replaceBtn.type = "button";
  replaceBtn.dataset.fk = "memory-replace-fact";
  const lessonBtn = el("button", "rooms-add", "File a lesson");
  lessonBtn.type = "button";
  lessonBtn.dataset.fk = "memory-add-lesson";
  /* The one of the four that is not a form. A note has a body, and a body wants
     the surface a note is read on — see `NoteReader.compose`. */
  const noteBtn = el("button", "rooms-add", "Write a note");
  noteBtn.type = "button";
  noteBtn.dataset.fk = "memory-write-note";
  writeActs.append(noteBtn, factBtn, replaceBtn, lessonBtn);
  const writeNote = el("p", "mem-write-note", APPEND_ONLY_NOTICE);
  const writeScope = el("p", "mem-write-note");
  writeScope.dataset.fk = "memory-write-scope";
  write.append(writeActs, writeNote, writeScope);
  /* The record of what the corpus cost, last and folded: what somebody opens this
     page for is their notes, and a list of jobs above them would put the plumbing
     in front of the point (#387). */
  const jobs = mountCaptureRecord();
  mount.append(field, head, readiness, list, write, jobs.mount);

  const folded: Fold = new Map();
  let notes: MemoryNoteEntry[] = [];
  let selected: string | null = null;
  /** The results, or `null` while the field is empty and the list is the corpus.
   *  Null rather than an empty array, because "searched and found nothing" and
   *  "not searching" are two different lists with two different sentences. */
  let hits: { note: MemoryNoteEntry; text: string }[] | null = null;
  /** The last status read, and when. Reading it spawns the sidecar, so it is
   *  cached rather than asked for on the path of every query. */
  let status: MemoryStatus | null = null;
  let statusReadAt = 0;
  /** Whether a search is in flight, and the query waiting behind it. */
  let running = false;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Which search is the current one: a slow answer must not land on a query
   *  somebody has already replaced. */
  let seq = 0;

  const paint = () => {
    const names = opts.names();
    /* Whichever list is showing: it is what memory HOLDS, and somebody reading a
       result still wants to know it is one of forty notes rather than one of four
       hundred. */
    head.textContent = corpusLine(notes);
    if (hits !== null) { paintHits(); return; }
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

    /* One heading per project, newest first, and the lessons last. Only the
       first arrives open: a corpus across a dozen projects is a wall either way,
       and a wall of headings with counts is one a person can read. Which one is
       first does not depend on which project is open — see `group`. */
    const groups = group(notes, names);
    groups.forEach((g, i) => list.append(section(g, folded.get(g.key) ?? i > 0)));
  };

  /** The same list, from the other source.
   *
   *  Ungrouped on purpose: results are ordered by how well they match, and
   *  cutting them into "this project" and "the rest" would put a weaker hit above
   *  a stronger one for a reason nobody asked for. A row still says when a note
   *  is a lesson from every project, which is the one thing the grouping said
   *  that a result still needs. */
  const paintHits = () => {
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
    for (const hit of hits!) rows.append(row(hit.note, hit.text));
    list.append(rows);
  };

  const section = (g: Group, shut: boolean): HTMLElement => {
    const box = el("section", "mem-group");
    const toggle = el("button", "mem-group-head");
    toggle.type = "button";
    toggle.dataset.fk = `memory-group-${g.key}`;
    toggle.setAttribute("aria-expanded", String(!shut));
    toggle.append(
      el("span", "mem-group-title", g.title),
      // On the header, so a collapsed group still says how much is behind it.
      el("span", "mem-group-count", String(g.notes.length)),
    );
    const body = el("div", "mem-rows");
    body.hidden = shut;
    toggle.onclick = () => {
      const now = !body.hidden;
      folded.set(g.key, now);
      toggle.setAttribute("aria-expanded", String(!now));
      body.hidden = now;
    };
    for (const note of g.notes) body.append(row(note));
    box.append(toggle, body);
    return box;
  };

  const row = (note: MemoryNoteEntry, text?: string): HTMLElement => {
    const btn = el("button", `notes-row mem-row${note.file === selected ? " selected" : ""}`);
    btn.type = "button";
    btn.dataset.fk = `memory-row-${note.file}`;
    btn.dataset.file = note.file;
    const line = el("div", "notes-row-head");
    line.append(el("span", "notes-row-title", rowTitle(note)));
    if (note.when) line.append(el("span", "notes-row-when", note.when));
    btn.append(line);
    /* Nothing about where it came from while browsing: every row sits under a
       heading that just said it, and repeating the project on each of forty rows
       is forty repetitions of the one fact the heading exists for. A RESULT has no
       heading above it, so there it says — and a lesson from another project
       turning up is the feature working, not a leak. */
    if (text !== undefined) {
      const scope = rowScope(note, opts.names());
      if (scope) {
        btn.append(el("div", "notes-row-scope", note.kind === "diary"
          ? `${scope} — a lesson, any project`
          : scope));
      }
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
      statusReadAt = Date.now();
    } catch {
      status = null;
      statusReadAt = Date.now();
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

  /** Whether the cached status is still worth trusting.
   *
   *  Every read of it spawns the sidecar, so asking before each search put a
   *  process on the path of every query — on top of the search's own, which loads
   *  the embedding model. What the status answers changes on the scale of a
   *  download finishing or an index run completing, not on the scale of typing.
   *  A minute is far shorter than either and far longer than a sentence. */
  const STATUS_TTL_MS = 60_000;

  const readinessNow = async (): Promise<MemoryStatus | null> => {
    if (status !== null && Date.now() - statusReadAt < STATUS_TTL_MS) return status;
    await sayReadiness();
    return status;
  };

  /** Run the query, or go back to browsing when there is none.
   *
   *  The readiness check is what keeps an empty result honest: without it, "no
   *  results" is returned for a missing model, an index that has not been built,
   *  and notes too short to index — three states with three different next steps,
   *  and only one of them is about the notes.
   *
   *  **One search at a time, and the newest wins.** A search is a process that
   *  loads a 479 MB model, so two in flight are two model loads competing for the
   *  same CPU — which is what made typing into this field stutter once a corpus
   *  was big enough to be worth searching. The debounce alone does not prevent it:
   *  it bounds how often a query is SENT, not how many are running. So a query
   *  arriving while one runs replaces the pending one and waits its turn, and only
   *  the last of a burst is ever run. */
  const search = async () => {
    let query = field.value.trim();
    if (!query) {
      // Browsing needs nothing, so clearing the field is instant and asks
      // nothing of the sidecar.
      if (hits !== null) { hits = null; paint(); }
      return;
    }
    if (running) { pending = query; return; }
    running = true;
    try {
      await runQuery(query);
      // Whatever arrived while that one ran, and only the last of it.
      while (pending !== null && pending !== query) {
        query = pending;
        pending = null;
        await runQuery(query);
      }
      pending = null;
    } finally {
      running = false;
    }
  };

  const runQuery = async (query: string) => {
    const ready = await readinessNow();
    if (ready === null || !searchReadiness(ready).ready) {
      // The list stays on the corpus rather than emptying: browsing works, the
      // sentence above says what searching would need, and blanking what does
      // work would say the opposite.
      if (hits !== null) { hits = null; paint(); }
      readiness.hidden = false;
      return;
    }
    const mine = ++seq;
    let found: MemoryHit[];
    try {
      /* Everything, rather than this project plus the lessons. The list under
         this field is the whole corpus by project (#382 as revised), and a search
         that quietly answered from a narrower corpus than the one on screen would
         be the page disagreeing with itself. */
      found = await memorySearch(query, undefined, 12);
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

  /** A fact belongs to a project; a lesson does not.
   *
   *  So a window with no active workspace can still file a lesson and has nothing
   *  to record a fact against — offered as a sentence rather than as two buttons
   *  that fail when pressed. */
  const paintWrite = () => {
    const ws = opts.workspace();
    factBtn.hidden = ws === null;
    replaceBtn.hidden = ws === null;
    // A note belongs to a project too — it is written under that project's
    // `Sessions/`, which is what gives it a scope at all.
    noteBtn.hidden = ws === null;
    writeScope.hidden = ws !== null;
    if (ws === null) {
      writeScope.textContent =
        "A note and a fact belong to a project, and this window has none active. A "
        + "lesson is global and can be filed from here.";
    }
  };

  const wrote = async (did: boolean) => {
    if (!did) return;
    /* Repaint from disk rather than from what the form thinks it wrote: the file
       is the memory (ADR-0004), and the listing is a walk over it. The reindex is
       the backend's, on the same write. */
    await refresh();
  };

  noteBtn.onclick = () => { opts.onCompose?.(); };
  factBtn.onclick = () => {
    const ws = opts.workspace();
    if (ws) void addFactForm({ workspaceId: ws.id, workspaceName: ws.name }).then(wrote);
  };
  replaceBtn.onclick = () => {
    const ws = opts.workspace();
    if (ws) void replaceFactForm({ workspaceId: ws.id, workspaceName: ws.name }).then(wrote);
  };
  lessonBtn.onclick = () => {
    const ws = opts.workspace();
    void addLessonForm({
      workspaceId: ws?.id ?? "",
      // The label a diary records. Without a workspace there is no name to give,
      // and a lesson filed from nowhere says so rather than inventing one.
      workspaceName: ws?.name ?? "no project",
    }).then(wrote);
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
    paintWrite();
    await sayReadiness();
    await jobs.refresh();
  };

  return {
    mount,
    refresh,
    focusSearch: () => { field.focus(); field.select(); },
    summary: () => ({
      corpus: corpusLine(notes),
      readiness: readiness.hidden ? null : (readiness.textContent || null),
    }),
    revealCaptures: jobs.reveal,
  };
}
