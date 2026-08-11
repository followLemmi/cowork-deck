/** Bytes the app sends to the PTY for a key combination the legacy terminal
 *  encoding cannot express, or `null` to let xterm encode the key as it always
 *  has.
 *
 *  This is deliberately not a `Command`. A command is an app action; this
 *  produces bytes for the process on the other end of the pty, which is why it
 *  lives here rather than beside `matchHotkey`. The panel consults it *after*
 *  `matchHotkey`, so any combination the app has already claimed — `Cmd+Enter`
 *  on macOS, `Ctrl+Shift+Enter` elsewhere, both `zoom` — never reaches this
 *  function at all.
 *
 *  ## Why the app has to answer this and xterm cannot
 *
 *  In the legacy encoding a terminal has no way to say "Enter, with Shift
 *  held": `Enter` is `CR` and that is the whole alphabet. Modifier+Enter
 *  therefore arrives at the pty byte-identical to `Enter`, and claude does the
 *  only thing it can with a bare `CR` — submit. Distinguishing them needs
 *  `modifyOtherKeys` or the kitty keyboard protocol, and this app negotiates
 *  neither.
 *
 *  So the app does what every real terminal does instead, and what claude's own
 *  `/terminal-setup` writes into iTerm2 and VS Code: it binds the combination to
 *  `ESC` + `CR`, which claude reads as "insert a newline". The app *is* the
 *  terminal here, so the binding is the app's to make.
 *
 *  ## Which combinations, and why these
 *
 *  `Shift+Enter` is the one that costs something every day — it is what people
 *  press to compose a second line, and it is what `/terminal-setup` binds.
 *  `Alt/Option+Enter` and `Ctrl+Enter` are the two a person tries next when
 *  `Shift+Enter` fails them, and neither can mean anything else: the legacy
 *  encoding cannot express either, so nothing downstream has ever been able to
 *  bind them. Mapping all three to the same newline costs nothing and removes
 *  three ways to submit a half-written message by accident.
 *
 *  `Alt+Enter` is a special case worth knowing about: xterm already encodes it
 *  as `ESC` + `CR` on its own. Naming it here changes no bytes. It is listed
 *  because the rule is "modifier+Enter inserts a newline", and a table that
 *  silently omits one third of itself because a dependency happens to agree
 *  today is a table that breaks quietly when the dependency stops agreeing.
 *
 *  The app modifier keeps `Enter` for `zoom` — `Cmd+Enter` on macOS,
 *  `Ctrl+Shift+Enter` on Windows and Linux (see `matchHotkey`). That is a
 *  decision, not an oversight: zoom is reached far more often than a newline
 *  needs a fourth spelling, and `Shift+Enter` now covers the newline. The
 *  `metaKey` guard below is what keeps this function from claiming a
 *  combination the app modifier owns on a platform where `matchHotkey` did not
 *  claim it first (Super+Enter on Linux, which belongs to the window manager).
 *
 *  Matched on `e.code`, the physical key, for the same reason `matchHotkey` is:
 *  an English interface does not imply a Latin keyboard layout. */
export function terminalKeyBytes(
  e: {
    code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
    altKey?: boolean;
  },
): string | null {
  if (e.code !== "Enter" && e.code !== "NumpadEnter") return null;
  if (e.metaKey) return null;
  if (e.shiftKey || e.ctrlKey || e.altKey) return "\x1b\r";
  return null;
}
