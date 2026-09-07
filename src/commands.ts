import type { SessionState } from "./ipc";

export interface Command { id: string; title: string; run: () => void; hotkey?: string }

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
}

/** Map a keydown to a command id, or null to let the terminal have it.
 *
 *  Matches on `e.code` (the physical key), not `e.key` (the character
 *  produced): with a Cyrillic layout active, Cmd+K arrives as "л" and the old
 *  key-based matching matched nothing at all. An English interface does not
 *  imply a Latin keyboard layout, so this stays keyed to the physical key.
 *
 *  On Windows and Linux the app modifier is Ctrl, which is also readline
 *  inside claude: Ctrl+W deletes the last word, Ctrl+B moves back a character,
 *  Ctrl+K kills to end of line. Claiming those bare broke muscle memory in
 *  every prompt, so there the bindings require Shift as well. macOS has no
 *  such clash — Cmd is free — and keeps its plain bindings. */
export function matchHotkey(
  e: {
    code: string; key?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
    altKey?: boolean;
  },
  isMac: boolean,
): string | null {
  // Region cycling has no modifier: it is the only way out of the terminal,
  // which swallows Tab in both directions.
  if (e.code === "F6") return e.shiftKey ? "prev-region" : "next-region";
  // Bare F2, the platform convention for rename. Any modifier falls through to
  // the PTY. Routing it through here rather than through a listener of its own
  // is the only correct wiring: `attachCustomKeyEventHandler` returns false
  // exactly when this matches, which is what stops F2 also reaching claude as
  // `\e[12~` while the rename happens.
  if (e.code === "F2" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    return "rename-active";
  }

  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  // Windows/Linux need Shift to stay clear of readline; macOS must not have it
  // (Cmd+Shift+K is a different binding to the user's eye).
  const letterOk = isMac ? !e.shiftKey : e.shiftKey;

  if (e.code === "Enter" && letterOk) return "zoom";
  if (e.code === "BracketRight" && e.shiftKey) return "next-waiting";
  // Shift on both platforms: the plain letter belongs to the terminal.
  if (e.code === "KeyT" && e.shiftKey) return "new-task";
  // The terminal drawer filling the window, and back. Shift on both platforms, so
  // it reads Cmd+Shift+E and Ctrl+Shift+E — which is what makes it symmetric
  // where a Shift variant of Cmd+J could not be: on Windows and Linux
  // Ctrl+Shift+J is already the drawer itself.
  //
  // The cost is stated rather than discovered: the legacy encoding cannot express
  // Shift with a control character, so Ctrl+Shift+E reaches a pty byte-identical
  // to Ctrl+E — readline's end-of-line. That byte is what is being claimed, and
  // it is the same trade every letter in the table below already makes; bare
  // Ctrl+E is untouched. It clears `terminal-keys.ts`, which claims only Enter.
  if (e.code === "KeyE" && e.shiftKey) return "expand-terminals";

  const letters: Record<string, string> = {
    KeyK: "palette", KeyN: "new-session", KeyW: "close-active",
    KeyF: "search", KeyB: "broadcast",
    // The terminal drawer, on the key every editor with a bottom panel uses for
    // one. It reads as Cmd+J on macOS and Ctrl+Shift+J elsewhere, by the same
    // readline rule as every other letter here.
    KeyJ: "toggle-terminals",
  };
  const cmd = letters[e.code];
  if (cmd && letterOk) return cmd;

  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && !e.shiftKey) return `focus-${digit[1]}`;
  return null;
}

export function nextWaitingIndex(states: SessionState[], current: number): number | null {
  const n = states.length;
  for (let i = 1; i <= n; i++) {
    const idx = ((current + i) % n + n) % n;
    if (states[idx] === "waitingInput") return idx;
  }
  return null;
}
