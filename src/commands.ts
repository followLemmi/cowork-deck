import type { SessionState } from "./ipc";

export interface Command { id: string; title: string; run: () => void; hotkey?: string }

export function matchHotkey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): string | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();
  if (k === "k") return "palette";
  if (k === "n" && !e.shiftKey) return "new-session";
  if (k === "w" && !e.shiftKey) return "close-active";
  if (k === "f" && !e.shiftKey) return "search";
  if (k === "]" && e.shiftKey) return "next-waiting";
  if (/^[1-9]$/.test(k) && !e.shiftKey) return `focus-${k}`;
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
