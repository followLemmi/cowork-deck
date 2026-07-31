# Design: GitHub Issues as the board's second source

## The problem

The board works, and it works on markdown files. That was the right first
implementation — it made the tracker useful without a network, a token or a
schema — but it also means that for any repository whose backlog already lives
on GitHub, the deck's board is a second, parallel, permanently diverging list.
Nobody keeps two backlogs. So on those workspaces the board sits empty and the
issues stay in a browser tab, which is exactly the context switch the tracker
was built to remove.

The tracker spec anticipated this and left a port for it (`TaskProvider`,
`provider.rs:29`). What it did not anticipate is how much of the board's
behaviour reaches *past* that port: the board configuration, the migration
banner, the directory watcher, the sidecar the agent writes through, and the
five-second poll all assume a folder. The port is real; the seam around it is
not yet.

## Goal

Make the existing Board screen show a repository's open issues, with the same
three actions the file board offers — start a session, close, create — and with
the same honesty about what is stale and what is missing. One task source per
workspace, chosen once, never merged.

## Scope

**In:**

1. A second `TaskProvider` over `gh issue list`, rendering on the **existing**
   Board screen. Not a fourth view.
2. Exactly one task source per workspace, chosen in the workspace settings form.
3. A synthesized, non-editable two-step board: `open` and `closed`.
4. All open issues in one page, with an honest "showing N of M".
5. ▶ — a git worktree on a new branch off the repository's default branch, and a
   session inside it, linked to the issue.
6. ✓ — close, with a confirmation and a close reason. Reopen, without one.
7. `+ task` → `gh issue create`.
8. Provider-shaped session injection: a session in a GitHub workspace is never
   told about `board.json`, a cards directory, or the `cowork_task` sidecar.
9. Polling paced against the GraphQL budget, gated on view and focus, with a
   visible data age and a last-good cache.

**Out, and where it goes instead:**

- **Comments and review threads.** The conversation is the third spec of the
  pull-request group; issue comments belong with it, and `gh issue list --json
  comments` returning `[]` on the row is not a reason to build a thread view
  here.
- **GitHub Projects columns and status fields.** `projectCards` and
  `projectItems` are on the row (verified), and a Projects status field is
  exactly the multi-step board the ⚙ editor draws — which is the point: mapping
  it means mapping *writes* to it, and `gh` has no issue-side command for that.
  There is also a hard gate: both fields fail the **entire** request without the
  `read:project` scope, which the app does not require of a bound account
  (`github.ts:27`). Its own spec, on top of this one, and it starts with a scope.
- **More than one provider at a time.** `TrackerConfig.providers` is a `Vec`
  (`model.rs:151`) but every reader takes `.first()` (`tasks_cmd.rs:156`, `:202`,
  `:264`), so one-source-per-workspace is already enforced by construction. Two
  simultaneous sources would need a merge rule, a conflict rule, and a per-card
  "which source" marker — three decisions with no demand behind them.
- **Filters.** `-a` assignee, `-A` author, `-l` label, `-m` milestone, `-S`
  search all exist and none is offered. A filter you can set is a filter you can
  forget you set, and then the board is lying about what is open. Decision 4.
- **Notifications, and polling while the board is not on screen.** Same refusal
  as the PR view, and decision 7 shows the arithmetic that makes it a refusal
  rather than an omission.
- **Labels, assignees and milestones on create.** `gh issue create` takes
  `-l/-a/-m`, but each needs the repository's list of them fetched into a form
  control. An issue can be labelled after it exists.
- **Jira.** Its own spec. This one is what makes it cheap: after this, adding a
  provider is a `TaskProvider` implementation plus a `TrackerProvider` variant,
  not a rework of the board.
- **Issues for a repository the machine has no clone of.** `--repo OWNER/NAME`
  works outside a git repository (verified), so this is a deliberate refusal, not
  a limitation — see decision 2 and Open question 1.
- **Pagination past the first page.** Decision 4 shows the count instead.

## Where this departs from the paragraph already written

The PR spec's "Neighbouring specs" section records the issues board as decisions
already taken. Three of them are wrong or incomplete, and this spec supersedes
them:

1. It says **`capabilities.statuses` returns `open`/`closed`, which makes the
   board two-column and finally puts that field to work.** `statuses`
   (`provider.rs:13`) is not what makes the board two-column — nothing reads it.
   The board's columns come from `BoardConfig.steps` (`tasks.ts:104`), which
   reaches the frontend through `BoardCapabilities.board` (`tasks_cmd.rs:322`),
   assembled from `FsTaskProvider::board()` (`tasks_cmd.rs:340`). The
   configurable-board work landed between the two specs and moved that
   authority. Decision 3 puts the synthesized board where the board actually
   reads it.
2. It says **`cowork_task new` files one.** It must not. The sidecar writes files
   directly and has no path back to the app (`cowork_task.rs:6-8`); giving it a
   GitHub mode means giving it a token, a repository and a second provider, to
   duplicate a command the agent already has. Decision 5 removes the sidecar
   from a GitHub workspace entirely and hands the agent `gh` instead.
3. It says **✓ closes an issue**, without saying that closing is visible to the
   whole repository while moving a card is not. Decisions 3 and 10 add the
   confirmation that difference demands.

The other two — one source per workspace, and switching warns and leaves the
cards on disk — stand as written and are elaborated in decisions 2 and 8.

## Key decisions

### 1. The port gains nothing; the board moves out of it, and `scan` stays out

`TaskProvider` has five methods — `capabilities`, `list`, `create`, `resolve`,
`update` (`provider.rs:29-35`) — and gets no sixth. Three things currently
reached through `provider_for` are not on it, and each is handled differently:

- **`board()` / `board_error()` (`fs.rs:87-88`) move up to the IPC layer.** A new
  `board_for(&Workspace) -> board::Loaded` branches on the tracker kind: for
  `fs`, today's `board::load_or_create(root)`; for GitHub, the synthesized
  constant with `error: None`. `FsTaskProvider` is then built with
  `with_board` (`fs.rs:83`) from that same result — the existing precedent for a
  provider being handed a board it did not read. One place decides the board.
  **Cost:** `FsTaskProvider::new` still reads `board.json` itself (`fs.rs:76`)
  and cannot stop, because `cowork_task` constructs a provider from environment
  alone (`cowork_task.rs:102`) with no IPC layer above it. So there are two
  readers of `board.json` in the codebase, and they must not disagree. They
  won't — both call `board::load_or_create` — but the duplication is real and
  should be stated rather than discovered.
- **`scan()` (`fs.rs:111`) stays a concrete method on `FsTaskProvider` and stays
  off the trait.** It means "every file in the root, unfiltered, with `conflict`
  already set" — three concepts a GitHub provider has none of. Its callers are
  the migration (`tasks_cmd.rs:499`), `rewrite_step` (`:705`) and `step_usage`
  (`:731`): the migration banner and the ⚙ editor, both of which must not exist
  for a GitHub workspace.
- **`provider_for` (`:309`) returns `Box<dyn TaskProvider>`,** and a second
  function `fs_provider_for(ws)` returns the concrete type for the six commands
  that need it: `tasks_migration_status` (`:534`), `tasks_migrate` (`:558`),
  `tasks_migration_dismiss` (`:594`), `board_config_save` (`:777`),
  `board_step_rewrite` (`:787`), `board_step_usage` (`:799`). Each refuses a
  non-file-backed workspace with one error.

**A correction to the seam survey this spec was commissioned from.** It reported
"7 of `provider_for`'s 9 call sites use methods that are not on the trait". The
count is different: `provider_for` has **7** non-test call sites (`:337`, `:350`,
`:361`, `:384`, `:400`, `:412`, `:731`), of which **3** touch non-trait methods —
`:337` (`board()`, `board_error()`), `:412` (`board()`), `:731` (`scan()`,
`board()`). Three further sites build an `FsTaskProvider` directly rather than
through `provider_for` (`:498`, `:704`, `:766`). The conclusion the survey drew
from its number survives its number: widening the port is real work, and six
commands end up file-only.

*Rejected:* adding all three methods to the trait. Every future provider would
then have to answer "what is your unfiltered scan" and "what is your board
configuration", and for GitHub both answers are stubs. A trait whose
implementations return stubs for half of it has stopped being a port.

*Also rejected:* an enum `TaskSource { Fs(..), GitHub(..) }` instead of a trait
object. It would make each file-only command a compiler-checked `match`, which is
attractive — but the trait already exists, and `Box<dyn>` plus one narrowing
function is less machinery than an enum whose every arm has to be visited when
Jira lands.

### 2. `resolve_root` keeps its shape; seven of its eight callers are already right

`resolve_root` (`:154`) stays `Option<(PathBuf, RootCreation)>` and keeps
answering exactly one question: *where do this workspace's card files live*. For
a GitHub-configured workspace it returns `None` — the same answer as "no tracker
configured" — and that is the correct answer for almost everything downstream.
Its eight non-test callers, verified:

| Caller | With `None` | Verdict |
|---|---|---|
| `effective_root` (`:195`) | `None` | correct; feeds the two below |
| `provider_for` (`:310`) | `Err("not-configured")` | replaced by decision 1's branch |
| `tasks_watch_sync` (`:437`) | `filter_map` drops it | correct — no files, no watcher |
| `offer_for` (`:485`) | `Ok(None)`, no migration offer | correct — decision 8 |
| `tasks_migrate` (`:563`) | `Err("not-configured")` | correct backstop; unreachable from the UI |
| `rewrite_step` (`:702`) | `Err("not-configured")` | correct — ⚙ is hidden |
| `save_config` (`:765`) | `Err("not-configured")` | correct — ⚙ is hidden |
| `start_session` (`commands.rs:632`) | no tracker env at all | **wrong, and this is the seam** |

`with_previous_location` (`:213`) and `seed_previous_location` (`:255`) reach it
through `effective_root` and both return early — see decision 8. `is_project_root`
(`:200`) matches on `providers.first()` directly and yields `false`.

So one caller needs real GitHub behaviour and seven need nothing. The new
resolution sits beside `resolve_root`, not inside it:

```rust
enum TrackerKind {
    Fs { root: PathBuf, creation: RootCreation },
    GitHub,
}
fn tracker_kind(ws: &Workspace) -> Option<TrackerKind>;
```

`resolve_root` becomes the thin projection of it that the seven path-shaped
callers keep using unchanged. `TrackerProvider` (`model.rs:169`, `#[serde(tag =
"type", rename_all = "lowercase")]`) gains a second variant, serializing as
`{"type":"github"}`; the TS mirror at `ipc.ts:231` widens from the literal
`"fs"` to a union.

**The GitHub variant carries no fields.** The repository is resolved from the
workspace's own folder — once per app run, by `gh` itself, and then passed
explicitly on every call; see decision 11. The account comes from `ws.github`,
exactly as `pr_list` already resolves it (`run_gh_for_workspace`,
`commands.rs:357-387`). Storing `owner/name` in the tracker config would be a
second source of truth that can disagree with the folder's actual remote.
**Cost:** a GitHub-backed workspace must be a git repository with a GitHub remote
— the same `no-repo` condition the PR view already has (`pr-view.ts:37-40`) — so
you cannot track a repository you have not cloned, even though `--repo` would
permit it. See Open question 1.

**A forward-compatibility cost worth naming:** `TrackerProvider` is an internally
tagged enum, so a build that predates this change cannot deserialize
`{"type":"github"}`. That failure propagates up through `TrackerConfig` to
`Workspace`, so downgrading the app after configuring a GitHub board risks the
whole workspace record reading as unparseable. Not a reason to change the
encoding — the store has no schema-tolerance mechanism to reach for — but the
implementation plan should check what `store.rs` does with a workspace that fails
to deserialize, because the answer decides whether this is an annoyance or a data
loss.

### 3. The board is two steps, synthesized, and not editable

```rust
BoardConfig {
    v: 1,
    steps: vec![
        Step { id: "open",   label: "Open",   terminal: false, working: false },
        Step { id: "closed", label: "Closed", terminal: true,  working: false },
    ],
    kinds: vec![Kind { id: "issue", label: "Issue" }],
}
```

It passes `BoardConfig::validate` (`board.rs:113`) — one terminal step, at most
one working step, a non-empty kind list. `kinds` is non-empty only because
`validate` rejects `NoKinds` (`:137`); nothing uses it, because no issue carries
a kind (decision 4).

**No working step.** A GitHub issue has no "in progress" state to write, and
`working: true` would make ▶ try to write one. The consequences fall out
correctly from code that already exists: `workingStep(cfg)` returns `null`, so
`sessions.ts::launchFromTask`'s pre-launch move is skipped (`:241-242`) and
`isStale` returns `false` (`tasks.ts:131`) — while `derivedStatus` still returns
`"working"` from a live session (`tasks.ts:28`), so the "in progress" chip
(`board.ts:266`) keeps working. That is the tracker spec's decision 11 paying
off: "in progress" was never stored, so there is nothing to store here.

**Drag and drop.** A drop on `closed` closes the issue; a drop on `open` reopens
it. Both are what the columns mean, and refusing the gesture on a board that has
exactly two columns would leave the columns decorative. But a close is visible to
the whole repository and a reopen restores the state of a moment ago, so:
**a drop onto `closed` is confirmed, a drop onto `open` is not** — the same
asymmetry, for the same reason, as the PR spec's decision 7.

Mechanically this needs both halves:

- `GhIssueProvider::update` honours a `status` patch by running `gh issue
  close`/`reopen`, because the drag handler (`board.ts:212-225`), the `‹ ›`
  arrows (`:298-340`) and the card modal all go through `tasks_update`
  (`:393`) and none of them should learn a provider name.
- `main.ts::moveTask` (`:272`) asks for the confirmation before calling it, in
  the `→ closed` direction only. The frontend has to own this: a confirmation
  raised inside the provider is a modal raised from Rust.

`update` also honours `title` and `body` via `gh issue edit`, so the card modal
saves. It refuses `kind`, which nothing can set.

**The `‹ ›` arrows stay.** With two steps each card gets exactly one arrow
(`board-config.ts:33-41`), which duplicates ✓ on an open issue and is a bare
reopen on a closed one. Redundant, and kept: they are the keyboard path, not a
fallback for the drag — xterm eats Tab inside a tile (`board.ts:290-292`) — and a
board with no keyboard route to closing would be worse than a redundant button.
`›` on an open issue takes the same confirmation as the drop.

**`⚙` is hidden.** It is currently drawn whenever a tracker is configured
(`board.ts:69`, on `if (caps)`). `BoardCapabilities` (`tasks_cmd.rs:319`) gains
`board_editable: bool`, and `board.ts:69` reads it. On `BoardCapabilities`
rather than `ProviderCapabilities` because the board is what is not editable, and
`BoardCapabilities` is where the board already lives — the serde flatten at
`:320` means the frontend sees one object either way.

**`kinds` and labels.** Issue labels are **not** kinds. `Task` gains
`labels: Vec<String>` with `#[serde(default)]` — so every existing card
deserializes unchanged — rendered as chips in the meta row exactly as
`pr-view.ts:119` renders a PR's. Mapping labels onto `kind` would break on the
first issue carrying two of them, and `kind` is a single value that the card
modal offers as a select. `labels` is capped at `labels(first:100)` and truncates
**silently** (measured) — accepted without comment, because an issue with more
than a hundred labels is not a thing the board needs to be honest about the way it
needs to be honest about a truncated *list of issues*.

**The `boardError` banner needs no change.** Its prose names `board.json`
(`board.ts:102-104`) and stays true, because a synthesized configuration cannot
fail to load: `board_error` is always `None` for GitHub and the banner never
draws. The same holds for the `foreign` banner (`:125-130`) — decision 4 sets
every issue's `project` to the workspace name, so `boardColumns` (`tasks.ts:100`)
finds nothing foreign.

**The `closed` column is fetched, not accumulated.** With an open-only list a
closed issue would simply vanish from the board, which for a file card it does
not. So the fetch is two calls: `-s open -L 50` and `-s closed -L 20`. Twenty
matches `boardColumns`' existing `doneLimit = 20` (`tasks.ts:93`) exactly, so the
column caps itself the way it always has. **`--state all` in one wide call is not
an alternative:** it orders by `createdAt` descending and does not group by state
(measured), so a single page cannot fill a capped closed column — it would
truncate the open list with closed rows. Two calls at 1 point each are both
correct and cheaper.

**The fetch asks for recency order, and the board keeps sorting as it does.**
`boardColumns` re-sorts whatever it is given — a non-terminal column by
`created`, a terminal one by `resolved` (`tasks.ts:106-108`) — so the provider's
order is advisory and no frontend change is needed. It still matters, because the
open list is capped at 50: *which* 50 come back is not something the frontend can
re-sort its way out of, and "the 50 least recently touched" would be the wrong
50. `gh issue list --search "sort:updated-desc"` stays on GraphQL at 1 point
(measured), so asking for the right ones is free. `Task` gains no `updatedAt`
field for this — one new field (`labels`) is enough, and a per-card age is not
something the board shows.

### 4. The `Task` mapping, field by field

