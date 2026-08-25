// Workspace and skill create/edit form modals. Reuse the overlay/actions
// pattern from modal.ts but need multi-field layouts (color swatches, a
// native folder-pick button, a multiline prompt textarea), so they build
// their own DOM here rather than extending modal.ts's single-field helpers.

import { pickFolder } from "./dialog";
import { ghStatus, trackerOpenCount, trackerRootPreview } from "./ipc";
import type { BoardConfig, KindId, MergeOptions, Schedule, SchedulePreset, TaskDraft, TrackerConfig, TrackerRootPreview, WorkspaceGithub } from "./ipc";
import { accountChoices } from "./github";
import { closeConfirmText, fsRootOf } from "./issues";
import { parsePlaceholders } from "./placeholders";
import { validateSchedule, schedulePreview } from "./schedule";
import { openDialog } from "./dialog-shell";
import { confirmModal } from "./modal";
import { icon, SCENARIO_ICONS, type IconName } from "./icons";

/** Named, not a bare list of hexes. Six buttons carrying nothing but
 *  `style.background` announced as "button, button, button, button, button,
 *  button" — colour was the only carrier and there was no text alternative
 *  anywhere, which is 1.4.1 and 4.1.2, both Level A. The name lives beside the
 *  value so the two cannot drift; `#e06c75` is not a name a person can act on. */
/* On the app's own palette, because a workspace dot sits two pixels from a state chip
 * on the same row: a dot in a family the palette does not contain reads as a sixth
 * signal competing with the four that mean something. Three of these ARE the state
 * hues, which is deliberate — a dot is a 9px circle with no text and no border, and
 * nothing in the app treats it as a state, so reusing the hues keeps the screen to one
 * set of colours instead of two. The other three are the ink steps and they move with
 * the palette: `ice` was the old accent's icy blue, True Ink has no blue to give it,
 * and a name is worth less than nothing over a colour that is no longer icy. */
const COLORS = [
  { value: "#7bd77f", name: "green" },
  { value: "#efc845", name: "amber" },
  { value: "#fb817a", name: "red" },
  { value: "#f6f7f9", name: "chalk" },
  { value: "#b9babd", name: "stone" },
  { value: "#9a9c9f", name: "slate" },
];

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

/** `okLabel` names the action where "OK" would not: a dialog whose confirmation
 *  is public wants its button to say what it does. */
function actions(okLabel = "OK"): { row: HTMLElement; ok: HTMLButtonElement; cancel: HTMLButtonElement } {
  const row = document.createElement("div");
  row.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "modal-cancel"; cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "modal-ok"; ok.textContent = okLabel;
  row.append(cancel, ok);
  return { row, ok, cancel };
}

/** Create/edit form for a workspace: name, native folder-pick path field, and
 *  a color swatch picker. Resolves the collected values on OK, or null on
 *  Cancel/backdrop click. */
type WorkspaceFormResult = {
  name: string; path: string; color: string;
  github: WorkspaceGithub | null; tracker: TrackerConfig | null;
};

