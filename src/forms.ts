// Workspace and skill create/edit form modals. Reuse the overlay/actions
// pattern from modal.ts but need multi-field layouts (color swatches, a
// native folder-pick button, a multiline prompt textarea), so they build
// their own DOM here rather than extending modal.ts's single-field helpers.

import { pickFolder } from "./dialog";
import { trackerRootPreview } from "./ipc";
import type { Schedule, SchedulePreset, TaskDraft, TaskKind, TrackerConfig, TrackerRootPreview } from "./ipc";
import { parsePlaceholders } from "./placeholders";
import { validateSchedule, schedulePreview } from "./schedule";
import { openDialog } from "./dialog-shell";
import { icon, SCENARIO_ICONS, type IconName } from "./icons";

const COLORS = ["#61afef", "#98c379", "#e5c07b", "#c678dd", "#e06c75", "#56b6c2"];

/** Shows a validation message where the user is looking, instead of the OK
 *  button quietly doing nothing — the original behaviour for an empty name. */
function showError(el: HTMLElement, message: string) {
  el.textContent = message;
  el.style.display = "";
}

function labeled(labelText: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "form-row";
  const span = document.createElement("span");
  span.className = "form-label";
  span.textContent = labelText;
  wrap.append(span, field);
  return wrap;
}

/** A checkbox belongs beside its label, not under it. `labeled()` stacks the
 *  label above the field, which is right for text inputs and leaves a lone
 *  16px box adrift on its own line for a checkbox. */
function labeledCheck(labelText: string, box: HTMLInputElement, hint?: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "form-check";
  const text = document.createElement("span");
  text.className = "form-check-text";
  text.textContent = labelText;
  wrap.append(box, text);
  if (hint) {
    const h = document.createElement("span");
    h.className = "form-check-hint";
    h.textContent = hint;
    wrap.append(h);
  }
  return wrap;
}

/** Wraps a <select> so the chevron can be drawn in CSS. Native select controls
 *  render tall and chunky next to our inputs, and their arrow is whatever the
 *  platform feels like. */
function selectWrap(select: HTMLSelectElement): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "select-wrap";
  wrap.append(select);
  return wrap;
}

function actions(): { row: HTMLElement; ok: HTMLButtonElement; cancel: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "modal-cancel"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "modal-ok"; ok.textContent = "OK";
  row.append(cancel, ok);
  return { row, ok, cancel };
}

/** Create/edit form for a workspace: name, native folder-pick path field, and
 *  a color swatch picker. Resolves the collected values on OK, or null on
 *  Cancel/backdrop click. */
type WorkspaceFormResult = { name: string; path: string; color: string; tracker: TrackerConfig | null };