| Field | From the issue | Note |
|---|---|---|
| `id` | `number` as a decimal string, `"42"` | Not the GraphQL node `id`. The number is what `gh issue close` takes, what a person types, and what goes in the branch name. Ids stop being globally unique across providers, which is safe because a workspace has one source. |
| `title` | `title` | |
| `kind` | `""` | Nothing maps to it. `gh issue list --json` exposes no issue-type field (verified: the accepted list has none). `kindLabel` returns `""` for an empty id (`board-config.ts:12`) and `board.ts:264` then omits the chip, so no card shows a meaningless one. |
| `status` | `"open"` when `state == "OPEN"`, else `"closed"` | `state` is uppercase **from `gh issue list`** and lowercase from `gh search issues` (verified). The parser accepts one command's casing, and the spec never routes both into it. |
| `project` | **the workspace's name**, supplied by the backend | Load-bearing, twice: `boardColumns` filters `t.project === project` where `project` is `ws.name` (`main.ts:252`, `tasks.ts:100`), and `main.ts::launchFromTask` (`:205`) resolves the workspace by `w.name === t.project`. The repository name here would empty the board and break ▶. Set the same way `tasks_list` already does it (`p.list(&ws.name)`, `:351`). |
| `created` | `createdAt` | |
| `resolved` | `closedAt` | `null` on an open issue (verified) — exactly the field's meaning. |
| `origin` | `Human`, always | See below. |
| `session` | `None`, always | It names *our* session on a card the CLI filed, and there is nowhere on an issue to keep it. Nothing is lost: the live link is `taskId → session` on the session record (tracker spec, decision 11), which is what `derivedStatus` reads. |
| `body` | `body`, on the list call | Kept in the field set. See below. |
| `path` | the issue's `url` | See below. |
| `damaged` | `None`, always | There is no partial parse: `gh` returns a whole row or the call fails. |
| `conflict` | `false`, always | Issue numbers are unique per repository by construction. The condition cannot arise. |

**`origin` is `Human` and that is not a lie, it is a loss.** `author.is_bot` is on
the real row (verified) and was the obvious candidate — but `origin` exists to
make *agent-filed* cards visible, so the feature is not frightening (tracker
spec). In a GitHub workspace an agent files through `gh issue create` under the
workspace's own account, so its issue is indistinguishable from a person's: the
distinction the field was invented for does not survive the round trip. Marking
Dependabot's issues "session" would put a true-ish label in a field that means
something else. So: `Human`, and the chip never appears. The board loses the
signal, and the spec says so rather than faking it.

That decision also sidesteps two of the measured author traps: a bot's `author`
omits the `id` and `name` keys **entirely** (absent, not null) and prefixes its
`login` with `app/`, and `author.name` is `""` for 85 of 200 users on `cli/cli`.
Reading neither field means neither trap can bite. Should Open question 2 go the
other way, the rule is `name` if non-empty, else `login`, and every access must go
through the `.get().and_then()` shape `gh_pr.rs:112-117` already uses for exactly
this — an absent key and a null must behave identically, or one bot-filed issue
blanks the board.

**`comments` is excluded from the field set; `body` is kept.** The measurement is
that `body` + `comments` together take a 46-issue response from 24 KB / 0.85 s to
122 KB / 1.40 s — but it does not separate them, and on the repository where it
was taken the arrays run to a hundred comments each. `comments` goes out
regardless: nothing here reads it, it is silently capped at 100 in list mode, and
there is no `commentsCount` field, so any count derived from it lies above 100 —
three reasons before payload is even considered.

`body` stays, and that is a decision rather than an omission. Dropping it would
mean a second `gh issue view` call on the two hottest interactions — opening a
card modal, and ▶ building its prompt — and a loading state inside a modal that
today has none. **What is unmeasured:** the cost of `body` *alone*. If it turns
out to be most of the 5×, the fix is to drop it from the poll and fetch it on
demand, which is a contained change: `GhIssueProvider::resolve` already exists as
the natural place for a single-issue read, and `Task.body` would arrive `""` from
`list`. The implementation plan should measure `body`-only payload once before
accepting this, because the answer is cheap to get and reverses the decision.

**`path` holds a URL, and the field's name is now wrong.** `path` is read in
exactly three visible places: `taskPrompt`'s `Card file: ${task.path}` line
(`tasks.ts:40`), the damaged/conflict tooltip (`board.ts:269-272`), and
`frontmatter::file_name(&card.path)` inside `rewrite_step` (`tasks_cmd.rs:712`).
The second and third are unreachable for an issue (`damaged`/`conflict` are
always false; `rewrite_step` is file-only), and the first is rewritten wholesale
by decision 5. The URL is the honest answer to "where does this card live".
Renaming the field to `location` across both languages costs more than it buys;
the mismatch is recorded here instead.

**A consequence worth stating because it is correct rather than accidental:**
with `damaged` and `conflict` always false, `canWrite` (`board.ts:238`) is always
true, every card is draggable, and neither ▶ nor ✓ is ever hidden for those
reasons.

### 5. The agent is handed `gh`, and the sidecar is removed from the workspace

This is the largest decision and the one with the most ways to leak.

**The sidecar gets no GitHub mode.** `session_env` (`commands.rs:61`) already
omits `COWORK_TASKS_DIR`, `COWORK_PROJECT` and `COWORK_TASK_BIN` when there is no
root (`:69`, the `if let Some(root)`), and decision 2 makes `resolve_root` return
`None` for a GitHub workspace — so that omission happens for free. With no
`COWORK_TASK_BIN` the agent has no path to the sidecar; with no
`COWORK_TASKS_DIR` every subcommand fails loudly at `run()`'s `env_var` check
(`cowork_task.rs:96`, `:83-88`) for anyone who finds it anyway; and `guard`
returns 0 at `:205` and prints nothing. No leak, and no new refusal to write —
the existing ones already say the right thing.

The hook stays wired unconditionally (`hooks.rs:30-32`). Its comment argues for
one branch instead of two, and with the guard allowing on its own that argument
still holds.

*Rejected:* linking a GitHub provider into the sidecar. It would need a token and
a repository in its environment, `COWORK_TASKS_DIR` would have to be faked to get
past `:96`, and the guarantee the sidecar exists for — a correct ULID and correct
frontmatter (tracker spec, decision 10) — has no analogue: `gh` already is the
correct-by-construction writer. *Also rejected:* a channel back to the app. The
sidecar deliberately has none (`:6-8`), and opening one so an agent can close an
issue it can already close is a listener, a protocol and a new failure mode for
nothing.

**One new environment variable, for one reason.** Omitting everything would also
silence `guard`'s no-card branch (`:232-258`), which is the only thing that tells
a *plainly started* session that this workspace has a tracker at all — the launch
prompt is built on the ▶ path alone. Losing it would quietly kill the "found a
side problem, file a ticket" convention in every GitHub workspace. So:

- `COWORK_ISSUE_REPO=OWNER/NAME` — set by `session_env` for a GitHub-backed
  workspace.
- `COWORK_ISSUE_NUMBER` — set only on the ▶-from-an-issue path, the analogue of
  `COWORK_TASK_ID` (`commands.rs:76-78`).

`guard` gains a GitHub branch **dispatched before it reads `COWORK_TASKS_DIR`**
(`cowork_task.rs:204`), so it never constructs an `FsTaskProvider` and never
names a folder.

**`Stop` does not block in a GitHub workspace.** The file guard blocks a `Stop`
that leaves a card open (`:301-315`) because moving a card is cheap, local and
reversible. Closing a GitHub issue is none of those: it is visible to everyone in
the repository and undoing it is a second public action. A hook that holds a
session hostage until the agent closes an issue is a hook that pressures an agent
into a public write. So the GitHub guard reports every turn and never blocks.
**Cost:** an agent can finish with the issue still open and nothing stops it —
which is what ✓ and the person are for.

**What the agent is told, verbatim.**

`UserPromptSubmit`, with an issue (`COWORK_ISSUE_NUMBER` set):

> Tracker card: issue #42 in followLemmi/cowork-deck. Close it with: gh issue
> close 42 --repo followLemmi/cowork-deck. Do not close it unless the work is
> finished — closing is visible to everyone in the repository.

`UserPromptSubmit`, without one:

> This workspace's tracker is the GitHub issues of followLemmi/cowork-deck. File
> one with: gh issue create --repo followLemmi/cowork-deck --title "…" --body
> "…". Only file an issue for something you are not going to fix in this session.

The launch prompt — `issuePrompt`, a sibling of `taskPrompt` (`tasks.ts:33-66`),
which it replaces entirely on this path:

```
GitHub issue #42 in followLemmi/cowork-deck.

Title: Sidebar badge sticks after a rename
https://github.com/followLemmi/cowork-deck/issues/42

<body, when there is one>

When the work is finished, close the issue: gh issue close 42
Do not close it if the work is incomplete — a closed issue is visible to
everyone in the repository.
```

No steps line and no `status` command: the board has two steps, both are named by
the close instruction, and there is nothing between them to move to. That drops
all three `"$COWORK_TASK_BIN"` references `taskPrompt` carries (`:54`, `:58`,
`:63`) and the `Card file:` line (`:40`).

**The non-leak invariant, stated so it can be tested:** `issuePrompt`'s output
contains no `COWORK_`, no `board.json`, and no filesystem path;
`taskPrompt`'s contains no `gh `. Both directions, one test each — the second
matters as much as the first, because a shared prompt builder that grew a `gh`
line would leak the network model into a folder-backed workspace.

**The harness for the sidecar half already exists, and it is the right one.**
`src-tauri/tests/cowork_task.rs` (24 tests) spawns the built binary as a real
child and drives it purely through the environment — `Command::new(bin)`
with `.env("COWORK_TASKS_DIR", dir.path()).env("COWORK_PROJECT", "deck")` over a
tempdir seeded with a `board.json` (`run`, `:24-39`; `tempdir_with_board`, `:14`)
— which is exactly the axis a provider is selected on. `guard`'s branches are
already covered end to end there: `guard_blocks_the_first_stop_while_the_card_is_open`,
`guard_allows_a_stop_once_the_card_is_in_a_terminal_step`,
`guard_prints_the_card_and_its_step_on_a_user_prompt`,
`guard_allows_when_the_tracker_directory_is_unset`,
`guard_allows_when_board_json_is_unusable`.