export function workspaceForm(
  initial?: {
    /** The workspace being edited, so the switch-away warning can count the cards
     *  still in its folder. Absent for a new workspace, which has none. */
    id?: string;
    name: string; path: string; color: string;
    github?: WorkspaceGithub | null; tracker?: TrackerConfig | null;
  },
): Promise<WorkspaceFormResult | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => void submit(),
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

    let color = initial?.color ?? COLORS[0].value;
    const swatches = document.createElement("div");
    swatches.className = "form-swatches";
    // The same treatment as the scenario icon picker below, which already got this
    // right: a radiogroup with a name per option and the selection exposed through
    // `aria-checked` rather than through a CSS ring only.
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Workspace colour");
    for (const c of COLORS) {
      const dot = document.createElement("button");
      dot.type = "button"; dot.className = "form-swatch"; dot.style.background = c.value;
      dot.setAttribute("role", "radio");
      dot.setAttribute("aria-label", c.name);
      dot.setAttribute("aria-checked", String(c.value === color));
      dot.classList.toggle("selected", c.value === color);
      dot.onclick = () => {
        color = c.value;
        for (const s of swatches.querySelectorAll(".form-swatch")) {
          s.classList.remove("selected");
          s.setAttribute("aria-checked", "false");
        }
        dot.classList.add("selected");
        dot.setAttribute("aria-checked", "true");
      };
      swatches.append(dot);
    }

    const colorRow = document.createElement("div");
    colorRow.className = "form-row";
    const colorLabel = document.createElement("span");
    colorLabel.className = "form-label";
    colorLabel.textContent = "Colour";
    colorRow.append(colorLabel, swatches);

    // --- GitHub: аккаунт и идентичность коммитов ---
    const account = document.createElement("select");
    account.className = "modal-input form-gh-account";
    // gh может отсутствовать — тогда останется единственный пункт «не привязан».
    // Promise.resolve оборачивает вызов: падение самого IPC (а не его промиса)
    // иначе роняет построение формы целиком, и пользователь не видит ни одного
    // поля из-за недоступного gh.
    void Promise.resolve()
      .then(() => ghStatus())
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
    const mkRadio = (value: "project" | "path" | "github", text: string) => {
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
    const githubRadio = mkRadio("github", "the repository's GitHub issues");

    // Shown only for a source this build cannot name — a record a newer build
    // wrote. The checkbox is on because there *is* a tracker, and no radio is
    // checked because none of them describes it; without this line that would
    // read as a form that lost its selection.
    const unknownNote = document.createElement("p");
    unknownNote.className = "form-hint tk-f-unknown";
    unknownNote.textContent =
      "This workspace uses a task source this version does not recognise. It is kept exactly as "
      + "it is unless you choose one of the options above.";
    unknownNote.classList.add("tk-hidden");

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
    // Polite, never assertive: this redraws on every keystroke of the name and
    // the path, and an assertive region would interrupt the person mid-word to
    // read out a path they are still typing. Announcing the whole region at once
    // keeps "Cards will live in: <path>" from arriving as two unrelated updates.
    trackerPreview.setAttribute("aria-live", "polite");
    trackerPreview.setAttribute("aria-atomic", "true");

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
      // would otherwise stay behind on its own. Keyed on `pathRadio` rather than
      // on "not project", so the GitHub choice hides the folder controls too —
      // a picker for a source with no folder is a control that does nothing.
      trackerPathRow.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
      // Hidden with the block it explains, not merely emptied by the guard
      // below. Both are true today; only this one is structural, and an
      // aria-live region left in the tree is a region a reader can still reach.
      trackerPreview.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
      void refreshPreview();
    };
    onInput.onchange = syncTracker;
    projectRadio.onchange = syncTracker;
    pathRadio.onchange = syncTracker;
    githubRadio.onchange = syncTracker;

    // Prefill: editing a workspace's name must not silently wipe its tracker
    // configuration — which is exactly what keying this on the presence of a
    // `root` used to do to the two variants that have none. The switch is on the
    // provider *variant*, and its last arm is the one that matters: a source this
    // build cannot name is left unselected and carried through by `submit`,
    // because reconstructing it would mean guessing what a newer build meant.
    const initialProvider = initial?.tracker?.providers[0] ?? null;
    const initialRoot = fsRootOf(initialProvider);
    if (initialProvider === null) {
      projectRadio.checked = true;              // a new or tracker-less workspace
    } else if (initialProvider.type === "github") {
      onInput.checked = true;
      githubRadio.checked = true;
    } else if (initialRoot) {
      onInput.checked = true;
      if (initialRoot.kind === "path") { pathRadio.checked = true; trackerPath.value = initialRoot.path; }
      else projectRadio.checked = true;
    } else {
      // Present, configured, and unreadable to this build. No radio can say so.
      onInput.checked = true;
      unknownNote.classList.remove("tk-hidden");
    }
    syncTracker();

    const error = document.createElement("div");
    error.className = "form-error"; error.style.display = "none";
    const { row, ok, cancel } = actions();
    box.append(title, labeled("Name", name), labeled("Folder", pathRow), colorRow,
      labeled("Аккаунт GitHub", account),
      labeled("Имя в коммитах", gitName),
      labeled("Почта в коммитах", gitEmail),
      labeled("SSH-ключ", sshKey),
      ghHint,
      onRow, rootRow, unknownNote, trackerPathRow, trackerPreview, error, row);

    const close = (v: WorkspaceFormResult | null) => { closeDialog(); resolve(v); };
    // `submit` awaits a confirmation now, and both OK and Enter reach it. Without
    // this the second of two quick clicks would raise a second confirmation over
    // the first, for one form.
    let submitting = false;
    const submit = async () => {
      if (submitting) return;
      submitting = true;
      try { await run(); } finally { submitting = false; }
    };
    const run = async () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n) return showError(error, "Enter a workspace name.");
      if (!p) return showError(error, "Choose a project folder.");
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
      let tracker: TrackerConfig | null = null;
      if (onInput.checked) {
        if (githubRadio.checked) {
          // Asked before the save, and only when a folder is being left behind:
          // afterwards the deck no longer knows the old root, and renaming the
          // workspace in the same save loses the pointer to it as well — the old
          // folder is named after the slug of the old name — so this sentence is
          // then the only thing that says where the cards are.
          if (initialRoot !== null) {
            const ok = await confirmModal(await abandonFolderWarning());
            if (!ok) return;   // the form stays open, the radio stays where it is
          }
          tracker = { providers: [{ type: "github" }] };
        } else if (pathRadio.checked) {
          const tp = trackerPath.value.trim();
          // An empty path is not "off", it is a typo: keep the form open.
          if (!tp) { trackerPath.focus(); return showError(error, "Enter the tracker folder."); }
          tracker = { providers: [{ type: "fs", root: { kind: "path", path: tp } }] };
        } else if (projectRadio.checked) {
          tracker = { providers: [{ type: "fs", root: { kind: "project" } }] };
        } else {
          // No radio is checked and the tracker is on: the only way to reach this
          // is the source this build cannot name, left exactly as it was found.
          // Written before the `else` arms above were made explicit, a stray
          // `else` here would have replaced it with a project folder.
          tracker = initial?.tracker ?? null;
        }
      }
      close({ name: n, path: p, color, github, tracker });
    };

    /** The sentence for leaving a folder behind. Every clause is load-bearing: how
     *  much is there, where it is, that nothing is deleted, that nothing is copied
     *  to GitHub, and that the switch is reversible.
     *
     *  Both facts are best-effort. The count needs a directory read and the path
     *  needs the preview's answer; neither may block a save, so each has a wording
     *  that is true when it is missing — "any cards there", "its previous folder". */
    async function abandonFolderWarning(): Promise<string> {
      const id = initial?.id;
      const n = id ? await trackerOpenCount(id).catch(() => null) : null;
      const what = n === null ? "any cards there" : `${n} open card${n === 1 ? "" : "s"}`;
      // Resolved from `initial` every time rather than read off the preview the
      // form is already showing. The preview follows the *editable* name and path
      // fields, so on a form where either was changed before the switch it names
      // where the cards *would have* gone — not where they are. The old name and
      // the old path are the only two inputs that answer this question.
      let where: string | null = null;
      if (initialRoot?.kind === "path" && initial) {
        where = await trackerRootPreview(initial.name, initialRoot.path)
          .then((r) => r.root).catch(() => null);
      } else if (initialRoot?.kind === "project" && initial) {
        // The same location the radio above names, and the workspace's own folder
        // is a fact this form already has.
        where = `${initial.path} (.cowork/tasks)`;
      }
      return `This workspace has ${what} in ${where ?? "its previous folder"}. Switching to GitHub `
        + "issues leaves every one of them on disk, untouched — this board will stop showing them, "
        + "and nothing will copy them to GitHub. Switching back later brings them back.";
    }

    ok.onclick = () => void submit();
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
export function placeholderForm(
  names: string[],
  /** Values to start the fields at. Empty for an ordinary launch; a previous
   *  run's own values when the launch is a re-run from the history.
   *
   *  Pre-filled and **shown**, never applied silently: a scenario's parameters
   *  may name a branch, a target or a person, and re-running yesterday's values
   *  against today's branch is exactly what a form the person can read prevents.
   *  Reconciled against the *current* template by the caller — the record is not
   *  authoritative over a prompt that has been edited since. */
  prefill: Record<string, string> = {},
): Promise<Record<string, string> | null> {
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
      // Guarded, not `prefill[n] ?? ""`: `n` is a placeholder name out of a
      // prompt somebody typed, and `{{constructor}}` would otherwise reach
      // through the prototype and open the field holding
      // `function Object() { [native code] }`. `fillPlaceholders` guards the
      // mirror-image lookup for the same reason.
      inp.value = Object.prototype.hasOwnProperty.call(prefill, n) ? prefill[n] : "";
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
    const first = inputs.get(names[0]);
    first?.focus();
    // Selected rather than left with the caret at the end: a pre-filled field is
    // a suggestion, and the fastest thing to do with a suggestion you disagree
    // with is type over it.
    first?.select();
  });
}