export function workspaceForm(
  initial?: { name: string; path: string; color: string; tracker?: TrackerConfig | null },
): Promise<WorkspaceFormResult | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Edit workspace" : "New workspace";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    const path = document.createElement("input");
    path.className = "modal-input form-path"; path.type = "text";
    path.value = initial?.path ?? ""; path.placeholder = "path to the project folder";
    const pick = document.createElement("button");
    pick.className = "form-pick"; pick.type = "button"; pick.textContent = "Choose folder…";
    pick.onclick = async () => {
      const p = await pickFolder();
      if (p) {
        path.value = p;
        if (!name.value.trim()) name.value = p.split("/").filter(Boolean).pop() ?? "";
        void refreshPreview();
      }
    };
    const pathRow = document.createElement("div");
    pathRow.className = "form-pathrow";
    pathRow.append(path, pick);

    let color = initial?.color ?? COLORS[0];
    const swatches = document.createElement("div");
    swatches.className = "form-swatches";
    for (const c of COLORS) {
      const dot = document.createElement("button");
      dot.type = "button"; dot.className = "form-swatch"; dot.style.background = c;
      dot.classList.toggle("selected", c === color);
      dot.onclick = () => {
        color = c;
        swatches.querySelectorAll(".form-swatch").forEach((s) => s.classList.remove("selected"));
        dot.classList.add("selected");
      };
      swatches.append(dot);
    }

    const colorRow = document.createElement("div");
    colorRow.className = "form-row";
    const colorLabel = document.createElement("span");
    colorLabel.className = "form-label";
    colorLabel.textContent = "Colour";
    colorRow.append(colorLabel, swatches);

    // --- Task tracker ---
    // The checkbox is a single control, so `labeledCheck` fits. Each radio
    // lives in its own <label> — one control per label there too.
    const onInput = document.createElement("input");
    onInput.type = "checkbox";
    onInput.className = "tk-f-on";
    const onRow = labeledCheck("Task tracker", onInput,
      "Keep a backlog of markdown cards for this workspace.");

    const rootRow = document.createElement("div");
    rootRow.className = "form-row";
    const mkRadio = (value: "project" | "path", text: string) => {
      const l = document.createElement("label");
      const i = document.createElement("input");
      i.type = "radio";
      i.className = "tk-f-root";
      i.name = "trackerRoot";
      i.value = value;
      l.append(i, document.createTextNode(` ${text}`));
      rootRow.append(l);
      return i;
    };
    const projectRadio = mkRadio("project", "in the project (.cowork/tasks)");
    const pathRadio = mkRadio("path", "a folder of my own");

    const trackerPath = document.createElement("input");
    trackerPath.className = "modal-input tk-f-path";
    trackerPath.type = "text";
    trackerPath.placeholder = "/home/…/vault/Tasks";
    // Same native picker as the project folder above. Typing an absolute path
    // by hand is the one thing a desktop app should not ask for, and this field
    // is the more likely of the two to point somewhere far from the project.
    const trackerPick = document.createElement("button");
    trackerPick.className = "form-pick tk-f-pick";
    trackerPick.type = "button";
    trackerPick.textContent = "Choose folder…";
    trackerPick.onclick = async () => {
      const p = await pickFolder();
      if (p) { trackerPath.value = p; void refreshPreview(); }
    };
    const trackerPathRow = document.createElement("div");
    trackerPathRow.className = "form-pathrow";
    trackerPathRow.append(trackerPath, trackerPick);

    // Cards land in folders the app creates, so the form names them before the
    // save rather than leaving the person to find them afterwards.
    const trackerPreview = document.createElement("div");
    trackerPreview.className = "tk-f-preview";

    const renderPreview = (p: TrackerRootPreview | null) => {
      trackerPreview.replaceChildren();
      if (!p) return;
      const head = document.createElement("p");
      head.className = "tk-f-preview-head";
      head.textContent = "Cards will live in:";
      const where = document.createElement("p");
      where.className = "tk-f-preview-path";
      where.textContent = p.root;
      trackerPreview.append(head, where);
      if (p.baseMissing) {
        const warn = document.createElement("p");
        warn.className = "tk-f-preview-warn";
        warn.textContent = "That folder does not exist, so nothing will be created.";
        trackerPreview.append(warn);
        return;
      }
      // Absent when there is nothing to create: an "already exists" line would
      // be noise on every later edit of the same workspace.
      if (p.creating.length) {
        const made = document.createElement("p");
        made.className = "tk-f-preview-creating";
        made.textContent =
          `${p.creating.map((n) => `${n}/`).join(" and ")} will be created for you.`;
        trackerPreview.append(made);
      }
    };

    // A newer request must win even if an older one replies later. The token
    // is consumed before the guard, not after: a guard failure (tracker
    // turned off, root switched back to project, name blanked mid-flight) has
    // to invalidate an in-flight request too, or a stale success can redraw
    // the very preview the guard just cleared.
    let previewToken = 0;
    const refreshPreview = async () => {
      const token = ++previewToken;
      const picked = trackerPath.value.trim();
      // The project folder is a slug of the name, so a blank name would resolve
      // to slugify("") — "task" — and promise a folder that will never exist.
      const wsName = name.value.trim();
      if (!onInput.checked || !pathRadio.checked || !picked || !wsName) {
        renderPreview(null);
        return;
      }
      try {
        const p = await trackerRootPreview(wsName, picked);
        if (token === previewToken) renderPreview(p);
      } catch {
        // An explanatory line in a form is not worth a visible failure.
        if (token === previewToken) renderPreview(null);
      }
    };

    trackerPath.oninput = () => void refreshPreview();
    name.oninput = () => void refreshPreview();

    const syncTracker = () => {
      rootRow.classList.toggle("tk-hidden", !onInput.checked);
      // Hide the row, not just the input: the pick button lives beside it and
      // would otherwise stay behind on its own.
      trackerPathRow.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
      void refreshPreview();
    };
    onInput.onchange = syncTracker;
    projectRadio.onchange = syncTracker;
    pathRadio.onchange = syncTracker;

    // Prefill: editing a workspace's name must not silently wipe its tracker
    // configuration.
    const initialRoot = initial?.tracker?.providers[0]?.root ?? null;
    if (initialRoot) {
      onInput.checked = true;
      if (initialRoot.kind === "path") { pathRadio.checked = true; trackerPath.value = initialRoot.path; }
      else projectRadio.checked = true;
    } else {
      projectRadio.checked = true;
    }
    syncTracker();

    const error = document.createElement("div");
    error.className = "form-error"; error.style.display = "none";
    const { row, ok, cancel } = actions();
    box.append(title, labeled("Name", name), labeled("Folder", pathRow), colorRow,
      onRow, rootRow, trackerPathRow, trackerPreview, error, row);

    const close = (v: WorkspaceFormResult | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n) return showError(error, "Enter a workspace name.");
      if (!p) return showError(error, "Choose a project folder.");
      let tracker: TrackerConfig | null = null;
      if (onInput.checked) {
        if (pathRadio.checked) {
          const tp = trackerPath.value.trim();
          // An empty path is not "off", it is a typo: keep the form open.
          if (!tp) { trackerPath.focus(); return showError(error, "Enter the tracker folder."); }
          tracker = { providers: [{ type: "fs", root: { kind: "path", path: tp } }] };
        } else {
          tracker = { providers: [{ type: "fs", root: { kind: "project" } }] };
        }
      }
      close({ name: n, path: p, color, tracker });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    name.focus();
  });
}

