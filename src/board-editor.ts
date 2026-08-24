// The ⚙ editor: lets a person change a board's steps and kinds themselves,
// instead of hand-editing board.json. Renaming or removing a step can leave
// cards pointing at an id the saved configuration no longer has, so the
// editor tracks which rows need a rewrite and hands that back alongside the
// edited configuration; `applyBoardEdit` at the bottom of this file is what
// main.ts::editBoard then calls to run those rewrites before saving.

import { openDialog } from "./dialog-shell";
import type { BoardConfig, BoardKind, BoardStep, KindId, RewriteReport, StepId, StepUsage } from "./ipc";

export interface BoardEditorResult {
  config: BoardConfig;
  rewrites: { from: StepId; to: StepId }[];
}

/** One card-moving instruction: everything in step `from` becomes `to`. */
type Rewrite = { from: StepId; to: StepId };

/** Mirrors `BoardConfig::validate` (src-tauri/src/tasks/board.rs) exactly, in
 *  the same order, so the editor can refuse a draft before Save is ever
 *  pressed. The backend still validates independently — a configuration can
 *  also arrive by hand — so this is a courtesy for whoever is filling in the
 *  form, not the only guard. There is deliberately no whitespace rule for a
 *  kind id: the Rust side has none either, and inventing one here would make
 *  this a stricter mirror than the thing it mirrors. */
export function validateDraft(cfg: BoardConfig): string | null {
  if (cfg.steps.length === 0) return "board.json lists no steps";
  const seenSteps: string[] = [];
  for (const s of cfg.steps) {
    if (!s.id) return "a step has an empty id";
    if (/\s/.test(s.id)) return `step id "${s.id}" contains whitespace`;
    if (seenSteps.includes(s.id)) return `two steps share the id "${s.id}"`;
    seenSteps.push(s.id);
  }
  if (!cfg.steps.some((s) => s.terminal)) {
    return 'no step is marked terminal, so no step means "closed"';
  }
  if (cfg.steps.filter((s) => s.working).length > 1) return "more than one step is marked working";
  if (cfg.kinds.length === 0) return "board.json lists no card kinds";
  const seenKinds: string[] = [];
  for (const k of cfg.kinds) {
    if (!k.id) return "a kind has an empty id";
    if (seenKinds.includes(k.id)) return `two kinds share the id "${k.id}"`;
    seenKinds.push(k.id);
  }
  return null;
}

/** One editable step row. `originalId` is the id this row had when the editor
 *  opened — `null` for a row added with "+ step", which never had cards to
 *  begin with. `awaitingRemoval` is set the moment ✕ is pressed on a row whose
 *  original id has cards: the row survives with a destination select in place
 *  of its usual controls, and Save stays disabled until one is chosen — there
 *  is no plain remove for a step that has cards (see openBoardEditor below). */
interface StepRow {
  originalId: StepId | null;
  id: string;
  label: string;
  terminal: boolean;
  working: boolean;
  awaitingRemoval: boolean;
}

interface KindRow {
  originalId: KindId | null;
  id: string;
  label: string;
}

function stepRowsFrom(steps: BoardStep[]): StepRow[] {
  return steps.map((s) => ({
    originalId: s.id,
    id: s.id,
    label: s.label,
    terminal: s.terminal === true,
    working: s.working === true,
    awaitingRemoval: false,
  }));
}

function kindRowsFrom(kinds: BoardKind[]): KindRow[] {
  return kinds.map((k) => ({ originalId: k.id, id: k.id, label: k.label }));
}

function labeled(labelText: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "form-row tk-e-field";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.append(span, field);
  return wrap;
}

/** Open the editor: read the current configuration, edit it, and resolve with
 *  the edited configuration plus the rewrites it implies on Save, or `null` on
 *  Cancel/Escape. `usage` is this project's card count per step (task 9a's
 *  `board_step_usage`), in the configuration's own order — it is what lets a
 *  rename or removal say how many cards are affected before asking, rather
 *  than after. */
