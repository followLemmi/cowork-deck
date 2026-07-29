# Design: a tracker root per project, and moving cards when it changes

## The problem

A workspace can point its tracker at any folder on disk — a dedicated repo, an
Obsidian vault, a synced directory. People do this precisely so every project's
backlog lives in one place, which means one folder ends up holding cards from
several projects at once.

Today that folder is used verbatim. Every project writes into the same
directory, and the only thing keeping the projects apart is the `project:` field
inside each card: `list()` filters by it, and `boardColumns` counts what does
not match into a "foreign" footer. Nothing is lost, but the folder itself is a
pile — `ls` tells you nothing about which card belongs to what, and the person
who chose a shared root got exactly the mixing they were trying to avoid.

Giving each project a subfolder fixes the pile. That change moves the effective
root, which strands whatever cards are already at the old one — so the two
halves of this spec are one feature: cards go into a per-project subfolder, and
whenever the effective root moves the app offers to bring the cards along.

## Scope

In scope:

- The effective root for an external tracker path becomes `<picked>/<project>`.
- The app offers to move cards whenever a workspace's effective root changes:
  on an edit in the workspace form, on a workspace rename, and once for configs
  written before this change.
- Moving rewrites `project:` inside the moved cards when the workspace was
  renamed.

Out of scope:

- The in-project root (`<ws.path>/.cowork/tasks`) is unchanged. It is already
  per-project by construction.
- Nothing about GitHub or Jira providers. The `TaskProvider` port is untouched.
- No change to how `boardColumns` handles foreign cards. A shared root can
  still contain other projects' cards — subfoldering makes that rarer, not
  impossible, and the footer stays as the honest report of it.

## Root resolution

`resolve_root` currently returns `Option<(PathBuf, bool)>`, where the `bool`
means "this root is ours to create". Two roots and three creation policies no
longer fit in a bool:

```rust
pub enum RootCreation {
    /// The whole chain is ours: `<ws.path>/.cowork/tasks`.
    Always,
    /// Only the project subfolder, and only inside a parent that already exists.
    LeafInsideExistingParent,
    /// Create nothing. The CLI receives an already-resolved COWORK_TASKS_DIR.
    Never,
}
```

`Always` has to stay separate from `LeafInsideExistingParent`: the in-project
root's parent is `<ws.path>/.cowork`, which need not exist on a fresh project,
so "create the leaf inside an existing parent" would refuse the very case it is
supposed to handle. `Never` is what `bin/cowork_task.rs` passes today as
`false`.

| Config | Effective root | Creation |
| --- | --- | --- |
| `{ kind: "project" }` | `<ws.path>/.cowork/tasks` | `Always` |
| `{ kind: "path", path }` | `<path>/<ws.name>` | `LeafInsideExistingParent` |

`LeafInsideExistingParent` is what preserves the existing guarantee that a
user-supplied path is never created silently. The picked parent is checked for
real existence; only then is the project subfolder made inside it. A typo in the
parent still surfaces as `RootMissing` rather than scattering an empty tree.

`FsTaskProvider::new` takes `RootCreation` in place of its current `create_root:
bool`, and `ensure_root_if_ours` takes it too. `bin/cowork_task.rs` passes
`Never` where it passes `false` today: the CLI receives a fully resolved
`COWORK_TASKS_DIR` and must not create anything, including the project
subfolder.

The subfolder name is computed from `ws.name` on every resolution rather than
frozen into the config. The config keeps meaning "the folder the human picked",
which is what the form shows and what the picker returns, and the folder name
can never drift from the project name. The cost is that renaming a workspace
moves the effective root — which is why a rename is one of the migration
triggers below rather than an accident.

## Remembering where the cards were

```rust
pub struct PreviousLocation {
    /// Where to look for the old cards.
    pub root: String,
    /// The project name at that time. If it differs from the current
    /// `ws.name`, `project:` inside the moved cards has to be rewritten.
    pub project: String,
    /// Whether that was the in-project root, which decides whether damaged
    /// cards come along.
    pub was_project_root: bool,
}
```