`guard_allows_when_the_tracker_directory_is_unset` is the existing precedent for
"no reachable tracker, so allow rather than block" — and it is precisely the shape
a GitHub workspace would hit if the sidecar stayed purely file-only. **Silently
allowing there would not be honest,** and that is the whole reason
`COWORK_ISSUE_REPO` exists: without it the agent in a GitHub workspace is told
nothing at all about the tracker, and "allow silently" would mean the contract
changed under the agent with no announcement. The existing precedent is right for
its own case — an *unreachable* file tracker, where there is nothing true left to
say — and wrong as a model for a workspace whose tracker is perfectly reachable by
a different route.

So the new tests go in that same file, in that same shape:

- `COWORK_ISSUE_REPO` set, `COWORK_TASKS_DIR` unset, `UserPromptSubmit` → exit 0
  and a context line naming the repository and `gh issue create`; asserted to
  contain no folder path and no `COWORK_`.
- The same with `COWORK_ISSUE_NUMBER` → the line names the issue and `gh issue
  close`.
- `COWORK_ISSUE_REPO` set, `Stop` → exit 0 and **no** block, in both the
  with-issue and without-issue cases. This is the assertion that decision 5's
  refusal to block is real rather than intended.
- Both variables set and `COWORK_TASKS_DIR` also set — the state that should never
  occur — asserted to take the GitHub branch, since it is dispatched first. A
  contradictory environment must resolve one way on purpose rather than by
  statement order in a future edit.

### 6. ▶ builds a worktree beside the workspace, and refuses to duplicate a PR's

- **Branch:** `issue-42-<slug(title)>`, using the existing `slug`
  (`gh_pr.rs:201`), which is verified to strip path separators and cap at 40
  characters. `issue-` prefixed rather than a bare `42-…`, so it is unambiguous
  beside `pr-42` in `git branch`.
- **Base:** the repository's default branch, from the repository-facts call that
  also supplies `nameWithOwner` — one GraphQL point, once per workspace per app
  run, cached (decision 7, decision 11). `defaultBranchRef{name}` is verified and
  returned `main`. Not the workspace's current `HEAD`: the person may be sitting on
  a feature branch, and an issue branch based on it would silently inherit
  unrelated work.
- **Directory:** `<parent>/<workspace-name>-issue/<number>-<slug>`, beside the
  workspace, never inside it. Same rule and the same reason as
  `gh_pr::worktree_path` (`gh_pr.rs:227-235`) and BUG-026, recorded in its doc
  comment (`gh_pr.rs:220-226`): a nested worktree made `npm test` glob suites out
  of it and run 880 tests instead of 183, and would equally land in `git status`
  and in the task watcher. A `-issue` sibling rather than sharing `-pr`, so the
  two kinds are legible on disk.
- **Idempotency:** if the path exists, hand it back — as `pr_worktree_add` does
  (`commands.rs:529-531`). If the *branch* exists but the path does not, attach a
  worktree to the existing branch instead of creating one, or ▶ dies the second
  time after a manual directory removal.
- **Cleanup:** the same three guards as `offerWorktreeCleanup` (`main.ts:511`) —
  a live session in it stops the offer (`deck.hasSessionIn`, `sessions.ts:287`),
  the backend refuses while dirty (`worktree_is_clean`, `commands.rs:480`), and
  the person still says yes. Offered when the issue closes, never automatic.

**The collision, and the fix.** `pr_worktree_add` fetches `pull/{n}/head` into a
*local* branch named `pr-{n}` (`commands.rs:537-538`) and keys the directory by
`{number}-{slug(headRefName)}` (`gh_pr.rs:234`). So the ordinary path through
this feature produces two copies of one piece of work:

1. ▶ on issue #42 → `…-issue/42-sidebar-badge-sticks` on branch
   `issue-42-sidebar-badge-sticks`.
2. Push, open PR #57.
3. ▶ on PR #57 → `…-pr/57-issue-42-sidebar-badge-sticks`, branch `pr-57`, same
   commits, different directory. Pushing back from it needs `git push origin
   pr-57:issue-42-sidebar-badge-sticks`, and nothing says so.

**Decision: `pr_worktree_add` looks for an existing worktree on the PR's head
branch before creating anything.** `git worktree list --porcelain` reports each
worktree's path and branch; if one is checked out on a local branch matching
`headRefName` and the PR is not cross-repository (`isCrossRepository`,
`gh_pr.rs:86`), hand that path back. Only with no match does it fall back to
today's fetch-into-`pr-{n}`. When it reuses one, the tile's prompt says so —
that this is the directory the issue was worked in.

*Rejected:* re-keying the worktree path by branch slug rather than number, so the
two paths coincide by construction. It is the tidier model, and it changes the
directory naming of the already-written PR path: every worktree a user already
has stops resolving, so `pr_worktree_path` (`commands.rs:506`) reports it absent
and the cleanup offer never appears for it. The lookup changes no naming and no
existing directory. **Cost of the choice made:** one extra `git` invocation per ▶
on a PR, and it does nothing for a fork — where the head is not a local branch,
and where our own issue flow cannot have produced the first worktree anyway.

### 7. One 30-second interval, gated in one place, and counts that never fetch

Budget: 5000 GraphQL points per hour, and one `gh issue list --json` call is
measured at exactly 1 point (ten calls moved the counter by ten,
`X-Ratelimit-Resource: graphql`, `core` unmoved). The `search` bucket — 30
requests *per minute* — is never used, which rules out a search-based total count
as a polling input.

**Two points per tick, and a third only when it can change the answer:**

| Call | Points | When |
|---|---|---|
| `gh issue list -s open -L 50 --json …` | 1 | every tick |
| `gh issue list -s closed -L 20 --json …` | 1 | every tick |
| `gh api graphql` — open/closed `totalCount` | 1 | **only when the open page came back full** |
| `gh api graphql` — `nameWithOwner` + `defaultBranchRef` | 1 | once per workspace per app run |

**The totals query runs only on a full page.** A page that came back with fewer
than 50 rows *is* the total — "showing 12 of 12" needs no second call — so the
only moment `totalCount` can change the message is the moment the page is
capped. In a repository with fewer than 50 open issues, which is most of them,
the totals call never fires at all. This is what makes the count honest and free
in the same breath, and it comes straight out of the measured ceilings below.

**One interval: 30 s.** No fast/slow split, because nothing on an issue changes
on its own the way a check run does — the PR view's two-speed `pollIntervalMs`
(`pr.ts:76-78`) has no analogue here. Faster than the PR view's settled 60 s
because a board is the screen you sit on while triaging; far slower than the
board's current blind 5 s. The measured ceilings say why 5 s was never an option
here: at that interval, list-only supports about 6 workspaces, list plus totals
about 3, and list plus PRs plus totals **1 to 2**.

**Gates, all in one function**, exactly as `schedulePrPoll` does
(`main.ts:384-388`): the board is the current view, `document.hasFocus()`, and
the active workspace's source is GitHub. A single `setTimeout` chain rescheduled
only after the request returns (`main.ts:387`, `:440`) — never `setInterval`, so
a slow network cannot queue `gh` processes. **This changes the file board too:**
`main.ts:116` is a 5-second `setInterval` with no focus gate firing three IPC
calls per tick, and it becomes the same gated chain.

**The arithmetic.** Only one view and one workspace are watched at a time — that
is what the gates are for — so the steady state is one screen's:

- Issues board watched for a solid hour at 30 s, under 50 open issues (no totals
  call): 120 × 2 = **240 points/hour**, 4.8% of the budget.
- Same hour with the open list permanently capped, so the totals call fires every
  tick: 120 × 3 = **360/hour**, 7.2%.
- PR view watched for that hour at its settled 60 s instead: 60 × 1 = 60/hour.
- Worst plausible mixed hour — alternating between the two views, a capped repo,
  40 writes each forcing a refresh: 360 + 60 + (40 × 3) = **540/hour**, 10.8%.
- For contrast, the measured cost of the interval this replaces: a 5 s poll is 720
  calls/hour, **14.4% for one workspace with a single call per tick** — and the
  board's current tick makes three IPC calls, one of which (`tasks_open_counts`)
  fans out across every workspace.
- The number that would hurt: un-gated background polling of four GitHub
  workspaces, 4 × 120 × 3 = **1440/hour**, 29% — spent on screens nobody is
  looking at. That is why background polling is out of scope, and not merely
  unbuilt.

**`tasks_open_counts` never touches the network.** It iterates *every* workspace,
constructs a fresh provider each time (`tasks_cmd.rs:408-426`), and is called on
every board tick (`main.ts:116`) and after every mutation (`:198`, `:267`,
`:284`, `:302`, `:336`, `:359`). Four GitHub workspaces at 3 points each would
put 12 points behind every card edit. So for a GitHub workspace it serves the
open count the board's own last fetch recorded, from an in-memory per-workspace
cache on `AppState` — beside `gh_tokens` (`commands.rs:27`), same lifetime, same
"in memory only, never persisted" rule — and reports **nothing at all** for a
workspace whose board has not been opened this run.