export function openBoardEditor(cfg: BoardConfig, usage: StepUsage[]): Promise<BoardEditorResult | null> {
  return new Promise((resolve) => {
    const usageByStep = new Map(usage.map((u) => [u.step, u.count]));
    const cardCount = (id: StepId | null): number => (id !== null ? usageByStep.get(id) ?? 0 : 0);

    let steps: StepRow[] = stepRowsFrom(cfg.steps);
    let kinds: KindRow[] = kindRowsFrom(cfg.kinds);
    // Removals that already picked a destination — the row itself is gone
    // from `steps` by the time one lands here (see the remove button below).
    const pendingRemovals: Rewrite[] = [];

    // The elements each row is currently rendered as. Typing into an id must
    // not rebuild the row that owns the caret, so the handlers that used to
    // call renderAll() reach the few things an edit can change *elsewhere*
    // through these instead. Both maps are rebuilt by their render function.
    interface StepRowEls {
      el: HTMLElement;
      workingCheck: HTMLInputElement;
      upBtn: HTMLButtonElement;
      downBtn: HTMLButtonElement;
      dest: HTMLSelectElement | null;
    }
    const stepEls = new Map<StepRow, StepRowEls>();
    interface ArrowEls { upBtn: HTMLButtonElement; downBtn: HTMLButtonElement }
    const kindEls = new Map<KindRow, ArrowEls & { el: HTMLElement }>();

    // A one-shot complaint about an action the editor has just refused, as
    // opposed to a standing condition like an invalid draft: shown by the next
    // sync() and then cleared, so it does not outstay the action it explains.
    let refusal: string | null = null;

    const titleId = "board-editor-title";
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => { if (!saveDisabled()) submit(); },
      labelledBy: titleId,
    });
    box.classList.add("modal-box--form", "modal-box--wide");

    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.id = titleId;
    heading.textContent = "Configure the board";

    const stepsSection = document.createElement("div");
    stepsSection.className = "tk-e-section";
    const kindsSection = document.createElement("div");
    kindsSection.className = "tk-e-section";
    const errorEl = document.createElement("div");
    errorEl.className = "form-error";

    const actionsRow = document.createElement("div");
    actionsRow.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-cancel";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "modal-ok";
    okBtn.textContent = "Save";
    actionsRow.append(cancelBtn, okBtn);

    function currentConfig(): BoardConfig {
      return {
        v: cfg.v,
        steps: steps.filter((s) => !s.awaitingRemoval).map((s) => ({
          id: s.id,
          label: s.label,
          ...(s.terminal ? { terminal: true as const } : {}),
          ...(s.working ? { working: true as const } : {}),
        })),
        kinds: kinds.map((k) => ({ id: k.id, label: k.label })),
      };
    }

    /** A row's id, edited away from what it was when the editor opened, counts
     *  as a rename only when its original id actually has cards — an edit to a
     *  fresh "+ step" row, or to a step nobody uses, moves nothing. */
    function currentRewrites(): Rewrite[] {
      const renames = steps
        .filter((s) => !s.awaitingRemoval && s.originalId !== null && s.originalId !== s.id
          && cardCount(s.originalId) > 0)
        .map((s) => ({ from: s.originalId as StepId, to: s.id }));
      return [...pendingRemovals, ...renames];
    }

    /** A destination chosen for a removal has to *still* be a step when Save is
     *  pressed, not merely have been one when it was picked: the destination can
     *  afterwards be removed itself (silently, if it has no cards), be renamed,
     *  or be the source of a second removal. The backend does not backstop this
     *  — it refuses the card write and reports the cards as `skipped`, which is
     *  not an error, so the configuration would save and leave those cards in
     *  exactly the unknown-step column this rule exists to refuse to make. */
    function brokenRemoval(): Rewrite | null {
      const ids = currentConfig().steps.map((s) => s.id);
      return pendingRemovals.find((r) => !ids.includes(r.to)) ?? null;
    }

    /** main.ts runs the rewrites one after another, so a destination that is
     *  itself a source carries the arrivals on with it: swapping two ids lands
     *  both steps' cards in one step, with nothing skipped and so no alert at
     *  all. Refuse the draft instead — doing it properly needs a two-phase
     *  rewrite through a scratch id, which is more than this editor should
     *  take on. */
    function crossingRewrites(): { first: Rewrite; second: Rewrite } | null {
      const rewrites = currentRewrites();
      for (const first of rewrites) {
        const second = rewrites.find((r) => r !== first && r.from === first.to);
        if (second) return { first, second };
      }
      return null;
    }

    /** The single place that decides whether Save is allowed and, if not, what
     *  to say. The order is the order the questions arise in: an unanswered
     *  "where do these cards go" first, then a destination that has since gone
     *  or leads onwards, then whatever `validateDraft` makes of the draft. */
    function blockingMessage(): string | null {
      if (steps.some((s) => s.awaitingRemoval)) return "Choose where its cards go before saving.";
      const broken = brokenRemoval();
      if (broken) {
        return `The cards in "${broken.from}" were going to "${broken.to}", which the board no longer has. `
          + `Put "${broken.to}" back, or cancel and start again.`;
      }
      const crossing = crossingRewrites();
      if (crossing) {
        return `"${crossing.first.from}" sends its cards to "${crossing.first.to}", which sends them on to `
          + `"${crossing.second.to}" — both steps' cards would end up in one. Change one of the two.`;
      }
      return validateDraft(currentConfig());
    }

    function saveDisabled(): boolean {
      return blockingMessage() !== null;
    }

    function sync(): void {
      const message = blockingMessage();
      okBtn.disabled = message !== null;
      errorEl.textContent = refusal ?? message ?? "";
      refusal = null;
    }

    /** The rename note, or `null` when this row has nothing to announce. Kept
     *  separate from the row so an id keystroke can replace just this. */
    function renameNote(row: StepRow): HTMLElement | null {
      const count = cardCount(row.originalId);
      if (row.awaitingRemoval || row.originalId === null || row.id === row.originalId || count === 0) return null;
      const note = document.createElement("span");
      note.className = "tk-e-note tk-e-rename-note";
      note.textContent = `${count} card(s) will be updated to say "${row.id}"`;
      return note;
    }

    function refreshRenameNote(row: StepRow): void {
      const els = stepEls.get(row);
      if (!els) return;
      els.el.querySelector(".tk-e-rename-note")?.remove();
      const note = renameNote(row);
      if (note) els.el.append(note);
    }

    function fillDestOptions(dest: HTMLSelectElement, row: StepRow): void {
      dest.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Choose a step…";
      dest.append(blank);
      for (const other of steps) {
        if (other === row) continue;
        const opt = document.createElement("option");
        opt.value = other.id;
        opt.textContent = other.label || other.id;
        dest.append(opt);
      }
    }

    /** An id or label edited in one row changes what the destination selects in
     *  the *other* rows read and mean, and those rows never own the caret — so
     *  they can be rebuilt while the row being typed into is left alone. */
    function refreshDestOptions(): void {
      for (const [row, els] of stepEls) {
        if (!els.dest) continue;
        const chosen = els.dest.value;
        fillDestOptions(els.dest, row);
        els.dest.value = [...els.dest.options].some((o) => o.value === chosen) ? chosen : "";
      }
    }

    /** Checking one Working box clears the rest of the model; this writes that
     *  back to the boxes without replacing the one just clicked. */
    function refreshWorkingChecks(): void {
      for (const [row, els] of stepEls) els.workingCheck.checked = row.working;
    }

    /** Reordering does have to re-render — the rows themselves change places —
     *  so focus is put back on the arrow that was pressed, in its new row.
     *  Without it, pressing ↓ twice in a row needs a re-tab in between. */
    function focusArrow(els: ArrowEls | undefined, delta: number): void {
      if (!els) return;
      const pressed = delta < 0 ? els.upBtn : els.downBtn;
      const other = delta < 0 ? els.downBtn : els.upBtn;
      (pressed.disabled ? other : pressed).focus();
    }

    function moveStep(row: StepRow, delta: number): void {
      const i = steps.indexOf(row);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      renderSteps();
      sync();
      focusArrow(stepEls.get(row), delta);
    }

    function moveKind(row: KindRow, delta: number): void {
      const i = kinds.indexOf(row);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= kinds.length) return;
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
      renderKinds();
      sync();
      focusArrow(kindEls.get(row), delta);
    }

    function renderStepRow(row: StepRow, index: number): HTMLElement {
      const el = document.createElement("div");
      el.className = "tk-e-row tk-e-step-row";

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "tk-e-step-label";
      labelInput.value = row.label;
      labelInput.placeholder = "label";
      labelInput.disabled = row.awaitingRemoval;
      labelInput.oninput = () => { row.label = labelInput.value; refreshDestOptions(); sync(); };

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.className = "tk-e-step-id";
      idInput.value = row.id;
      idInput.placeholder = "id";
      idInput.disabled = row.awaitingRemoval;
      // Deliberately not renderAll(): rebuilding this section would detach the
      // input being typed into on the first character, which blurs it, and the
      // replacement is never focused — an id would take one click per letter.
      idInput.oninput = () => {
        row.id = idInput.value;
        refreshRenameNote(row);
        refreshDestOptions();
        sync();
      };

      const terminalCheck = document.createElement("input");
      terminalCheck.type = "checkbox";
      terminalCheck.className = "tk-e-step-terminal";
      terminalCheck.checked = row.terminal;
      terminalCheck.disabled = row.awaitingRemoval;
      terminalCheck.onchange = () => { row.terminal = terminalCheck.checked; sync(); };
      const terminalLabel = document.createElement("label");
      terminalLabel.className = "tk-e-check";
      terminalLabel.append(terminalCheck, document.createTextNode("Terminal"));

      const workingCheck = document.createElement("input");
      workingCheck.type = "checkbox";
      workingCheck.className = "tk-e-step-working";
      workingCheck.checked = row.working;
      workingCheck.disabled = row.awaitingRemoval;
      // Radio-like: checking one clears every other row's — the way "no more
      // than one working step" reads to a person, rather than a rule they only
      // discover from a rejected Save.
      workingCheck.onchange = () => {
        if (workingCheck.checked) { for (const s of steps) s.working = false; }
        row.working = workingCheck.checked;
        refreshWorkingChecks();
        sync();
      };
      const workingLabel = document.createElement("label");
      workingLabel.className = "tk-e-check";
      workingLabel.append(workingCheck, document.createTextNode("Working"));

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "tk-e-step-up";
      upBtn.textContent = "↑";
      upBtn.setAttribute("aria-label", "Move step up");
      upBtn.disabled = index === 0 || row.awaitingRemoval;
      upBtn.onclick = () => moveStep(row, -1);

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "tk-e-step-down";
      downBtn.textContent = "↓";
      downBtn.setAttribute("aria-label", "Move step down");
      downBtn.disabled = index === steps.length - 1 || row.awaitingRemoval;
      downBtn.onclick = () => moveStep(row, 1);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tk-e-step-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove step");
      removeBtn.disabled = row.awaitingRemoval;
      removeBtn.onclick = () => {
        // A step some earlier removal was told to send its cards to cannot go
        // away underneath it: the same check `brokenRemoval` makes at Save
        // time, said at the moment it can still be acted on.
        const incoming = pendingRemovals.find((r) => r.to === row.id);
        if (incoming) {
          refusal = `"${incoming.from}"'s cards are going to "${row.id}", so "${row.id}" has to stay. `
            + `Cancel and start again to choose differently.`;
          sync();
          return;
        }
        // A plain remove would deliberately manufacture the unknown-step
        // column for every card still sitting in this step — refused here, not
        // just documented, for any row whose original id has cards.
        if (row.originalId === null || cardCount(row.originalId) === 0) {
          steps = steps.filter((s) => s !== row);
        } else {
          row.awaitingRemoval = true;
        }
        renderAll();
      };

      el.append(
        labeled("Label", labelInput), labeled("Id", idInput),
        terminalLabel, workingLabel, upBtn, downBtn, removeBtn,
      );

      const rename = renameNote(row);
      if (rename) el.append(rename);

      let dest: HTMLSelectElement | null = null;
      if (row.awaitingRemoval) {
        const note = document.createElement("span");
        note.className = "tk-e-note";
        note.textContent = `${cardCount(row.originalId)} card(s) here — choose where they go:`;
        el.append(note);

        dest = document.createElement("select");
        dest.className = "tk-e-step-dest";
        dest.setAttribute("aria-label", "Move its cards to");
        fillDestOptions(dest, row);
        dest.value = "";
        const select = dest;
        select.onchange = () => {
          if (!select.value) return;
          pendingRemovals.push({ from: row.originalId as StepId, to: select.value });
          steps = steps.filter((s) => s !== row);
          renderAll();
        };
        el.append(dest);
      }

      stepEls.set(row, { el, workingCheck, upBtn, downBtn, dest });
      return el;
    }

    function renderKindRow(row: KindRow, index: number): HTMLElement {
      const el = document.createElement("div");
      el.className = "tk-e-row tk-e-kind-row";

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "tk-e-kind-label";
      labelInput.value = row.label;
      labelInput.placeholder = "label";
      labelInput.oninput = () => { row.label = labelInput.value; sync(); };

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.className = "tk-e-kind-id";
      idInput.value = row.id;
      idInput.placeholder = "id";
      idInput.oninput = () => { row.id = idInput.value; sync(); };

      // Kinds have no terminal/working flags, but they are ordered: this list's
      // order is the order of the kind buttons on the new-card form, so it has
      // to be changeable without removing and re-adding a kind.
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "tk-e-kind-up";
      upBtn.textContent = "↑";
      upBtn.setAttribute("aria-label", "Move kind up");
      upBtn.disabled = index === 0;
      upBtn.onclick = () => moveKind(row, -1);

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "tk-e-kind-down";
      downBtn.textContent = "↓";
      downBtn.setAttribute("aria-label", "Move kind down");
      downBtn.disabled = index === kinds.length - 1;
      downBtn.onclick = () => moveKind(row, 1);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tk-e-kind-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove kind");
      // No destination is asked for here: a kind carries no equivalent of
      // `board_step_usage`, so there is nothing for the editor to count.
      removeBtn.onclick = () => { kinds = kinds.filter((k) => k !== row); renderAll(); };

      el.append(labeled("Label", labelInput), labeled("Id", idInput), upBtn, downBtn, removeBtn);
      kindEls.set(row, { el, upBtn, downBtn });
      return el;
    }

    /** Focus a fresh row's Label input: the "+" button that made it has just
     *  been replaced along with the section, so focus would otherwise be on
     *  nothing and the row would need a click before it could be filled in. */
    function focusNewRow(el: HTMLElement | undefined, selector: string): void {
      el?.querySelector<HTMLInputElement>(selector)?.focus();
    }

    function renderSteps(): void {
      stepEls.clear();
      stepsSection.replaceChildren();
      const head = document.createElement("div");
      head.className = "tk-e-section-head";
      head.textContent = "Steps";
      stepsSection.append(head);
      const list = document.createElement("div");
      list.className = "tk-e-steps";
      steps.forEach((row, i) => list.append(renderStepRow(row, i)));
      stepsSection.append(list);
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "tk-e-add-step";
      addBtn.textContent = "+ step";
      addBtn.setAttribute("aria-label", "Add a step");
      addBtn.onclick = () => {
        const row: StepRow = {
          originalId: null, id: "", label: "", terminal: false, working: false, awaitingRemoval: false,
        };
        steps.push(row);
        renderAll();
        focusNewRow(stepEls.get(row)?.el, ".tk-e-step-label");
      };
      stepsSection.append(addBtn);
    }

    function renderKinds(): void {
      kindEls.clear();
      kindsSection.replaceChildren();
      const head = document.createElement("div");
      head.className = "tk-e-section-head";
      head.textContent = "Kinds";
      kindsSection.append(head);
      const list = document.createElement("div");
      list.className = "tk-e-kinds";
      kinds.forEach((row, i) => list.append(renderKindRow(row, i)));
      kindsSection.append(list);
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "tk-e-add-kind";
      addBtn.textContent = "+ kind";
      addBtn.setAttribute("aria-label", "Add a kind");
      addBtn.onclick = () => {
        const row: KindRow = { originalId: null, id: "", label: "" };
        kinds.push(row);
        renderAll();
        focusNewRow(kindEls.get(row)?.el, ".tk-e-kind-label");
      };
      kindsSection.append(addBtn);
    }

    function renderAll(): void {
      renderSteps();
      renderKinds();
      sync();
    }

    box.append(heading, stepsSection, kindsSection, errorEl, actionsRow);
    renderAll();

    const close = (v: BoardEditorResult | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      if (saveDisabled()) return;
      close({ config: currentConfig(), rewrites: currentRewrites() });
    };
    okBtn.onclick = submit;
    cancelBtn.onclick = () => close(null);
    stepsSection.querySelector<HTMLInputElement>(".tk-e-step-label")?.focus();
  });
}

