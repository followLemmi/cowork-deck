// Workspace and skill create/edit form modals. Reuse the overlay/actions
// pattern from modal.ts but need multi-field layouts (color swatches, a
// native folder-pick button, a multiline prompt textarea), so they build
// their own DOM here rather than extending modal.ts's single-field helpers.

import { pickFolder } from "./dialog";
import type { Schedule, SchedulePreset, TaskDraft, TaskKind, TrackerConfig } from "./ipc";
import { parsePlaceholders } from "./placeholders";
import { validateSchedule } from "./schedule";

const COLORS = ["#61afef", "#98c379", "#e5c07b", "#c678dd", "#e06c75", "#56b6c2"];

function overlay(): { overlay: HTMLElement; box: HTMLElement } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.append(box);
  document.body.append(overlay);
  return { overlay, box };
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
type WorkspaceFormResult = { name: string; path: string; color: string; tracker: TrackerConfig | null };

export function workspaceForm(
  initial?: { name: string; path: string; color: string; tracker?: TrackerConfig | null },
): Promise<WorkspaceFormResult | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
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

    // ——— Трекер задач ———
    // Чекбокс — одиночный контрол, <label> здесь уместен. Радиокнопки живут
    // каждая в своём <label>, тоже по одному контролу на label.
    const onLabel = document.createElement("label");
    onLabel.className = "form-row";
    const onInput = document.createElement("input");
    onInput.type = "checkbox";
    onInput.className = "tk-f-on";
    const onText = document.createElement("span");
    onText.className = "form-label";
    onText.textContent = "Трекер задач";
    onLabel.append(onInput, onText);

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
    const projectRadio = mkRadio("project", "в проекте (.cowork/tasks)");
    const pathRadio = mkRadio("path", "своя папка");

    const trackerPath = document.createElement("input");
    trackerPath.className = "modal-input tk-f-path";
    trackerPath.type = "text";
    trackerPath.placeholder = "/home/…/vault/Tasks";

    const syncTracker = () => {
      rootRow.classList.toggle("tk-hidden", !onInput.checked);
      trackerPath.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
    };
    onInput.onchange = syncTracker;
    projectRadio.onchange = syncTracker;
    pathRadio.onchange = syncTracker;

    // Предзаполнение: правка имени пространства не должна молча снести
    // настройку трекера.
    const initialRoot = initial?.tracker?.providers[0]?.root ?? null;
    if (initialRoot) {
      onInput.checked = true;
      if (initialRoot.kind === "path") { pathRadio.checked = true; trackerPath.value = initialRoot.path; }
      else projectRadio.checked = true;
    } else {
      projectRadio.checked = true;
    }
    syncTracker();

    const { row, ok, cancel } = actions();
    box.append(title, labeled("Имя", name), labeled("Папка", pathRow), colorRow,
      onLabel, rootRow, trackerPath, row);

    const close = (v: WorkspaceFormResult | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n || !p) return; // требуются оба
      let tracker: TrackerConfig | null = null;
      if (onInput.checked) {
        if (pathRadio.checked) {
          const tp = trackerPath.value.trim();
          // Пустой путь — это не «выключено», это опечатка: не закрываем форму.
          if (!tp) { trackerPath.focus(); return; }
          tracker = { providers: [{ type: "fs", root: { kind: "path", path: tp } }] };
        } else {
          tracker = { providers: [{ type: "fs", root: { kind: "project" } }] };
        }
      }
      close({ name: n, path: p, color, tracker });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    name.focus();
  });
}

/** Create/edit form for a skill: name, emoji icon, multiline prompt textarea,
 *  and a checkbox scoping the skill to the active workspace. Resolves the
 *  collected values on OK, or null on Cancel/backdrop click. */
