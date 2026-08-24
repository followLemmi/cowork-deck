// The opened card: everything a task holds, editable, saving only what the
// person actually touched. Between opening the modal and pressing Save an
// agent may have moved the card's step, or a sync may have brought another
// machine's version — a patch carrying every field would silently undo that.

import { openDialog } from "./dialog-shell";
import { wireExternal } from "./external";
import { isKnownKind, isKnownStep } from "./board-config";
import { renderMarkdown } from "./markdown";
import { ago } from "./pr";
import type { BoardConfig, KindId, StepId, Task, TaskPatch } from "./ipc";

export interface CardFormValues { title: string; kind: KindId; status: StepId; body: string }

/** Only what changed. The card's file may have moved on under the modal — an
 *  agent running `cowork_task status`, a sync from another machine — and a patch
 *  carrying every field would quietly undo it. */
export function computePatch(original: Task, edited: CardFormValues): TaskPatch {
  const patch: TaskPatch = {};
  const title = edited.title.trim();
  if (title !== original.title.trim()) patch.title = title;
  if (edited.kind !== original.kind) patch.kind = edited.kind;
  if (edited.status !== original.status) patch.status = edited.status;
  // Compared with separators normalised, because a `<textarea>`'s `value` gives
  // newlines back as LF whatever the file used. A CRLF card would otherwise
  // report its body changed the moment it was opened — so renaming such a card
  // would also ship `body`, overwriting whatever an agent or a sync wrote to it
  // meanwhile, and leave the file with a CRLF frontmatter block and an LF body.
  // The Rust side preserves CRLF deliberately; do not defeat it from here.
  // Still compared as *written* rather than emptiness-checked: an emptied body
  // is a change, and `!edited.body` would read it as untouched.
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  if (lf(edited.body) !== lf(original.body)) {
    // Send it back in the separator the file already used. The textarea can only
    // ever hand back LF, so writing that verbatim would leave a CRLF card with a
    // CRLF frontmatter block and an LF body — this is the first path in the app
    // that rewrites a body at all, and it should not be the one that quietly
    // changes a person's line endings.
    patch.body = original.body.includes("\r\n")
      ? lf(edited.body).replace(/\n/g, "\r\n")
      : edited.body;
  }
  return patch;
}

/** One row of the facts block. `mono` marks the values that are identifiers rather
 *  than prose — an id, a session name, a path — because those are read character by
 *  character and a proportional face makes that harder than it needs to be. */
export interface CardFact {
  label: string; value: string; title?: string; mono?: boolean;
  /** Renders the value as a link. Only the issue URL has one: it is the single fact in
   *  this list that is also a destination. */
  href?: string;
  /** Renders as chips instead of text. Labels are a set, not a sentence. */
  chips?: string[];
}

/** The heading already shows `#150` for anything whose id is all digits — the same test
 *  `openCardModal` uses for the title. Exported so the two cannot drift: the facts list
 *  drops the `id` row exactly when the heading is already saying it. */
export function idIsInHeading(task: Task): boolean {
  return /^\d+$/.test(task.id);
}

/** `owner/repo#150` from an issue URL — the form a person says out loud. `null` for
 *  anything that is not one, which is every file card: its `path` is a path. */