It lives on `TrackerConfig` as `previousLocation`, and `save_workspace` writes
it when the effective root changes — that call site already holds both the
stored workspace and the incoming one, so it can compute both roots and compare
them. It does not check whether any cards are actually there; that is the
banner's job, and doing it at save time would make saving a workspace depend on
a filesystem read that can fail.

A workspace being created for the first time has no stored counterpart and
therefore never gets a `previousLocation`: there is no old root, and seeding one
from a freshly picked folder would offer to move cards the person has never
filed. The write happens only on the update path, where a stored workspace with
the same id exists.

One `previousLocation` covers a simultaneous rename and path change: the root
comparison catches it either way, and `project` records the old name regardless
of which field moved.

### Telling an older config apart

The third trigger — configs written before this change, whose cards sit directly
in the picked folder — needs to distinguish "no previous location" from "written
by a version that had no such field". With `skip_serializing_if =
"Option::is_none"` those two serialize identically, so a discriminator is
required:

```rust
#[serde(rename = "v", default = "v1")]
pub version: u8,                          // on TrackerConfig
pub const TRACKER_CONFIG_VERSION: u8 = 2;
```

This is the same shape `ScheduleRun` already uses for the same reason, down to
the `default = "v1"` helper and the "records without the field are version 1 and
are converted on read" rule.

On reading a `v: 1` config whose root is `kind: "path"`, seed
`previousLocation = { root: path, project: ws.name, was_project_root: false }` —
for a config written by the old version, "the cards are directly in the picked
folder" is simply true. A `v: 1` config with a project root is left alone: its
path did not change.

## The migration module

New module `src-tauri/src/tasks/migrate.rs`, split into a pure decision and the
IO that carries it out. The rules are the part worth testing, and in a pure
function they are testable against an array of `Task` with no tempdir.

### Deciding

```rust
pub fn plan(cards: &[Task], project: &str, was_project_root: bool) -> MigrationPlan
```

`cards` is every card at the old root, unfiltered — foreign ones included, since
`plan` is what decides they are foreign and `left_foreign` is what the banner
reports. `list(project)` cannot supply that: it filters by project before
returning. So `FsTaskProvider::scan` becomes `pub(crate)`, and the caller builds
a second provider at `previousLocation.root` with `RootCreation::Never` — reading
the old root must never create it, least of all when it is an unmounted volume's
mount point.

```rust
if c.project == project     { moves.push(..) }          // ours, damaged or not
else if c.damaged.is_some() { if was_project_root { moves.push(..) }
                              else { left_damaged += 1 } }
