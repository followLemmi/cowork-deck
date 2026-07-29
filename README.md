<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="cowork-deck" width="128" height="128" />

# cowork-deck

**A desktop deck for running multiple [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions side by side.**

Each tile is a real terminal — a PTY-backed `claude` process in a workspace of your choice — with live
per-session state, token usage, and git context at a glance.

![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/backend-Rust-000000?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/frontend-TypeScript-3178C6?logo=typescript&logoColor=white)
![xterm.js](https://img.shields.io/badge/terminal-xterm.js-2A2A2A)
![No framework](https://img.shields.io/badge/UI-vanilla%20TS-informational)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)

</div>

---

Each tile is a real terminal (backed by a PTY) attached to a `claude` process running in a chosen
workspace directory, optionally launched with a canned skill prompt. Session state (idle, working,
waiting for input, ended, error) is tracked per tile via Claude Code's hooks and surfaced as a label
and, optionally, a desktop notification.

Built with [Tauri v2](https://v2.tauri.app/) (Rust backend, PTY + process management) and a small
TypeScript / [xterm.js](https://xtermjs.org/) frontend — no UI framework. Dark theme, One Dark palette,
memory footprint kept under ~100 MB.

## Features

- **Multi-session deck** — run many `claude` sessions as tiles in one window, each a full interactive terminal.
- **Live state tracking** — per-tile `idle` / `working` / `finished a turn` / `waiting for a decision` / `ended` / `error`, driven by Claude Code hooks, with optional desktop notifications. Click a notification to focus that session. "Finished a turn" and "waiting for a decision" are separate on purpose: an interactive `claude` parks at the prompt when it is done, which is not the same as being blocked on a permission request.
- **Floating status pill** — an always-on-top pill counting the sessions blocked on a decision, so you can step away from the app and still know when one needs you. A session that merely finished its task announces itself with a notification instead.
- **Workspaces** — group sessions by workspace in a color-coded sidebar, and switch the deck to show only one workspace's terminals.
- **Zoom / juggle** — double-click a tile header to expand one terminal near-full while the rest shrink to a filmstrip; click a shrunken tile to juggle focus (animated).
- **Scenarios** — launch sessions with canned prompts, parameterized with `{{name}}` placeholders filled in at start.
- **Scheduled scenarios** — attach a schedule (hourly / daily at `HH:MM` / weekly) to a scenario and it fires unattended into a fresh session, using stored defaults for its placeholders. It runs on *your* machine through *your* Claude Code — no cloud agents, no extra cost, full local context and permissions.
- **Run a schedule now** — a ⏰ button on a scheduled scenario runs it immediately, exactly as the schedule would, without consuming the upcoming scheduled run.
- **Task tracker** — a per-workspace backlog of markdown cards (`.cowork/tasks/` in the project, or any folder you point at — a dedicated repo, an Obsidian vault — where the cards go into a `cowork-deck-tasks/<workspace>/` folder the app creates, one container however many workspaces you point there). A Board screen next to Terminals, `Cmd/Ctrl+Shift+T` to file one without leaving the deck, and ▶ on a card launches a session with the card as its prompt. Sessions file their own tickets via a bundled `cowork_task` CLI, so a side finding becomes a card instead of scope creep. "In progress" is derived from live sessions, never stored, so nothing gets stuck.
- **A board each project configures** — the steps (columns) and card kinds live in a `board.json` beside the cards, so one project can run `backlog / todo / doing / shipped` and the next just `open / done`. Edit them from the board's ⚙ editor, which also moves the cards a rename or a removal would otherwise strand. Cards open as documents to read and edit, and move between steps by drag or by the ‹ › on the card. See [The board](#the-board).
- **Context-preserving restart** — restart an ended/errored tile and resume its Claude Code context (`claude --resume`).
- **Auto-restore** — reopen yesterday's tiles on launch; window size, position, and active workspace are persisted.
- **Broadcast input** — type once and send the same input to several sessions at once.
- **Observability** — token usage per session and per project, plus a git indicator on each tile.
- **Keyboard-first** — a command palette that lists every binding, `F6` to move between the sidebar and the terminal, and in-terminal search and clear. On Windows and Linux the bindings use `Ctrl+Shift`, leaving bare `Ctrl+W`/`Ctrl+B`/`Ctrl+K` to readline inside `claude`; macOS uses plain `Cmd`.

## Build & run

**Prerequisites:** [Node.js](https://nodejs.org/) + npm, a [Rust toolchain](https://rustup.rs/), and the
[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your platform. Claude Code
(`claude`) must be installed (see [Locating the `claude` binary](#locating-the-claude-binary)).

```bash
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build    # produces a release bundle for your platform
```

`npm run tauri dev` and `npm run tauri build` drive the Tauri CLI, which in turn runs `npm run dev` /
`npm run build` (Vite) for the frontend before launching or bundling the Rust app.

### Tests

```bash
npm test                                            # frontend (vitest)
cargo test --manifest-path src-tauri/Cargo.toml     # backend (Rust)
```

## Sessions and the app window

Sessions are not daemonized: every running `claude` process is a child of the app and is killed when the
app window closes. There is no background/detached mode — closing the window ends all sessions. If you
need a session to survive a restart, use the restart (⟳) affordance on a tile once it reaches `exited` or
`error` state — it starts a fresh session in the same workspace with the same initial prompt (resuming
Claude Code's context where possible), but it does not resume the app's own tracked state from before the
restart.

The same applies to schedules: the scheduler lives inside the app, so a scheduled scenario only fires
while the window is open. Runs missed while the app was closed are not lost — each scheduled scenario
catches up once on the next launch, however long it has been. A scenario whose previous scheduled run is
still `working` or `needs input` skips the new run rather than stacking a second one. A run that simply
finished does not block the next one, and its tile is closed when the next run starts, so a scenario keeps
at most one tile.

A run that produced nothing — no workspace, a skipped overlap, `claude` missing — is recorded rather
than silently swallowed: the scenario's row says what happened and when it was last successful.

## The board

The Board is a screen of its own, not a panel: switching to it puts the columns
where the terminals were. A column per configured step, cards of one height, and
the terminal columns capped so a column nobody reads cannot grow without end —
a non-terminal column never hides a card, because hiding work is not the same as
tidying it.

Click a card to open it as a document: title, kind, step and body in one dialog,
and only the fields you actually changed are written back. Move a card by
dragging it into another column, or with the ‹ › on the card itself — those
arrows are the keyboard's equal, not a fallback, because a terminal tile eats
Tab. A card the app cannot safely write — damaged frontmatter, an id that
collides — refuses the move rather than offering it and failing. A card parked in
the working step with no session running on it is marked, since ▶ moves the card
itself and a crashed session would otherwise read as work in progress. Cards
naming a step the configuration does not know stay visible in their own column;
cards belonging to another project in a shared root are counted, not silently
hidden.

### The configuration

Each project's tracker root (see [Task tracker](#features) above) holds a
`board.json` beside the cards. It lists the project's steps — a Kanban column
each — and its card kinds. Steps and kinds are **per project**: one board might
have `backlog / todo / doing / shipped`, another just `open / done`; nothing in
the app or its CLI assumes either. A step can carry two flags: `terminal`
(closed — more than one step may be terminal, and the first in configuration
order is where ✓ and `cowork_task done` send a card) and `working` (at most
one — where ▶ moves a card when it launches a session).

The ⚙ on the board edits all of it without leaving the app, and treats the cards
as part of the configuration rather than as its casualties: renaming a step
rewrites the cards standing in it, and removing a step that still has cards asks
where they should go instead of stranding them. It says how many cards a change
affects **before** you commit to it, and refuses a draft the backend would
reject anyway — so a broken board is caught in the form, not after the save.
Hand-editing the file still works; the backend validates independently either
way.

If `board.json` is missing, the app creates it with today's default
`open`/`done` configuration. If it exists but cannot be parsed or fails
validation (no terminal step, a duplicate id, and so on), the board falls back
to that same default **without rewriting the file** — the broken bytes stay on
disk so you can fix your own typo, and the board shows a banner explaining
why.

### A session and its card

A running session gets its card's id via `COWORK_TASK_ID`, and its opening
prompt carries a snapshot of the steps as they stood at launch. That snapshot
ages the moment anyone edits the board, so the live list from
`cowork_task steps` is the authority when the two disagree. A session moves
its card with `cowork_task status <id> <step>`.

Keeping the card honest does not rest on the agent remembering to. ▶ writes the
working step itself, before the session starts, so the board is right whether or
not the agent cooperates. From there each turn is reminded of the card's current
step, and the first attempt to finish while the card is still open is refused
once, naming the call that would move it. Only once: a second attempt goes
through, because a reminder the session cannot get past is a trap, not a
reminder — and a card that genuinely belongs where it is stays there by saying
so. A tracker that cannot be read never blocks anything.

A session **not** launched from a card gets no such prompt, so the tracker
introduces itself instead: while the workspace has one configured, each turn
adds a line naming the card directory, the `cowork_task new` call that files a
card, and the kinds this board accepts. Without a configured tracker, or with a
`board.json` that cannot be read, it says nothing — there is nothing it could
say that would be true.

### Moving the cards

Point a workspace at a folder of your own and the form names the folders it
would create before it creates any of them, so a mistyped path is visible while
it is still free to fix. The cards land in
`<picked>/cowork-deck-tasks/<workspace>/`, which makes the workspace's own name
part of its root: renaming the workspace moves it. So whenever the root changes,
the app offers to bring the existing cards along, and until they are moved — or
the offer is dismissed — the board carries a banner for the ones still sitting at
the previous root. `board.json` travels with them, so a project does not lose its
columns by changing where its cards live.

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

State tracking (the `working`/`done`/`needs input`/`exited`/`error` labels and notifications) depends on Claude
Code hooks reporting session state back to the app. If you're running an older `claude` version that
doesn't support these hooks, or a hook fails to fire for any other reason, the terminal itself is
unaffected — you can still type, scroll, and interact with the session normally. The only symptom is that
the tile's state label stays on `idle` instead of reflecting the actual state.

## Roadmap

**Next**

- **Scheduling v2** — cron expressions, more than one schedule per scenario, and last-run info in the ⏰ tooltip (all deliberately left out of the first cut).
- **UI localization** — a language switch and translated strings; the interface is English-only today.
- **Tracker providers** — GitHub Issues and Jira boards inside the deck, configured per workspace on top of the existing `TaskProvider` port (needs system-keychain token storage).

**Later**

- **Session diff review** — a side-by-side diff of what a session changed, without leaving the deck.
- **Project memory** — a per-project store of decisions, architecture, and gotchas that scenarios pick up automatically.
- **Multi-provider** — agent CLIs beyond Claude Code (Codex, Gemini CLI, Ollama, …), with keys going straight to the provider.
- **Agent teams** — handing work along Dev → QA → PM, including delegation to cheaper agents.

**Non-goals**

- **Cloud agents.** Every session is a local process on your machine, and scheduled work uses your own Claude Code install rather than a hosted runner.
- **Token markup or proxying.** The app never sits between you and your provider.
- **A UI framework.** Vanilla TypeScript and xterm.js; the sub-100 MB footprint is a feature, not an accident.
