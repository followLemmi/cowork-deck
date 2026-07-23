// Lightweight in-webview modal dialogs. The Tauri webview does not implement
// window.prompt()/confirm()/alert() (prompt returns null with no UI), so these
// vanilla replacements provide working text input and confirmation. No
// dependencies; styled via .modal-* rules in styles.css.

function makeOverlay(): { overlay: HTMLElement; box: HTMLElement } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.append(box);
  document.body.append(overlay);
  return { overlay, box };
}

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
    const { overlay, box } = makeOverlay();
    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = "text";
    input.value = initial;
    const { row, ok, cancel } = actions();
    box.append(title(label), input, row);

    const close = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    ok.onclick = () => close(input.value);
    cancel!.onclick = () => close(null);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question. Resolves true on OK, false on Cancel/backdrop. */
export function confirmModal(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, box } = makeOverlay();
    const { row, ok, cancel } = actions();
    box.append(title(message), row);

    const close = (value: boolean) => {
      overlay.remove();
      resolve(value);
    };
    ok.onclick = () => close(true);
    cancel!.onclick = () => close(false);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(false);
    });
    ok.focus();
  });
}

/** Show a message with a single OK button. Resolves when dismissed. */
export function alertModal(message: string): Promise<void> {
  return new Promise((resolve) => {
    const { overlay, box } = makeOverlay();
    const { row, ok } = actions("OK", null);
    box.append(title(message), row);

    const close = () => {
      overlay.remove();
      resolve();
    };
    ok.onclick = close;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    ok.focus();
  });
}