export function issueRef(path: string): string | null {
  const m = /^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(path);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

/** The card's facts, in the order they are worth reading, with nothing in them that
 *  says nothing.
 *
 *  This replaces six `label: value` lines of identical weight, one of which was a raw
 *  ISO timestamp and one a full path. Three changes, and each is a claim:
 *
 *  - **Dates are relative.** `2026-07-01T10:00:00Z` is not a fact a person reads; "3 d
 *    ago" is. The exact value survives as the row's `title`, so nothing is lost.
 *  - **Absent values get no row.** `resolved: —` and `session: —` were two of the six
 *    lines, and a row is a claim — the honest rendering of "there is no session" is no
 *    session row, not a row with a dash in it.
 *  - **`origin` appears only when it is not the ordinary case.** A person filing a card
 *    is the default; a session filing one is worth saying. */
export function cardFacts(task: Task, now: number): CardFact[] {
  const out: CardFact[] = [];
  // No `id` row when the heading is already `#150`. A row is a claim, and that one
  // claimed the dialog's own title a second time. A file card's id is a ULID nobody says
  // out loud, so there the row stays and earns its place.
  if (!idIsInHeading(task)) out.push({ label: "id", value: task.id, mono: true });
  // "opened" is the word GitHub uses and the word a person triaging says; "created" is
  // right for a file that was written.
  const ref = issueRef(task.path);
  out.push({
    label: ref ? "opened" : "created", value: ago(task.created, now), title: task.created,
  });
  if (task.resolved) {
    out.push({ label: "closed", value: ago(task.resolved, now), title: task.resolved });
  }
  if (task.session) out.push({ label: "session", value: task.session, mono: true });
  if (task.origin !== "human") out.push({ label: "filed by", value: task.origin });
  // Labels were nowhere in this dialog, though they are the main way anyone finds
  // everything about payments — and the row that carries them is behind it.
  if (task.labels.length > 0) out.push({ label: "labels", value: "", chips: task.labels });
  // An issue's `path` is a URL, so "path" was the wrong word for it and the value was
  // unreadable besides: it wrapped mid-host across two lines. The short ref is a fact a
  // person can read and a destination they can reach; the whole URL stays on the row.
  if (ref) out.push({ label: "on GitHub", value: ref, href: task.path, title: task.path });
  else out.push({ label: "path", value: task.path, mono: true });
  return out;
}

/** What Save will write, in words.
 *
 *  `computePatch` sends only the fields a person actually touched, so that an agent
 *  moving the card's step — or a sync from another machine — is not silently undone by
 *  a save. That is the best behaviour in this dialog and it was completely invisible:
 *  the button said "Save" and a person had no way to know it would not overwrite the
 *  step they never looked at. Now the dialog says so, and says it about the edit in
 *  front of them rather than in the abstract. */
export function describePatch(patch: TaskPatch): string {
  const NAMES: Record<string, string> = {
    title: "the title", kind: "the kind", status: "the step", body: "the body",
    reason: "the reason",
  };
  const parts = (Object.keys(NAMES) as (keyof typeof NAMES)[])
    .filter((k) => k in patch)
    .map((k) => NAMES[k]);
  if (parts.length === 0) return "Nothing changed yet.";
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Save writes ${list} — nothing else.`;
}

/** Wraps a <select> so the chevron can be drawn in CSS, matching every other
 *  select in the app (see forms.ts's own copy of this — not exported there,
 *  so duplicated here rather than reached across files for one function). */
function selectWrap(select: HTMLSelectElement): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "select-wrap";
  wrap.append(select);
  return wrap;
}

/** A labelled row, matching `forms.ts`'s own `labeled()` (not exported there
 *  either — see the note on `selectWrap` above). Without it the dialog opens
 *  as a bare input, two bare selects and a bare textarea: a screen reader
 *  announces "edit text, blank" and "combo box" twice with no indication of
 *  what any of them is. */
function labeled(labelText: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.append(span, field);
  return wrap;
}

/** One <option> per configured entry, plus — when the card's own value is not
 *  among them — a leading option for that value, selected. A card can name a
 *  step or kind board.json does not know, and the only acceptable way out is
 *  to keep it: silently switching to a different one on save would be worse
 *  than showing it. `unknownLabel` lets a caller say something other than
 *  "<id> (not in board.json)" — needed because an *absent* kind (`""`) is a
 *  legal state, not an unknown one, and that message would say something
 *  untrue about it. */
function buildSelect(
  className: string, options: { id: string; label: string }[], current: string, known: boolean,
  unknownLabel: (id: string) => string = (id) => `${id} (not in board.json)`,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = className;
  if (!known) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = unknownLabel(current);
    select.append(opt);
  }
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.label;
    select.append(opt);
  }
  select.value = current;
  return select;
}

/** A definition list, never `innerHTML` — a title or a path is user content, not
 *  markup (see board.ts:41). A `<dl>` rather than six spans because that is what this
 *  is: label/value pairs, and a reader announces them as pairs instead of as one run
 *  of text. The two columns are what make the values scannable. */
function factsList(facts: CardFact[]): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "tk-c-facts";
  for (const f of facts) {
    const dt = document.createElement("dt");
    dt.textContent = f.label;
    const dd = document.createElement("dd");
    if (f.chips) {
      // A set, not a sentence: chips, and uncoloured, because hue in this palette belongs
      // to session state and fifteen repository labels would collide with it.
      const wrap = document.createElement("span");
      wrap.className = "tk-c-labels";
      for (const name of f.chips) {
        const chip = document.createElement("span");
        chip.className = "tk-label";
        chip.textContent = name;
        wrap.append(chip);
      }
      dd.append(wrap);
    } else if (f.href) {
      const a = document.createElement("a");
      a.textContent = f.value;
      // Opened through the plugin rather than navigated to — see `external.ts`.
      // A refusal leaves the value on the row as text: an issue URL that is not
      // `http(s)` is still the fact this row states, and a link that goes
      // nowhere would be the worse of the two.
      if (wireExternal(a, f.href)) dd.append(a);
      else dd.textContent = f.value;
    } else {
      dd.textContent = f.value;
    }
    if (f.mono) dd.classList.add("tk-c-mono");
    // The exact value for anything shown in a friendlier form. On the `<dd>` rather
    // than the row so the tooltip appears over the value it belongs to.
    if (f.title) dd.title = f.title;
    dl.append(dt, dd);
  }
  return dl;
}

/** Why a card cannot be trusted or written.
 *
 *  Returned as separate reasons rather than one string joined with " — ": that join
 *  produced a single run-on line carrying a parse error, a path and an instruction, and
 *  the path — the one thing a person needs in order to go and fix it — was in the
 *  middle of it. The path is no longer repeated here at all; it is a row in the facts
 *  list, where every other identifier lives. */
export function brokenReasons(task: Task, canWrite: boolean): string[] {
  const reasons: string[] = [];
  if (task.damaged) reasons.push(`Damaged: ${task.damaged}`);
  if (task.conflict) {
    reasons.push(`More than one file carries id ${task.id}. Only one can win a write, so this has to be resolved by hand.`);
  }
  if (!canWrite) reasons.push("Repair the file by hand — this card cannot be saved from here.");
  return reasons;
}

/** Open a card: read everything it holds, edit it, and resolve with the
 *  edited values on Save or `null` on Cancel/Escape. `canWrite` false — a
 *  damaged or conflicting card — disables every field and drops Save
 *  entirely, rather than offering an edit that cannot be written back. */
export function openCardModal(
  task: Task, cfg: BoardConfig, canWrite: boolean,
  /** Whether the board has kinds worth choosing between. False for a synthesized
   *  board — one synthetic kind is not a choice, and an issue's kind is always
   *  empty — and it is the same `boardEditable` flag the ⚙ button reads, so the
   *  two cannot disagree about it. Default true: every existing caller is a
   *  file-backed board. */
  showKind = true,
): Promise<CardFormValues | null> {
  return new Promise((resolve) => {
    // Named for a screen reader the way every other dialog in the app is —
    // `forms.ts`'s `taskForm`/`workspaceForm`/`skillForm` all build a
    // `div.modal-title`, and this one is not the exception. Keyed to the
    // card's id so two card modals opened in immediate succession (open,
    // cancel, open another) never collide on the same id.
    const titleId = `card-modal-title-${task.id}`;
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => { if (canWrite) submit(); },
      labelledBy: titleId,
    });
    // Its own width class as well as the shared form one, and it must come after
    // `--form` in the stylesheet: both are single-class selectors, so source order is
    // what decides which width wins.
    box.classList.add("modal-box--form", "modal-box--card");

    const head = document.createElement("div");
    head.className = "tk-c-head";
    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.id = titleId;
    // "Card" told a person what they were already looking at. For an issue the number
    // IS its name — `gh_issues.rs` puts it in `id` — and for a file card the id is a
    // ULID, which names nothing a human uses, so that one is called what the board and
    // the CLI both call it.
    heading.textContent = idIsInHeading(task) ? `#${task.id}` : "Task";
    head.append(heading);

    // A textarea, not an input, and only in order to WRAP. An issue title runs to eighty
    // characters as a matter of course; an input answers that by scrolling the beginning
    // out of sight, and this dialog focuses the field on open, so the caret lands at the
    // end and takes the first third of the sentence with it.
    // Enter still saves (`data-single-line`, read by dialog-shell) and a pasted newline
    // is folded to a space, which is what the input did silently.
    const titleInput = document.createElement("textarea");
    titleInput.className = "modal-input tk-c-title";
    titleInput.rows = 1;
    titleInput.dataset.singleLine = "true";
    titleInput.value = task.title;
    // `field-sizing: content` would do this in CSS but not in the webview this ships in.
    const grow = () => {
      titleInput.style.height = "auto";
      titleInput.style.height = `${titleInput.scrollHeight}px`;
    };
    titleInput.addEventListener("input", () => {
      if (titleInput.value.includes("\n")) {
        titleInput.value = titleInput.value.replace(/\r?\n/g, " ");
      }
      grow();
    });

    const kindSelect = buildSelect(
      "tk-c-kind", cfg.kinds, task.kind, isKnownKind(cfg, task.kind),
      // An absent kind is legal, not unknown — see buildSelect's own comment.
      (id) => (id ? `${id} (not in board.json)` : "(no kind)"),
    );
    const stepSelect = buildSelect(
      "tk-c-step", cfg.steps, task.status, isKnownStep(cfg, task.status),
    );
    const selectsRow = document.createElement("div");
    selectsRow.className = "tk-c-selects";
    // The select itself is still built and still holds the card's own kind, so a
    // save from a board without a kind row sends no `kind` at all rather than
    // blanking it — `computePatch` compares against the original and this is
    // equal to it by construction. Only the control is withheld.
    if (showKind) selectsRow.append(labeled("Kind", selectWrap(kindSelect)));
    selectsRow.append(labeled("Step", selectWrap(stepSelect)));

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "modal-input tk-c-body";
    bodyInput.value = task.body;
    // The body of a card is Markdown — the pull request screen renders it as such — so
    // the field says so and counts its lines. A `<textarea>` in the UI face was the
    // only place in the app where authored Markdown was set in a proportional font.
    // Built by hand rather than through `labeled()`, which wraps its field in a `<label>`
    // and relies on implicit association. That is right for a lone field and wrong here:
    // a `<label>` containing a rendered body and a button means every click inside the
    // rendered text, and the click on the button itself, also activates the labelled
    // control. So the label is explicit — `for` against an id — and the row is a div.
    bodyInput.id = "tk-c-body-field";
    const bodyRow = document.createElement("div");
    bodyRow.className = "form-row";
    const bodyLabel = document.createElement("div");
    bodyLabel.className = "form-label tk-c-label-row";
    const bodyLabelText = document.createElement("label");
    bodyLabelText.htmlFor = bodyInput.id;
    bodyLabelText.textContent = "Body";
    bodyLabel.append(bodyLabelText);
    bodyRow.append(bodyLabel);
    const bodyHint = document.createElement("span");
    bodyHint.className = "tk-c-hint";
    const countLines = () => {
      const n = bodyInput.value === "" ? 0 : bodyInput.value.split(/\r?\n/).length;
      bodyHint.textContent = `Markdown · ${n} line${n === 1 ? "" : "s"}`;
    };
    countLines();

    // Reading is the resting state. A body is read every time a card is triaged and
    // written once, and until now the only rendering of it was the editor: `##`,
    // backticks and `>` as literal characters, monospaced, in a box a fraction of the
    // body's length. `renderMarkdown` is the same one the pull request screen uses.
    const bodyRead = document.createElement("div");
    bodyRead.className = "tk-c-read md";
    bodyRead.tabIndex = 0;
    const paintRead = () => {
      bodyRead.replaceChildren(renderMarkdown(bodyInput.value));
    };
    paintRead();
    bodyInput.hidden = true;

    const bodyMode = document.createElement("button");
    bodyMode.type = "button";
    bodyMode.className = "tk-c-mode";
    bodyMode.textContent = "Edit";
    bodyMode.setAttribute("aria-pressed", "false");
    bodyMode.onclick = () => {
      const editing = bodyMode.getAttribute("aria-pressed") === "true";
      if (editing) paintRead();
      bodyRead.hidden = !editing;
      bodyInput.hidden = editing;
      bodyMode.setAttribute("aria-pressed", String(!editing));
      bodyMode.textContent = editing ? "Edit" : "Done";
      // Focus follows the mode: the keyboard is never left on a hidden box.
      (editing ? bodyRead : bodyInput).focus();
    };
    // A card nobody can write is a card nobody can edit, so the toggle goes with the
    // field it toggles — the reading side stays, which is the half that still works.
    if (!canWrite) bodyMode.hidden = true;

    bodyLabel.append(bodyHint, bodyMode);
    bodyRow.append(bodyRead, bodyInput);

    // Two columns, and the reason is not "there was room". A dialog wide enough to stop
    // the body scrolling is also wide enough to give it a 100-character measure, which
    // is worse to read than the narrow box it replaced. So the width goes to a rail of
    // reference material — the selects and the facts — and the body keeps a measure a
    // person can read while gaining all the height the dialog has.
    const main = document.createElement("div");
    main.className = "tk-c-main";
    main.append(labeled("Title", titleInput), bodyRow);

    const side = document.createElement("div");
    side.className = "tk-c-side";
    side.append(selectsRow, factsList(cardFacts(task, Date.now())));

    const cols = document.createElement("div");
    cols.className = "tk-c-cols";
    cols.append(main, side);

    const children: HTMLElement[] = [head];

    if (task.damaged || task.conflict) {
      // A banner, not a run-on paragraph. Each reason is its own line, and the path it
      // used to carry is now a row in the facts list with every other identifier.
      const broken = document.createElement("div");
      broken.className = "tk-c-broken";
      for (const r of brokenReasons(task, canWrite)) {
        const line = document.createElement("p");
        line.textContent = r;
        broken.append(line);
      }
      // Before the columns: a card that cannot be written is the first thing to say,
      // not a footnote under the fields it has just disabled.
      children.push(broken);
    }
    children.push(cols);

    const actionsRow = document.createElement("div");
    actionsRow.className = "modal-actions";
    // What Save will actually write, beside the button that does it. See
    // `describePatch`: only touched fields are sent, and until now nothing said so.
    const patchNote = document.createElement("p");
    patchNote.className = "tk-c-patch";
    // Polite rather than assertive: it changes on every keystroke, and an assertive
    // region would interrupt a screen reader mid-word for the whole time somebody is
    // typing a title.
    patchNote.setAttribute("aria-live", "polite");
    if (canWrite) actionsRow.append(patchNote);
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-cancel";
    cancelBtn.textContent = "Cancel";
    actionsRow.append(cancelBtn);
    let okBtn: HTMLButtonElement | null = null;
    if (canWrite) {
      okBtn = document.createElement("button");
      okBtn.className = "modal-ok";
      okBtn.textContent = "Save";
      actionsRow.append(okBtn);
    }
    children.push(actionsRow);

    if (!canWrite) {
      titleInput.disabled = true;
      kindSelect.disabled = true;
      stepSelect.disabled = true;
      bodyInput.disabled = true;
    }

    box.append(...children);

    const close = (v: CardFormValues | null) => { closeDialog(); resolve(v); };
    const values = (): CardFormValues => ({
      title: titleInput.value,
      kind: kindSelect.value,
      status: stepSelect.value,
      body: bodyInput.value,
    });
    const submit = () => { close(values()); };

    // The note is derived from the same function the save itself uses, so the two can
    // never disagree about what is about to be written.
    const refresh = () => {
      patchNote.textContent = describePatch(computePatch(task, values()));
      countLines();
    };
    refresh();
    for (const el of [titleInput, bodyInput]) el.addEventListener("input", refresh);
    for (const el of [kindSelect, stepSelect]) el.addEventListener("change", refresh);
    cancelBtn.onclick = () => close(null);
    if (okBtn) okBtn.onclick = submit;
    // A disabled `titleInput.focus()` is a no-op, and `FOCUSABLE` excludes
    // disabled controls, so nothing would take focus at all — leaving it on
    // the card's own title button *behind* the overlay, where Space (unlike
    // Enter) is not intercepted by the shell and reopens a second modal.
    (canWrite ? titleInput : cancelBtn).focus();
    // After the box is in the document: `scrollHeight` on a detached element is zero, so
    // a title measured before this point wraps to one line and stays there.
    grow();
  });
}
