/** Reading, off the terminal's own screen, that a turn is running — and that a
 *  keystroke was the person ending it.
 *
 *  ## Why the deck has to read the screen at all
 *
 *  Session state is otherwise reported entirely by the hooks `hooks.rs`
 *  installs: `UserPromptSubmit` and `PreToolUse` say `working`, `Stop` says
 *  `done`. **`Stop` does not run when a turn ends because the person
 *  interrupted it** — documented behaviour of the hook, not a gap in the
 *  reporter. So an `Escape` mid-turn left the last `PreToolUse`'s `working`
 *  standing for the rest of the session's life, and `working` is not only a
 *  colour: `shouldSkipOverlap` in `src/schedule.ts` refuses to fire a scenario
 *  over a busy session, and `derivedStatus` in `src/tasks.ts` keeps a card's
 *  "in progress" chip while one is busy. One `Escape` and neither ever
 *  recovered (#333).
 *
 *  The hint is the only thing on the machine that knows. It is Claude Code
 *  saying, in its own words and on its own frame, that a turn is running and
 *  that `Escape` will end it — present for exactly as long as that is true, and
 *  gone the instant the interrupt lands. That makes "the hint was there, the
 *  person pressed `Escape`, the hint is gone" a *confirmed* end of turn rather
 *  than an assumed one, which is the whole reason the panel waits for the
 *  second half instead of reporting on the keystroke. An `Escape` that Claude
 *  Code spent on something else — dismissing a completion menu over a running
 *  turn — leaves the hint up, and nothing is reported.
 *
 *  ## Read from the screen, not from the output stream
 *
 *  Claude Code is Ink: it repaints when something changes and is otherwise
 *  silent, so a long tool call can produce no output for a minute while the
 *  hint sits on screen throughout. "Not in the bytes that arrived recently"
 *  therefore says nothing about whether it is up. The screen buffer is the
 *  question's real answer, and xterm is already holding it. */

/** The hint Claude Code prints while a turn can be interrupted.
 *
 *  Anchored on the two words that are the feature — a version that renamed the
 *  key would be a different feature — and tolerant of everything around them,
 *  because the rest of that line is decoration that has changed repeatedly
 *  across versions: a spinner and a verb before it, an elapsed time, a token
 *  count, and a second hint after it behind a `·`. `esc`/`escape` because both
 *  spellings have shipped.
 *
 *  Deliberately NOT matched loosely on "interrupt" alone: the word turns up in
 *  a session's own output — a stack trace, a `git` message, this file read back
 *  in a terminal — and a match there would end a turn that is still running. */
const INTERRUPT_HINT = /\besc(?:ape)? to interrupt\b/i;

/** Whether any of these lines is Claude Code offering the interrupt.
 *
 *  Takes the lines rather than the terminal so that what counts as the hint can
 *  be tested without one. The caller passes the SCREEN — see `TerminalPanel` —
 *  not the scrollback: the hint is redrawn in place on the frame, and an old
 *  copy scrolled off above would answer for a turn that finished long ago. */
export function showsInterruptHint(lines: readonly string[]): boolean {
  return lines.some((line) => INTERRUPT_HINT.test(line));
}

/** Whether this keydown is the interrupt — bare `Escape`, nothing held.
 *
 *  Matched on `e.code`, the physical key, for the reason `matchHotkey` and
 *  `terminalKeyBytes` are: an English interface does not imply a Latin keyboard
 *  layout.
 *
 *  Bare only. A modifier held with `Escape` is either an app hotkey — already
 *  claimed before this is consulted — or a sequence Claude Code reads as
 *  something other than an interrupt, and neither is a turn ending.
 *
 *  `Ctrl+C` is not here although it also interrupts, and that is a decision:
 *  pressed twice it quits Claude Code instead, which reports `ended` through
 *  `SessionEnd` — and a `done` from this path landing after that `ended` would
 *  bring a dead session back to life on the deck. `Escape` has no such second
 *  meaning. */
export function isInterruptKey(
  e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey?: boolean },
): boolean {
  return e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
