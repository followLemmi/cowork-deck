import { describe, it, expect } from "vitest";
import { matchHotkey, nextWaitingIndex } from "../src/commands";
import type { SessionState } from "../src/ipc";

describe("matchHotkey", () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false };
  it("maps Cmd+K to palette", () => {
    expect(matchHotkey({ ...base, key: "k", metaKey: true })).toBe("palette");
  });
  it("maps Ctrl+K to palette", () => {
    expect(matchHotkey({ ...base, key: "k", ctrlKey: true })).toBe("palette");
  });
  it("maps Cmd+digit to focus-N", () => {
    expect(matchHotkey({ ...base, key: "3", metaKey: true })).toBe("focus-3");
  });
  it("maps Cmd+Shift+] to next-waiting", () => {
    expect(matchHotkey({ ...base, key: "]", metaKey: true, shiftKey: true })).toBe("next-waiting");
  });
  it("returns null without modifier", () => {
    expect(matchHotkey({ ...base, key: "k" })).toBeNull();
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