else                        { left_foreign += 1 }       // another project's
```

The `project:` match is checked **first**, and the order carries meaning.
"Damaged" and "someone else's" are different things: a card with `kind: nonsense`
is damaged while its `project:` is perfectly fine, and it is ours. Checking
`damaged` first would leave such a card behind in a shared vault.

Damaged cards from an external root stay put because a damaged card there may be
an unrelated note that merely has an `id:` field — the same reasoning
`FsTaskProvider::resolve` already uses when it refuses to write into one. From
an in-project root everything is ours by construction, so damaged cards come
along; leaving them would orphan a card into a folder the board no longer reads.

`left_damaged` and `left_foreign` are returned for the banner's wording, not for
logic. Without them the banner would say "7 cards" where the folder holds 9, and
the discrepancy would be silent.

Cards with a duplicate `id` need no special case. Both files carry our
`project:`, both are planned, both move, and `conflict` is recomputed in the new
root so the flag survives. Splitting the pair would be worse than moving it
whole.

### Carrying it out

```rust
pub fn apply(
    plan: &MigrationPlan,
    to: &Path,
    /// Some(new_name) when the workspace was renamed.
    rename_project_to: Option<&str>,
) -> MigrationReport
```

Per card:

1. Destination already exists → skip, with "already at the destination" as the
   reason. File names are `<ulid>-<slug>.md` and ULIDs are unique, so a real
   collision means this card is already there — a re-run, not a clash.
2. `rename_project_to` is `Some` → read, rewrite the `project:` line, write to
   the destination, remove the source. The content changes either way, so
   `rename` has no part in this branch.
3. Otherwise → `fs::rename`, falling back to copy + remove on **any** error.
   `.cowork/tasks` to an external vault is an ordinary `EXDEV`; enumerating
   error kinds to gate a fallback that is correct unconditionally buys nothing.

The source is removed only after the destination is written. No branch has a
window where a card exists nowhere.

`tasks_migrate` runs `ensure_root_if_ours` on the destination before planning
anything. On an external root that creates the project subfolder inside an
existing parent; if the parent is missing it creates nothing and the command
fails with `RootMissing` before a single card is touched, rather than moving some
and then discovering there is nowhere to put the rest.

A failure on one card does not stop the rest, and the report lists what was
skipped and why — the same posture `scan()` already takes, where one unreadable
entry is skipped rather than failing the whole directory.

### `set_project` in `frontmatter.rs`

```rust
pub fn set_project(text: &str, new_project: &str) -> Option<String>
```

A line-level edit exactly like `set_status_done`: replaces the `project:` line
if present, inserts it if absent, preserves every other line byte-for-byte and
reuses the document's line-ending style. Going through `render_card` is not an
option — it knows nine keys, so `tags:`, `aliases:` and Dataview fields would be
dropped the first time a vault card was moved by a rename.

### Clearing `previousLocation`

Not on "apply returned success", but by re-checking: after `apply`, read the old
root again and rebuild the `plan`; clear `previousLocation` when `moves` is
empty. The condition is self-correcting — no bookkeeping about skip reasons, and
a re-run does not get stuck on cards that are already at the destination.

## IPC and data flow

```rust
tasks_migration_status(workspace_id)  -> Option<MigrationOffer>
tasks_migrate(workspace_id)           -> MigrationReport
tasks_migration_dismiss(workspace_id) -> ()
```

```rust
pub struct MigrationOffer {
    pub from: String,            // shown to the human in full
    pub to: String,
    pub moving: usize,
    pub leaving_foreign: usize,
    pub leaving_damaged: usize,
    pub renaming_project: bool,  // whether project: gets rewritten
}
```

`tasks_migration_status` returns `None` when there is no `previousLocation`, when
the old root is gone, or when the plan is empty — and in that last case it
clears `previousLocation` as it goes, so the self-correcting condition from the
previous section lives in exactly one place.

```
save_workspace (name or root changed)
  └─ writes previousLocation, bumps v to 2
store read (v == 1, path root)
  └─ seeds previousLocation
refreshBoard
  └─ tasks_capabilities + tasks_list + tasks_migration_status   <- third call
       └─ board.render({ …, migration })
[Move them here]  → tasks_migrate → taskWatchSync + refreshBoard + refreshCounts
[Leave them there] → tasks_migration_dismiss → refreshBoard
```

`taskWatchSync` after a move is required, not tidiness: the destination root may
have been created moments ago, and the watcher has to attach to it. Skipping it
leaves a board that only updates on the five-second poll, which reads as "it
sometimes lags" rather than as a missing watcher.

The sidebar badge counts the effective root only, so before a move it shows 0
while cards sit at the old location. Summing both roots would make the badge
claim the cards are here when the board does not show them; a zero next to an
explaining banner is the honest pair.

## The banner

```
┌─ Tasks ────────────────────────────────────────────┐
│ 7 cards are still in the previous location:        │
│ /home/u/vault/Tasks                                │
│ 2 cards there belong to other projects and stay.   │
│                                                    │
│   [Move them here]   [Leave them there]            │
│ Left there, they stay on disk but this board       │
│ will not show them.                                │
└────────────────────────────────────────────────────┘
  open (0)                    done (0)
