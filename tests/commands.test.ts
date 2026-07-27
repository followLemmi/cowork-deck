import { describe, it, expect } from "vitest";
import { matchHotkey, nextWaitingIndex } from "../src/commands";
import type { SessionState } from "../src/ipc";

describe("matchHotkey", () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false };
  it("maps Cmd+K to palette on macOS", () => {
    expect(matchHotkey({ ...base, key: "k", metaKey: true }, true)).toBe("palette");
  });
  it("on macOS, Ctrl+K is NOT an app modifier — passes through to terminal", () => {
    expect(matchHotkey({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false }, true)).toBeNull();
  });
  it("on Windows/Linux, Ctrl+K IS the app modifier", () => {
    expect(matchHotkey({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false }, false)).toBe("palette");
  });
  it("maps Cmd+digit to focus-N", () => {
    expect(matchHotkey({ ...base, key: "3", metaKey: true }, true)).toBe("focus-3");
  });
  it("maps Cmd+Shift+] to next-waiting", () => {
    expect(matchHotkey({ ...base, key: "]", metaKey: true, shiftKey: true }, true)).toBe("next-waiting");
  });
  it("maps Cmd+B to broadcast on macOS", () => {
    expect(matchHotkey({ ...base, key: "b", metaKey: true }, true)).toBe("broadcast");
  });
  it("returns null without modifier", () => {
    expect(matchHotkey({ ...base, key: "k" }, true)).toBeNull();
  });
  it("maps the capture hotkey without shadowing readline", () => {
    const ev = { key: "T", metaKey: true, ctrlKey: false, shiftKey: true };
    expect(matchHotkey(ev, true)).toBe("new-task");
    // Без shift это не наш хоткей.
    expect(matchHotkey({ ...ev, shiftKey: false }, true)).toBeNull();
    // На Linux/Windows — только ctrl+shift, чтобы не глотать readline.
    expect(matchHotkey({ key: "T", metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe("new-task");
  });
});

describe("nextWaitingIndex", () => {
  const S = (x: string[]): SessionState[] => x as SessionState[];
  it("finds the next waiting after current, wrapping", () => {
    const states = S(["idle", "waitingInput", "working", "waitingInput"]);
    expect(nextWaitingIndex(states, 1)).toBe(3);
    expect(nextWaitingIndex(states, 3)).toBe(1); // wrap
  });
  it("returns null when none waiting", () => {
    expect(nextWaitingIndex(S(["idle", "working"]), 0)).toBeNull();
  });
  it("works when current is -1 (none focused)", () => {
    expect(nextWaitingIndex(S(["working", "waitingInput"]), -1)).toBe(1);
  });
});
