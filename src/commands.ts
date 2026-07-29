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
  e: { code: string; key?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean,
): string | null {
  // Region cycling has no modifier: it is the only way out of the terminal,
  // which swallows Tab in both directions.
  if (e.code === "F6") return e.shiftKey ? "prev-region" : "next-region";

  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  // Windows/Linux need Shift to stay clear of readline; macOS must not have it
  // (Cmd+Shift+K is a different binding to the user's eye).
  const letterOk = isMac ? !e.shiftKey : e.shiftKey;

  if (e.code === "Enter" && letterOk) return "zoom";
  if (e.code === "BracketRight" && e.shiftKey) return "next-waiting";
  // Shift on both platforms: the plain letter belongs to the terminal.
  if (e.code === "KeyT" && e.shiftKey) return "new-task";

  const letters: Record<string, string> = {
    KeyK: "palette", KeyN: "new-session", KeyW: "close-active",
    KeyF: "search", KeyB: "broadcast",
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
