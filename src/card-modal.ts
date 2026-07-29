// The opened card: everything a task holds, editable, saving only what the
// person actually touched. Between opening the modal and pressing Save an
// agent may have moved the card's step, or a sync may have brought another
// machine's version — a patch carrying every field would silently undo that.

import { openDialog } from "./dialog-shell";
import { isKnownKind, isKnownStep } from "./board-config";
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
  if (lf(edited.body) !== lf(original.body)) patch.body = edited.body;
  return patch;
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

/** `id: value` spans, never `innerHTML` — a title or a path is user content,
 *  not markup (see board.ts:41). */
function fact(label: string, value: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = `${label}: ${value}`;
  return span;
}

/** The reason(s) a card cannot be trusted or written, plus the path — the one
 *  thing a person needs to go fix it by hand. */
function brokenMessage(task: Task, canWrite: boolean): string {
  const reasons: string[] = [];
  if (task.damaged) reasons.push(`damaged: ${task.damaged}`);
  if (task.conflict) reasons.push(`more than one file carries id ${task.id} — fix it by hand`);
  reasons.push(task.path);
  if (!canWrite) reasons.push("Repair the file by hand — this card cannot be saved from here.");
  return reasons.join(" — ");
}

/** Open a card: read everything it holds, edit it, and resolve with the
 *  edited values on Save or `null` on Cancel/Escape. `canWrite` false — a
 *  damaged or conflicting card — disables every field and drops Save
 *  entirely, rather than offering an edit that cannot be written back. */
export function openCardModal(task: Task, cfg: BoardConfig, canWrite: boolean): Promise<CardFormValues | null> {
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
    box.classList.add("modal-box--form");

    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.id = titleId;
    heading.textContent = "Card";

    const titleInput = document.createElement("input");
    titleInput.className = "modal-input tk-c-title";
    titleInput.type = "text";
    titleInput.value = task.title;

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
    selectsRow.append(labeled("Kind", selectWrap(kindSelect)), labeled("Step", selectWrap(stepSelect)));

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "modal-input tk-c-body";
    bodyInput.value = task.body;

    const facts = document.createElement("div");
    facts.className = "tk-c-facts";
    facts.append(
      fact("id", task.id),
      fact("created", task.created),
      fact("resolved", task.resolved ?? "—"),
      fact("origin", task.origin),
      fact("session", task.session ?? "—"),
      fact("path", task.path),
    );

    const children: HTMLElement[] = [
      heading, labeled("Title", titleInput), selectsRow, labeled("Body", bodyInput), facts,
    ];

    if (task.damaged || task.conflict) {
      const broken = document.createElement("p");
      broken.className = "tk-c-broken";
      broken.textContent = brokenMessage(task, canWrite);
      children.push(broken);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "modal-actions";
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
    const submit = () => {
      close({
        title: titleInput.value,
        kind: kindSelect.value,
        status: stepSelect.value,
        body: bodyInput.value,
      });
    };
    cancelBtn.onclick = () => close(null);
    if (okBtn) okBtn.onclick = submit;
    // A disabled `titleInput.focus()` is a no-op, and `FOCUSABLE` excludes
    // disabled controls, so nothing would take focus at all — leaving it on
    // the card's own title button *behind* the overlay, where Space (unlike
    // Enter) is not intercepted by the shell and reopens a second modal.
    (canWrite ? titleInput : cancelBtn).focus();
  });
}
