# cowork-deck

A desktop deck for running multiple [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions
side by side. Each session runs `claude` in its own **external terminal window** — cowork-deck spawns the
terminal, it does not render one — in a chosen workspace directory, optionally launched with a canned
skill prompt. Session state (idle, working, waiting for input, ended, error) is tracked per session via
Claude Code's hooks and surfaced in the app as a card with a state label and, optionally, a desktop
notification.

Built with [Tauri v2](https://v2.tauri.app/) (Rust backend, external process management) and a small
TypeScript frontend — no UI framework, no embedded terminal emulator.

## Build & run

```bash
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build     # produces a release bundle for your platform
```

`npm run tauri dev` and `npm run tauri build` drive the Tauri CLI, which in turn runs `npm run dev` /
`npm run build` (Vite) for the frontend before launching or bundling the Rust app.

## External terminal

Launching a session opens a **separate terminal window**, outside the app, running `claude` in the chosen
workspace directory. cowork-deck itself has no terminal UI — the app window only shows a deck of session
cards (name, state label, restart/close buttons); the actual `claude` process and its output live entirely
in the external terminal window.

### Terminal command setting

A setting in the sidebar controls which terminal cowork-deck uses to open sessions:

- **Leave it empty (the default)** to auto-detect the system's default terminal:
  - **Linux:** `$TERMINAL -e` if the `$TERMINAL` environment variable is set, else `x-terminal-emulator -e`
    if present, else the first found among Ghostty, WezTerm, kitty, Alacritty, GNOME Terminal, Konsole, or
    xterm.
  - **Windows:** `wt` (Windows Terminal) if present, else `cmd /c start`.
  - **macOS:** best-effort — the first found among Ghostty, WezTerm, kitty, or Alacritty, else falls back
    to `open -a Terminal` (which may need a template override to accept extra arguments cleanly).
- **Set an explicit template** to override auto-detection, e.g. `ghostty -e`, `wezterm start --`, or
  `gnome-terminal --`. The template is split into an argv prefix and cowork-deck appends the `claude`
  invocation (with `--settings <temp-file>` and the optional skill prompt) after it.

State tracking and notifications are unaffected by which terminal you use — they go through Claude Code's
hooks, not the terminal, so they work the same whether you're on the auto-detected default or a custom
command (see [Graceful degradation](#graceful-degradation) below).

## Sessions and the app window

Sessions are not daemonized by cowork-deck: every spawned terminal process is tracked as a child of the
app and is killed when the app window closes. There is no background/detached mode from the app's point
of view — closing the window kills all tracked processes. If you need a session to survive a restart, use
the restart (⟳) affordance on a session card once it reaches `завершён` (ended) or `ошибка` (error) state —
it starts a fresh session in the same workspace with the same initial prompt, but it does not resume state
from before the restart.

**Caveat — terminals with a single background instance:** some terminal emulators (e.g. ones with a
client/server or "mux" model) work by having the spawned process hand off to an already-running background
daemon and then exit immediately, while the daemon keeps the actual window open. For those, the process
cowork-deck tracked has already exited on its own — killing it (on window close, or via the card's close
button) does nothing, because it's not the process that owns the window. In that case the terminal window
stays open even after the app removes the session from the deck (or the app itself closes), and you'll
need to close that window yourself. This is a property of the terminal you've configured, not a bug in
cowork-deck.

## Locating the `claude` binary

By default cowork-deck looks for `claude` (or `claude.cmd` on Windows) on `PATH`. If Claude Code isn't on
`PATH`, or you want to pin a specific installation, set the `COWORK_CLAUDE_PATH` environment variable to
the full path of the executable before launching the app:

```bash
COWORK_CLAUDE_PATH=/usr/local/bin/claude npm run tauri dev
```

If neither `COWORK_CLAUDE_PATH` nor a `claude` on `PATH` can be found, the app shows an alert on startup
telling you to set `COWORK_CLAUDE_PATH` and restart.

## Graceful degradation

State tracking (the `работает`/`ждёт ввода`/`завершён`/`ошибка` labels and notifications) depends on
Claude Code hooks reporting session state back to the app. It works entirely independently of the
terminal — the hook path is `claude` → hook → reporter binary → local listener → app, and never touches
the terminal window. If you're running an older `claude` version that doesn't support these hooks, or a
hook fails to fire for any other reason, the external terminal itself is unaffected — you can still type,
scroll, and interact with the session normally in its window. The only symptom is that the session's card
stays on `готов` (idle) instead of reflecting the actual state.