```

The "belong to other projects" line renders only when `leaving_foreign > 0`;
otherwise it describes a situation where nothing is left behind.

The consequence sentence is not decoration. After a dismissal the cards stay on
disk but fall outside the effective root, and the board will not show them
again. It is recoverable by hand — point the tracker back at that folder — but it
reads as disappearance, so the button cannot just say "Leave them" and stop
there.

Real failures stay visible. When `apply` returns skips for any reason other than
"already at the destination", `previousLocation` survives, the banner re-renders
with the remainder, and the reasons render in the existing `.tk-warn` style.
There is no path where a move silently did half the job.

## Error handling

**An unmounted volume is the trap.** The tempting rule — "the old root is gone,
so clear `previousLocation`" — would silently forget cards on an external disk or
a network share that simply is not visible right now. Two distinct cases:

| Old root | Action |
| --- | --- |
| exists, nothing to move | clear `previousLocation` |
| **does not exist** | **keep** `previousLocation`, return `None` |

In the second case there is no banner, because there is nothing to offer — but
the pointer survives, so when the volume returns the banner returns with it.

**The external root's parent is missing** (a typo in the path). `tasks_list`
already fails with `RootMissing`, and the board already renders that through
`emptyStateMessage`. The banner shows alongside it, and together they explain the
whole picture: the destination does not exist because its parent does not.
"Move them here" fails with the same error into `.tk-warn`. No extra flag on
`MigrationOffer` — it is one error, surfaced where the person already reads
errors.

**The destination was written but the source could not be removed.** The card now
exists in two places, and `conflict` is computed per root so it will not catch
this pair. That makes it a skip with a reason rather than a silent success, and
`previousLocation` stays so the re-check sees it.

**`set_project` returned `None`** (no frontmatter). Impossible for a parsed card,
since `parse_card` requires a frontmatter block — but `apply` records a skip
instead of unwrapping. An invariant that holds in another module is not grounds
for a panic in this one.

## Testing

Pure `plan`, no tempdir:

- Ours moves. Ours-and-damaged moves.
- Damaged from an in-project root moves; from a shared external root it stays
  and lands in `leaving_damaged`.
- Foreign stays and lands in `leaving_foreign`.
- **Damaged but with a matching `project:` moves** — the test that fails if the
  checks in `plan` are reordered.
- A duplicate-`id` pair moves whole.

`resolve_root`: a path root resolves to `<path>/<ws.name>` with
`LeafInsideExistingParent`; a project root is unchanged with `Always`. The two
existing tests assert the verbatim path and must be updated.

`ensure_root_if_ours`, three cases of which one is a guard:

- `LeafInsideExistingParent` with an existing parent creates the leaf.
- `LeafInsideExistingParent` with a **missing** parent creates nothing. This
  test must fail if anyone "simplifies" the branch to `create_dir_all` — it is
  the typo guarantee.
- `Always` creates the whole chain; `Never` creates nothing.

`apply`, on a tempdir: a move leaves the source gone and the destination
present; a collision is skipped with a reason and the source is left intact;
`rename_project_to` rewrites `project:` while preserving `tags: [inbox]` and
CRLF.

`set_project`, pure: replaces an existing line, inserts a missing one, preserves
unknown keys and CRLF, returns `None` without frontmatter.

Config version: a `v1` path-root config seeds `previousLocation`; a `v1`
project-root config does not; a `v2` config is untouched. The existing `model.rs`
test about not truncating a settings file must keep passing.

Frontend: the banner renders with its counts; the "other projects" line is
absent when `leaving_foreign == 0`; the buttons call the right IPC and trigger a
refresh; no banner when `migration === null`. Assertions key on classes and
numbers rather than prose, so the wording can be rewritten without breaking
tests — with one exception, an assertion that the consequence line renders at
all, keyed on its class.

### A gap named rather than papered over

The `EXDEV` fallback branch (`rename` failed, so copy + remove) is not unit
tested. Simulating `EXDEV` honestly needs a second filesystem, and substituting
a read-only directory would test permissions instead of cross-device behaviour.
The copy + remove code itself does run, in the `rename_project_to` branch, so
what stays uncovered is the decision "it failed, try the other way" rather than
the copying path.
