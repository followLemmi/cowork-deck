// Shared behaviour for every modal in the app: the overlay, the keyboard
// contract and focus handling.
//
// All six dialogs used to build their own overlay and handle none of this.
// Escape closed nothing (the global keydown handler deliberately bows out
// while an overlay is open, and no dialog had a handler of its own), Tab
// walked out of the overlay into the sidebar and the terminal underneath —
// where keystrokes went into a PTY the user could not see — and closing
// dropped focus on <body>, so the next Tab restarted from the top of the page.

export interface DialogHandle {
  overlay: HTMLElement;
  box: HTMLElement;
  close: () => void;
}

export interface DialogOptions {
  /** Escape, backdrop click, or the cancel button. */
  onCancel: () => void;
  /** Enter outside a textarea, or the accept button. */
  onAccept: () => void;
  /** Accessible name, when the dialog has a title element. */
  labelledBy?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openDialog({ onCancel, onAccept, labelledBy }: DialogOptions): DialogHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  if (labelledBy) box.setAttribute("aria-labelledby", labelledBy);
  overlay.append(box);
  document.body.append(overlay);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      // A prompt textarea owns Enter — it is how you write a second line.
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "TEXTAREA") return;
      e.preventDefault();
      onAccept();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !box.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !box.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  // Capture, so the dialog sees the key before anything inside it does.
  document.addEventListener("keydown", onKeyDown, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) onCancel(); });

  const close = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    previouslyFocused?.focus?.();
  };

  return { overlay, box, close };
}