**Cost, plainly:** a GitHub workspace's sidebar badge is as fresh as the last
time you looked at that board, and absent before that. `WorkspacesPanel` already
draws nothing for a count of zero (`workspaces.ts:137-143`), so "absent" needs no
new rendering. The better answer — one batched GraphQL query returning
`totalCount` for every GitHub workspace's repository in a single 1-point call —
is the thing to build if that staleness turns out to matter. See Open question 3.

### 8. Switching a workspace's source warns in the form, and touches nothing on disk

The path machinery goes quiet by itself, which is the whole answer to how
`previousLocation` and the migration banner behave:

- Switching to GitHub makes `effective_root(new)` `None` (`:195`), so
  `with_previous_location` returns at `:223` — "turning the tracker off: nowhere
  to move cards to, so nothing to record". **No pointer is written and the banner
  never appears.** Correct: the banner's job is to move card *files* to another
  *folder*, and there is no folder.
- `seed_previous_location` (`:255`) returns at `:268`, because its `match` on
  `providers.first()` only recognises `Fs { Path }`.

So the warning is the workspace form's job, not the banner's, and it has to be
raised before the save — afterwards the deck no longer knows the old root. When
the tracker was `fs` and is being switched to `github`, the form counts what is
at the old root and confirms:

> This workspace has 7 open cards in
> /home/u/vault/cowork-deck-tasks/cowork-deck. Switching to GitHub issues leaves
> every one of them on disk, untouched — this board will stop showing them, and
> nothing will copy them to GitHub. Switching back later brings them back.

Fully reversible, and the last sentence says so: no file is touched, and
switching the radio back yields the same `resolve_root` result. The count needs a
new read-only command (`tracker_open_count(workspace_id) -> Option<usize>`); when
the root cannot be read it says "any cards there" instead of a number, rather
than blocking the save on a directory read.

**One sharp edge, stated rather than hidden:** renaming the workspace *and*
switching to GitHub in the same save loses the pointer, because
`with_previous_location` returns at `:223` before it records the rename — and the
old root's folder is named after the slug of the old name (`:170`). The cards are
still on disk, under a folder named for a name the workspace no longer has, and
the person has to find it. The confirmation above names the full path for exactly
this reason.

### 9. Three unavailable states from the PR view, plus a cache and a visible age

Reused verbatim in meaning and mechanism from `pr-view.ts:4`, `:28-41`, detected
from the error string as `main.ts:430-437` already does: `no-gh` ("Set up gh" →
the GitHub screen), `no-account` ("Bind an account" → the workspace form),
`no-repo` (no action — nothing in the app can fix it). Each explains itself and
offers the next step; none is ever rendered as an empty list, because from an
empty list it is impossible to tell whether something broke.

Two additions the exit codes make possible. `gh help exit-codes` gives **4 =
authentication required**, and no credentials at all returns it — a reliable
signal that today's string matching (`main.ts:430-437`) cannot get. So exit 4 maps
straight to `no-account`, and a missing scope — exit 1 with **nothing on stdout** —
maps to an error rather than a parse failure, because the exit code is checked
before the output is looked at. `run_gh_for_workspace` (`commands.rs:383`) already
does that; the point is that it must keep doing it, since "parse and see whether it
was JSON" would turn a scope problem into "gh returned unreadable JSON".

Offline and rate-limited are **not** their own screens. The last good list stays
on screen with its age and the error text — the PR view's shape
(`main.ts:436`, `pr-view.ts:88`).

**The rate limit is detected proactively, never by matching its message.** Its
exit code and stderr text are **unverified** — the survey could not provoke a
refusal without abusing a live API — so a handler keyed on that text would be a
guess dressed as a check, and it would fail silently on the one day it mattered.
Instead the response's `X-Ratelimit-Remaining` is read (or probed with `gh api`)
and a low figure is surfaced as a banner *before* the refusal: "GitHub's hourly
API budget is nearly used up — the board will stop refreshing shortly." One
sentence, because the fix is "wait", not "retry". A separate footnote from the
measurement: `gh api rate_limit` reported `search: used 0` immediately after real
search calls, so the headers are the source of truth and that endpoint is not.

The board's existing two states survive unchanged: `caps === null` → "No task
tracker is configured for this workspace" (`board.ts:34`), and a non-null `error`
→ the error text (`:36`).

**What the board grows,** all on `BoardState` (`board.ts:5`):

1. `fetchedAt` and an age line on every render — "updated N ago" / "never
   loaded", `pr-view.ts:70-71`. The board has no data age today at all.
2. `unavailable: BoardUnavailable | null` and its explain-and-fix box.
3. An in-memory last-good list per workspace, so a failed tick keeps the screen
   populated.
4. The "showing N of M" line.

Note for the record: the PR view's own "showing N of M" is currently only half
honest — `main.ts:419-422` sets `total: prs.length` with a comment saying the
repository's real open count is not knowable from `pr_list`, and
`pr-view.ts:97-99` therefore says "the repository has more open" without a
number. The issues board can do better, because `repository.issues.totalCount`
costs 1 point and only when the page is capped, and it should: "showing 50 of 63
open" is a sentence with two real numbers in it.

**And issue #115 needs correcting, not silently contradicting.** Its comment
recommends the REST route, `/search/issues?q=…&per_page=1`, for the
total. GraphQL `repository.issues.totalCount` is strictly better on both counts
that comment weighed: it spends 1 GraphQL point rather than the 30-per-minute
search budget, and it reads the repository object directly, so it has **no
eventual-consistency lag** — which means the "show 'about M'" hedge and the
"suppress the count during a mutation" caveat recorded there do not apply at all.
Someone should post that on #115; a spec that quietly does the opposite of a
recorded recommendation leaves the next reader to discover the disagreement.

### 10. `+ task` creates, `✓` closes with a reason, reopen does not ask

- **`+ task` → `gh issue create --title … --body …`.** `capabilities.canCreate`
  is `true`, so the button appears through the existing condition
  (`board.ts:61`). The existing `taskForm(caps.board)` (`main.ts:189`) collects
  title, kind and body; the kind select is hidden when `board_editable` is false,
  because one synthetic kind is not a choice.
- **`✓` → `gh issue close <n>`, confirmed.** Unlike the file board's ✓, which
  writes a local file. The confirmation is the same asymmetry as decision 3's
  drop rule and the PR spec's decision 7.
- **The confirmation offers the close reason.** `gh issue close` accepts
  `-r {completed|"not planned"}` (verified). The modal is already being raised,
  the distinction is real and visible on the issue's timeline, and it costs one
  two-way control: "Completed" (default) or "Not planned". No comment field —
  `-c` exists, but a comment is a conversation, and conversations are the next
  spec.
- **Reopen → `gh issue reopen <n>`, unconfirmed.** It restores the state of a
  moment ago. Reachable from the `closed` column's `‹` and from a drop on `open`.

**Three mechanical facts about the write commands shape the implementation.**

1. **None of them accepts `--json`** — human text and an exit code, nothing to
   parse. So every write is "did it exit 0", followed by a refetch. That is also
   why nothing here depends on `create`'s output: its success text was never
   observed (see the honest gaps above), and reading the new issue's number out of
   it would be building on an unverified string. The board refetches and the new
   issue arrives like any other.
2. **`create` and `edit` prompt interactively when `-t`/`-b` are missing**, which
   in a spawned child is a hang waiting to happen. Two guards: every argv always
   carries `--title`, and the body goes in on **stdin via `--body-file -`** rather
   than in argv — a multi-line body in an argument vector is the kind of thing
   that works until someone's issue body contains something the shell layer cares
   about. `std::process::Command::output()` sets stdin to null, so today's
   `run_gh_for_workspace` (`commands.rs:381`) would give a prompt EOF and an error
   rather than a hang — but it also cannot feed a body, so it needs a
   stdin-carrying sibling: `.stdin(Stdio::piped())`, `spawn`, write, then
   `wait_with_output`. That is the same shape the sidecar's own integration test
   already uses (`tests/cowork_task.rs:30-39`).
3. **`close --reason` takes the literal strings `completed` and `not planned`** —
   with a space, quoted — and that is what sets `stateReason`. The reason is
   written in v1 and never read back: `stateReason` stays out of the field set
   until something displays it, which is what Open question 4 decides.

### 11. Every `gh issue` call carries `--repo`, resolved once and cached

`pr_list_argv` (`commands.rs:320`) passes no `--repo` and relies on the process's
`cwd` being a repository — which works today because `run_gh_for_workspace` sets
`cwd` to `ws.path` (`:379`). The issues path does not inherit that assumption:
`issue_list_argv` and every write argv take an explicit `owner/name` and always
emit `-R`. Two reasons, one of them specific to this feature.

