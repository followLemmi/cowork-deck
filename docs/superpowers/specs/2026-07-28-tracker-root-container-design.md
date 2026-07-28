# Design: one container folder for tracker cards, and saying so before creating it

## The problem

An external tracker path currently resolves to `<picked>/<project-slug>`. That
keeps projects apart, which is what it was for, but it spends the person's own
folder to do it: point three workspaces at `~/vault` and `~/vault` grows three
directories it did not ask for, interleaved with whatever the human keeps there.

The fix is one directory of ours instead of many: `<picked>/cowork-deck-tasks/<project-slug>`.
Everything the app creates lives under a single name the person can recognise,
move, or delete as one unit.

The app also never says what it is about to create. A folder picker that quietly
grows two levels inside the chosen directory is a surprise even when the layout
is the right one, so the workspace form states the resolved path and names the
folders that do not exist yet.

## Scope

In scope:

- The effective root for an external tracker path becomes
  `<picked>/cowork-deck-tasks/<project-slug>`.
- Resolution recognises a picked folder that is already part of that layout and
  does not nest a second copy inside it.
- `RootCreation` carries the folder the human picked, so "everything below it is
  ours" is one rule covering zero, one and two levels.
- The workspace form shows the resolved root and which folders will be created.
- `TRACKER_CONFIG_VERSION` becomes 3, and a `v: 2` config seeds
  `previousLocation` so the existing banner offers to move the cards.

Out of scope:

- The in-project root `<ws.path>/.cowork/tasks` is unchanged. It is already
  per-project, and it is inside the project rather than in the person's space.
- The container name is fixed at `cowork-deck-tasks`. Making it configurable
  would add a field to every config and a migration to every rename of it, to
  save a person who does not want our folder from picking a different parent.
- No validation of the picked path at save time. A path that does not exist
  still saves and still surfaces as `RootMissing` on the board; the form
  explains rather than refuses. Blocking the save is a different feature — form
  validation — and it would need an answer for an unmounted volume, which is a
  legitimate path that is temporarily absent.
- Nothing about the GitHub or Jira providers.

## Root resolution

One constant, `TRACKER_CONTAINER = "cowork-deck-tasks"`, and three cases. In all
three the **base is the folder the human picked**, and everything below the base
is ours to create:

| Picked | Effective root | Ours to create |
| --- | --- | --- |
| an ordinary folder, `/vault` | `/vault/cowork-deck-tasks/my-project` | two levels |
| the container, `/vault/cowork-deck-tasks` | `/vault/cowork-deck-tasks/my-project` | one level |
| the project root, `/vault/cowork-deck-tasks/my-project` | itself | nothing |

Recognition is a pure function of the picked path and the workspace name:

```rust
fn append_layout(picked: &Path, slug: &str) -> PathBuf {
    let name = picked.file_name().and_then(|s| s.to_str());
    // Already the project folder inside our container: this IS the root.
    if name == Some(slug)
        && picked.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str())
            == Some(TRACKER_CONTAINER)
    {
        return picked.to_path_buf();
    }
    // Already the container: only the project folder is missing.
    if name == Some(TRACKER_CONTAINER) {
        return picked.join(slug);
    }
    picked.join(TRACKER_CONTAINER).join(slug)
}
```

The second case is the one that matters in practice. After the first migration
the container exists, so the next time someone opens the picker they see
`cowork-deck-tasks` and choose it — and a rule that only ever appended would
hand them `cowork-deck-tasks/cowork-deck-tasks/my-project`.

The third case is rarer but free once the parent is being inspected anyway, and
it is what makes re-picking the folder the board is already reading a no-op
rather than another doubling.

Recognition is deliberately **name-based, not content-based**. Asking the
filesystem "does this folder look like one of ours" would make resolution depend
on a directory read that can fail, and `resolve_root` is called on every list,
count and watcher sync. A folder the person happens to have named
`cowork-deck-tasks` is treated as ours, which is the same answer we would want
anyway.

`slugify(&ws.name)` stays the project component, with the reasoning unchanged
from the previous design: a workspace name is free text, and `slugify` yields
exactly one path component, never empty.

## Creation policy

`RootCreation::LeafInsideExistingParent` meant "create exactly one level, and
only if the parent exists". Two levels do not fit it, and the variant that
replaces it carries the base explicitly:

```rust
pub enum RootCreation {
    /// The whole chain is ours: `<ws.path>/.cowork/tasks`.
    Always,
    /// `base` must already exist; everything below it is ours to create.
    InsideExisting { base: PathBuf },
    /// Create nothing. The CLI receives an already-resolved COWORK_TASKS_DIR.
    Never,
}
```

`ensure_root` for `InsideExisting { base }`: if `base` is not a directory,
`RootMissing` — nothing is created, which is the typo guarantee stated once and
now covering any depth. Otherwise `create_dir_all(root)`, which is safe
precisely because the base was checked: recursion can only run below a directory
the human pointed at.

The `PathBuf` costs `RootCreation` its `Copy` derive. Three call sites pass it
by value today (`provider_for`, `tasks_watch_sync`, `start_session`) and become
clones or borrows. That is the honest price of making the base explicit; the
alternative — a level count, with the base recomputed by walking ancestors —
keeps `Copy` and puts an off-by-one where the typo guarantee lives.

## Telling the person what will be created

A new command, because the alternative is worse:

```rust
tracker_root_preview(workspace_name: String, picked_path: String)
    -> TrackerRootPreview

pub struct TrackerRootPreview {
    /// The resolved effective root, in full.
    pub root: String,
    /// Single folder names, outermost first, that do not exist yet — e.g.
    /// `["cowork-deck-tasks", "my-project"]`, never full paths. Empty when
    /// `base_missing`, because then nothing will be created.
    pub creating: Vec<String>,
    /// The picked folder itself is absent, so nothing will be created.
    pub base_missing: bool,
}
```

