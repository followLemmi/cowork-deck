import { openDialog } from "./dialog-shell";
// Lightweight in-webview modal dialogs. The Tauri webview does not implement
// window.prompt()/confirm()/alert() (prompt returns null with no UI), so these
// vanilla replacements provide working text input and confirmation. No
// dependencies; styled via .modal-* rules in styles.css.

function title(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "modal-title";
  h.textContent = text;
  return h;
}

function actions(okLabel = "OK", cancelLabel: string | null = "Отмена") {
  const row = document.createElement("div");
  row.className = "modal-actions";
  const ok = document.createElement("button");
  ok.className = "modal-ok";
  ok.textContent = okLabel;
  if (cancelLabel !== null) {
    const cancel = document.createElement("button");
    cancel.className = "modal-cancel";
    cancel.textContent = cancelLabel;
    row.append(cancel, ok);
    return { row, ok, cancel };
  }
  row.append(ok);
  return { row, ok, cancel: null };
}

/** Prompt for a line of text. Resolves the entered string on OK/Enter, or null
 *  on Cancel/Escape/backdrop click. */
export function promptModal(label: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = "text";
    input.value = initial;
    const { row, ok, cancel } = actions();
    const { box, close } = openDialog({
      onCancel: () => finish(null),
      onAccept: () => finish(input.value),
    });
    const finish = (value: string | null) => { close(); resolve(value); };
    box.append(title(label), input, row);
    ok.onclick = () => finish(input.value);
    cancel!.onclick = () => finish(null);
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question. Resolves true on OK, false on Cancel/backdrop. */
export function confirmModal(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { row, ok, cancel } = actions();
    const { box, close } = openDialog({
      onCancel: () => finish(false),
      onAccept: () => finish(true),
    });
    const finish = (value: boolean) => { close(); resolve(value); };
    box.append(title(message), row);
    ok.onclick = () => finish(true);
    cancel!.onclick = () => finish(false);
    ok.focus();
  });
}

/** Show a message with a single OK button. Resolves when dismissed. */
export function alertModal(message: string): Promise<void> {
  return new Promise((resolve) => {
    const { row, ok } = actions("OK", null);
    const { box, close } = openDialog({ onCancel: finish, onAccept: finish });
    function finish() { close(); resolve(); }
    box.append(title(message), row);
    ok.onclick = finish;
    ok.focus();
  });
}
