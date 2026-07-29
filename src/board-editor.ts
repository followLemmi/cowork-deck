// The ⚙ editor: lets a person change a board's steps and kinds themselves,
// instead of hand-editing board.json. Renaming or removing a step can leave
// cards pointing at an id the saved configuration no longer has, so the
// editor tracks which rows need a rewrite and hands that back alongside the
// edited configuration — main.ts::editBoard runs the rewrites before saving.

import { openDialog } from "./dialog-shell";
import type { BoardConfig, BoardKind, BoardStep, KindId, StepId, StepUsage } from "./ipc";

export interface BoardEditorResult {
  config: BoardConfig;
  rewrites: { from: StepId; to: StepId }[];
}

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
    const pendingRemovals: { from: StepId; to: StepId }[] = [];

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
    function currentRewrites(): { from: StepId; to: StepId }[] {
      const renames = steps
        .filter((s) => !s.awaitingRemoval && s.originalId !== null && s.originalId !== s.id
          && cardCount(s.originalId) > 0)
        .map((s) => ({ from: s.originalId as StepId, to: s.id }));
      return [...pendingRemovals, ...renames];
    }

    function saveDisabled(): boolean {
      if (steps.some((s) => s.awaitingRemoval)) return true;
      return validateDraft(currentConfig()) !== null;
    }

    function sync(): void {
      const awaiting = steps.some((s) => s.awaitingRemoval);
      okBtn.disabled = saveDisabled();
      errorEl.textContent = awaiting
        ? "Choose where its cards go before saving."
        : (validateDraft(currentConfig()) ?? "");
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
      labelInput.oninput = () => { row.label = labelInput.value; sync(); };

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.className = "tk-e-step-id";
      idInput.value = row.id;
      idInput.placeholder = "id";
      idInput.disabled = row.awaitingRemoval;
      idInput.oninput = () => { row.id = idInput.value; renderAll(); };

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
        renderAll();
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
      upBtn.onclick = () => {
        [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
        renderAll();
      };

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "tk-e-step-down";
      downBtn.textContent = "↓";
      downBtn.setAttribute("aria-label", "Move step down");
      downBtn.disabled = index === steps.length - 1 || row.awaitingRemoval;
      downBtn.onclick = () => {
        [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
        renderAll();
      };

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tk-e-step-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove step");
      removeBtn.disabled = row.awaitingRemoval;
      removeBtn.onclick = () => {
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

      const count = cardCount(row.originalId);
      if (!row.awaitingRemoval && row.originalId !== null && row.id !== row.originalId && count > 0) {
        const note = document.createElement("span");
        note.className = "tk-e-note";
        note.textContent = `${count} card(s) will be updated to say "${row.id}"`;
        el.append(note);
      }

      if (row.awaitingRemoval) {
        const note = document.createElement("span");
        note.className = "tk-e-note";
        note.textContent = `${count} card(s) here — choose where they go:`;
        el.append(note);

        const dest = document.createElement("select");
        dest.className = "tk-e-step-dest";
        dest.setAttribute("aria-label", "Move its cards to");
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
        dest.value = "";
        dest.onchange = () => {
          if (!dest.value) return;
          pendingRemovals.push({ from: row.originalId as StepId, to: dest.value });
          steps = steps.filter((s) => s !== row);
          renderAll();
        };
        el.append(dest);
      }

      return el;
    }

    function renderKindRow(row: KindRow): HTMLElement {
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

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tk-e-kind-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove kind");
      // No destination is asked for here: a kind carries no equivalent of
      // `board_step_usage`, so there is nothing for the editor to count.
      removeBtn.onclick = () => { kinds = kinds.filter((k) => k !== row); renderAll(); };

      el.append(labeled("Label", labelInput), labeled("Id", idInput), removeBtn);
      return el;
    }

    function renderSteps(): void {
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
        steps.push({ originalId: null, id: "", label: "", terminal: false, working: false, awaitingRemoval: false });
        renderAll();
      };
      stepsSection.append(addBtn);
    }

    function renderKinds(): void {
      kindsSection.replaceChildren();
      const head = document.createElement("div");
      head.className = "tk-e-section-head";
      head.textContent = "Kinds";
      kindsSection.append(head);
      const list = document.createElement("div");
      list.className = "tk-e-kinds";
      kinds.forEach((row) => list.append(renderKindRow(row)));
      kindsSection.append(list);
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "tk-e-add-kind";
      addBtn.textContent = "+ kind";
      addBtn.setAttribute("aria-label", "Add a kind");
      addBtn.onclick = () => {
        kinds.push({ originalId: null, id: "", label: "" });
        renderAll();
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
