# Design: a board a project configures, on a screen of its own

## The problem

The tracker works, but the board it draws is not yet a board.

**The two screens are one screen.** `setView(true)` puts `tk-hidden` on `#deck`
and expects `.tk-hidden { display: none }` (`styles.css:416`) to take it away.
It does not: `#deck { display: grid }` on line 74 is an id selector and outweighs
a class one, so the terminals stay put and `#board` — correctly taking `flex: 1`
— opens beside them. The result reads as a panel on the right, which is not what
the code intends and not what anyone wants. `layout.test.ts` missed it because it
asserts the class, not the resulting `display`.

**Cards are whatever height their content makes them.** An unbounded title plus
a full `damaged:` paragraph carrying a filesystem path means no two cards in a
column line up, and the column cannot be read at a glance.

**A card cannot be opened.** `Task.body` already crosses the IPC boundary and is
shown nowhere. There is no way to read a card in the app, and no way to edit one
at all: the provider offers `create` and `resolve`, and nothing else.

**The workflow is hard-coded.** `TaskKind` is `bug | task | idea` and
`TaskStatus` is `open | done`, both `Copy` enums in `tasks/model.rs`. A project
that thinks in backlog → todo → in progress → review → done cannot say so.

## Scope

One change, four outcomes: a board that a project configures, on a screen of its
own, with cards of one size that open for reading and editing.

In scope:

- The view switch actually switching, and the sidebar showing only what the
  board screen can use.
- `board.json` in the project's card folder: ordered steps and card kinds.
- `StepId` / `KindId` replacing the two enums, and the frontmatter parser giving
  up its opinion on which values are valid.
- Cards of fixed height; a modal that reads and edits a card.
- Moving a card by dragging it, and by keyboard.
- A `⚙` editor for steps and kinds, including what happens to cards when a step
  is renamed or removed.
- The session moving its own card: `COWORK_TASK_ID`, three new `cowork_task`
  subcommands, and two hooks that keep the agent from forgetting.

Out of scope:

- Deleting a card from the app. Deleting a file inside somebody's Obsidian vault
  deserves its own conversation.
- Renaming a card's file when its title changes (see "The file keeps its name").
- Per-kind colours, swimlanes, filters, search.
- Anything about the GitHub and Jira providers beyond leaving
  `ProviderCapabilities` able to describe them.

## The configuration file

`board.json`, in the project's card folder — the directory
`tasks_cmd::resolve_root` hands to the app and to every session as
`COWORK_TASKS_DIR`. The card scan does not see it: `fs.rs:93` accepts only
`.md`.

```json
{
  "v": 1,
  "steps": [
    { "id": "open", "label": "open" },
    { "id": "done", "label": "done", "terminal": true }
  ],
  "kinds": [
    { "id": "bug", "label": "bug" },
    { "id": "task", "label": "task" },
    { "id": "idea", "label": "idea" }
  ]
}
```

The order of `steps` is the order of the columns. `"v"` is named as
`TrackerConfig`'s version field is (`model.rs:134`), so versioning looks the same
everywhere in this project.

A step carries `id` and `label` and two optional flags:

- **`terminal`** — the target of `✓`, and "closed" for the sidebar counts. At
  least one is required; exactly one is not. That way a `cancelled` step can join
  `done` later without touching the model. `✓` and `cowork_task done` move a card
  to the first terminal step in order.
- **`working`** — at most one. `▶` moves a card there when it launches a
  session. With no step flagged, `▶` writes nothing, which is exactly today's
  behaviour — a special case of the new rule rather than a branch beside it.

A kind carries `id` (written to `kind:`) and `label` (shown on the card).

### Validation

Checked when the file is read, and again in the editor before it is written:

- `steps` is not empty; `id`s are unique, non-empty, and free of whitespace —
  they go into YAML frontmatter unquoted and into a CLI argument.
- At least one step has `terminal: true`.
- No more than one step has `working: true`.
- `kinds` is not empty; `id`s are unique and non-empty.

### A file we cannot read is not a file we overwrite