/** Create/edit form for a skill: name, emoji icon, multiline prompt textarea,
 *  and a checkbox scoping the skill to the active workspace. Resolves the
 *  collected values on OK, or null on Cancel/backdrop click. */
export function skillForm(
  activeWorkspaceId: string | null,
  initial?: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule?: Schedule | null },
  /** Name of the active workspace, shown in the schedule preview so "where
   *  will this run" is answered before saving rather than after. */
  activeWorkspaceName: string | null = null,
): Promise<{ name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Edit scenario" : "New scenario";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    // Free-text emoji was the one remaining way to put a foreign glyph next to
    // the icon set — the exact mismatch the set exists to remove. Stored as an
    // icon name; the Rust field is a String either way, so no migration. An
    // emoji saved earlier stays as it is and still renders.
    let iconName = initial?.icon ?? "play";
    const iconPicker = document.createElement("div");
    iconPicker.className = "form-swatches";
    iconPicker.setAttribute("role", "radiogroup");
    iconPicker.setAttribute("aria-label", "Scenario mark");
    for (const n of SCENARIO_ICONS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "form-swatch form-icon-swatch";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", n);
      b.setAttribute("aria-checked", String(n === iconName));
      b.classList.toggle("selected", n === iconName);
      b.append(icon(n as IconName));
      b.onclick = () => {
        iconName = n;
        for (const other of iconPicker.querySelectorAll(".form-icon-swatch")) {
          other.classList.remove("selected");
          other.setAttribute("aria-checked", "false");
        }
        b.classList.add("selected");
        b.setAttribute("aria-checked", "true");
      };
      iconPicker.append(b);
    }

    const promptField = document.createElement("textarea");
    promptField.className = "modal-input form-prompt"; promptField.rows = 4;
    promptField.value = initial?.prompt ?? "";

    const scope = document.createElement("input");
    scope.className = "form-scope"; scope.type = "checkbox";
    scope.checked = initial ? initial.workspaceId != null : false;

    // --- schedule section: hidden until "On a schedule" is ticked ---
    const schedEnabled = document.createElement("input");
    schedEnabled.type = "checkbox"; schedEnabled.className = "form-sched-enabled";
    schedEnabled.checked = !!initial?.schedule?.enabled;

    const kind = document.createElement("select");
    kind.className = "form-sched-kind";
    for (const [v, t] of [["hourly", "hourly"], ["daily", "daily"], ["weekly", "weekly"]] as const) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; kind.append(o);
    }
    const weekday = document.createElement("select");
    weekday.className = "form-sched-weekday";
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((w, i) => {
      const o = document.createElement("option"); o.value = String(i); o.textContent = w; weekday.append(o);
    });
    const hour = document.createElement("input");
    hour.type = "number"; hour.min = "0"; hour.max = "23"; hour.className = "form-sched-hour"; hour.value = "9";
    hour.setAttribute("aria-label", "hours");
    const minute = document.createElement("input");
    minute.type = "number"; minute.min = "0"; minute.max = "59"; minute.className = "form-sched-minute"; minute.value = "0";
    minute.setAttribute("aria-label", "minutes");
    // Visible, not just a tooltip: two bare number boxes gave no clue which
    // was which, and for the hourly preset the single remaining box did not
    // say whether "30" meant "at :30" or "every 30 minutes".
    const hourLabel = document.createElement("span");
    hourLabel.className = "form-sched-unit"; hourLabel.textContent = "h";
    const minuteLabel = document.createElement("span");
    minuteLabel.className = "form-sched-unit"; minuteLabel.textContent = "min";

    // Daily, not the first <option>. Hourly as a silent default means someone
    // who ticks the box, types a time into the one visible number field and
    // saves gets 24 claude runs a day.
    kind.value = "daily";
    const ip = initial?.schedule?.preset;
    if (ip) {
      kind.value = ip.kind;
      if (ip.kind === "hourly") minute.value = String(ip.minute);
      else if (ip.kind === "daily") { hour.value = String(ip.hour); minute.value = String(ip.minute); }
      else { weekday.value = String(ip.weekday); hour.value = String(ip.hour); minute.value = String(ip.minute); }
    }

    const timeRow = document.createElement("div");
    timeRow.className = "form-sched-time";
    const weekdayWrap = selectWrap(weekday);
    const syncTimeRow = () => {
      const weekly = kind.value === "weekly";
      const hourly = kind.value === "hourly";
      // Hide the wrapper, not the select: the wrapper draws the chevron, so
      // hiding only the select leaves a stray arrow floating in the row.
      weekdayWrap.style.display = weekly ? "" : "none";
      hour.style.display = hourly ? "none" : "";
      hourLabel.style.display = hourly ? "none" : "";
      minuteLabel.textContent = hourly ? "minute of the hour" : "min";
    };
    kind.addEventListener("change", syncTimeRow);
    timeRow.append(selectWrap(kind), weekdayWrap, hour, hourLabel, minute, minuteLabel);

    // One default per `{{placeholder}}`, rebuilt as the prompt is edited —
    // a scheduled run is unattended, so it can't prompt for values.
    const defWrap = document.createElement("div");
    defWrap.className = "form-sched-defaults";
    const defHead = document.createElement("div");
    defHead.className = "form-sched-defhead";
    defHead.textContent = "Default parameter values";
    const defHint = document.createElement("div");
    defHint.className = "form-sched-hint";
    defHint.textContent = "a scheduled run has nobody to ask, so the values are needed up front";
    const defInputs = new Map<string, HTMLInputElement>();
    const renderDefaults = () => {
      const names = parsePlaceholders(promptField.value);
      defWrap.innerHTML = "";
      const kept = new Map(defInputs);
      defInputs.clear();
      if (names.length) defWrap.append(defHead, defHint);
      for (const n of names) {
        const inp = document.createElement("input");
        inp.className = "modal-input form-sched-def"; inp.type = "text"; inp.placeholder = `value for {{${n}}}`;
        inp.value = kept.get(n)?.value ?? initial?.schedule?.defaults?.[n] ?? "";
        defInputs.set(n, inp);
        defWrap.append(labeled(n, inp));
      }
    };
    promptField.addEventListener("input", renderDefaults);
    renderDefaults();

    const readPreset = (): SchedulePreset => {
      const h = Number(hour.value), m = Number(minute.value);
      if (kind.value === "hourly") return { kind: "hourly", minute: m };
      if (kind.value === "daily") return { kind: "daily", hour: h, minute: m };
      return { kind: "weekly", weekday: Number(weekday.value), hour: h, minute: m };
    };
    // What the four controls above actually add up to, restated in words and
    // kept in step with them. describeSchedule/nextRunLabel already existed —
    // they were just never shown where the decision is made.
    const preview = document.createElement("div");
    preview.className = "form-sched-preview";
    const syncPreview = () => {
      const wsName = scope.checked ? (activeWorkspaceName ?? null) : null;
      preview.textContent = schedulePreview(readPreset(), new Date(), wsName);
    };
    for (const el of [kind, weekday, hour, minute, scope]) {
      el.addEventListener("change", syncPreview);
      el.addEventListener("input", syncPreview);
    }

    const caveat = document.createElement("div");
    caveat.className = "form-sched-hint";
    caveat.textContent =
      "Only fires while cowork-deck is open. Missed runs happen once, at the next start.";

    const schedBody = document.createElement("div");
    schedBody.className = "form-sched-body";
    schedBody.append(timeRow, preview, caveat, defWrap);
    const syncSchedBody = () => { schedBody.style.display = schedEnabled.checked ? "" : "none"; };
    schedEnabled.addEventListener("change", syncSchedBody);
    syncSchedBody(); syncTimeRow(); syncPreview();

    const schedError = document.createElement("div");
    schedError.className = "form-sched-error"; schedError.style.display = "none";

    const readDefaults = (): Record<string, string> => {
      const defaults: Record<string, string> = {};
      for (const [n, inp] of defInputs) defaults[n] = inp.value.trim();
      return defaults;
    };

    const { row, ok, cancel } = actions();
    box.append(
      title, labeled("Name", name), labeled("Mark", iconPicker),
      labeled("Task", promptField),
      labeledCheck("Only for the current workspace", scope,
        "otherwise the scenario is visible and runs in any"),
      labeledCheck("On a schedule", schedEnabled,
        "run it without a human present"),
      schedBody, schedError, row,
    );

    const close = (v: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const n = name.value.trim(); const pr = promptField.value.trim();
      if (!n) return showError(schedError, "Enter a scenario name.");
      if (!pr) return showError(schedError, "Describe the task for Claude.");
      const defaults = readDefaults();
      const preset = readPreset();
      const v = validateSchedule(schedEnabled.checked, preset, pr, defaults);
      if (!v.ok) return showError(schedError, v.error);
      close({
        name: n, icon: iconName, prompt: pr,
        workspaceId: scope.checked ? activeWorkspaceId : null,
        // Unticking pauses, it does not erase: keeping the rule and the
        // defaults is what makes "off for a week" a checkbox instead of a
        // full re-entry. Absent only when there never was a schedule.
        schedule: schedEnabled.checked
          ? { preset, defaults, enabled: true }
          : (initial?.schedule ? { ...initial.schedule, preset, defaults, enabled: false } : null),
      });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    name.focus();
  });
}