**A blank workspace name yields no preview at all.** `slugify("")` returns
`"task"`, so a form recomputing on every keystroke would show
`<picked>/cowork-deck-tasks/task` — a folder that will never exist — to anyone
who picks the folder before typing the name. The frontend therefore skips the
call while the name field is blank, and the line is absent rather than wrong.

Computing the preview in TypeScript would mean a second implementation of
`slugify` and of the three-case recognition rule, in a language that cannot
share the first one. They would agree on the day they were written and disagree
after the next change to either. The command keeps one source of truth and costs
one local IPC round-trip per keystroke in a modal.

The form renders, under the folder picker:

```
Cards will live in:
/home/u/vault/cowork-deck-tasks/cowork-deck
cowork-deck-tasks/ and cowork-deck/ will be created for you.
```

- The third line lists only what `creating` names, joined with " and " — one name
  reads `cowork-deck/ will be created for you.`, two read as in the block above.
  The line is absent when `creating` is empty: silence means there is nothing to
  create, and an "already exists" line would be noise on every subsequent edit
  of the same workspace.
- When `base_missing`, the third line is replaced by a warning that the chosen
  folder does not exist, so nothing will be created. This is the typo case, and
  it is the one moment where saying it early is worth more than the board's
  eventual `RootMissing`.
- The preview recomputes when **either** the path or the name changes: the
  project component is `slugify(&ws.name)`, so editing the name in the same form
  moves the folder. Watching only the path would show a stale path to anyone who
  renames a workspace and repoints it in one sitting.
- The tracker block already hides itself unless the "path" root kind is
  selected (`syncTracker` in `src/forms.ts`); the preview lives inside that
  block and follows the same visibility.

Failures of the preview command are swallowed into "no preview" rather than
surfaced. It is an explanatory line in a form, and a modal that refuses to open
because a path could not be probed would be worse than one that says less.

## Migrating a v2 config

`TRACKER_CONFIG_VERSION` becomes 3, and `seed_previous_location` stops meaning
"below the current version, so the cards are in the picked folder" and becomes a
decision per version:

| Config version | Where the cards physically are |
| --- | --- |
| `v: 1` | directly in the picked folder |
| `v: 2` | `<picked>/<slug>` |
| `v: 3` | nothing to seed |

Everything downstream is already built and tested: the pointer, the offer, the
banner, `apply`, and the `project:` rewrite on a rename.

**The trap this version has and the previous one did not.** When the picked
folder is already the container, the v2 root and the v3 root are the same path —
both `/vault/cowork-deck-tasks/my-project`. Seeding there would offer to move
cards from a folder into itself. So seeding gains the guard
`with_previous_location` already has: **do not seed when the computed old root
equals the current effective root.** Without it, the second case of the
recognition table produces a banner that can never be satisfied.

The existing "a pending pointer wins" rule covers the chained upgrade. Someone
who never answered the v1 banner and now reads a v3 build still has
`previousLocation` pointing at the picked folder — where the cards actually are —
and it is left alone rather than recomputed into an empty directory.

## Error handling

**The picked folder is missing.** `RootMissing`, nothing created, at any depth.
The form says so up front; the board says so on read. Save is still allowed:
an unmounted volume is a legitimate configuration that is temporarily absent,
and refusing the save would make the app unusable in exactly the case the
previous design took care to survive.

**A file sits where the container should go.** `base.is_dir()` is false for the
level above it, or `create_dir_all` fails; either way it surfaces as
`RootMissing` or `Io` on the first read, in the place the person already reads
errors. No special case.

**Two workspaces whose names slugify identically** still share one folder inside
the container, and `project:` still keeps their boards apart. Unchanged, and
still accepted for the same reason.

## Testing

Pure `resolve_root`, no tempdir:

- An ordinary folder gains both levels, and the base is the picked folder.
- The container gains only the project level.
- The project folder inside the container resolves to itself.
- **The `../..` escape test from the previous design must still pass.** It is
  the reason the project component is a slug, and the new cases must not have
  moved that guarantee.

`ensure_root` / `ensure_root_if_ours` with `InsideExisting { base }`:

- Two levels created inside an existing base.
- One level created when the container already exists.
- Nothing created, and no error, when root equals base and base exists.
- **Nothing created when the base is missing.** This test must fail if anyone
  reduces the branch to an unguarded `create_dir_all` — it is the typo
  guarantee, and it is now the only thing standing between a mistyped path and a
  two-level tree.

`seed_previous_location`: a `v: 1` config seeds the picked folder; a `v: 2`
config seeds `<picked>/<slug>`; a `v: 3` config is untouched; a `v: 2` config
whose picked folder is the container seeds nothing; a pending pointer survives
all of them.

`tracker_root_preview`: the pure resolution is tested through `resolve_root`, so
what this needs is a tempdir case per shape — both levels missing, container
present, everything present, base missing — asserting `creating` and
`base_missing` rather than prose.

Frontend: the preview line renders the path it was given; the "will be created"
line appears only when `creating` is non-empty and lists those names; the
missing-base warning replaces it when `base_missing`; a blank name produces no
preview and no call; a rejected preview call leaves the form usable with no line.
Assertions key on classes and values, not on wording.

### A gap named rather than papered over

Nothing here tests that the preview and `resolve_root` agree, because they are
the same code path by construction — the command calls `resolve_root`. If a
future change gives the preview its own resolution, that agreement becomes
untested and the duplication this design exists to avoid is back.
