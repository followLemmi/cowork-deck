# CONTEXT — the vocabulary of the deck

`docs/agents/domain.md` asks that anything naming a domain concept — an issue title, a test
name, a refactor proposal — use the term as this file defines it, and not drift to a synonym.
This is that list. It says what each word means *here*, and where two words are deliberately
close it says what separates them, because those are the pairs that get confused.

It is not a description of the interface; the README is that, and it is the place to look for
what the app does. Nor is it a decision record: a decision and its reasoning go in
`docs/adr/`, and the entries below name the ADR where one settles the meaning.

## The window

**Deck** — the row of tiles, and the app's name. It never leaves the window: a page that
needs the width makes the deck *yield* into a filmstrip rather than replacing it. "The deck"
in prose is the tiles; "cowork-deck" is the product.

**Tile** — one session on screen: a real terminal, its name, its state, its branch, its
token count. A tile is a session's presentation. It is not the session — a session survives a
tile being torn out into another window, and a tile in the filmstrip carries no terminal at
all.

**Rail** — the three icons that decide what the panel holds (tree, journal, scenarios), with
Settings at its foot under a gap, because Settings changes nothing about the panel.

**Panel** — the surface beside the rail. The tree of workspaces and their sessions, the
journal, or the scenarios. One panel, three contents.

**Tree** — workspaces and their sessions as one hierarchy, a workspace appearing once with
its sessions as children. Creation is positional: the last row in a group is *New session in
`<name>`*, standing where the new session will appear.

**Ledger** — the readings in the top bar that count what wants a person: "1 waiting for a
decision", "1 stopped on an error". A run that finished unwatched is not in it, because it
wants nothing. Each reading opens one of the sessions it counted.

**Filmstrip** — the reduced form of the deck when a tile is zoomed or a page takes the width.

**Drawer** — the shell terminals under the deck (`Cmd+J`), one per workspace, started in its
folder and carrying its account. Momentary by design: it does not survive a restart. Not to
be confused with the **diff drawer**, which is the pull request's diff.

**Status area** — the menu bar on macOS, the notification area on Windows. It answers on
demand: a click drops the **tray panel** under it. The **dock** (or taskbar) is the other
surface, and it carries the count. The panel never carries a count and the dock never carries
detail — see ADR-0013.

**Meter** — a limit drawn as a bar. A **reading** is the number itself. A reading always
carries its **source**, and that is a rule rather than a habit: see ADR-0009.

## What runs

**Session** — a PTY-backed `claude` in a workspace's folder, with a name, a state and a
transcript. Sessions are children of the app: there is no detached mode, and the scheduler
only fires while the window is open.

**State** — what a session is doing, and the two that matter most are separate on purpose:
*finished a turn* is an interactive `claude` parked at its prompt with nothing owed;
*waiting for a decision* is blocked on a permission request. Collapsing them would make the
ledger a lie.

**Turn** — one exchange. The hooks report most of them; a turn the hooks do not report is
read off the terminal's own screen, which is ADR-0015.

**Activity** — which tools a session ran, read from the agent's own log rather than from the
hooks the deck installs (ADR-0008). Distinct from **usage**, which is what it cost.

**Broadcast** — typing one thing into several sessions at once.

## Where work is

**Workspace** — a project folder, a colour, and a GitHub account. The unit almost everything
belongs to: sessions, boards, scenarios, schedules and notes are all a workspace's. A
workspace's identity across machines is its remote (ADR-0007), or its folder where there is
no remote (ADR-0010).

**Worktree** — a git worktree beside the workspace, never inside it, where a session launched
from an issue or a pull request runs.

**Board** — a workspace's work, from one of two sources and never both: markdown **cards**
under `.cowork/tasks/`, or the repository's own GitHub **issues**. A **step** is a column;
the steps and card kinds are configuration, so one project runs
`backlog / todo / doing / shipped` and the next runs `open / done`. "In progress" is derived
from live sessions and never stored.

**Scenario** — a saved prompt under a name, launched as a session in one press. Each distinct
`{{name}}` in it becomes a field at launch. Matched by letter rather than by ASCII, so a
prompt in any script names its fields in that script.

**Schedule** — a scenario firing unattended (hourly, daily, weekly). It belongs to one
workspace — the one open when it was saved — and the scheduler resolves that before firing,
so an unattended run cannot land in whatever project was on screen at 03:00.

**Journal** — the immutable record of every run: how it started, how long it took, the final
message. Erasing exists at one granularity, one scenario's history wholesale.

## Memory

**Note** — what a closed session leaves behind, written by a model, markdown on disk under
the workspace's directory. It is somebody's notes, indexed — not a record of truth. Its
`## TL;DR` is what a search reads first.

**Capture** — the one model call per closed session that writes the note: consented at the
close, owed to a queue, and charged to the user's own account. ADR-0014.

**Fact** — a durable claim, one line in `Facts.md`, appended and never rewritten. Replacing
one marks the old line and puts the new one under it, so the corpus can still say when it
changed and to what (ADR-0004).

**Diary room** — where a lesson worth carrying to *another* project is filed. Rooms are
global on purpose: that is what lets a mistake made in one repository stop the same mistake
in the next.

**Corpus** — every note, fact and lesson on this machine, rooted at the config directory.
The markdown is the memory; the **index** is a cache that may be thrown away (ADR-0004).

**Sidecar** — a helper binary bundled beside the app: `cowork_report` (the hooks' reporter),
`cowork_task` (the CLI a session files a card with), `cowork_memory` (the indexer). The
indexer is a sidecar because `ort` links ONNX Runtime — ADR-0003.

## Sync

**Config directory** — where the deck keeps workspaces, scenarios, the journal and the
corpus. It is *also* the sync repository (ADR-0006), and one instance per config directory is
the rule a lock in it enforces (ADR-0012).

**Sync** — the config directory as a private GitHub repository, off until switched on. What
travels is workspaces and their bindings, scenarios, the journal (one file per machine, so
two never collide) and the corpus. Credentials never do (ADR-0001).

## Two words this project avoids

**"Project"** in code and in issues means a **workspace**. The README says "project folder"
where it is talking to a person about their disk; a symbol, a test name or an issue title uses
`workspace`.

**"Tab"**. There are none. A tile is a tile and a page is a page.