/** Quick capture of a card. The title is required: a nameless card is useless
 *  in a backlog, so an empty input does not close the dialog. */
export function taskForm(
  cfg: BoardConfig,
  /** Whether to offer the kind row. False for a synthesized board — one synthetic
   *  kind is not a choice — and the draft then carries that kind unchanged, which
   *  the GitHub provider ignores anyway. Default true: the file board's own
   *  callers and tests predate the flag. */
  showKind = true,
): Promise<TaskDraft | null> {
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
    // One button per configured kind, the first selected: `validate` refuses a
    // configuration with no kinds, so there is always one to preselect.
    let kind: KindId = cfg.kinds[0]?.id ?? "";
    const kindRow = document.createElement("div");
    kindRow.className = "form-row";
    const kindLabelEl = document.createElement("span");
    kindLabelEl.className = "form-label";
    kindLabelEl.textContent = "Kind";
    const kindBox = document.createElement("div");
    kindBox.className = "tk-f-kinds";
    for (const k of cfg.kinds) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.kind = k.id;
      b.textContent = k.label;
      b.className = "tk-f-kind";
      b.classList.toggle("selected", k.id === kind);
      b.onclick = () => {
        kind = k.id;
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
    // The row is withheld, not emptied: `kind` still carries `cfg.kinds[0]`, which
    // is the synthetic kind on a board that has only one, and the GitHub provider
    // ignores it. A kind row with one button would be a choice that is not one.
    box.append(title, labeled("Title", titleInput), ...(showKind ? [kindRow] : []),
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

/** The close confirmation for an issue, which is a confirmation *and* a choice.
 *
 *  `confirmModal` cannot carry the choice, and `gh issue close` takes a reason
 *  that is visible on the issue forever, so this is its own dialog: the sentence
 *  from `closeConfirmText` — the same one the rule's test pins, so the warning
 *  exists once — and the two reasons `gh` accepts, `completed` preselected.
 *
 *  Exactly two reasons, in that order: `gh_issues::close_reason` drops anything
 *  else, and a third option here would be a close that quietly lost its reason.
 *  No comment field — a comment is a conversation, and conversations are the next
 *  spec.
 *
 *  Resolves the chosen reason, or `null` on Cancel, Escape or the backdrop.
 *  Never a default reason on refusal: an unanswered confirmation closes nothing. */
export function closeIssueModal(
  number: number | string, title: string,
): Promise<"completed" | "not planned" | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    const heading = document.createElement("div");
    heading.className = "modal-title";
    // textContent, not innerHTML: the title is the repository's text and anyone
    // who can open an issue on a repository the user can read chooses it.
    heading.textContent = closeConfirmText(number, title);

    // Built like mergeForm's strategy row: a span label plus the radios in a
    // <div>, never `labeled()` — a <label> wrapping the whole group forwards a
    // click on its text to the first control and would silently change the answer.
    const row = document.createElement("div");
    row.className = "form-row";
    const label = document.createElement("span");
    label.className = "form-label";
    label.textContent = "Reason";
    const group = document.createElement("div");
    group.className = "ci-reasons";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Close reason");
    const REASONS = ["completed", "not planned"] as const;
    const radios: HTMLInputElement[] = [];
    for (const r of REASONS) {
      const l = document.createElement("label");
      const i = document.createElement("input");
      i.type = "radio"; i.name = "closeReason"; i.className = "ci-reason"; i.value = r;
      i.checked = r === "completed";
      l.append(i, document.createTextNode(` ${r}`));
      group.append(l);
      radios.push(i);
    }
    row.append(label, group);

    const { row: acts, ok, cancel } = actions("Close issue");
    box.append(heading, row, acts);

    const close = (v: "completed" | "not planned" | null) => { closeDialog(); resolve(v); };
    const submit = () => {
      // Found among the radios rather than read off an index: the checked one is
      // whichever the person left checked.
      const chosen = radios.find((r) => r.checked)?.value;
      close(chosen === "not planned" ? "not planned" : "completed");
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    ok.focus();
  });
}

/** Confirmation for the one irreversible action in the feature.
 *
 *  Shows what is being merged, into what, and at which commit — the same commit
 *  the caller pins with `--match-head-commit`, so the dialog and the merge can
 *  never disagree. Only the strategies the repository permits are offered: a
 *  button for a forbidden one could do nothing but fail. */
export function mergeForm(
  pr: { number: number; title: string; headRefName: string; baseRefName: string; headRefOid: string },
  opts: MergeOptions,
): Promise<{ strategy: string; deleteBranch: boolean } | null> {
  return new Promise((resolve) => {
    const { box, close: closeDialog } = openDialog({
      onCancel: () => close(null),
      onAccept: () => submit(),
    });
    box.classList.add("modal-box--form");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = `Merge #${pr.number}`;

    // Two paragraphs, not one with a newline in it: a "\n" inside a <p> renders
    // as a space, and the pull request title would run into the branch pair.
    const what = document.createElement("p");
    what.className = "form-hint mg-what";
    what.textContent = pr.title;

    const at = document.createElement("p");
    at.className = "form-hint mg-at";
    at.textContent =
      `${pr.headRefName} → ${pr.baseRefName}, at commit ${pr.headRefOid.slice(0, 7)}`;

    // The pin is the whole reason the commit is on screen; a refusal later is
    // easier to read as a guarantee than as a fault if it was named up front.
    const pinNote = document.createElement("p");
    pinNote.className = "form-hint mg-pin-note";
    pinNote.textContent =
      "The merge is pinned to that commit: if the branch moves first, it is refused.";

    // Built like kindRow in taskForm: a span label plus the controls in a
    // <div>, NOT labeled() — a <label> wraps one control, and a click on the
    // text of one wrapping the whole group would change the selection.
    const strategyRow = document.createElement("div");
    strategyRow.className = "form-row";
    const strategyLabel = document.createElement("span");
    strategyLabel.className = "form-label";
    strategyLabel.textContent = "Strategy";
    const strategyBox = document.createElement("div");
    strategyBox.className = "mg-strategies";
    strategyBox.setAttribute("role", "radiogroup");
    strategyBox.setAttribute("aria-label", "Merge strategy");
    const radios: HTMLInputElement[] = [];
    for (const s of opts.strategies) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio"; input.name = "mergeStrategy";
      input.className = "mg-strategy"; input.value = s;
      input.checked = s === opts.default;
      label.append(input, document.createTextNode(` ${s}`));
      strategyBox.append(label);
      radios.push(input);
    }
    strategyRow.append(strategyLabel, strategyBox);

    const deleteBox = document.createElement("input");
    deleteBox.type = "checkbox";
    deleteBox.className = "mg-delete";
    const deleteRow = opts.repoDeletesBranch
      ? (() => {
          const p = document.createElement("p");
          p.className = "form-hint mg-delete-note";
          p.textContent = "This repository deletes merged branches itself.";
          return p;
        })()
      : labeledCheck("Delete the branch after merging", deleteBox);

    const { row, ok, cancel } = actions();
    // Named, not "OK": the one button in the app that cannot be undone says
    // what it does.
    ok.textContent = "Merge";
    box.append(title, what, at, pinNote, strategyRow, deleteRow, row);

    const close = (v: { strategy: string; deleteBranch: boolean } | null) => {
      closeDialog(); resolve(v);
    };
    const submit = () => {
      const picked = radios.find((r) => r.checked)?.value ?? opts.default;
      close({
        strategy: picked,
        // Never true when the repository does it anyway: `deleteBox` is not in
        // the tree then, and an unticked box would be reported as a choice.
        deleteBranch: opts.repoDeletesBranch ? false : deleteBox.checked,
      });
    };
    ok.onclick = submit;
    cancel.onclick = () => close(null);
    // Focus lands on the choice rather than on the button that merges.
    (radios.find((r) => r.checked) ?? radios[0])?.focus();
  });
}
