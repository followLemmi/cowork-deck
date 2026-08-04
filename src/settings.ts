// The one preference the app has: text size.
//
// A dialog rather than palette entries alone, and the reason is that the palette
// renders one-shot commands with nowhere to show the current value — a size chooser
// with no visible current size is a guessing game. Rejected for the same kind of
// reason: a fourth button beside the view switch (a preference is not a screen), a
// settings *screen* (its own `ViewName`, hidden-root rule and switch tests, for one
// control), and a hotkey (`matchHotkey` is crowded and a preference has not earned
// one). The palette *does* get "larger" and "smaller" as direct commands, because
// stepping is the thing worth doing without opening anything.

import { openDialog } from "./dialog-shell";
import { applyScale, currentScale, scaleLabel, SCALE_STEPS } from "./ui-scale";

/** Choose a text size.
 *
 *  Resolves to the chosen scale, or `null` when the person cancelled — in which case
 *  the scale in force when the dialog opened has already been put back.
 *
 *  Every step previews live. A size chooser that only takes effect on OK asks a
 *  person to imagine the result of each option, which is exactly the thing they
 *  opened the dialog to stop doing. Cancel therefore has real work to do, and it is
 *  the one behaviour here worth a test of its own. */
export function settingsDialog(): Promise<number | null> {
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

    const title = document.createElement("div");
    title.className = "modal-title";
    title.id = "settings-title";
    title.textContent = "Text size";
    box.append(title);

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