The general one: `--repo` removes the ambiguity of a call whose working directory
turns out not to be the repository anyone meant. The specific one: this feature
creates worktrees and runs sessions inside them (decision 6), so directories whose
`origin` is *related to but not identical with* the workspace's now exist in
numbers, and a command that resolves its repository from wherever it happens to be
standing is a command waiting to act on the wrong one.

`owner/name` comes from the repository-facts call in decision 7 —
`nameWithOwner` in the same GraphQL query as `defaultBranchRef`, 1 point, once per
workspace per app run, cached beside the tokens in `AppState`
(`commands.rs:27`). Not parsed out of `git remote get-url`: that is free but has
to handle both SSH and HTTPS forms, and `gh`'s own answer is authoritative about
which remote `gh` would have picked.

**This is also the answer to what would otherwise be an open question about
storing the repository in the tracker config.** It is neither stored nor guessed:
it is resolved from the workspace's own folder, once, by `gh`.

**Recommendation for the PR path, which the user should confirm:** bring
`pr_list_argv` into line — pass the same cached `owner/name` and emit `-R`. It is
a two-line change, it removes an implicit dependency on `cwd` from code that will
soon sit next to code that cannot rely on it, and doing it now avoids two
neighbouring modules disagreeing about how they name a repository. It is
nonetheless a change to a shipped path for no user-visible gain, so it is called
out rather than done silently.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| A fourth view for issues | The board *is* this screen. A second board differing only in where its rows come from would double every state — empty, unavailable, stale, migrating — for one source. |
| Both sources at once on one board | Needs a merge rule, a conflict rule and a per-card source marker. `.first()` at `tasks_cmd.rs:156` already says one, and nothing has asked for two. |
| Issue labels as `kind` | Breaks on the first issue with two labels, and `kind` is a single-value select in the card modal. A `labels` array is the shape the data has. |
| Adding `board()`/`scan()` to `TaskProvider` | Every future provider would answer with stubs. A port whose implementations stub half of it has stopped being one. |
| Storing `owner/name` in the tracker config | A second source of truth that can disagree with the folder's git remote. See Open question 1. |
| A GitHub mode in the `cowork_task` sidecar | Needs a token, a repository, and a faked `COWORK_TASKS_DIR` to get past `cowork_task.rs:96`, in order to duplicate a command the agent already has. |
| A channel from the sidecar back to the app | It deliberately has none (`cowork_task.rs:6-8`). A listener and a protocol so an agent can close an issue it can already close. |
| A `Stop` hook that blocks until the issue is closed | Pressures an agent into a write the whole repository can see. Decision 5. |
| Basing the issue branch on the workspace's current `HEAD` | Silently inherits whatever feature branch the person happened to be sitting on. |
| Re-keying the PR worktree path by branch slug | The tidier model, and it orphans every worktree the PR path has already created. Decision 6. |
| `-s all` in one call, to fill both columns | Measured: it orders by `createdAt` desc and does **not** group by state, so one page cannot fill a capped closed column — it truncates the open list with closed rows instead. Two calls at 1 point each. |
| A search-based total count (REST `/search/issues`, as issue #115 recommends) | The `search` bucket is 30 requests **per minute** — a 5 s poll on one workspace eats 40% of the window. `repository.issues.totalCount` costs 1 GraphQL point, is exact, and has no eventual-consistency lag, so #115's "about M" hedge is unnecessary. #115 should be corrected. |
| `projectCards` / `projectItems` in the field set | Without `read:project` they fail the **entire** request — exit 1, empty stdout — and the app requires only `repo` of a bound account (`github.ts:27`). One added field would blank the board for everyone. |
| A rate-limit handler that matches gh's refusal text | That text is **unverified**: the refusal could not be provoked safely. A string match on an unobserved message is a guess that fails on the one day it matters. `X-Ratelimit-Remaining`, read proactively, instead. |
| Parsing `gh issue create`'s output for the new number | Its success output has never been observed. The board refetches instead, which needs no new fact. |
| Passing a multi-line body in argv | `--body-file -` on stdin. A body is user and agent text, and argv is the wrong place for it — and `create` prompts interactively when `-b` is missing, which in a child process is a hang waiting for the one case that reaches it. |
| Background polling for the sidebar badges | 1440 points/hour for four workspaces nobody is looking at. Decision 7. |
| A filter row in v1 | A filter you can set is a filter you can forget you set, and then "showing N of M" is lying. |

## Verified facts about `gh`

**Version.** `gh version 2.82.1 (2025-10-22)` on this machine, measured while
writing this spec. The PR spec claims 2.86.0 and says the account spec's 2.82.1
"should be refreshed" — but 2.82.1 is what is actually installed here, so the PR
spec's number is the one that needs checking. Neither is asserted as "the"
version by this spec.

**`gh issue list --json` accepts exactly these fields,** confirmed by asking for
an unknown one:

```
assignees, author, body, closed, closedAt, closedByPullRequestsReferences,
comments, createdAt, id, isPinned, labels, milestone, number, projectCards,
projectItems, reactionGroups, state, stateReason, title, updatedAt, url
```

**Two of those fields are a landmine.** `projectCards` and `projectItems` fail
the **entire request** — exit 1, nothing on stdout — unless the token carries
`read:project`: `GraphQL: Your token has not been granted the required scopes …
['read:project']`. The app requires only `repo` of a bound account
(`REQUIRED_SCOPES`, `src/github.ts:27`), so the workspace's account is not
guaranteed to have it. Neither field goes in `ISSUE_LIST_FIELDS`, and the
constant carries a comment saying why — otherwise the next person to want
Projects support adds one field and the board goes blank for everyone.

**Parser traps, all measured** (against `followLemmi/cowork-deck` and `cli/cli`
by the survey this spec was commissioned from; not re-run here):

- `author` for a **bot** omits the `id` and `name` keys **entirely** —
  `{"is_bot":true,"login":"app/cursor"}`. Absent keys, not nulls, and `login`
  carries an `app/` prefix.
- `author.name` is `""` for users with no display name — 85 of 200 rows on
  `cli/cli`. Treat `""` as absent and fall back to `login`.
- `stateReason` has exactly four values: `""` while open, `COMPLETED`,
  `NOT_PLANNED`, `DUPLICATE`. **Not** an `Option` keyed on null.
- **`state` casing differs by command:** `OPEN`/`CLOSED` from `gh issue list`,
  `open`/`closed` from `gh search issues`. Never feed both into one
  deserialiser.
- `labels` is capped at `labels(first:100)` and truncates **silently**, with no
  flag saying so.
- `comments` is capped at 100 in list mode but complete in `gh issue view` —
  observed 100 against 107 on `cli/cli#326` — and `gh issue list` has no
  `commentsCount` field at all. Any comment count taken from the list lies above
  100.
- `body` and `comments` together are ~5× the payload: 24 KB → 122 KB and 0.85 s
  → 1.40 s for 46 issues. The measurement does **not** separate the two, and on
  `cli/cli` the hundred-comment arrays are almost certainly most of it —
  see decision 4 for what this spec does about that and what stays unmeasured.
- `milestone` is null on 104 of 104 issues in the target repository,
  `assignees` empty on 104/104, `isPinned` false on 104/104. Those paths are
  unexercised by live calls and can only be covered by fixtures.

**Flags**, confirmed from `--help` here: `-s {open|closed|all}` (default open),
`-L/--limit` (default 30), `-a` assignee, `-A` author, `-l` label, `-m`
milestone, `-S` search, `-R/--repo [HOST/]OWNER/REPO`, inherited by every `gh
issue` subcommand.

**`--state all` does not group by state.** It orders by `createdAt` descending,
so one wide page cannot fill a capped "closed" column — two calls are both
cheaper and correct. Separately: `gh issue list --search "sort:updated-desc"`
stays on GraphQL at 1 point, so ordering by recency costs nothing.

**Writes**: `gh issue close <n> [-c comment] [-r {completed|"not planned"}]`,
`gh issue reopen <n> [-c comment]`, `gh issue create [-t] [-b|-F] [-l] [-a]
[-m]`, `gh issue edit`. **None accepts `--json`, `--jq` or `--template`** — human
text and an exit code, nothing to parse. `create` and `edit` **prompt
interactively** when `-t`/`-b` are missing. `close --reason` takes the literal
strings `completed` and `not planned`, with a space; that is how `stateReason`
gets its value.

**Exit codes** (`gh help exit-codes`): 0 success, 1 any failure, 2 cancelled,
**4 authentication required**. So: no credentials at all gives a distinct,
reliable 4; an invalid token gives 1 with `HTTP 401: Bad credentials`; an unknown
`--json` field gives 1 with `Unknown JSON field: "…"`; **a missing scope gives 1
with nothing on stdout.** The exit code must therefore be checked before
parsing — never "parse and see whether it was JSON".
`run_gh_for_workspace` already does exactly that (`commands.rs:383`), so the
existing path is correct and must stay that way.

**Rate, measured rather than inferred.** One `gh issue list --json` call is
exactly one HTTP request to `/graphql` and exactly 1 point: ten calls moved the
counter by ten, `X-Ratelimit-Resource: graphql`, `core` unmoved. A 5 s poll is
720 points/hour — **14.4% of 5000 for one workspace**, and adding a totals query
on every tick doubles it. Measured ceilings at a 5 s interval: list only ≈ 6
workspaces, list + totals ≈ 3, list + PRs + totals ≈ 1–2. Decision 7 is built on
these numbers. The REST search route is ruled out cold: `/search/issues` is 30
requests **per minute**, so a 5 s poll on one workspace eats 40% of that window.
Footnote worth carrying: `gh api rate_limit` reported `search: used 0` even
immediately after real search calls — trust the `X-Ratelimit-*` response headers,
not that endpoint.

**Totals and the default branch arrive together**, 1 point, measured returning
`{main, 46, 58}`:

```graphql
repository(owner:, name:) {
  nameWithOwner
  defaultBranchRef { name }
  open:   issues(states: OPEN)   { totalCount }
  closed: issues(states: CLOSED) { totalCount }
}
```

**Failures**, told apart by stderr: a non-repository directory without `--repo` →
`failed to run git: fatal: not a git repository`; an unknown repository →
`GraphQL: Could not resolve to a Repository`. An empty result is exit 0 and `[]`
— distinguishable from every failure, which is what lets "no open issues" be a
real state rather than a guess.

### Two honest gaps, and one thing the research does not prove

1. ~~**The success output of the write commands was not observed.**~~ **Half
   closed, by observation rather than by a throwaway run.** Filing issue #117
   against this repository on 2026-07-30 used the exact argv shape this spec
   specifies — `gh issue create --repo … --title … --label … --body-file <path>` —
   and it printed **the new issue's URL on stdout, and nothing else, exit 0**:
   `https://github.com/followLemmi/cowork-deck/issues/117`. So the number *is*
   recoverable from the output, and the `--body-file` path is confirmed to work
   for a multi-line body.

   That does not change decision 10: the board still refetches rather than parsing
   that URL. The refetch needs no new fact, survives a future change to `gh`'s
   output, and is the same path every other write already takes. The gap is closed
   in the sense that matters — nobody is now designing against an unobserved
   string. **`gh issue close`'s success output remains unobserved**, and the
   manual check keeps that half: nothing parses it either, but it should stop
   being unseen before the write path ships.
2. **The rate-limit refusal could not be provoked safely**, so its exit code and
   stderr text are unknown. **No handler may match that text.** Decision 9 uses
   the proactive signal instead.
3. `followLemmi/cowork-deck` is public, so nothing measured here demonstrates
   that the per-workspace token scoping is what made the read path work. For a
   private repository it certainly would matter — but this spec does not claim it
   was shown.

## Components

### Rust — `src-tauri/src/tasks/gh_issues.rs` (new)

Pure functions first, following `gh.rs` and `gh_pr.rs`:

- `parse_issues(json: &str, project: &str) -> Result<Vec<Task>, String>` — the
  mapping in decision 4, hand-rolled rather than derived, for the same reasons
  `parse_pull_requests` is (`gh_pr.rs:98-101`): `author` is a nullable object,
  `labels` is an array of objects, and `stateReason` is `""` rather than absent.
- `parse_repo_facts(json: &str) -> Result<RepoFacts, String>` — `nameWithOwner`,
  the default branch, and the two totals from one GraphQL response. Two callers
  with different lifetimes: the first two fields are cached per workspace per app
  run, the totals are re-read only when a page comes back full.
- `issue_list_argv(repo, state, limit) -> Vec<String>`,
  `issue_close_argv(repo, n, reason)`, `issue_create_argv(repo, draft)` — pure
  argv builders, testable without a network, the shape `pr_list_argv`
  (`commands.rs:320`) and `pr_merge_argv` (`:424`) already established. Every one
  takes the repository and emits `-R` (decision 11); the create builder emits
  `--body-file -` and never puts a body in argv.
- `issue_branch(number, title) -> String` and
  `issue_worktree_path(workspace_path, number, title) -> PathBuf` — pure, and
  asserted to resolve outside the workspace folder, as
  `worktree_path`'s test does (`gh_pr.rs:435-443`).
- `GhIssueProvider` — implements `TaskProvider` over a closure that runs `gh`, so
  the trait implementation is testable without a process.

### Rust — everything else

`ISSUE_LIST_FIELDS` is the analogue of `PR_LIST_FIELDS` (`gh_pr.rs:69`), with the
same guard test that every requested field is read (`:404-411`) **and its
inverse** — that `projectCards`, `projectItems` and `comments` are absent, each
for the reason recorded above the constant. Reads run through
`run_gh_for_workspace` (`commands.rs:357`) unchanged, so redaction (`gh.rs:109`),
the token cache (`:341`) and the check-the-exit-code-before-parsing rule (`:383`)
are inherited rather than re-implemented. Writes that carry a body need a
stdin-piping sibling of it, because `.output()` (`:381`) cannot feed one.

New commands: `issue_totals`, `issue_worktree_add`, `issue_worktree_path`,
`issue_worktree_remove`. Close and reopen do **not** get their own commands —
they are `tasks_update` with a `status` patch (decision 3), so the board's four
existing write paths stay one path.

### Frontend

- `src/tasks.ts` — `issuePrompt` beside `taskPrompt`, and the two non-leak tests.
- `src/board.ts` — `board_editable` gates ⚙; the age line, the unavailable box,
  the count line, and label chips in the meta row.
- `src/main.ts` — the board's poll becomes the gated `setTimeout` chain; `moveTask`
  and `closeTask` confirm in the closing direction; `launchFromTask` picks prompt
  and worktree by source.
- `src/sessions.ts` — `launchOnWorktree` (`:271`) gains an optional `taskId`. It
  sets none today, which is right for a PR and wrong for an issue: an issue
  session runs in a worktree *and* is linked to a card, and without the link
  `derivedStatus` (`tasks.ts:24`) cannot show "in progress" and the second ▶
  cannot focus the first session instead of raising a duplicate.
- `src/forms.ts` — the tracker block (`:188-324`) gains a third root choice and
  decision 8's confirmation.
- `src/view.ts`, `src/board-config.ts`, `src-tauri/src/hooks.rs`,
  `src-tauri/src/tasks/watch.rs` — **untouched, deliberately.** The watcher one is
  worth saying out loud: `watch.rs:53` takes `&[(String, PathBuf)]` and `:65`
  skips anything that is not a directory, so it cannot represent a non-path
  source — and it does not have to, because `tasks_watch_sync`'s `filter_map`
  (`tasks_cmd.rs:436`) drops a workspace with no root. A GitHub workspace
  contributes no watcher, which means polling is its only refresh path, which is
  why decision 7's interval carries more weight than the file board's.

## What this changes in already-shipped code

The PR-view work this builds on is not yet merged to `main`, so "shipped" here
means "on this branch". Every file, with the reason:

| File | Change |
|---|---|
| `src-tauri/src/model.rs:169` | `TrackerProvider` gains a `GitHub` variant. |
| `src-tauri/src/tasks/model.rs:13` | `Task` gains `labels: Vec<String>`, `#[serde(default)]`. |
| `src-tauri/src/tasks/mod.rs` | One line for the new module. |
| `src-tauri/src/tasks_cmd.rs` | `tracker_kind` beside `resolve_root`; `provider_for` (`:309`) returns `Box<dyn TaskProvider>` plus a narrowing `fs_provider_for`; `board_for` takes over `board()`/`board_error()` (`:340-341`); `BoardCapabilities` (`:319`) gains `board_editable`; `tasks_open_counts` (`:408`) serves GitHub from cache; six file-only commands refuse a non-fs workspace; new `tracker_open_count`. |
| `src-tauri/src/commands.rs` | `session_env` (`:61`) gains the GitHub branch and two variables; `start_session` (`:632`) branches on the source — the one wrong caller of `resolve_root`; `pr_worktree_add` (`:518`) gains the existing-worktree lookup; `AppState` (`:11`) gains the open-count and repo-facts caches; a stdin-carrying sibling of `run_gh_for_workspace` (`:357`) for `--body-file -`, because `.output()` (`:381`) cannot feed one; four new issue commands. |
| `src-tauri/src/commands.rs:320` | **`pr_list_argv` passes no `--repo`** and depends on `cwd`. Decision 11 recommends bringing it into line with the issues path; called out because it is a shipped path with no user-visible gain. |
| `src/github.ts:27` | `REQUIRED_SCOPES = ["repo"]` — unchanged, and the reason `projectCards`/`projectItems` must stay out of the field set. Worth a comment there pointing at the constraint, so the next person to widen the scopes knows what depends on them. |
| `src-tauri/src/bin/cowork_task.rs:197` | `guard` gains its GitHub branch, dispatched before `COWORK_TASKS_DIR` is read (`:204`). |
| `src-tauri/src/gh_pr.rs` | `slug` (`:201`) **moves into the library** — `tasks/slug.rs` — and `gh_pr` re-exports it, so its own tests are untouched. Not "reused as-is", which this spec first said and which the crate boundary forbids: `lib.rs` exposes only `pub mod tasks` and states that `tasks` must not depend on the binary's private modules, and `gh_pr` is one of them (`main.rs:6`). One `slug`, shared, in the crate both callers can see. The worktree rule is still copied rather than moved. |
| `src/ipc.ts` | `TrackerConfig` (`:231`) widens off the `"fs"` literal; `Task` (`:201`) gains `labels`; capabilities gain `boardEditable`; new wrappers. |
| `src/board.ts` | `:69` (⚙), `:5` (`BoardState`), `:262` (meta row), plus the age line, the unavailable box and the count line. |
| `src/tasks.ts:33` | `issuePrompt` added beside `taskPrompt`; `taskPrompt` unchanged. |
| `src/main.ts` | `:116` (the un-gated 5 s `setInterval`), `:231` (`refreshBoard`), `:261` (`closeTask`), `:272` (`moveTask`), `:204` (`launchFromTask`). |
| `src/sessions.ts:271` | `launchOnWorktree` gains an optional `taskId`. |
| `src/forms.ts:188-324` | Third root choice; the switch confirmation. |
| `src/card-modal.ts` | Kind select hidden when the board is not editable. |

## Testing

**Three harnesses exist, not two.** Inline `#[cfg(test)] mod tests` with pure
parsers over captured JSON string constants and zero network (`gh.rs`,
`gh_pr.rs`); vitest with jsdom over the views; **and `src-tauri/tests/`**, which
holds `cowork_task.rs` (24 tests) and `reporter.rs` (2) and spawns the built
binaries as real child processes. The third is the one that matters most here —
see decision 5 for what goes in it and why its environment-driven shape is exactly
right for a provider selected by environment.

**Baseline on this branch (`60438bc`), measured rather than quoted:**
`npx tsc --noEmit` clean, **43 vitest files / 412 tests**, **286 cargo tests**
across the lib, both binaries and both integration files. Nothing may regress
below those numbers. The gate is
`npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`.

*The PR plan's recorded figures — 367 vitest, 263 cargo — are stale and should not
be repeated. Nor should the claim that there is no integration directory.*

**Run the gate from a worktree, never from `/home/…/lemsoft/cowork-deck`.** The
main checkout has `.claude/worktrees/` nested inside it, and vitest globs suites
out of nested worktrees — that is BUG-026 itself, the same bug decision 6 keeps
worktrees outside the workspace to avoid.

**Rust, pure:** the `Task` mapping field by field over captured rows — an open
issue with `stateReason: ""`, `milestone: null`, `closedAt: null`, a bot author
missing its `id` and `name` keys with an `app/`-prefixed login, a user with
`name: ""`, a null `author`, a two-label issue, and a closed issue with each of
`COMPLETED`/`NOT_PLANNED`/`DUPLICATE`; `[]` as a legal empty answer, not an
error; malformed JSON as an error, not a panic; the `RepoFacts` parse; every argv
builder including `--repo` on all of them and the `not planned` reason quoting;
`issue_branch` and `issue_worktree_path`, with the assertion that the path lies
outside the workspace; a field-list guard test mirroring `gh_pr.rs:404-411`, plus
its inverse — **`ISSUE_LIST_FIELDS` contains neither `projectCards` nor
`projectItems` nor `comments`**, which is the only automated defence against
someone adding a field that blanks the board for every account without
`read:project`.

**Fixtures, not live calls, for three paths.** `milestone` is null on 104 of 104
issues in the target repository, `assignees` empty on 104/104, `isPinned` false on
104/104 — so a populated milestone, a populated assignee list and a pinned issue
can only ever be exercised by hand-written JSON. Recorded here so nobody
concludes from a green suite against a real repository that those branches were
covered.

**Rust, seams:** `tracker_kind` for all three configurations; `resolve_root`
returning `None` for GitHub; `session_env` for a GitHub workspace asserting the
*absence* of `COWORK_TASKS_DIR`/`COWORK_PROJECT`/`COWORK_TASK_BIN` and the
presence of `COWORK_ISSUE_REPO` — the leak test, written as an assertion about
what is missing, because that is the failure mode; each of the six file-only
commands refusing a GitHub workspace.

**Rust, integration (`tests/cowork_task.rs`):** the four new `guard` cases listed
in decision 5, in that file's existing environment-driven shape.

**TS, pure:** `issuePrompt` shape, including an issue with no body; the two
non-leak invariants of decision 5; `boardColumns` over synthesized-board input;
the poll gates, including that the totals call is skipped on a short page.

**jsdom:** ⚙ absent when `boardEditable` is false and present when it is true;
the age line on every render; the unavailable states each offering their step;
the count line's two real numbers, and its absence on a short page; label chips;
a drop onto `closed` raising a confirmation and a drop onto `open` not.

**Not coverable, therefore a manual step at the end** — the same shape as the PR
spec's and task 13 of the account branch:

- Real network calls against a real repository.
- **One throwaway `gh issue create` and `gh issue close` against a scratch
  repository**, to record what their success output actually is. Nothing in this
  spec parses it, but nobody has seen it, and that should stop being true before
  the write path ships.
- The rate-limit banner — driven by an injected low `X-Ratelimit-Remaining`, not
  by provoking a real refusal, since the refusal's own text is unverified and
  nothing matches on it.
- The issue → PR worktree reuse of decision 6, end to end, including the push.
- The switch confirmation of decision 8 against a root that really holds cards.
- A **private** repository. Everything measured for this spec was measured against
  a public one, so nothing so far demonstrates that the per-workspace token is
  what makes the read path work.

## Questions that were open, and how they were answered

All seven were put to the user on 2026-07-30 and are closed. Recorded here rather
than folded silently into the decisions above, so a later reader can see that
each was a choice and what the alternative was.

1. **Must a GitHub-backed workspace be a clone of its repository? — Yes.** The
   folder must be that repository; the config stores no `owner/name` and a form
   field for one is refused. So a repository you have not cloned cannot be
   tracked, and `no-repo` (`pr-view.ts:37-40`) is the honest screen for it. Bought
   with that cost: one source of truth, and ▶ always has something to make a
   worktree from. Decisions 2 and 11 stand as written.
2. **Show the issue's author? — No, not in v1.** The meta row is already dense and
   the board has never shown an author. `author` therefore stays out of the field
   set, which also keeps the three measured author traps (absent `id`/`name` keys
   on a bot, `app/`-prefixed login, `name: ""`) out of the parser entirely. If a
   shared repository later makes it necessary, decision 4 records the rule the
   parser must use.
3. **The sidebar badge: cached, or one batched query? — Cached.** Decision 7 as
   written: served from the board's own last fetch, absent for a workspace whose
   board has not been opened this run, and never a network call. Fewer moving
   parts and no way to spend budget on a screen nobody is looking at. The batched
   single-point query stays the named answer if that staleness turns out to
   matter — it is an addition, not a rewrite.
4. **One terminal column or two? — One.** `closed`, with `completed` / `not
   planned` offered as a two-way control inside the close confirmation
   (decision 10). A third column would cost width on every board, and
   `stateReason` stays out of the field set because nothing reads it back.
5. **Fetch the closed page every tick? — Yes**, as decision 7 has it: one code
   path, 2 points a tick, 4.8% of the hourly budget.
6. **Bring `pr_list_argv` into line with explicit `--repo`? — Yes.** Decision 11's
   recommendation is accepted. It is a change to a shipped path with no
   user-visible gain, so it is a task of its own with its own commit, and it goes
   on the manual check: the PR list must still be correct afterwards.
7. **Measure `body` alone before the plan starts? — Measured, and `body` stays in
   the poll.** 50 open issues of `followLemmi/cowork-deck`: 15,508 bytes / 0.94 s
   without either field; 85,291 bytes / 0.99 s with `body`; 119,297 bytes / 1.67 s
   with `body` and `comments`. So `body` is 82% of the byte growth but costs
   0.05 s, while `comments` costs 0.68 s — the wall-clock the earlier 5× figure was
   really measuring belongs to `comments`, which is already excluded for three
   other reasons. 85 KB every 30 seconds through a local CLI is not a cost worth a
   loading state in the card modal. Decision 4's fallback (drop `body` from the
   poll, fetch it in `resolve`) is therefore not needed and should not be built.

## Neighbouring specs

**The pull requests view** (`2026-07-29-github-pull-requests-design.md`) — this
spec supersedes its "issues board" paragraph, corrects three of the five
decisions recorded there (see "Where this departs" above), and shares its
worktree rule, its unavailable states and its polling shape. Decision 6 changes
one shipped function of it.

**The file-backed tracker** (`2026-07-27-issue-tracker-design.md`) and the board
configuration specs of 2026-07-28 — unchanged by this one. Nothing here alters
how a card file is written, scanned or migrated; the file provider is not
touched, and that is the test of whether the port was worth having.

**The pull request in full** — conversation, review threads, commits, diffs, job
logs. Issue comments belong with it, not here.

**Jira** — after this, a `TaskProvider` implementation and a `TrackerProvider`
variant. `ProviderCapabilities.statuses` (`provider.rs:13`), still read by
nothing, is where it will start to matter: `open → closed` is not a Jira
transition graph.
