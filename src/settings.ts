// Settings: the app's own preferences, and where it keeps what it knows.
//
// Two sections, and the second one is not a preference at all — it is an answer.
// "Where is my configuration, and what is this workspace bound to" is asked by
// anyone who wants to back a file up, read one, move a project or find out which
// account a push will go out as, and until now the app answered none of it: the
// paths were in nobody's documentation and the bindings were only visible inside
// the form that edits them. A window that shows them is worth more than one that
// merely lets them be changed.
//
// It stays a modal rather than becoming a screen or a second OS window. A screen
// would need a page in the panel, and the panel's pages are things you WORK in;
// settings is a thing you visit. A second window would need its own entry point,
// its own stylesheet copy (see `pill.css`) and a story for what happens when the
// main window closes under it.
//
// The text-size section previews live. A size chooser that only takes effect on OK
// asks a person to imagine the result of each option, which is exactly what they
// opened it to stop doing. Cancel therefore has real work to do, and it is the one
// behaviour here with a test of its own.

import { openDialog } from "./dialog-shell";
import { applyScale, currentScale, scaleLabel, SCALE_STEPS } from "./ui-scale";
import type { ConfigPaths, Workspace } from "./ipc";

/** Everything the window shows that it does not own.
 *
 *  Passed in rather than read here, and the reason is the same one `settings.ts`
 *  has always followed: this module owns a dialog, not the app's state. The paths
 *  come from Rust, the workspace from the panel, and the two actions are the
 *  caller's — `revealPath` and the workspace form both already exist elsewhere and
 *  neither belongs to a preferences window. */
export interface SettingsInput {
  paths: ConfigPaths | null;
  workspace: Workspace | null;
  /** What this workspace's tasks come from, in words — "cards in .cowork/tasks",
   *  "issues in acme-labs/relay". Resolved by the caller, which owns the tracker
   *  vocabulary. */
  taskSource: string | null;
  onReveal: (path: string) => void;
  onEditWorkspace: () => void;
}

/** Open Settings. Resolves to the chosen text size, or `null` when the person
 *  cancelled — in which case the scale in force when it opened is already back. */
export function settingsDialog(input: SettingsInput): Promise<number | null> {
  return new Promise((resolve) => {
    const opened = currentScale();
    let picked = opened;
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      // Put the preview back before resolving, so a caller that persists on OK
      // never has to think about the cancel path.
      if (value === null) applyScale(opened, document.documentElement);
      closeDialog();
      resolve(value);
    };

    const { box, close: closeDialog } = openDialog({
      onCancel: () => finish(null),
      onAccept: () => finish(picked),
      labelledBy: "settings-title",
    });

    box.classList.add("modal-box--settings");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.id = "settings-title";
    title.textContent = "Settings";
    box.append(title);

    box.append(sectionHead("Text size"));
    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent =
      "Scales the whole interface. The terminal's own type follows, rounded to a "
      + "whole pixel so its character grid stays sharp.";
    box.append(hint);

    const group = document.createElement("div");
    group.className = "settings-sizes";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Text size");

    const buttons: HTMLButtonElement[] = [];
    const select = (scale: number) => {
      picked = scale;
      applyScale(scale, document.documentElement);
      for (const b of buttons) {
        const mine = Number(b.dataset.scale) === scale;
        b.classList.toggle("selected", mine);
        b.setAttribute("aria-checked", String(mine));
      }
    };

    for (const step of SCALE_STEPS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-size";
      b.dataset.scale = String(step);
      b.setAttribute("role", "radio");
      // The label is the name, so no separate `aria-label`: "115% · 14.95px" is what
      // is on the button and what a reader should say.
      b.textContent = scaleLabel(step);
      b.onclick = () => select(step);
      buttons.push(b);
      group.append(b);
    }
    box.append(group);
    select(opened);

    /* --- Where things are kept ------------------------------------------
       Two owners, said apart: the app's own files, which are the same wherever
       you are, and this workspace's bindings, which are not. Conflating them is
       how "where is my config" gets answered with a path that turns out to be
       one project's. */
    box.append(sectionHead("Where things are kept"));
    if (input.paths) {
      const p = input.paths;
      box.append(kv("The app's own files", p.dir, {
        mono: true,
        action: { label: "Reveal", run: () => input.onReveal(p.dir) },
      }));
      const names = document.createElement("p");
      names.className = "set-files";
      /* Every one of them named, including the ones not written yet, and the
         absent ones say so: a person looking for a file they have never saved
         needs to be told it is not there rather than shown a shorter list. */
      for (const f of p.files) {
        const chip = document.createElement("span");
        chip.className = "set-file" + (f.exists ? "" : " set-file--absent");
        chip.textContent = f.name;
        if (!f.exists) chip.title = "Not written yet";
        names.append(chip);
      }
      box.append(names);
    }

    const ws = input.workspace;
    if (ws) {
      box.append(kv(`This workspace · ${ws.name}`, ws.path, {
        mono: true,
        action: { label: "Reveal", run: () => input.onReveal(ws.path) },
      }));
      /* The account is the fact this window exists to surface: "which account
         does a push from here go out as" was answerable only by opening the form
         that changes it. */
      box.append(kv(
        "Pushes as",
        ws.github?.login ? `${ws.github.login} · ${ws.github.host}` : "no account bound",
        { muted: !ws.github?.login },
      ));
      box.append(kv("Tasks come from", input.taskSource ?? "nothing configured", {
        muted: input.taskSource === null,
        action: { label: "Edit workspace…", run: () => { finish(picked); input.onEditWorkspace(); } },
      }));
    } else {
      const none = document.createElement("p");
      none.className = "form-hint";
      none.textContent = "No workspace is active, so there is nothing bound to show.";
      box.append(none);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = () => finish(null);
    const ok = document.createElement("button");
    ok.className = "modal-ok";
    ok.textContent = "OK";
    ok.onclick = () => finish(picked);
    actions.append(cancel, ok);
    box.append(actions);

    buttons.find((b) => b.classList.contains("selected"))?.focus();
  });
}

/** A section's heading. Not an `h2`: this dialog's accessible name is its title,
 *  and the sections are groups within one document rather than documents of their
 *  own — `role="group"` with a label is what says that, and a heading level here
 *  would claim an outline the modal does not have. */
function sectionHead(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "set-head";
  h.textContent = text;
  return h;
}

/** One fact: what it is, what it is, and — where there is one — the thing to press
 *  about it. A definition row rather than a form row, because none of these is a
 *  field: three of the four are read-only answers, and the fourth opens the form
 *  that owns them. */
function kv(
  label: string,
  value: string,
  opts: { mono?: boolean; muted?: boolean; action?: { label: string; run: () => void } } = {},
): HTMLElement {
  const row = document.createElement("div");
  row.className = "set-kv";
  const l = document.createElement("span");
  l.className = "set-kv-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "set-kv-value"
    + (opts.mono ? " set-kv-value--mono" : "")
    + (opts.muted ? " set-kv-value--muted" : "");
  v.textContent = value;
  v.title = value;
  row.append(l, v);
  if (opts.action) {
    const b = document.createElement("button");
    b.className = "set-kv-act";
    b.textContent = opts.action.label;
    b.onclick = opts.action.run;
    row.append(b);
  }
  return row;
}