/** What `applyBoardEdit` needs from the outside world, passed in rather than
 *  imported so the sequence it encodes — and in particular the one place it
 *  stops — can be exercised without a Tauri backend or a real modal. */
export interface BoardEditIo {
  rewrite: (from: StepId, to: StepId, config: BoardConfig) => Promise<RewriteReport>;
  save: (config: BoardConfig) => Promise<void>;
  alert: (message: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
}

/** Carry out what the editor handed back: the rewrites first, then the
 *  configuration — a card must never point at a step the saved configuration no
 *  longer has, and saving first would leave exactly that window open.
 *
 *  Returns `false` when the configuration was deliberately left alone, so the
 *  caller can tell "nothing was written" from "written, or tried and reported".
 */
export async function applyBoardEdit(result: BoardEditorResult, io: BoardEditIo): Promise<boolean> {
  for (const r of result.rewrites) {
    let report: RewriteReport;
    try {
      report = await io.rewrite(r.from, r.to, result.config);
    } catch (e) {
      await io.alert(`Could not update the cards in "${r.from}": ${String(e)}`);
      return false; // Leave the configuration alone: it still matches what is on disk.
    }
    if (report.skipped.length) {
      // Ask, rather than telling. A skipped card is not an error, so saving
      // anyway would leave it sitting in a step the configuration is about to
      // stop listing — and the person would learn that from an alert they had
      // already dismissed. It may well be the right choice for a damaged card,
      // which needs hand repair either way; it is theirs to make.
      const go = await io.confirm(
        `Moved ${report.rewritten} card(s) to "${r.to}". ${report.skipped.length} could not be moved:\n` +
        report.skipped.map((s) => `${s.fileName}: ${s.reason}`).join("\n") +
        "\n\nSave the new configuration anyway? Those cards will show in the unknown-step column until they are fixed.");
      if (!go) return false;
    }
  }
  try { await io.save(result.config); }
  catch (e) { await io.alert(`Could not save the board configuration: ${String(e)}`); }
  return true;
}
