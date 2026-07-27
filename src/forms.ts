// Workspace and skill create/edit form modals. Reuse the overlay/actions
// pattern from modal.ts but need multi-field layouts (color swatches, a
// native folder-pick button, a multiline prompt textarea), so they build
// their own DOM here rather than extending modal.ts's single-field helpers.

import { pickFolder } from "./dialog";
import { ghStatus, type Schedule, type SchedulePreset, type WorkspaceGithub } from "./ipc";
import { accountChoices } from "./github";
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
  initial?: { name: string; path: string; color: string; github?: WorkspaceGithub | null },
): Promise<{ name: string; path: string; color: string; github: WorkspaceGithub | null } | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");
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

    // --- GitHub: аккаунт и идентичность коммитов ---
    const account = document.createElement("select");
    account.className = "modal-input form-gh-account";
    // gh может отсутствовать — тогда останется единственный пункт «не привязан».
    void ghStatus()
      .then((st) => {
        for (const c of accountChoices(st, initial?.github?.login ?? null)) {
          const opt = document.createElement("option");
          opt.value = c.value;
          opt.textContent = c.label;
          if (c.missing) opt.classList.add("gh-missing");
          account.append(opt);
        }
        account.value = initial?.github?.login ?? "";
      })
      .catch((e) => {
        console.debug("ghStatus failed", e);
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "— gh недоступен —";
        account.append(opt);
      });

    const gitName = document.createElement("input");
    gitName.className = "modal-input"; gitName.type = "text";
    gitName.placeholder = "как в глобальном .gitconfig";
    gitName.value = initial?.github?.gitName ?? "";

    const gitEmail = document.createElement("input");
    gitEmail.className = "modal-input"; gitEmail.type = "text";
    gitEmail.placeholder = "как в глобальном .gitconfig";
    gitEmail.value = initial?.github?.gitEmail ?? "";

    const sshKey = document.createElement("input");
    sshKey.className = "modal-input"; sshKey.type = "text";
    sshKey.placeholder = "ключ для ssh-ремоутов (необязательно)";
    sshKey.value = initial?.github?.sshKey ?? "";

    const ghHint = document.createElement("p");
    ghHint.className = "form-hint";
    ghHint.textContent =
      "Применится к новым и перезапущенным сессиям — у живых окружение уже зафиксировано.";

    const error = document.createElement("div");
    error.className = "form-error"; error.style.display = "none";
    const { row, ok, cancel } = actions();
    box.append(
      title, labeled("Имя", name), labeled("Папка", pathRow), colorRow,
      labeled("Аккаунт GitHub", account),
      labeled("Имя в коммитах", gitName),
      labeled("Почта в коммитах", gitEmail),
      labeled("SSH-ключ", sshKey),
      ghHint,
      error, row,
    );

    const close = (
      v: { name: string; path: string; color: string; github: WorkspaceGithub | null } | null,
    ) => { closeDialog(); resolve(v); };
    const submit = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n) return showError(error, "Укажите имя пространства.");
      if (!p) return showError(error, "Выберите папку проекта.");
      const login = account.value.trim();
      const opt = (el: HTMLInputElement) => { const v = el.value.trim(); return v ? v : undefined; };
      // Пустой логин снимает привязку целиком: git-идентичность без аккаунта —
      // отдельная фича, которой мы не обещали.
      const github: WorkspaceGithub | null = login
        ? {
            host: initial?.github?.host ?? "github.com",
            login,
            gitName: opt(gitName),
            gitEmail: opt(gitEmail),
            sshKey: opt(sshKey),
          }
        : null;
      close({ name: n, path: p, color, github });
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
    title.textContent = initial ? "Изменить сценарий" : "Новый сценарий";

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
    iconPicker.setAttribute("aria-label", "Значок сценария");
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
    const weekdayWrap = selectWrap(weekday);
    const syncTimeRow = () => {
      const weekly = kind.value === "weekly";
      const hourly = kind.value === "hourly";
      // Hide the wrapper, not the select: the wrapper draws the chevron, so
      // hiding only the select leaves a stray arrow floating in the row.
      weekdayWrap.style.display = weekly ? "" : "none";
      hour.style.display = hourly ? "none" : "";
      hourLabel.style.display = hourly ? "none" : "";
      minuteLabel.textContent = hourly ? "минута часа" : "мин";
    };
    kind.addEventListener("change", syncTimeRow);
    timeRow.append(selectWrap(kind), weekdayWrap, hour, hourLabel, minute, minuteLabel);

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
      title, labeled("Имя", name), labeled("Значок", iconPicker),
      labeled("Задание", promptField),
      labeledCheck("Только для текущего пространства", scope,
        "иначе сценарий виден и запускается в любом"),
      labeledCheck("По расписанию", schedEnabled,
        "запускать без участия человека"),
      schedBody, schedError, row,
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
