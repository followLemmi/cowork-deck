import { describe, it, expect } from "vitest";
import { terminalKeyBytes } from "../src/terminal-keys";

// `ESC` + `CR`. Spelled out once so the assertions below read as the bytes on
// the wire rather than as an escape nobody double-checks.
const NEWLINE = "\x1b\r";

describe("terminalKeyBytes", () => {
  const base = { code: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("sends ESC+CR for Shift+Enter, so claude inserts a newline", () => {
    expect(terminalKeyBytes({ ...base, shiftKey: true })).toBe(NEWLINE);
  });
  it("sends ESC+CR for Alt/Option+Enter", () => {
    expect(terminalKeyBytes({ ...base, altKey: true })).toBe(NEWLINE);
  });
  it("sends ESC+CR for Ctrl+Enter", () => {
    expect(terminalKeyBytes({ ...base, ctrlKey: true })).toBe(NEWLINE);
  });
  it("sends ESC+CR when several of them are held at once", () => {
    expect(terminalKeyBytes({ ...base, shiftKey: true, altKey: true })).toBe(NEWLINE);
  });

  it("leaves a bare Enter alone — that is the submit, and xterm's CR is right", () => {
    expect(terminalKeyBytes(base)).toBeNull();
  });

  // On macOS `matchHotkey` claims Cmd+Enter for `zoom` and this function never
  // sees it. On Linux the app modifier is Ctrl, so Super+Enter does arrive
  // here — and it belongs to the window manager, not to us.
  it("leaves the meta key alone when it is held on its own", () => {
    expect(terminalKeyBytes({ ...base, metaKey: true })).toBeNull();
  });

  // But meta *with* another modifier is nobody's: `matchHotkey` rejects
  // Cmd+Shift+Enter on macOS (the app modifier there is bare Cmd), so a flat
  // `if (e.metaKey) return null` would send it to xterm as a bare CR and submit
  // the message — issue #234 all over again, one thumb away from Shift+Enter.
  it("still sends ESC+CR when meta is held alongside another modifier", () => {
    expect(terminalKeyBytes({ ...base, metaKey: true, shiftKey: true })).toBe(NEWLINE);
    expect(terminalKeyBytes({ ...base, metaKey: true, ctrlKey: true })).toBe(NEWLINE);
    expect(terminalKeyBytes({ ...base, metaKey: true, altKey: true })).toBe(NEWLINE);
  });

  it("treats the keypad Enter as the Enter it is", () => {
    expect(terminalKeyBytes({ ...base, code: "NumpadEnter", shiftKey: true })).toBe(NEWLINE);
  });

  it("answers null for every other key, modified or not", () => {
    expect(terminalKeyBytes({ ...base, code: "KeyA", shiftKey: true })).toBeNull();
    expect(terminalKeyBytes({ ...base, code: "Tab", shiftKey: true })).toBeNull();
    expect(terminalKeyBytes({ ...base, code: "F2", altKey: true })).toBeNull();
  });

  // `altKey` is optional on the parameter type, because the event objects the
  // rest of the app builds do not all carry it.
  it("tolerates an event without altKey", () => {
    expect(terminalKeyBytes({ code: "Enter", metaKey: false, ctrlKey: false, shiftKey: true }))
      .toBe(NEWLINE);
    expect(terminalKeyBytes({ code: "Enter", metaKey: false, ctrlKey: false, shiftKey: false }))
      .toBeNull();
  });
});
