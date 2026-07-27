// Workspace and skill create/edit form modals. Reuse the overlay/actions
// pattern from modal.ts but need multi-field layouts (color swatches, a
// native folder-pick button, a multiline prompt textarea), so they build
// their own DOM here rather than extending modal.ts's single-field helpers.

import { pickFolder } from "./dialog";
import type { Schedule, SchedulePreset } from "./ipc";
import { parsePlaceholders } from "./placeholders";
import { validateSchedule, schedulePreview } from "./schedule";
import { openDialog } from "./dialog-shell";

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

function actions(): { row: HTMLElement; ok: HTMLButtonElement; cancel: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "modal-cancel"; cancel.textContent = "Отмена";
  const ok = document.createElement("button");
  ok.className = "modal-ok"; ok.textContent = "OK";
  row.append(cancel, ok);
  return { row, ok, cancel };
}

/** Create/edit form for a workspace: name, native folder-pick path field, and
 *  a color swatch picker. Resolves the collected values on OK, or null on
 *  Cancel/backdrop click. */
export function workspaceForm(
  initial?: { name: string; path: string; color: string },
): Promise<{ name: string; path: string; color: string } | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Изменить пространство" : "Новое пространство";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    const path = document.createElement("input");
    path.className = "modal-input form-path"; path.type = "text";
    path.value = initial?.path ?? ""; path.placeholder = "путь к папке проекта";
    const pick = document.createElement("button");
    pick.className = "form-pick"; pick.type = "button"; pick.textContent = "Выбрать папку…";
    pick.onclick = async () => {
      const p = await pickFolder();
      if (p) {
        path.value = p;
        if (!name.value.trim()) name.value = p.split("/").filter(Boolean).pop() ?? "";
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
    colorLabel.textContent = "Цвет";
    colorRow.append(colorLabel, swatches);

    const error = document.createElement("div");
    error.className = "form-error"; error.style.display = "none";
    const { row, ok, cancel } = actions();
    box.append(title, labeled("Имя", name), labeled("Папка", pathRow), colorRow, error, row);

    const close = (v: { name: string; path: string; color: string } | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n) return showError(error, "Укажите имя пространства.");
      if (!p) return showError(error, "Выберите папку проекта.");
      close({ name: n, path: p, color });
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
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = initial ? "Изменить сценарий" : "Новый сценарий";

    const name = document.createElement("input");
    name.className = "modal-input form-name"; name.type = "text";
    name.value = initial?.name ?? "";

    const icon = document.createElement("input");
    icon.className = "modal-input form-icon"; icon.type = "text";
    icon.value = initial?.icon ?? ""; icon.placeholder = "▶";

    const promptField = document.createElement("textarea");
    promptField.className = "modal-input form-prompt"; promptField.rows = 4;
    promptField.value = initial?.prompt ?? "";

    const scope = document.createElement("input");
    scope.className = "form-scope"; scope.type = "checkbox";
    scope.checked = initial ? initial.workspaceId != null : false;

    // --- schedule section: hidden until «По расписанию» is ticked ---
    const schedEnabled = document.createElement("input");
    schedEnabled.type = "checkbox"; schedEnabled.className = "form-sched-enabled";
    schedEnabled.checked = !!initial?.schedule?.enabled;

    const kind = document.createElement("select");
    kind.className = "form-sched-kind";
    for (const [v, t] of [["hourly", "каждый час"], ["daily", "ежедневно"], ["weekly", "еженедельно"]] as const) {
      const o = document.createElement("option"); o.value = v; o.textContent = t; kind.append(o);
    }
    const weekday = document.createElement("select");
    weekday.className = "form-sched-weekday";
    ["вс", "пн", "вт", "ср", "чт", "пт", "сб"].forEach((w, i) => {
      const o = document.createElement("option"); o.value = String(i); o.textContent = w; weekday.append(o);
    });
    const hour = document.createElement("input");
    hour.type = "number"; hour.min = "0"; hour.max = "23"; hour.className = "form-sched-hour"; hour.value = "9";
    hour.setAttribute("aria-label", "часы");
    const minute = document.createElement("input");
    minute.type = "number"; minute.min = "0"; minute.max = "59"; minute.className = "form-sched-minute"; minute.value = "0";
    minute.setAttribute("aria-label", "минуты");
    // Visible, not just a tooltip: two bare number boxes gave no clue which
    // was which, and for the hourly preset the single remaining box did not
    // say whether "30" meant "at :30" or "every 30 minutes".
    const hourLabel = document.createElement("span");
    hourLabel.className = "form-sched-unit"; hourLabel.textContent = "ч";
    const minuteLabel = document.createElement("span");
    minuteLabel.className = "form-sched-unit"; minuteLabel.textContent = "мин";

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
    const syncTimeRow = () => {
      const weekly = kind.value === "weekly";
      const hourly = kind.value === "hourly";
      weekday.style.display = weekly ? "" : "none";
      hour.style.display = hourly ? "none" : "";
      hourLabel.style.display = hourly ? "none" : "";
      minuteLabel.textContent = hourly ? "минута часа" : "мин";
    };
    kind.addEventListener("change", syncTimeRow);
    timeRow.append(kind, weekday, hour, hourLabel, minute, minuteLabel);

    // One default per `{{placeholder}}`, rebuilt as the prompt is edited —
    // a scheduled run is unattended, so it can't prompt for values.
    const defWrap = document.createElement("div");
    defWrap.className = "form-sched-defaults";
    const defHead = document.createElement("div");
    defHead.className = "form-sched-defhead";
    defHead.textContent = "Значения параметров по умолчанию";
    const defHint = document.createElement("div");
    defHint.className = "form-sched-hint";
    defHint.textContent = "запуск по расписанию некому спросить, поэтому значения нужны заранее";
    const defInputs = new Map<string, HTMLInputElement>();
    const renderDefaults = () => {
      const names = parsePlaceholders(promptField.value);
      defWrap.innerHTML = "";
      const kept = new Map(defInputs);
      defInputs.clear();
      if (names.length) defWrap.append(defHead, defHint);
      for (const n of names) {
        const inp = document.createElement("input");
        inp.className = "modal-input form-sched-def"; inp.type = "text"; inp.placeholder = `значение {{${n}}}`;
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
      "Срабатывает, только пока cowork-deck открыт. Пропущенные запуски выполняются один раз при следующем старте.";

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
      title, labeled("Имя", name), labeled("Значок", icon),
      labeled("Задание", promptField), labeled("Только для текущего пространства", scope),
      labeled("По расписанию", schedEnabled), schedBody, schedError, row,
    );

    const close = (v: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      const n = name.value.trim(); const pr = promptField.value.trim();
      if (!n) return showError(schedError, "Укажите имя сценария.");
      if (!pr) return showError(schedError, "Опишите задание для Claude.");
      const defaults = readDefaults();
      const preset = readPreset();
      const v = validateSchedule(schedEnabled.checked, preset, pr, defaults);
      if (!v.ok) return showError(schedError, v.error);
      close({
        name: n, icon: icon.value.trim() || "▶", prompt: pr,
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
    title.textContent = "Параметры запуска";

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
