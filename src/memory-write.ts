// Writing into the corpus by hand: a fact, its replacement, and a lesson.
//
// Until now the corpus filled itself and a person could only read it. These are
// the two things worth writing by hand, and both already had the code to write
// them — `corpus::append_facts`, `corpus::supersede_fact` and
// `corpus::append_diary`.
//
// # `supersede_fact` finally gets a caller
//
// It shipped in #363 with a comment saying what was missing: "something that
// *knows* a fact has been superseded, which means showing the model the existing
// `Facts.md` and asking — a feature with a cost". A person knows, and asking them
// costs nothing.
//
// # Forms rather than an editor, and the reason is the file
//
// `Facts.md` and a diary are append-only line records: a fact is marked, never
// rewritten (ADR-0004), and a diary is one pipe-separated bullet per lesson.
// #386 makes NOTES editable, on the document surface, because a note is prose.
// A free-text editor over either of these would quietly undo "marked, never
// rewritten" — so the surface says that where somebody would look for the
// missing edit button.
//
// # The date and the marker are the app's
//
// A form that let somebody type `[active]` would let somebody type it wrong, and
// `grep` is what reads this file. What a person writes is the claim; the shape
// around it is written for them.

import { openDialog } from "./dialog-shell";
import {
  memoryAddFact, memoryAddLesson, memoryFacts, memoryRooms, memorySupersedeFact,
  type DiaryRoom, type MemoryFact,
} from "./ipc";

/** Why a line somebody just wrote may not come back from a search yet.
 *
 *  The measured floor: a chunk needs 120 letters to be indexed at all, and one
 *  lesson of about 80 indexes to nothing — a room becomes searchable at roughly
 *  its second (#375). Somebody who writes one fact and cannot find it has met a
 *  threshold, not a bug, and this is the surface that has to say so. */
export const SHORT_LINE_NOTICE =
  "A single short line is not searchable on its own — the index skips anything "
  + "under about 120 letters, so a file becomes findable once it holds a few. It is "
  + "on disk either way, and the page lists it immediately.";

/** Why these are forms and the note editor is not.
 *
 *  Said where somebody looks for the button that is missing. */
export const APPEND_ONLY_NOTICE =
  "Facts and lessons are appended, never rewritten: a fact that stops being true "
  + "is marked and replaced below, so the corpus can still answer when it changed "
  + "and to what. Notes are prose and can be edited.";

/** What a corpus with no rooms left has to say instead of an empty picker.
 *
 *  `rooms::Rooms::list` seeds two on a corpus that has never had any, so in
 *  practice there is always somewhere to file a lesson — but somebody who has
 *  retired both gets no re-seed, deliberately (#367). */
export const NO_ROOMS_NOTICE =
  "There are no diary rooms left to file a lesson into. Settings → Session notes "
  + "is where they are added back; a room you removed kept every lesson already in it.";

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

function labeled(text: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "form-row");
  wrap.append(el("span", "form-label", text), control);
  return wrap;
}

function actions(okText: string): { row: HTMLElement; ok: HTMLButtonElement; cancel: HTMLButtonElement } {
  const row = el("div", "modal-actions");
  const cancel = el("button", "modal-cancel", "Cancel");
  cancel.type = "button";
  const ok = el("button", "modal-ok", okText);
  ok.type = "button";
  ok.dataset.fk = "memory-write-ok";
  row.append(cancel, ok);
  return { row, ok, cancel };
}

/** Everything a form needs to know about where it is writing. */
export interface WriteTarget {
  /** The workspace a fact belongs to. A fact is one project's, so without one
   *  there is nothing to write and the caller does not offer the form. */
  workspaceId: string;
  /** Its name, for the diary's `workspace` field — a label rather than an id,
   *  because the id means nothing to somebody reading the diary in an editor. */
  workspaceName: string;
}

/** Add one fact to a workspace's `Facts.md`.
 *
 *  Resolves true when something was written, so the caller can repaint. */