/** Prompt for one value per placeholder name (order preserved). Resolves a
 *  name→value map on OK, or null on Cancel/backdrop click. */
export function placeholderForm(names: string[]): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Launch parameters";

    const inputs = new Map<string, HTMLInputElement>();
    const rows: HTMLElement[] = [];
    for (const n of names) {
      const inp = document.createElement("input");
      inp.className = "modal-input form-ph"; inp.type = "text";
      inp.dataset.name = n;
      inputs.set(n, inp);
      rows.push(labeled(n, inp));
    }

    const { row, ok, cancel } = actions();
    box.append(title, ...rows, row);

    const close = (v: Record<string, string> | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const values: Record<string, string> = {};
      for (const [n, inp] of inputs) values[n] = inp.value.trim();
      close(values);
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    inputs.get(names[0])?.focus();
  });
}

/** Quick capture of a card. The title is required: a nameless card is useless
 *  in a backlog, so an empty input does not close the dialog. */
export function taskForm(): Promise<TaskDraft | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "New task";

    const titleInput = document.createElement("input");
    titleInput.className = "modal-input tk-f-title";
    titleInput.type = "text";
    titleInput.placeholder = "what happened, or what to do";

    // The kind row is built like colorRow in workspaceForm: a span label plus
    // the controls in a <div>, NOT labeled() — a click on a <label>'s text is
    // forwarded to the first control inside it and would silently change the
    // selection.
    let kind: TaskKind = "task";
    const kindRow = document.createElement("div");
    kindRow.className = "form-row";
    const kindLabelEl = document.createElement("span");
    kindLabelEl.className = "form-label";
    kindLabelEl.textContent = "Kind";
    const kindBox = document.createElement("div");
    kindBox.className = "tk-f-kinds";
    const kinds: [TaskKind, string][] = [["bug", "bug"], ["task", "task"], ["idea", "idea"]];
    for (const [value, label] of kinds) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.kind = value;
      b.textContent = label;
      b.className = "tk-f-kind";
      b.classList.toggle("selected", value === kind);
      b.onclick = () => {
        kind = value;
        kindBox.querySelectorAll(".tk-f-kind").forEach((o) => o.classList.remove("selected"));
        b.classList.add("selected");
      };
      kindBox.append(b);
    }
    kindRow.append(kindLabelEl, kindBox);

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "modal-input tk-f-body";
    bodyInput.rows = 5;
    bodyInput.placeholder = "repro, links to files — anything";

    const error = document.createElement("div");
    error.className = "form-error"; error.style.display = "none";
    const { row, ok, cancel } = actions();
    box.append(title, labeled("Title", titleInput), kindRow,
      labeled("Description", bodyInput), error, row);

    const close = (v: TaskDraft | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const t = titleInput.value.trim();
      // No nameless cards: say so instead of an OK button that does nothing.
      if (!t) { titleInput.focus(); return showError(error, "Enter a task title."); }
      close({ title: t, kind, body: bodyInput.value });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    titleInput.focus();
  });
}
