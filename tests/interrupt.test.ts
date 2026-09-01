import { describe, it, expect } from "vitest";
import { showsInterruptHint, isInterruptKey } from "../src/interrupt";

/** The hint as Claude Code has actually drawn it, version to version. What
 *  surrounds the two words has changed repeatedly — a spinner and a verb, an
 *  elapsed time, a token count, a second hint behind a `·` — and the matcher is
 *  anchored on the part that is the feature rather than on any one frame. */
const REAL = [
  "(esc to interrupt)",
  "✻ Cogitating… (12s · esc to interrupt)",
  "✢ Puzzling… (1m 4s · ↓ 3.1k tokens · esc to interrupt)",
  "  esc to interrupt · ctrl+t to hide todos",
  "Press escape to interrupt",
];

describe("the interrupt hint", () => {
  for (const line of REAL) {
    it(`reads a turn as running from ${JSON.stringify(line)}`, () => {
      expect(showsInterruptHint(["", "some output", line, ""])).toBe(true);
    });
  }

  it("reads nothing from a screen that is only the prompt", () => {
    expect(showsInterruptHint([
      "> ",
      "  ? for shortcuts",
      "",
    ])).toBe(false);
  });

  it("is not fooled by the word on its own", () => {
    // A session's own output is not a hint about the session. Every one of
    // these is text that turns up in an ordinary terminal, and a looser match
    // would end a turn that is still running.
    expect(showsInterruptHint([
      "thread 'main' panicked at 'interrupt handler already installed'",
      "  SIGINT: interrupt",
      "commit 9f2a1: handle the interrupt path",
      "export function isInterruptKey(e) {",
    ])).toBe(false);
  });

  it("reads nothing from an empty screen", () => {
    expect(showsInterruptHint([])).toBe(false);
  });
});

describe("the interrupt key", () => {
  const key = (over: Record<string, unknown> = {}) => ({
    code: "Escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over,
  });

  it("is a bare Escape", () => {
    expect(isInterruptKey(key())).toBe(true);
  });

  it("is the physical key, so a Cyrillic layout still interrupts", () => {
    // The layout changes `key`, never `code` — the same reason `matchHotkey`
    // and `terminalKeyBytes` match on `code`.
    expect(isInterruptKey({ ...key(), key: "Escape" } as never)).toBe(true);
  });

  for (const held of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    it(`is not Escape with ${held} held`, () => {
      expect(isInterruptKey(key({ [held]: true }))).toBe(false);
    });
  }

  it("is not any other key", () => {
    expect(isInterruptKey(key({ code: "KeyC" }))).toBe(false);
    // Ctrl+C interrupts too, and is deliberately not this: pressed twice it
    // quits Claude Code, and a `done` landing after that `ended` would bring a
    // dead session back to life on the deck.
    expect(isInterruptKey(key({ code: "KeyC", ctrlKey: true }))).toBe(false);
  });
});