export function addFactForm(target: WriteTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => done(false),
      onAccept: () => void submit(),
      labelledBy: "add-fact-title",
    });
    const title = el("div", "modal-title", "Record a fact");
    title.id = "add-fact-title";
    const input = el("input", "modal-input");
    input.type = "text";
    input.placeholder = "subject — predicate — object";
    input.dataset.fk = "fact-body";
    /* The shape, said rather than enforced. A three-part line is what makes
       `Facts.md` greppable, and a form that split it into three fields would
       insist on a grammar the file does not actually have — a fact with a longer
       predicate is still a fact. */
    const shape = el(
      "p",
      "form-hint",
      "One line, read later by eye and by grep: what it is about, what is true of "
      + "it, and what it is. The date and the [active] marker are written for you.",
    );
    const short = el("p", "form-hint", SHORT_LINE_NOTICE);
    const fault = el("p", "rooms-fault");
    fault.hidden = true;
    const { row, ok, cancel } = actions("Record it");
    box.append(title, labeled("The fact", input), shape, short, fault, row);

    const done = (wrote: boolean) => { closeDialog(); resolve(wrote); };
    const submit = async () => {
      const body = input.value.trim();
      if (!body) { input.focus(); return; }
      ok.disabled = true;
      try {
        await memoryAddFact(target.workspaceId, body);
      } catch (e) {
        ok.disabled = false;
        fault.hidden = false;
        fault.textContent = String(e);
        return;
      }
      done(true);
    };
    ok.onclick = () => void submit();
    cancel.onclick = () => done(false);
    input.focus();
  });
}

/** Replace a fact that has stopped being true.
 *
 *  The old line is picked rather than typed: it has to match what is in the file
 *  exactly, and asking somebody to retype a claim they can see is asking them to
 *  mistype it. */
export function replaceFactForm(target: WriteTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => done(false),
      onAccept: () => void submit(),
      labelledBy: "replace-fact-title",
    });
    const title = el("div", "modal-title", "Replace a fact");
    title.id = "replace-fact-title";
    const picker = el("select", "modal-input");
    picker.dataset.fk = "fact-old";
    const input = el("input", "modal-input");
    input.type = "text";
    input.placeholder = "what is true instead";
    input.dataset.fk = "fact-new";
    /* ADR-0004's rule, and not a choice — said here because "replace" reads like
       an overwrite and this is not one. */
    const rule = el(
      "p",
      "form-hint",
      "The old line is marked rather than removed, and the new one goes directly "
      + "under it. That is what lets the corpus answer when a fact changed, and to what.",
    );
    const fault = el("p", "rooms-fault");
    fault.hidden = true;
    const { row, ok, cancel } = actions("Replace it");
    box.append(title, labeled("Which fact", picker), labeled("Instead", input), rule, fault, row);

    const done = (wrote: boolean) => { closeDialog(); resolve(wrote); };
    const load = async () => {
      let facts: MemoryFact[];
      try {
        facts = await memoryFacts(target.workspaceId);
      } catch (e) {
        fault.hidden = false;
        fault.textContent = String(e);
        ok.disabled = true;
        return;
      }
      if (facts.length === 0) {
        // Nothing to replace is its own sentence rather than an empty picker
        // above a button that cannot work.
        fault.hidden = false;
        fault.textContent = "This project has no facts recorded yet, so there is none to replace.";
        picker.disabled = true;
        ok.disabled = true;
        return;
      }
      for (const fact of facts) {
        const opt = el("option", "", `${fact.date} — ${fact.body}`);
        opt.value = fact.body;
        picker.append(opt);
      }
      input.focus();
    };

    const submit = async () => {
      const old = picker.value;
      const replacement = input.value.trim();
      if (!old || !replacement) { input.focus(); return; }
      ok.disabled = true;
      let matched: boolean;
      try {
        matched = await memorySupersedeFact(target.workspaceId, old, replacement);
      } catch (e) {
        ok.disabled = false;
        fault.hidden = false;
        fault.textContent = String(e);
        return;
      }
      if (!matched) {
        /* The file moved under the form — a sync brought a version in, or the
           line was edited by hand. Writing the replacement anyway would leave two
           active claims about the same thing, so nothing is written and the form
           says so. */
        ok.disabled = false;
        fault.hidden = false;
        fault.textContent =
          "That fact is no longer in the file as it was, so nothing was changed. "
          + "Close this and try again.";
        return;
      }
      done(true);
    };
    ok.onclick = () => void submit();
    cancel.onclick = () => done(false);
    void load();
  });
}

