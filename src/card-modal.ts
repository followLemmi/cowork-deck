// The opened card: everything a task holds, editable, saving only what the
// person actually touched. Between opening the modal and pressing Save an
// agent may have moved the card's step, or a sync may have brought another
// machine's version — a patch carrying every field would silently undo that.

import { openDialog } from "./dialog-shell";
import { isKnownStep } from "./board-config";
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
  // Compared as written: an emptied body is a change, and `!edited.body` would
  // read it as untouched.
  if (edited.body !== original.body) patch.body = edited.body;
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

/** One <option> per configured entry, plus — when the card's own value is not
 *  among them — a leading option for that value, selected. A card can name a
 *  step or kind board.json does not know, and the only acceptable way out is
 *  to keep it: silently switching to a different one on save would be worse
 *  than showing it. */
function buildSelect(
  className: string, options: { id: string; label: string }[], current: string, known: boolean,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = className;
  if (!known) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `${current} (not in board.json)`;
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
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => { if (canWrite) submit(); },
    });
    box.classList.add("modal-box--form");

    const titleInput = document.createElement("input");
    titleInput.className = "modal-input tk-c-title";
    titleInput.type = "text";
    titleInput.value = task.title;

    const kindSelect = buildSelect(
      "tk-c-kind", cfg.kinds, task.kind, cfg.kinds.some((k) => k.id === task.kind),
    );
    const stepSelect = buildSelect(
      "tk-c-step", cfg.steps, task.status, isKnownStep(cfg, task.status),
    );
    const selectsRow = document.createElement("div");
    selectsRow.className = "tk-c-selects";
    selectsRow.append(selectWrap(kindSelect), selectWrap(stepSelect));

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

    const children: HTMLElement[] = [titleInput, selectsRow, bodyInput, facts];

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
    titleInput.focus();
  });
}