An unparseable or invalid `board.json` does not blank the board and is never
rewritten. The app falls back to the default two-step configuration and shows the
parse error in the banner — `BoardState.error` already carries exactly this kind
of message. Overwriting the file would erase a typo together with whatever the
person meant to write; they can fix it themselves, and they need to see the error
to do it.

### Creation

No file means the app writes the default above when the board is first opened for
that workspace: `open` and `done`, `done` terminal, and today's three kinds. At
that moment the board looks exactly as it does now.

### The configuration follows the cards

`migrate.rs` moves cards to a new root. If the destination has no `board.json`,
migration copies the source's. Without this, moving cards resets the workflow to
`open`/`done` and every migrated card lands in the unknown-step column. This is
correctness, not convenience.

## Model

`StepId(String)` and `KindId(String)` — newtypes, not bare `String`. A step id
and a kind id are both strings and both travel through the same functions
(`cowork_task status <id> <step>`, the drag handler, the modal's selects), so
swapping them is a mistake worth having the compiler catch. `Task.status: StepId`
and `Task.kind: KindId`.

`BoardConfig` is the only authority on which values are legal, exposing
`terminal_steps()`, `working_step()`, `has_step()`, `has_kind()`.

`ProviderCapabilities.statuses` finally carries something: the configured step
ids, in order. The field has existed since the provider trait was written
(`provider.rs:12`) and has never been populated — it is what a provider of any
kind, Jira included, can say about its own workflow.

It is not enough for the frontend, which also needs labels, the two flags, and
the kinds. So `taskCapabilities` returns the `BoardConfig` alongside the
capabilities, and `statuses` is derived from it. One IPC call, one source: the
board, the modal's selects and the `⚙` editor all read the same object, and there
is no second channel to fall out of step with the first.

Because that authority moves, `frontmatter.rs:57-69` gives up its own. An
unrecognised `status:` or `kind:` no longer damages a card; the parser reads the
string and passes it on. `damaged` keeps the meaning it had before those two
cases were folded into it: a missing `id`, `title`, or `project`.

### The unknown-step column

A card whose `status:` is not in the configuration is alive — it keeps `▶` and
`✓` — and appears in a column of its own at the end of the board, rendered only
when something is in it.

It exists for values that arrive from outside the app: a `board.json` edited by
hand, or one synced from another machine. It is not how the `⚙` editor leaves
things.

Such a card has no `‹` or `›`: its step is not in the ordered list, so there is
no step before or after it. It moves through the modal's step select, which lists
the card's own unknown step as the current value — otherwise opening a card and
saving an unrelated edit would move it somewhere without being asked to.

### Rewriting cards

Changing a step's `id`, or removing a step that still holds cards, rewrites
`status:` in the cards concerned. The rewrite goes through
`frontmatter::set_fields`, which preserves keys it does not know, and touches only
cards whose `project:` matches — a shared vault root holds other projects' cards,
and `fs.rs::resolve` already refuses to write those. The report has the shape the
root migration's does: how many were rewritten, which were not, and why.

## The board screen

**The switch.** `#deck.tk-hidden { display: none }` — id-plus-class beats id, so
`display: none` wins. Its test asserts the resulting `display`, not the presence
of the class; asserting the class is how this bug shipped.

**The sidebar.** On the board screen it shows WORKSPACES with its open counts and
nothing else. SCENARIOS, `+ session` and SESSIONS are hidden, and come back on
the terminals screen. Workspaces stay because the board shows one workspace at a
time and switching between them is the point.

**The columns.** `grid-template-columns: 1fr 1fr` goes away: there are as many
columns as the configuration has steps. `grid-auto-flow: column` with
`grid-auto-columns: minmax(240px, 1fr)`, and horizontal scrolling on the column
wrapper — the wrapper scrolls, never the page.

The cap on a long column stays the mechanism it is today (`doneLimit = 20`, a
`done (3+17)` heading) but applies only to terminal steps. Non-terminal columns
show everything: a card in `todo` hidden behind a limit is a lost task.

**The card.** Fixed height. The title clamps at two lines; the meta row and the
button row are pinned to the bottom, which is what makes them line up across
cards rather than nearly line up. `damaged` and `conflict` collapse into a `⚠`
glyph with `title` and `aria-label`; their full text, with the file path, moves
into the opened card.

Buttons, in order: `‹`, `▶`, `✓`, `›`. `‹` and `›` move the card one step back
and forward and are absent at the ends. The existing rules for hiding `▶` and
`✓` (`board.ts:185-202`) are unchanged: `▶` is hidden while a session is live and
on a damaged card, `✓` on a damaged or conflicting one.

`derivedStatus()` shrinks accordingly — the column now comes from the file. What
remains is the live-session marker ("in progress", pulsing) and a second, new
one: the card sits in the `working` step with no session running. That stale
state is possible precisely because `▶` now writes the step, so the board says
so — `no live session`, explained in `title`.

**Dragging.** Cards are `draggable`; columns are drop targets. A drop writes the
step optimistically and reconciles on the next refresh — the board re-reads
`listTasks` every five seconds anyway, so a failed write corrects itself, but the
error still has to be shown or the card just silently jumps back. The
unknown-step column is not a drop target: it is not a step.

## The opened card

A modal built on `openDialog`, the same shell the creation form uses. Editable:
title, kind, step, body. Below them, read-only: `id`, `created`, `resolved`,
`origin`, `session`, the file path — and the full `damaged` or `conflict` text
when there is one.

Saving goes through a new `task_update` command carrying only the fields that
changed.

### The file keeps its name

A card's filename is a slug of its title (`fs.rs:288`), but its identity is its
`id`. Editing the title does not rename the file: a rename would break links in
Obsidian and make the watcher report a delete followed by a create instead of an
edit.

### Damaged and conflicting cards are not written

For the same reasons `resolve` refuses them. A card missing `project:` may be an
ordinary vault note that happens to carry an `id:`, and when two files claim one
`id` there is no way to know which to write. The modal says so and shows the
path, so the person can repair it in their own editor.

### Saving does not clobber concurrent edits

Between opening the modal and pressing Save the file may have changed — an agent
moved the step, a sync brought another machine's version. So Save re-reads the
file and applies, via `set_fields`, only the fields the person actually touched.
The body is rewritten only if they edited the body.

## Moving a card between steps

Three writers, deliberately overlapping, because each covers the others' failure:

1. **`▶`** writes the `working` step when it launches a session. This does not
   depend on an agent remembering anything.
2. **The session** moves the card onward with `cowork_task status` — through
   review, to done — because it is the party that knows what it just did.
3. **The person** drags a card, uses `‹` / `›`, or picks a step in the modal.

## What the session gets

**`COWORK_TASK_ID`** joins `COWORK_TASKS_DIR` and the rest in the launch
environment (`commands.rs:63`). `start_session` takes an optional `task_id` for
it; the frontend already has the value, since `SessionEntry.task_id` has been in
the model from the start (`model.rs:214`). It is set on `--resume` too — without
that, a restored session loses its card and all three layers of reminding switch
off silently.

**Three new `cowork_task` subcommands:**

- `status <id> <step>` — moves the card. An unknown step is refused with the
  legal ones listed, so the agent can correct itself instead of guessing. Damaged
  and conflicting cards are refused as `done` refuses them.
- `steps` — prints the configured steps, one `id` per line in board order, with
  a trailing marker on the terminal ones. One id per line because an agent will
  pipe it, and because the skill has to be able to describe the output without
  knowing the project. This is what keeps the `file-a-task` skill
  project-agnostic: it cannot name one project's `backlog` and `todo`, but it can
  say to ask.
- `guard` — reads a hook's JSON on stdin and prints what that hook expects. One
  subcommand for both events, because their decision is the same one: look at the
  card named by `COWORK_TASK_ID` and at the step it is in.

`done` keeps working and now means "move to the first terminal step". Nothing
already written into a prompt or a skill breaks.

**Hooks.** `hooks.rs` currently attaches one command per event, the reporter. The
settings format allows several, so `UserPromptSubmit` and `Stop` gain a second,
`cowork_task guard`. The reporter's job does not change.

The hooks are attached to **every** session, not only to ones launched from a
card. With no `COWORK_TASK_ID` the guard allows and exits. That is one branch
instead of two when building the settings, and one less thing to forget on the
`--resume` path.

- `UserPromptSubmit` returns `additionalContext`: one line naming the card, its
  current step, and the command that moves it. Tens of tokens per turn, and only
  when a card is attached. This is the layer that fights forgetting, because the
  instruction lives in recent context instead of in the session's first message.
- `Stop` blocks once when the card is in a non-terminal step. Once, because the
  payload carries `stop_hook_active`: when it is set, the guard allows. Otherwise
  the session cannot get out.

### The guard never holds a session hostage

Unreadable `board.json`, missing card, failing disk, damaged card, step already
terminal — every one of these exits 0 and allows. A tracker problem must not take
the work hostage. This is the principle the watcher already follows: its failure
degrades into a delay, not a breakage.

**Prompt and skill.** `taskPrompt` (`src/tasks.ts:29`) gains a line about
`status` listing the actual steps — the board has the configuration. The
`file-a-task` skill gains the same, via `cowork_task steps`.

## The `⚙` editor

A modal on `openDialog`, opened from `⚙` beside `+ task`. Steps: reorder with
up/down, `terminal` and `working` as toggles, add, remove. Then the same for
kinds. Every validation rule above is checked before the file is written, not
while writing it.

**Editing a `label` changes nothing on disk.** Renaming a column from `open` to
`Open items` is an ordinary, safe action; no card is touched.

**Editing an `id`** is the case that rewrites cards: the editor says how many are
affected and rewrites `status:` after confirmation. This is for when the files
themselves should read `todo` rather than `open`.

**Removing a step that holds cards asks where to move them**, and moves them.
There is no plain remove: it would deliberately manufacture the unknown-step
column, which exists as a safety net for edits made outside the app, not as a
result the editor produces. Kinds behave the same way.

## Error handling

Every new IPC call is wrapped on its own, as `refreshBoard` already wraps its
calls: one failing handle must not take a tick down.

A failed write — a drop, a save, a rewrite — states its reason in a modal, and
the board re-reads from disk. The files are the source of truth, not what is
currently drawn.

A partial rewrite reports as the root migration does: how many succeeded, which
did not, and why.

An invalid or unreadable `board.json` falls back to the default configuration,
shows the parse error, and leaves the file alone.

## Testing

**Rust**

- Each validation rule, separately: empty `steps`, duplicate ids, whitespace in
  an id, no terminal step, two `working` steps, empty `kinds`.
- An invalid `board.json` yields the default configuration plus an error, and the
  file on disk is byte-identical afterwards.
- The default file is created on first read when absent.
- Root migration copies `board.json` when the destination has none, and leaves an
  existing one alone.
- `status` moves a card; an unknown step is refused and the message names the
  legal steps; damaged and conflicting cards are refused.
- `guard`'s decision table — non-terminal step blocks; terminal step allows;
  `stop_hook_active` allows; missing `COWORK_TASK_ID` allows; missing card
  allows; unreadable configuration allows.
- A rewrite touches only cards whose `project:` matches, and preserves unknown
  frontmatter keys.
- `task_update` refuses damaged and conflicting cards, and writes only the fields
  it was given.

**TypeScript**

- `boardColumns` with N steps: order follows the configuration, the unknown-step
  bucket collects what the configuration does not know, and the cap applies to
  terminal steps only.
- A card renders its meta row and button row whatever its content, so the fixed
  height holds; a long title clamps rather than growing the card.
- The `no live session` marker appears for a card in the `working` step with no
  live session, and not otherwise.
- `‹` and `›` are absent at the first and last step.
- The unknown-step column rejects a drop.
- The modal's patch contains only the fields that changed.
- `#deck`'s resulting `display` is `none` on the board screen, and the sidebar's
  hidden blocks resolve to `none` as well. Asserting the class instead of the
  computed value is what let this bug ship.

**Expectations that invert on purpose**

`frontmatter.rs` currently asserts that an unrecognised `status` or `kind` marks
a card `damaged` (around `frontmatter.rs:267-273`). This design removes that
judgement from the parser and gives it to the configuration, so those assertions
are rewritten rather than repaired. Saying so here keeps the change from reading
as a regression at review time.

Also updated: `board.test.ts`, `tasks.test.ts`, `task-form.test.ts`,
`layout.test.ts`, and the `cowork_task` tests.
