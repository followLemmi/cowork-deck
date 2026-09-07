import { describe, it, expect } from "vitest";
import { matchHotkey, nextWaitingIndex } from "../src/commands";
import type { SessionState } from "../src/ipc";

describe("matchHotkey", () => {
  const base = { code: "", key: "", metaKey: false, ctrlKey: false, shiftKey: false };
  it("maps Cmd+K to palette on macOS", () => {
    expect(matchHotkey({ ...base, code: "KeyK", metaKey: true }, true)).toBe("palette");
  });
  it("on macOS, Ctrl+K is NOT an app modifier — passes through to terminal", () => {
    expect(matchHotkey({ ...base, code: "KeyK", ctrlKey: true }, true)).toBeNull();
  });
  it("maps Cmd+digit to focus-N", () => {
    expect(matchHotkey({ ...base, code: "Digit3", metaKey: true }, true)).toBe("focus-3");
  });
  it("maps Cmd+Shift+] to next-waiting", () => {
    expect(matchHotkey({ ...base, code: "BracketRight", metaKey: true, shiftKey: true }, true))
      .toBe("next-waiting");
  });
  it("maps Cmd+B to broadcast on macOS", () => {
    expect(matchHotkey({ ...base, code: "KeyB", metaKey: true }, true)).toBe("broadcast");
  });
  it("returns null without modifier", () => {
    expect(matchHotkey({ ...base, code: "KeyK" }, true)).toBeNull();
  });

  // Bare Ctrl+W/B/K/F/N are readline inside claude: Ctrl+W deletes the last
  // word, Ctrl+B moves back a character. Claiming them broke muscle memory in
  // every prompt on Windows and Linux, where Ctrl is also the app modifier.
  it("leaves readline keys to the terminal on Windows and Linux", () => {
    for (const code of ["KeyW", "KeyB", "KeyK", "KeyF", "KeyN"]) {
      expect(matchHotkey({ ...base, code, ctrlKey: true }, false)).toBeNull();
    }
  });
  it("uses Ctrl+Shift on Windows and Linux instead", () => {
    expect(matchHotkey({ ...base, code: "KeyK", ctrlKey: true, shiftKey: true }, false)).toBe("palette");
    expect(matchHotkey({ ...base, code: "KeyW", ctrlKey: true, shiftKey: true }, false)).toBe("close-active");
    expect(matchHotkey({ ...base, code: "KeyF", ctrlKey: true, shiftKey: true }, false)).toBe("search");
  });

  // e.key is the produced character, so on a Cyrillic layout Cmd+K arrives as
  // "л" and nothing matched at all. The UI's language says nothing about
  // which layout the user types in.
  it("matches by physical key, not by the character produced", () => {
    expect(matchHotkey({ ...base, code: "KeyK", key: "л", metaKey: true }, true)).toBe("palette");
  });

  it("maps the zoom hotkey", () => {
    expect(matchHotkey({ ...base, code: "Enter", metaKey: true }, true)).toBe("zoom");
    expect(matchHotkey({ ...base, code: "Enter", ctrlKey: true, shiftKey: true }, false)).toBe("zoom");
  });

  // The only way out of the terminal, which otherwise swallows Tab.
  it("maps F6 to region cycling without any modifier", () => {
    expect(matchHotkey({ ...base, code: "F6" }, true)).toBe("next-region");
    expect(matchHotkey({ ...base, code: "F6", shiftKey: true }, true)).toBe("prev-region");
  });
  it("maps bare F2 to rename, and lets every modified F2 through", () => {
    expect(matchHotkey({ ...base, code: "F2" }, true)).toBe("rename-active");
    expect(matchHotkey({ ...base, code: "F2" }, false)).toBe("rename-active");
    for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(matchHotkey({ ...base, code: "F2", [mod]: true }, true)).toBeNull();
    }
  });
  it("matches F2 on the physical key, so a Cyrillic layout still renames", () => {
    // The same rule as every other hotkey here: with a Cyrillic layout active
    // `e.key` is not the physical key. F2 produces no character, but a matcher
    // that reached for `key` at all would be one layout away from breaking.
    expect(matchHotkey({ ...base, code: "F2", key: "б" }, true)).toBe("rename-active");
  });
  // Cmd+Shift+E / Ctrl+Shift+E, symmetric on both platforms — which a Shift
  // variant of Cmd+J could not be, because Ctrl+Shift+J is already the drawer.
  it("maps the full-window terminal hotkey the same way on both platforms", () => {
    expect(matchHotkey({ ...base, code: "KeyE", metaKey: true, shiftKey: true }, true))
      .toBe("expand-terminals");
    expect(matchHotkey({ ...base, code: "KeyE", ctrlKey: true, shiftKey: true }, false))
      .toBe("expand-terminals");
    // Bare Ctrl+E stays readline's end-of-line, and bare Cmd+E is nobody's.
    expect(matchHotkey({ ...base, code: "KeyE", ctrlKey: true }, false)).toBeNull();
    expect(matchHotkey({ ...base, code: "KeyE", metaKey: true }, true)).toBeNull();
  });

  // It must not have taken the drawer's own key on the platform where that key
  // already carries Shift.
  it("leaves Ctrl+Shift+J the drawer's on Windows and Linux", () => {
    expect(matchHotkey({ ...base, code: "KeyJ", ctrlKey: true, shiftKey: true }, false))
      .toBe("toggle-terminals");
    expect(matchHotkey({ ...base, code: "KeyJ", metaKey: true }, true)).toBe("toggle-terminals");
  });

  it("maps the capture hotkey without shadowing readline", () => {
    const ev = { ...base, code: "KeyT", metaKey: true, shiftKey: true };
    expect(matchHotkey(ev, true)).toBe("new-task");
    // Without Shift it is not our hotkey — the bare letter belongs to the terminal.
    expect(matchHotkey({ ...ev, shiftKey: false }, true)).toBeNull();
    // Linux/Windows: ctrl+shift only, so readline keeps Ctrl+T.
    expect(matchHotkey({ ...base, code: "KeyT", ctrlKey: true, shiftKey: true }, false)).toBe("new-task");
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
