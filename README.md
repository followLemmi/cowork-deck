# cowork-deck

A desktop deck for running multiple [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions
side by side. Each tile is a real terminal (backed by a PTY) attached to a `claude` process running in a
chosen workspace directory, optionally launched with a canned skill prompt. Session state (idle, working,
waiting for input, ended, error) is tracked per tile via Claude Code's hooks and surfaced as a label and,
optionally, a desktop notification.

Built with [Tauri v2](https://v2.tauri.app/) (Rust backend, PTY + process management) and a small
TypeScript/xterm.js frontend — no UI framework.

## Build & run

```bash
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build     # produces a release bundle for your platform
```

`npm run tauri dev` and `npm run tauri build` drive the Tauri CLI, which in turn runs `npm run dev` /
`npm run build` (Vite) for the frontend before launching or bundling the Rust app.

## Sessions and the app window

Sessions are not daemonized: every running `claude` process is a child of the app and is killed when the
app window closes. There is no background/detached mode — closing the window ends all sessions. If you
need a session to survive a restart, use the restart (⟳) affordance on a tile once it reaches `завершён`
(ended) or `ошибка` (error) state — it starts a fresh session in the same workspace with the same initial
prompt, but it does not resume state from before the restart.

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

State tracking (the `идёт`/`ждёт ввода`/`завершён`/`ошибка` labels and notifications) depends on Claude
Code hooks reporting session state back to the app. If you're running an older `claude` version that
doesn't support these hooks, or a hook fails to fire for any other reason, the terminal itself is
unaffected — you can still type, scroll, and interact with the session normally. The only symptom is that
the tile's state label stays on `готов` (idle) instead of reflecting the actual state.