/** The three the model is asked for, offered to a person as a choice.
 *
 *  Free text would give the diaries three spellings of "high" within a month,
 *  and severity is the field a person scans a room by. */
const SEVERITIES = ["low", "medium", "high"];

/** File a lesson into a room the **person** picks.
 *
 *  That is the whole difference from a capture, which asks the model which room a
 *  lesson belongs in because nobody is there to ask. Here somebody is. */
export function addLessonForm(target: WriteTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => done(false),
      onAccept: () => void submit(),
      labelledBy: "add-lesson-title",
    });
    const title = el("div", "modal-title", "File a lesson");
    title.id = "add-lesson-title";
    const room = el("select", "modal-input");
    room.dataset.fk = "lesson-room";
    const severity = el("select", "modal-input");
    severity.dataset.fk = "lesson-severity";
    for (const s of SEVERITIES) {
      const opt = el("option", "", s);
      opt.value = s;
      if (s === "medium") opt.selected = true;
      severity.append(opt);
    }
    const category = el("input", "modal-input");
    category.type = "text";
    category.placeholder = "two or three words";
    category.dataset.fk = "lesson-category";
    const what = el("textarea", "modal-input");
    what.rows = 2;
    what.placeholder = "what happened";
    what.dataset.fk = "lesson-what";
    const avoid = el("textarea", "modal-input");
    avoid.rows = 2;
    avoid.placeholder = "how to avoid it next time";
    avoid.dataset.fk = "lesson-avoid";
    /* The half that makes the entry worth keeping — said here because "what
       happened" is the half people fill in and stop. */
    const why = el(
      "p",
      "form-hint",
      "A lesson is global: it is filed into a room rather than into this project, "
      + "and that is what lets a mistake made here stop the same mistake in the next "
      + "repository. How to avoid it is the half worth keeping.",
    );
    const short = el("p", "form-hint", SHORT_LINE_NOTICE);
    const fault = el("p", "rooms-fault");
    fault.hidden = true;
    const { row, ok, cancel } = actions("File it");
    box.append(
      title,
      labeled("Room", room),
      labeled("Severity", severity),
      labeled("Category", category),
      labeled("What happened", what),
      labeled("How to avoid it", avoid),
      why,
      short,
      fault,
      row,
    );

    const done = (wrote: boolean) => { closeDialog(); resolve(wrote); };
    const load = async () => {
      let rooms: DiaryRoom[];
      try {
        rooms = await memoryRooms();
      } catch (e) {
        fault.hidden = false;
        fault.textContent = String(e);
        ok.disabled = true;
        return;
      }
      if (rooms.length === 0) {
        // A person who has retired every room gets no re-seed, deliberately
        // (#367) — so this says where they come back from rather than offering
        // an empty picker above a button that cannot work.
        fault.hidden = false;
        fault.textContent = NO_ROOMS_NOTICE;
        room.disabled = true;
        ok.disabled = true;
        return;
      }
      for (const r of rooms) {
        const opt = el("option", "", r.description ? `${r.name} — ${r.description}` : r.name);
        opt.value = r.name;
        room.append(opt);
      }
      what.focus();
    };

    const submit = async () => {
      const said = what.value.trim();
      if (!room.value || !said) { what.focus(); return; }
      ok.disabled = true;
      try {
        await memoryAddLesson({
          room: room.value,
          workspace: target.workspaceName,
          severity: severity.value,
          category: category.value.trim(),
          what: said,
          avoid: avoid.value.trim(),
        });
      } catch (e) {
        ok.disabled = false;
        fault.hidden = false;
        fault.textContent = String(e);
        return;
      }
      done(true);
    };
    ok.onclick = () => void submit();
    cancel.onclick = () => done(false);
    void load();
  });
}