export function skillForm(
  activeWorkspaceId: string | null,
  initial?: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule?: Schedule | null },
): Promise<{ name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
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
    hour.title = "часы";
    const minute = document.createElement("input");
    minute.type = "number"; minute.min = "0"; minute.max = "59"; minute.className = "form-sched-minute"; minute.value = "0";
    minute.title = "минуты";

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
      weekday.style.display = kind.value === "weekly" ? "" : "none";
      hour.style.display = kind.value === "hourly" ? "none" : "";
    };
    kind.addEventListener("change", syncTimeRow);
    timeRow.append(kind, weekday, hour, minute);

    // One default per `{{placeholder}}`, rebuilt as the prompt is edited —
    // a scheduled run is unattended, so it can't prompt for values.
    const defWrap = document.createElement("div");
    defWrap.className = "form-sched-defaults";
    const defInputs = new Map<string, HTMLInputElement>();
    const renderDefaults = () => {
      const names = parsePlaceholders(promptField.value);
      defWrap.innerHTML = "";
      const kept = new Map(defInputs);
      defInputs.clear();
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

    const schedBody = document.createElement("div");
    schedBody.className = "form-sched-body";
    schedBody.append(timeRow, defWrap);
    const syncSchedBody = () => { schedBody.style.display = schedEnabled.checked ? "" : "none"; };
    schedEnabled.addEventListener("change", syncSchedBody);
    syncSchedBody(); syncTimeRow();

    const schedError = document.createElement("div");
    schedError.className = "form-sched-error"; schedError.style.display = "none";

    const readPreset = (): SchedulePreset => {
      const h = Number(hour.value), m = Number(minute.value);
      if (kind.value === "hourly") return { kind: "hourly", minute: m };
      if (kind.value === "daily") return { kind: "daily", hour: h, minute: m };
      return { kind: "weekly", weekday: Number(weekday.value), hour: h, minute: m };
    };
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

    const close = (v: { name: string; icon: string; prompt: string; workspaceId: string | null; schedule: Schedule | null } | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const n = name.value.trim(); const pr = promptField.value.trim();
      if (!n || !pr) return;
      const defaults = readDefaults();
      const preset = readPreset();
      const v = validateSchedule(schedEnabled.checked, preset, pr, defaults);
      if (!v.ok) { schedError.textContent = v.error; schedError.style.display = ""; return; }
      close({
        name: n, icon: icon.value.trim() || "▶", prompt: pr,
        workspaceId: scope.checked ? activeWorkspaceId : null,
        schedule: schedEnabled.checked ? { preset, defaults, enabled: true } : null,
      });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    name.focus();
  });
}

/** Prompt for one value per placeholder name (order preserved). Resolves a
 *  name→value map on OK, or null on Cancel/backdrop click. */
export function placeholderForm(names: string[]): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Параметры сценария";

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

    const close = (v: Record<string, string> | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const values: Record<string, string> = {};
      for (const [n, inp] of inputs) values[n] = inp.value.trim();
      close(values);
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    inputs.get(names[0])?.focus();
  });
}

/** Быстрый захват карточки. Заголовок обязателен: карточка без имени
 *  бесполезна в бэклоге, поэтому пустой ввод не закрывает модалку. */
export function taskForm(): Promise<TaskDraft | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Новая задача";

    const titleInput = document.createElement("input");
    titleInput.className = "modal-input tk-f-title";
    titleInput.type = "text";
    titleInput.placeholder = "что случилось или что сделать";

    // Строка типа устроена как colorRow в workspaceForm: span-подпись + контролы
    // в <div>, а НЕ labeled() — клик по тексту <label> форвардится на первую
    // кнопку и молча менял бы выбор.
    let kind: TaskKind = "task";
    const kindRow = document.createElement("div");
    kindRow.className = "form-row";
    const kindLabelEl = document.createElement("span");
    kindLabelEl.className = "form-label";
    kindLabelEl.textContent = "Тип";
    const kindBox = document.createElement("div");
    kindBox.className = "tk-f-kinds";
    const kinds: [TaskKind, string][] = [["bug", "баг"], ["task", "задача"], ["idea", "идея"]];
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
    bodyInput.placeholder = "репро, ссылки на файлы — что угодно";

    const { row, ok, cancel } = actions();
    box.append(title, labeled("Заголовок", titleInput), kindRow, labeled("Описание", bodyInput), row);

    const close = (v: TaskDraft | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const t = titleInput.value.trim();
      if (!t) { titleInput.focus(); return; } // безымянную карточку не создаём
      close({ title: t, kind, body: bodyInput.value });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    titleInput.focus();
  });
}
