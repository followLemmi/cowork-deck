<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="cowork-deck" width="128" height="128" />

# cowork-deck

**A desktop deck for running many [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions at once.**

Every tile is a real terminal — a PTY-backed `claude` in a project folder you chose — and the window
answers one question at a glance: *which of these needs me?*

![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/backend-Rust-000000?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/frontend-TypeScript-3178C6?logo=typescript&logoColor=white)
![xterm.js](https://img.shields.io/badge/terminal-xterm.js-2A2A2A)
![No framework](https://img.shields.io/badge/UI-vanilla%20TS-informational)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey)

<br />

<img src="docs/images/deck.png" alt="Five Claude Code sessions as tiles in one window — one working, one waiting for a decision, one finished, one stopped on an error, one idle — beside a panel holding workspaces and their sessions as one tree." width="960" />

<sub>Five sessions, five states, one glance. The bar down the left edge of each tile is its state —
green working, amber waiting on you, red broken — so a dozen sessions read in one sweep instead of a
dozen labels. The two readings in the top bar count the only two things that want a person.</sub>

<br />
<br />

<img src="docs/images/demo.gif" alt="A screen recording of the deck: a working session finishes its turn and its rail changes live, one tile zooms near-full while the rest become a filmstrip, a workspace's board lists its repository's issues and opens one as a document, and a pull request unfolds into its diff." width="960" />

<sub>Half a minute of the real UI: a session finishes its turn, zoom and juggle, a workspace's board
reading its repository's issues, a pull request and its diff — and back to the deck, which never left.
Recorded against the screenshot harness, so everything on screen is invented fixture data.</sub>

</div>

---

Each tile is a real terminal attached to a `claude` process in a workspace folder, optionally launched
with a saved prompt. State — idle, working, finished a turn, waiting for a decision, ended, error —
comes from Claude Code's own hooks and shows up as a rail, a chip, and a desktop notification if you
want one.

Built with [Tauri v2](https://v2.tauri.app/) (Rust: PTY and process management) and a small
TypeScript + [xterm.js](https://xtermjs.org/) frontend, no UI framework. Around 100 MB resident.

## The window

One row, three parts, and nothing ever replaces the deck:

- **The rail** — three icons that decide what the panel beside it holds: the tree, the journal of every
  run, the scenarios. Settings sits at its foot, under a gap, because it changes nothing about the
  panel.
- **The panel** — workspaces and their sessions as **one tree**. A workspace appears once and its
  sessions are its children, so "which project is this session in" and "where will a new one go" have
  the same answer. Creation is positional: the last row inside each group reads *New session in
  `<name>`*, at the place the new session will appear.
- **The deck** — the tiles. It never leaves the row; when a page needs width it *yields* by falling
  into its filmstrip rather than disappearing.

The top bar carries the workspace you are on and the account a push from it goes out as, plus a
**ledger**: "1 waiting for a decision", "1 stopped on an error". Each reading opens one of the sessions
it counted. A run that finished while nobody watched is not in it — it wants nothing from you.

The board and the pull requests are **one repository's**, so they are not in the rail: they open from
that repository's own row, into a panel on the other side of the deck.

![One terminal zoomed near-full, the other sessions reduced to a filmstrip of cards below it — each card carrying its name, state, branch and token count.](docs/images/zoom.png)

*Double-click a tile's header and it takes the window; the rest become a filmstrip. The cards carry no
terminal on purpose — at that size a terminal is texture, not information, so the space goes to the
four things worth knowing about a session you are not watching.*

## Sessions

- **State you can read across a dozen tiles.** "Finished a turn" and "waiting for a decision" are
  separate on purpose: an interactive `claude` parks at the prompt when it is done, which is not the
  same as being blocked on a permission request.
- **They name themselves.** A session started with no scenario and no card takes its name from Claude
  Code's transcript, so six rows reading `session · myproject` become six topics. The name says what
  the conversation *started* as; rename any tile with `F2` or the pencil, and emptying the field brings
  the automatic name back.
- **Nothing is torn down without asking.** Quitting names the sessions with something running in them
  and waits. What is killed is the whole process *session*, so a `npm run build` inside a shell dies
  with it rather than outliving the app.
- **Restart resumes the conversation** (`claude --resume`), and yesterday's tiles come back on launch.
- **Broadcast** types one thing into several sessions at once.
- **A floating pill** counts the sessions blocked on a decision, so you can step away from the window
  and still know when one needs you.<br /><img src="docs/images/pill.png" alt="A small floating pill reading “3 waiting for input”." width="240" />

Sessions are children of the app: there is no detached mode, and the scheduler only fires while the
window is open. Missed runs are not lost — each scheduled scenario catches up once on the next launch.

## Workspaces

A workspace is a project folder, a colour, and a GitHub account.

**The account is the workspace's.** Bind one and its sessions start with that access already in place:
`gh pr list`, `git push` and the authorship of commits all go out as the right person, and two
workspaces run on two accounts *at the same time*. The app stores **no tokens** — the account name is
all that is saved, and the token is read from `gh`'s keyring when a session starts. It never runs
`gh auth switch`, which is exactly why your own terminal outside the app keeps whichever account was
active there.

**A shell drawer per workspace.** `Cmd+J` (`Ctrl+Shift+J` elsewhere) opens ordinary interactive shells
under the deck, started in the workspace's folder and carrying its account — and saying so in one line
before the first prompt, naming the folder, the branch, the account and the git identity it will commit
as. That line is the only way to check the identity: the binding is injected as `GIT_AUTHOR_*`, which
outranks `.git/config`.

**A workspace can have a window of its own.** Pull one out — a button on its row, or drag it out on
macOS — and it gets a window holding that workspace and nothing else: no rail, no other projects, no
app-wide settings to confuse for the project's. In the main window it stays where it was, marked as
elsewhere, with its sessions still listed; clicking either raises the window that has them.

![A workspace pulled out into a window of its own: one workspace, its sessions, its board and pull requests, and no rail at all.](docs/images/workspace-window.png)

## Work: cards, issues, pull requests

**A board per workspace**, from one of two sources — never both.

*Markdown cards* in `.cowork/tasks/` (or any folder you point at — a dedicated repo, an Obsidian
vault). The steps and card kinds live in a `board.json` beside them, so one project runs
`backlog / todo / doing / shipped` and the next just `open / done`. `Cmd/Ctrl+Shift+T` files a card
without leaving the deck, ▶ launches a session with the card as its prompt, and sessions file their own
cards through a bundled `cowork_task` CLI — a side finding becomes a ticket instead of scope creep.
"In progress" is derived from live sessions, never stored, so nothing gets stuck there.

![The board: configured columns of cards, each card carrying its kind and the arrows that move it, one card in the working step marked as having a session running on it.](docs/images/board.png)

*Or the repository's own GitHub issues*, read under the workspace's account. ▶ opens a session on a new
branch in a worktree of its own; ✓ closes the issue, after asking. Issues open as documents — the body
rendered, the labels and the link to GitHub beside it.

![The same board reading a repository's GitHub issues, filtered by state and label, each row deep enough to show an excerpt of the body.](docs/images/issues.png)

**Pull requests** list under the same account: the checks, the review verdict, and how long ago each
moved. Four check states are distinguished and "no checks" is never shown as success. ▶ opens a session
on the pull request's branch in a worktree beside the workspace, never inside it. Merge is pinned to
the commit that was on screen — if the branch moved since the last refresh, the merge is refused and
you are asked to look again.

![A pull request's diff open in the workspace panel: two sticky line-number columns, + and − markers, added and removed bands.](docs/images/pull-requests.png)

*Colour is the third channel in the diff, never the channel: the two bands measure ~1.0 against each
other, so the literal `+` and `−` in their own column do the work.*

## Scenarios, schedules, and the journal

A **scenario** is a saved prompt under a name, launched as a session in one press — pinned to one
workspace or offered in all of them. Each distinct `{{name}}` in the prompt becomes a field in a small
form at launch; a prompt with no placeholders asks nothing. Placeholder names are matched by letter
rather than by ASCII, so a prompt written in any script names its fields in that script.

Attach a **schedule** (hourly, daily at `HH:MM`, weekly) and it fires unattended into a fresh session
using stored defaults. It runs on *your* machine through *your* Claude Code — no cloud agents, no extra
cost, full local context and permissions. A scenario whose previous run is still working or waiting
skips rather than stacking a second one.

Every run is **journalled**: how it started, how long it took, the final message. The journal lists them
newest first, filterable by scenario and by trigger, and a row that produced nothing says *which*
nothing it was. Records are immutable; erasing exists at one granularity — one scenario's history,
wholesale. Recording can be switched off, and the screen says so rather than looking empty.

## Memory sync

Workspaces, scenarios and the journal of what has run can live in a private GitHub repository of your
own, so a second machine has them without anyone copying files by hand. Off until you switch it on.

**What travels:** workspaces and their bindings, scenarios, the run journal (one file per machine, so
two never collide), and the memory corpus — which is a place kept for project memory rather than a
thing you have yet; see the roadmap. **What does not:** session layout, window state, terminal drawers,
connected accounts — the repository is an allowlist, and a test asserts the tracked set equals it
exactly. Absolute paths never travel: a workspace arriving from another machine has no folder here until
you point it at one, and a schedule arrives switched off so a 03:00 job does not start firing on two
machines. Conflicts are not resolved for you — notes are prose, and an automatic merge produces a
plausible paragraph nobody wrote.

See [ADR-0006](docs/adr/0006-the-config-directory-is-the-sync-repository.md) for why the config
directory *is* the repository.

## Install

Prebuilt bundles are on the [releases page](https://github.com/followLemmi/cowork-deck/releases): a
`.dmg` for macOS (Apple Silicon and Intel), an AppImage, `.deb` and `.rpm` for Linux. There is no
published Windows build yet — Windows means building from source.

<details>
<summary><b>macOS says the app "is damaged"</b></summary>

<br />

It is not. That wording is Gatekeeper's, and what it means is that the app is not notarized — there is
no paid Apple Developer account behind this project, so macOS quarantines the download instead of
checking a signature. Clear the flag once:

```bash
xattr -cr /Applications/cowork-deck.app
```

System Settings → Privacy & Security → "Open Anyway" is the same decision through the UI. And if you
would rather not clear a flag Apple set on a stranger's binary — fair — everything in the bundle is in
this repository, and `npm run tauri build` produces the same app from source.

</details>

## Build and run

**Prerequisites:** [Node.js](https://nodejs.org/) + npm, a [Rust toolchain](https://rustup.rs/), the
[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/), and Claude Code itself.

```bash
npm install
npm run tauri dev      # hot reload
npm run tauri build    # a release bundle for this platform
```

```bash
npm test                                            # frontend (vitest)
npm run contrast                                    # every colour pair the design claims
cargo test --manifest-path src-tauri/Cargo.toml     # backend (Rust)
```

> In a fresh clone or worktree, run `npm install && npm run build && npm run stage:reporter` once
> before `cargo test`: neither `dist/` nor `src-tauri/binaries/` is in git, and Tauri's build script
> fails without them.

**Two environment variables**, both optional: `COWORK_CLAUDE_PATH` pins a `claude` that is not on
`PATH` (without it, and with none found, the app says so on startup), and `COWORK_GH_PATH` does the
same for `gh`.

**The memory sidecar** is a separate crate under `crates/cowork-memory`, built and tested on its own
(`npm run stage:memory`). Its tests use a deterministic fake embedder; the ones needing the real model
are `#[ignore]`d.

## The design

The interface is a design system of its own — **True Ink**: a near-black, faintly cool ground where
**hue belongs to state**, so green, amber and red mean working, waiting on you and broken, and are
never spent on decoration. The accent is light itself, elevation is lightness rather than shadow (on
this ground a cast shadow has nowhere to go), and the terminal deliberately does not follow the
palette — it is a window onto another program, and those six ANSI hues are Claude Code's.

Every colour pair it claims is measured by `npm run contrast`, which fails if one falls under its
threshold and documents the three that deliberately do. The reasoning, the tokens, the mockups and the
measurements are in [docs/design/true-ink](docs/design/true-ink/README.md).

## Graceful degradation

State tracking depends on Claude Code's hooks reporting back. On an older `claude`, or if a hook fails
to fire, the terminal is unaffected — you can type, scroll and work normally. The only symptom is a tile
whose state label stays on `idle`.

## Roadmap

Work is tracked in [GitHub issues](https://github.com/followLemmi/cowork-deck/issues); the epics below
are the shape of it. Decisions worth outliving their issue are in [`docs/adr/`](docs/adr/).

### Being built next

| | |
|---|---|
| **Project memory** [#35](https://github.com/followLemmi/cowork-deck/issues/35) | The piece the app is missing rather than a piece it improves. Semantic search over what earlier sessions actually did and decided — for you, and for the agents through an MCP tool of their own. The corpus fills itself: a session writes its own summary when it closes, so nothing depends on anyone keeping notes. Local, like everything else here — the embedding model runs on your machine and the index never leaves it. The sidecar under `crates/cowork-memory` is built and tested; what is left is the app around it. |

### After that

| | |
|---|---|
| **Activity** [#323](https://github.com/followLemmi/cowork-deck/issues/323) | A tile says what a session **costs**. It says nothing about what it **did**. A panel that answers which tools ran, which subagents ran them and how many times — read from the agent CLI's own session log, Claude Code [#325](https://github.com/followLemmi/cowork-deck/issues/325) first. |
| **Limits** [#301](https://github.com/followLemmi/cowork-deck/issues/301) | Many sessions draw on one budget, and when it runs out they stall together. What each connected AI has left, where that number came from, and a pill that says "nothing moves until 19:00" instead of "3 waiting" [#305](https://github.com/followLemmi/cowork-deck/issues/305). |
| **Frame rate** [#261](https://github.com/followLemmi/cowork-deck/issues/261) | Dragging a grip or resizing the window gives up three quarters of the display's frame rate. Measured, with the work that follows from the measurements. |

### Later

| | |
|---|---|
| **Remote decks** [#273](https://github.com/followLemmi/cowork-deck/issues/273) | A desktop and a laptop are two decks with no way to see one from the other. A headless core, an ssh transport, and another machine's sessions in this window — scrollback replayed on attach, one notification on the machine its person is at. |
| **Sessions that spawn sessions** [#178](https://github.com/followLemmi/cowork-deck/issues/178) | Work across five repositories today means a person acting as the message bus between five tiles. A guarded spawn channel and a `cowork_session` sidecar, so one session can start a colleague. |
| **More agent CLIs** [#330](https://github.com/followLemmi/cowork-deck/issues/330) | Codex, Copilot and opencode read first — their session logs are the activity panel's second, third and fourth sources — then run. |
| **UI localization** | A language switch and translated strings. The interface is English-only today, deliberately and by written rule — which is a decision about the source, not about the person using it. |

## Where things are written down

Two places and no third: **GitHub issues** carry the work, and **[`docs/adr/`](docs/adr/)** carries the
decisions worth outliving the issue that prompted them. `CLAUDE.md` at the root is the contract for
anyone — human or agent — sending a change: English everywhere that outlives a conversation, `dev` as
the trunk, `main` as the released state.

The screenshots above come from [`harness/`](docs/images/README.md), which is the app itself with the
backend replaced by fixtures: real xterm instances holding real bytes, invented accounts and
repositories. A re-shoot is a re-shoot, and nobody's paths are published.
