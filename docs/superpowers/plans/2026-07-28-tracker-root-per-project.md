# Per-Project Tracker Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external tracker path resolves to `<picked>/<project-slug>` so one shared folder stops mixing projects, and whenever a workspace's effective root moves the board offers to move the existing cards there.

**Architecture:** `resolve_root` in `src-tauri/src/tasks_cmd.rs` stays the single choke point for path decisions and starts appending a per-project component. Because that moves the root, `TrackerConfig` gains a `previousLocation` pointer written on save and seeded for pre-change configs, and a new `tasks/migrate.rs` splits "what would move" (pure, over `&[Task]`) from "move it" (IO). The board reads the offer through a third IPC call in `refreshBoard` and renders a banner above its columns.

**Tech Stack:** Rust + Tauri 2 backend (`serde`, `tempfile` for tests), TypeScript frontend with Vitest + jsdom. No new dependencies.

## Global Constraints

- **English only.** Every string, comment, test name and doc in this plan is English. See `CLAUDE.md`; the only Cyrillic exceptions are the existing fixtures in `placeholders.ts`, `commands.ts`, `frontmatter.rs::slugify_keeps_cyrillic_and_strips_punctuation` and the filename assertion in `fs.rs`.
- **A user-supplied path is never created silently.** A typo in the picked folder must surface as `TaskError::RootMissing`, never as a new empty tree. This is the guarantee `RootCreation::LeafInsideExistingParent` exists to keep.
- **A card is never nowhere.** In every branch of `apply`, the source file is removed only after the destination is written.
- **`render_card` must never touch a vault card.** It knows nine keys. Any in-place frontmatter edit goes through the line-level editor in `frontmatter.rs`, so `tags:`, `aliases:` and Dataview fields survive.
- **One failing handle does not fail the tick.** Every added IPC call in `refreshBoard` gets its own `try`/`catch`, matching the existing `taskCapabilities`/`listTasks` treatment.
- **`TRACKER_CONFIG_VERSION = 2`.** Every code path that persists a `TrackerConfig` stamps this value, or a dismissed banner comes back on the next read.

## Four corrections to the spec

Both were found while writing this plan. Implement the plan's version.

1. **The subfolder name is `slugify(&ws.name)`, not `ws.name` verbatim.** A workspace name is free text from a form, so `PathBuf::join(&ws.name)` with a name like `../..` would escape the picked folder entirely. `slugify` already exists, is tested, is Unicode-aware, and by construction yields exactly one path component: only alphanumerics survive, so no separators, no `.`/`..`, and it never returns empty. The cost is cosmetic drift — `My Project` becomes the folder `my-project` — and one edge case: two workspaces whose names slugify identically would share a folder, where `project:` filtering still keeps their boards apart.

2. **The old root in `moving_back_to_where_the_cards_are_clears_the_pointer` is `/home/u/vault/tasks`, lowercase.** Found while executing Task 3: the test as first written seeded the pointer at `/home/u/vault/Tasks` and then renamed the workspace to `Tasks`, expecting the two to meet. They cannot — correction 1 makes the subfolder `slugify(&ws.name)`, and `slugify` lowercases, so the effective root is `/home/u/vault/tasks`. The implementation was right and the expectation was wrong, which is what the corrected spelling records.

3. **`FsTaskProvider::scan` becomes `pub`, not `pub(crate)`.** Found while executing Task 6: `tasks/fs.rs` is part of the `cowork_deck` **library** crate, while `tasks_cmd.rs` is a module of the **binary** crate, which reaches the tasks tree through `use cowork_deck::tasks` in `main.rs`. `pub(crate)` therefore does not reach the caller, and the build fails with `method scan is private`. Widening the otherwise deliberately minimal library surface is the cost of `offer_for` needing unfiltered cards.

4. **`previousLocation` is cleared from `apply`'s report, not from a re-plan.** The spec said to re-plan the old root and clear when `moves` is empty. That never clears when a card was skipped because the destination already had a file of that name: the card is still at the old root, so it is still in the plan, and the banner would nag forever. `apply` therefore classifies skips, and the caller clears when every skip is `AlreadyAtDestination`.

---

## File Structure

**Created**

- `src-tauri/src/tasks/migrate.rs` — the migration decision (`plan`, pure) and its execution (`apply`, IO). Nothing else in the tree knows how a card moves.

**Modified**

- `src-tauri/src/tasks/fs.rs` — `RootCreation` enum; `FsTaskProvider::new` takes it; `ensure_root` honours it; `scan` becomes `pub(crate)`.
- `src-tauri/src/tasks/frontmatter.rs` — private `set_fields` extracted from `set_status_done`; new `set_project` built on it.
- `src-tauri/src/tasks/mod.rs` — register `migrate`.
- `src-tauri/src/model.rs` — `PreviousLocation`; `TrackerConfig` gains `previous_location` and `version`; `TRACKER_CONFIG_VERSION`.
- `src-tauri/src/tasks_cmd.rs` — `resolve_root` returns `RootCreation`; `ensure_root_if_ours` honours it; pure `effective_root` / `is_project_root` / `with_previous_location` / `seed_previous_location`; normalizing `tracker_workspaces`; three new commands.
- `src-tauri/src/commands.rs` — `save_workspace` records the previous location.
- `src-tauri/src/main.rs` — register the three commands.
- `src-tauri/src/bin/cowork_task.rs` — pass `RootCreation::Never`.
- `src/ipc.ts` — `MigrationOffer`, `MigrationReport` types and three wrappers.
- `src/board.ts` — `BoardState.migration`, two handlers, the banner.
- `src/main.ts` — fetch the offer in `refreshBoard`, wire the handlers.
- `src/styles.css` — banner styling.

---

## Task 1: Line-level frontmatter field editing

`set_status_done` and the `set_project` this feature needs are the same algorithm with a different key list. Extract the shared part first, so the new function is three lines instead of a second copy of forty.

**Files:**
- Modify: `src-tauri/src/tasks/frontmatter.rs:151-183` (`set_status_done`)
- Test: `src-tauri/src/tasks/frontmatter.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn set_project(text: &str, new_project: &str) -> Option<String>`. Returns `None` when `text` has no frontmatter block. `pub fn set_status_done(text: &str, resolved_ts: &str) -> Option<String>` keeps its exact signature and behaviour.

- [ ] **Step 1: Write the failing tests for `set_project`**

Append inside `mod tests` in `src-tauri/src/tasks/frontmatter.rs`:

```rust
    #[test]
    fn set_project_replaces_an_existing_line() {
        let text = "---\nid: 01K1\ntitle: t\nproject: old-name\nstatus: open\n---\nbody\n";
        let out = set_project(text, "new-name").expect("has frontmatter");
        assert!(out.contains("project: new-name"), "{out}");
        assert!(!out.contains("old-name"), "the old value must be gone: {out}");
        assert!(out.contains("title: t"), "other keys must survive: {out}");
    }

    #[test]
    fn set_project_inserts_the_line_when_missing() {
        let text = "---\nid: 01K1\nstatus: open\n---\nbody\n";
        let out = set_project(text, "deck").expect("has frontmatter");
        assert!(out.contains("project: deck"), "{out}");
        assert!(out.contains("status: open"), "{out}");
    }

    #[test]
    fn set_project_preserves_an_unknown_key_and_crlf() {
        let text = "---\r\nid: 01K1\r\nproject: old\r\ntags: [inbox]\r\n---\r\nbody\r\n";
        let out = set_project(text, "deck").expect("has frontmatter");
        assert!(out.contains("tags: [inbox]"), "a vault key must survive: {out}");
        assert!(out.contains("project: deck\r\n"), "CRLF must be reused: {out}");
        assert!(!out.contains("project: deck\n\r"), "no mixed endings: {out}");
    }

    #[test]
    fn set_project_returns_none_without_frontmatter() {
        assert!(set_project("just text\n", "deck").is_none());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test set_project`
Expected: FAIL to compile — `cannot find function 'set_project' in this scope`.

- [ ] **Step 3: Extract `set_fields` and express both functions on it**

In `src-tauri/src/tasks/frontmatter.rs`, replace the whole body of `set_status_done` (keep its doc comment) with these three functions:

```rust
/// Set each `key: value` in an existing frontmatter block, replacing the line
/// where the key is already present and appending it where it is not. Keys are
/// appended in the order given. Every other line, and the body, is left
/// untouched byte-for-byte, and the document's line-ending style is reused for
/// both edited and inserted lines. Returns `None` when `text` has no
/// frontmatter block.
fn set_fields(text: &str, fields: &[(&str, &str)]) -> Option<String> {
    // The whole document uses one line-ending style throughout; reuse it so
    // CRLF input stays CRLF.
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (head, body) = split_frontmatter(text)?;

    let mut lines: Vec<String> = Vec::new();
    let mut seen = vec![false; fields.len()];
    for line in head.lines() {
        let key = line.split_once(':').map(|(k, _)| k.trim());
        match fields.iter().position(|(k, _)| Some(*k) == key) {
            Some(i) => {
                lines.push(format!("{}: {}", fields[i].0, fields[i].1));
                seen[i] = true;
            }
            None => lines.push(line.to_string()),
        }
    }
    for (i, (k, v)) in fields.iter().enumerate() {
        if !seen[i] {
            lines.push(format!("{k}: {v}"));
        }
    }

    let mut out = String::from("---");
    out.push_str(nl);
    for line in &lines {
        out.push_str(line);
        out.push_str(nl);
    }
    out.push_str("---");
    out.push_str(nl);
    out.push_str(body);
    Some(out)
}

/// Close a card: `status: done` plus a `resolved:` timestamp.
///
/// This exists so `resolve` never goes through `render_card` (which only knows
/// nine keys) on a real vault file: a card that also carries `tags:`,
/// `aliases:`, or Dataview fields would otherwise lose them the moment it is
/// closed. Returns `None` when `text` has no frontmatter block at all.
pub fn set_status_done(text: &str, resolved_ts: &str) -> Option<String> {
    set_fields(text, &[("status", "done"), ("resolved", resolved_ts)])
}

/// Repoint a card at a renamed project. Needed because `list` filters cards by
/// the workspace name, so cards moved by a rename would arrive at the new root
/// and still read as another project's.
pub fn set_project(text: &str, new_project: &str) -> Option<String> {
    set_fields(text, &[("project", new_project)])
}
```

- [ ] **Step 4: Run the whole frontmatter suite to verify the refactor changed nothing**

Run: `cd src-tauri && cargo test tasks::frontmatter`
Expected: PASS, including every pre-existing `set_status_done` test. Those tests are the safety net for the extraction — if `set_status_done_preserves_an_unknown_key`, `set_status_done_inserts_resolved_when_missing` or the CRLF test fails, `set_fields` diverged from the original and must be fixed rather than the tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/frontmatter.rs
git commit -m "refactor(tracker): one frontmatter field editor for status and project

set_project is the same algorithm as set_status_done with a different key
list, so the shared part becomes set_fields rather than a second copy. The
pre-existing set_status_done tests are what make the extraction safe: they
pin the behaviour the new function has to keep."
```

---

## Task 2: `RootCreation` and the per-project root

**Files:**
- Modify: `src-tauri/src/tasks/fs.rs:6-28` (struct, `new`, `ensure_root`), `:33` (`scan` visibility), `:171-173` and `:311`, `:323` (test constructors)
- Modify: `src-tauri/src/tasks_cmd.rs:31-57` (`resolve_root`, `ensure_root_if_ours`), `:67-70` (`provider_for`), `:196-232` (tests)
- Modify: `src-tauri/src/bin/cowork_task.rs:95`
- Modify: `src-tauri/src/commands.rs:219-226` (the `resolve_root` destructuring in `start_session`)

**Interfaces:**
- Consumes: `slugify` from `crate::tasks::frontmatter` (existing, `pub`).
- Produces:
  - `pub enum RootCreation { Always, LeafInsideExistingParent, Never }` in `crate::tasks::fs`, deriving `Debug, Clone, Copy, PartialEq, Eq`.
  - `pub fn FsTaskProvider::new(root: PathBuf, creation: RootCreation) -> Self`.
  - `pub(crate) fn FsTaskProvider::scan(&self) -> Result<Vec<Task>, TaskError>` — every card at the root, unfiltered, with `conflict` already set.
  - `pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, RootCreation)>`.
  - `pub fn ensure_root_if_ours(root: &Path, creation: RootCreation) -> std::io::Result<()>`.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/tasks_cmd.rs`, replace the two existing root tests and add two more. The full replacement for `project_root_lives_inside_the_workspace_and_is_ours_to_create`, `external_root_is_used_verbatim_and_never_created` and `ensure_root_if_ours_creates_a_project_root_but_never_a_path_root`:

```rust
    #[test]
    fn project_root_lives_inside_the_workspace_and_is_ours_to_create() {
        let w = ws(Some(tracker(TrackerRoot::Project)));
        let (root, creation) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/proj/.cowork/tasks"));
        assert_eq!(creation, RootCreation::Always);
    }

    #[test]
    fn an_external_root_gets_a_per_project_subfolder() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault/Tasks".into() })));
        let (root, creation) = resolve_root(&w).expect("configured");
        // One shared folder holding several projects is the whole reason this
        // exists: the cards go one level down, named for the project.
        assert_eq!(root, std::path::Path::new("/home/u/vault/Tasks/cowork-deck"));
        assert_eq!(creation, RootCreation::LeafInsideExistingParent);
    }

    #[test]
    fn the_subfolder_is_a_slug_so_a_workspace_name_cannot_escape_the_picked_folder() {
        // A workspace name is free text from a form. Joined verbatim, "../.."
        // would put the cards outside the folder the person picked.
        let mut w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        w.name = "../../etc".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/etc"));

        w.name = "My Project".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/my-project"));
    }

    #[test]
    fn ensure_root_if_ours_creates_a_project_root_but_never_a_path_root() {
        let dir = tempfile::tempdir().unwrap();

        let project_root = dir.path().join("proj").join(".cowork").join("tasks");
        ensure_root_if_ours(&project_root, RootCreation::Always).unwrap();
        assert!(project_root.is_dir(), "the in-project root is ours to create");

        // The picked folder exists, so its project subfolder is ours to make.
        let picked = dir.path().join("vault");
        std::fs::create_dir(&picked).unwrap();
        let leaf = picked.join("deck");
        ensure_root_if_ours(&leaf, RootCreation::LeafInsideExistingParent).unwrap();
        assert!(leaf.is_dir(), "a subfolder inside an existing parent is ours to make");
    }

    #[test]
    fn ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo() {
        let dir = tempfile::tempdir().unwrap();
        // This is the typo guarantee. If anyone "simplifies" the branch to
        // create_dir_all, this test is what fails.
        let leaf = dir.path().join("vualt").join("deck");
        ensure_root_if_ours(&leaf, RootCreation::LeafInsideExistingParent).unwrap();
        assert!(!leaf.exists(), "a typo'd parent must not be created");
        assert!(!dir.path().join("vualt").exists(), "nor its parent");

        let never = dir.path().join("cli-root");
        ensure_root_if_ours(&never, RootCreation::Never).unwrap();
        assert!(!never.exists(), "the CLI creates nothing");
    }
```

Replace the `no_tracker_is_a_legal_state_not_an_error` body's inline construction and add the `tracker` helper next to the existing `ws` helper in that `mod tests`:

```rust
    fn tracker(root: TrackerRoot) -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::Fs { root }],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }
    }
```

```rust
    #[test]
    fn no_tracker_is_a_legal_state_not_an_error() {
        assert!(resolve_root(&ws(None)).is_none());
        assert!(resolve_root(&ws(Some(TrackerConfig {
            providers: vec![],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        })))
        .is_none());
    }
```

Add to the `use` block of that `mod tests`: `use crate::tasks::fs::RootCreation;`

> **This task owns the `TrackerConfig` field additions**, not Task 3. The `tracker` helper above needs `previous_location` and `version` to exist, so Step 3 below adds both fields plus the `PreviousLocation` struct and `TRACKER_CONFIG_VERSION`. Task 3 adds only the pure helpers that read and write them. Do not skip ahead to Task 3 for the model change — everything you need is in this task's Step 3.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL to compile — `cannot find type 'RootCreation'`, and `struct 'TrackerConfig' has no field named 'previous_location'`.

- [ ] **Step 3: Add the enum, the two config fields, and honour them**

In `src-tauri/src/tasks/fs.rs`, above `pub struct FsTaskProvider`:

```rust
/// How much of a root a provider may bring into existence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootCreation {
    /// The whole chain is ours: on a fresh project `<ws.path>/.cowork/tasks`
    /// has neither `.cowork` nor `tasks` yet, so a "create the leaf inside an
    /// existing parent" rule would refuse the case it is meant to handle.
    Always,
    /// Only the leaf, and only inside a parent that already exists. This is
    /// what keeps a typo'd external path surfacing as `RootMissing` instead of
    /// scattering an empty tree across the disk.
    LeafInsideExistingParent,
    /// Create nothing. `cowork_task` is handed an already-resolved
    /// `COWORK_TASKS_DIR` and must not invent folders from a stale env var.
    Never,
}
```

Replace the struct, `new` and `ensure_root`:

```rust
pub struct FsTaskProvider {
    root: PathBuf,
    creation: RootCreation,
}

impl FsTaskProvider {
    pub fn new(root: PathBuf, creation: RootCreation) -> Self {
        Self { root, creation }
    }

    fn ensure_root(&self) -> Result<(), TaskError> {
        if self.root.is_dir() {
            return Ok(());
        }
        let missing = || TaskError::RootMissing(self.root.to_string_lossy().to_string());
        match self.creation {
            RootCreation::Always => {
                std::fs::create_dir_all(&self.root).map_err(|e| TaskError::Io(e.to_string()))
            }
            RootCreation::LeafInsideExistingParent => {
                match self.root.parent() {
                    Some(p) if p.is_dir() => {
                        std::fs::create_dir(&self.root).map_err(|e| TaskError::Io(e.to_string()))
                    }
                    // The picked folder itself is missing: a typo, an unmounted
                    // volume, a deleted directory. Say so instead of creating it.
                    _ => Err(missing()),
                }
            }
            RootCreation::Never => Err(missing()),
        }
    }
```

Change `fn scan` to `pub(crate) fn scan` — the migration reads the old root's cards unfiltered, which `list` cannot supply because it filters by project before returning.

In `src-tauri/src/tasks/fs.rs` tests, change the three constructors:
- `:171-173` → `FsTaskProvider::new(dir.to_path_buf(), RootCreation::Never)`
- `:311` → `FsTaskProvider::new(absent.clone(), RootCreation::Never)`
- `:323` → `FsTaskProvider::new(root.clone(), RootCreation::Always)`

In `src-tauri/src/model.rs`, add the two fields to `TrackerConfig` (the rest of the model change is Task 3):

```rust
pub struct TrackerConfig {
    #[serde(default)]
    pub providers: Vec<TrackerProvider>,
    /// Where this workspace's cards were before its effective root last moved.
    #[serde(rename = "previousLocation", default, skip_serializing_if = "Option::is_none")]
    pub previous_location: Option<PreviousLocation>,
    /// Storage format. Version 1 had no `previousLocation` and resolved an
    /// external root verbatim, so its cards sit directly in the picked folder.
    /// Records without the field are version 1 and are seeded on read.
    #[serde(rename = "v", default = "tracker_v1")]
    pub version: u8,
}

fn tracker_v1() -> u8 { 1 }

pub const TRACKER_CONFIG_VERSION: u8 = 2;
```

Also add the `PreviousLocation` struct above it (Task 3 adds its helpers, this task only needs the type to compile):

```rust
/// Where a workspace's cards were before its effective root last moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviousLocation {
    /// Where to look for the old cards.
    pub root: String,
    /// The project name at that time. When it differs from the current
    /// `ws.name`, `project:` inside the moved cards has to be rewritten.
    pub project: String,
    /// Whether that was the in-project root, which decides whether damaged
    /// cards come along: from `.cowork/tasks` everything is ours by
    /// construction, from a shared vault a damaged card may be someone's note
    /// that merely has an `id:` field.
    #[serde(rename = "wasProjectRoot")]
    pub was_project_root: bool,
}
```

Update the two `TrackerConfig` constructions in `src-tauri/src/model.rs:330` and `:337` to add `previous_location: None, version: TRACKER_CONFIG_VERSION,`.

In `src-tauri/src/tasks_cmd.rs`, replace `resolve_root`, `ensure_root_if_ours` and `provider_for`:

```rust
/// The provider root for a workspace, plus how much of it we may create.
/// `None` means "no tracker configured" — a legal, non-error state.
pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, RootCreation)> {
    let cfg = ws.tracker.as_ref()?;
    let first = cfg.providers.first()?;
    match first {
        TrackerProvider::Fs { root: TrackerRoot::Project } => Some((
            PathBuf::from(&ws.path).join(".cowork").join("tasks"),
            RootCreation::Always,
        )),
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => Some((
            // One folder per project inside the folder the person picked: they
            // pick one place for every project's backlog, and without this the
            // cards all land in the same directory.
            //
            // Slugified, not joined verbatim: a workspace name is free text, and
            // `join("../..")` would put the cards outside the picked folder
            // entirely. `slugify` yields exactly one component — only
            // alphanumerics survive, so no separators and no `..` — and never
            // returns empty.
            PathBuf::from(path).join(slugify(&ws.name)),
            RootCreation::LeafInsideExistingParent,
        )),
    }
}

/// Create as much of `root` as `creation` allows. A `LeafInsideExistingParent`
/// root whose parent is missing is left alone here rather than reported:
/// `FsTaskProvider::ensure_root` surfaces the same `RootMissing` loudly the
/// moment a card is actually read or written, and this function's callers
/// (`tasks_watch_sync`, `start_session`) are best-effort by design.
pub fn ensure_root_if_ours(
    root: &std::path::Path,
    creation: RootCreation,
) -> std::io::Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    match creation {
        RootCreation::Always => std::fs::create_dir_all(root),
        RootCreation::LeafInsideExistingParent => match root.parent() {
            Some(p) if p.is_dir() => std::fs::create_dir(root),
            _ => Ok(()),
        },
        RootCreation::Never => Ok(()),
    }
}

fn provider_for(ws: &Workspace) -> Result<FsTaskProvider, String> {
    let (root, creation) = resolve_root(ws).ok_or_else(|| "not-configured".to_string())?;
    Ok(FsTaskProvider::new(root, creation))
}
```

Add to the imports at the top of `tasks_cmd.rs`:

```rust
use crate::model::{PreviousLocation, TrackerProvider, TrackerRoot, Workspace, TRACKER_CONFIG_VERSION};
use crate::tasks::frontmatter::slugify;
use crate::tasks::fs::{FsTaskProvider, RootCreation};
```

In `src-tauri/src/bin/cowork_task.rs:95`:

```rust
    let provider = FsTaskProvider::new(
        std::path::PathBuf::from(&dir),
        FsRootCreation::Never,
    );
```

with `use cowork_deck::tasks::fs::{FsTaskProvider, RootCreation as FsRootCreation};` added to its imports (match the crate path the file already uses for `FsTaskProvider`).

In `src-tauri/src/commands.rs:219-226`, the destructuring `let resolved = crate::tasks_cmd::resolve_root(&ws);` now yields `RootCreation` in the second slot; change the `ensure_root_if_ours(root, *create)` call to `ensure_root_if_ours(root, *creation)` and rename the binding to match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS. `cargo clippy --all-targets` must report the same seven warnings as before this task and no new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(tracker): one folder per project inside a picked tracker root

A picked folder is where someone keeps every project's backlog, so using it
verbatim made one directory hold every project's cards at once. The effective
root becomes <picked>/<slug of the project name>.

The name is slugified rather than joined verbatim because a workspace name is
free text from a form: '../..' would put the cards outside the picked folder.
slugify yields exactly one path component and never returns empty.

resolve_root's bool grew into RootCreation because three creation policies no
longer fit in two states: the in-project root needs the whole chain, an
external root's project subfolder may only be made inside a parent that
already exists (so a typo still surfaces as RootMissing), and the CLI creates
nothing at all."
```

---

## Task 3: Remembering where the cards were

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs` (add pure helpers and the normalizing accessors — the `TrackerConfig` fields themselves were added in Task 2)
- Modify: `src-tauri/src/commands.rs:81-84` (`save_workspace`)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `resolve_root`, `RootCreation` (Task 2); `PreviousLocation`, `TRACKER_CONFIG_VERSION` (Task 2's model change).
- Produces:
  - `pub fn with_previous_location(old: Option<&Workspace>, new: Workspace) -> Workspace` — stamps `version` and records where the cards were, when saving `new` moves the effective root. Pure.
  - `pub fn seed_previous_location(ws: Workspace) -> Workspace` — a `v: 1` external config gets `previousLocation` pointing at the picked folder itself. Pure.
  - `fn tracker_workspaces(state: &State<AppState>) -> Result<Vec<Workspace>, String>` — every workspace, seeded.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks_cmd.rs`:

```rust
    fn v1_external(path: &str) -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Path { path: path.into() } }],
            previous_location: None,
            version: 1,
        }
    }

    #[test]
    fn a_v1_external_config_is_seeded_with_the_picked_folder_itself() {
        // Version 1 resolved the picked folder verbatim, so that is where the
        // cards physically are. Without seeding, the board would silently go
        // empty the first time someone updated the app.
        let out = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        let prev = out.tracker.unwrap().previous_location.expect("seeded");
        assert_eq!(prev.root, "/home/u/vault/Tasks");
        assert_eq!(prev.project, "cowork-deck");
        assert!(!prev.was_project_root);
    }

    #[test]
    fn a_v1_project_config_is_not_seeded_because_its_path_did_not_move() {
        let mut cfg = tracker(TrackerRoot::Project);
        cfg.version = 1;
        let out = seed_previous_location(ws(Some(cfg)));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn a_current_config_is_left_alone_by_seeding() {
        let out = seed_previous_location(ws(Some(tracker(
            TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
        ))));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn moving_the_root_records_where_the_cards_were() {
        let old = ws(Some(tracker(TrackerRoot::Project)));
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("recorded");
        assert_eq!(prev.root, "/home/u/proj/.cowork/tasks");
        assert_eq!(prev.project, "cowork-deck");
        assert!(prev.was_project_root, "damaged cards come along from our own folder");
    }

    #[test]
    fn renaming_the_workspace_records_the_old_name_and_the_old_root() {
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let mut new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        new.name = "deck".into();
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("recorded");
        // The folder is named for the project, so a rename moves the root too.
        assert_eq!(prev.root, "/home/u/vault/cowork-deck");
        assert_eq!(prev.project, "cowork-deck");
    }

    #[test]
    fn saving_without_moving_the_root_records_nothing() {
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let mut new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        new.color = "#98c379".into();
        let out = with_previous_location(Some(&old), new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn creating_a_workspace_records_nothing() {
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(None, new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn an_unmoved_pending_pointer_wins_over_the_old_effective_root() {
        // The cards are at the seeded location, not at the root the old config
        // resolved to — nothing was ever written to a root that was configured
        // and then left behind. Overwriting the pointer here would send the
        // migration looking in an empty folder.
        let old = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/other".into() })));
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("carried forward");
        assert_eq!(prev.root, "/home/u/vault/Tasks");
    }

    #[test]
    fn moving_back_to_where_the_cards_are_clears_the_pointer() {
        let old = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        // Picking a folder whose project subfolder IS the old location.
        let mut new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        new.name = "Tasks".into();
        let out = with_previous_location(Some(&old), new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn every_save_stamps_the_current_config_version() {
        // A dismissed banner must not come back on the next read, which is only
        // true while every persisting path leaves v at the current value.
        let out = with_previous_location(None, ws(Some(v1_external("/home/u/vault/Tasks"))));
        assert_eq!(out.tracker.unwrap().version, TRACKER_CONFIG_VERSION);
    }

    #[test]
    fn turning_the_tracker_off_records_nothing() {
        // There is nowhere to move cards to, so a pointer would describe a
        // migration that can never be offered.
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(Some(&old), ws(None));
        assert!(out.tracker.is_none());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL to compile — `cannot find function 'seed_previous_location'` and `cannot find function 'with_previous_location'`.

- [ ] **Step 3: Implement the helpers and wire them in**

Add to `src-tauri/src/tasks_cmd.rs`, below `ensure_root_if_ours`:

```rust
/// A workspace's effective root as a string, or `None` with no tracker.
fn effective_root(ws: &Workspace) -> Option<String> {
    resolve_root(ws).map(|(root, _)| root.to_string_lossy().to_string())
}

/// Whether this workspace's cards live in the in-project root, where every card
/// is ours by construction.
fn is_project_root(ws: &Workspace) -> bool {
    matches!(
        ws.tracker.as_ref().and_then(|c| c.providers.first()),
        Some(TrackerProvider::Fs { root: TrackerRoot::Project })
    )
}

/// Stamp the config version and, when saving `new` moves the effective root,
/// record where the cards were so the board can offer to bring them along.
///
/// Pure: no filesystem and no store access. Whether any cards are actually at
/// the old root is the banner's question — asking it here would make saving a
/// workspace depend on a directory read that can fail.
pub fn with_previous_location(old: Option<&Workspace>, mut new: Workspace) -> Workspace {
    if let Some(cfg) = new.tracker.as_mut() {
        cfg.version = TRACKER_CONFIG_VERSION;
    }

    // Creating a workspace: there is no old root, and seeding one from a
    // freshly picked folder would offer to move cards nobody has filed yet.
    let Some(old) = old else { return new };

    // Turning the tracker off: nowhere to move cards to, so nothing to record.
    let Some(new_root) = effective_root(&new) else { return new };

    // An un-acted-on pointer wins over the old effective root. A seeded v1
    // config, or an earlier move nobody confirmed, still names where the cards
    // physically are; nothing was ever written to a root that was configured
    // and then left behind.
    let previous = match old.tracker.as_ref().and_then(|c| c.previous_location.clone()) {
        Some(pending) => pending,
        None => match effective_root(old) {
            Some(root) => PreviousLocation {
                root,
                project: old.name.clone(),
                was_project_root: is_project_root(old),
            },
            None => return new,
        },
    };

    // Configured back to where the cards already are: nothing to migrate.
    if previous.root == new_root {
        return new;
    }
    if let Some(cfg) = new.tracker.as_mut() {
        cfg.previous_location = Some(previous);
    }
    new
}

/// A `v: 1` config resolved an external root verbatim, so its cards sit
/// directly in the picked folder rather than in the project subfolder this
/// version resolves to. Seed that as the previous location, or updating the app
/// would empty the board with no explanation.
pub fn seed_previous_location(mut ws: Workspace) -> Workspace {
    let name = ws.name.clone();
    let Some(cfg) = ws.tracker.as_mut() else { return ws };
    if cfg.version >= TRACKER_CONFIG_VERSION || cfg.previous_location.is_some() {
        return ws;
    }
    let picked = match cfg.providers.first() {
        Some(TrackerProvider::Fs { root: TrackerRoot::Path { path } }) => path.clone(),
        // A project root did not move: `<ws.path>/.cowork/tasks` is what
        // version 1 resolved to as well.
        _ => return ws,
    };
    cfg.previous_location = Some(PreviousLocation {
        root: picked,
        project: name,
        was_project_root: false,
    });
    ws
}
```

Replace the existing `fn workspace` and add the accessor above it:

```rust
/// Workspaces as the tracker sees them: a config written before
/// `TRACKER_CONFIG_VERSION` gets its previous location seeded. Normalizing here
/// rather than in `Store` keeps storage free of tracker semantics — and the
/// seed needs `ws.name`, which is not on `TrackerConfig` at all.
fn tracker_workspaces(state: &State<AppState>) -> Result<Vec<Workspace>, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    Ok(store.workspaces().into_iter().map(seed_previous_location).collect())
}

fn workspace(state: &State<AppState>, id: &str) -> Result<Workspace, String> {
    tracker_workspaces(state)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("workspace not found: {id}"))
}
```

In `tasks_open_counts` and `tasks_watch_sync`, replace the inline

```rust
    let all = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces()
    };
```

with

```rust
    let all = tracker_workspaces(&state)?;
```

In `src-tauri/src/commands.rs`, replace `save_workspace`:

```rust
#[tauri::command]
pub fn save_workspace(state: State<AppState>, ws: Workspace) -> Result<Vec<Workspace>, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    // Seeded the same way the tracker reads them, so a version 1 config's
    // cards are not forgotten by the very save that bumps it to version 2.
    let old = store
        .workspaces()
        .into_iter()
        .map(crate::tasks_cmd::seed_previous_location)
        .find(|w| w.id == ws.id);
    let ws = crate::tasks_cmd::with_previous_location(old.as_ref(), ws);
    store.upsert_workspace(ws).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, including `store::tests::upsert_refuses_to_truncate_on_non_not_found_read_error` and the `model.rs` round-trip tests — the two new `TrackerConfig` fields must not have broken settings compatibility.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(tracker): remember where a workspace's cards were

The effective root now moves on three events — a path change, a rename, and
the version bump itself — and each one strands whatever cards are at the old
root. TrackerConfig grows a previousLocation pointer written on save, plus a
version so a config from before this change can be told from one that simply
has no pointer.

The subtle case is a pointer that has not been acted on: for a seeded version
1 config the cards are in the picked folder, not in the root that config
would resolve to today, so the pending pointer wins over a recomputed one.
Overwriting it would send the migration looking in an empty folder."
```

---

## Task 4: Deciding what moves

**Files:**
- Create: `src-tauri/src/tasks/migrate.rs`
- Modify: `src-tauri/src/tasks/mod.rs`
- Test: `src-tauri/src/tasks/migrate.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `crate::tasks::model::Task`.
- Produces:
  - `pub struct Move { pub from: PathBuf, pub file_name: String }`
  - `pub struct MigrationPlan { pub moves: Vec<Move>, pub left_foreign: usize, pub left_damaged: usize }`
  - `pub fn plan(cards: &[Task], project: &str, was_project_root: bool) -> MigrationPlan`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/tasks/migrate.rs` containing only the test module and the `use` line, so the test run fails on the missing functions rather than a missing file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::{TaskKind, TaskOrigin, TaskStatus};

    fn card(id: &str, project: &str, damaged: Option<&str>) -> Task {
        Task {
            id: id.to_string(),
            title: "t".to_string(),
            kind: TaskKind::Task,
            status: TaskStatus::Open,
            project: project.to_string(),
            created: "2026-07-28T10:00:00Z".to_string(),
            resolved: None,
            origin: TaskOrigin::Human,
            session: None,
            body: String::new(),
            path: format!("/old/{id}-t.md"),
            damaged: damaged.map(str::to_string),
            conflict: false,
        }
    }

    fn moved_ids(p: &MigrationPlan) -> Vec<String> {
        p.moves
            .iter()
            .map(|m| m.file_name.split('-').next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn our_cards_move() {
        let p = plan(&[card("01A", "deck", None)], "deck", false);
        assert_eq!(moved_ids(&p), vec!["01A"]);
        assert_eq!(p.moves[0].from, std::path::Path::new("/old/01A-t.md"));
        assert_eq!(p.moves[0].file_name, "01A-t.md");
        assert_eq!((p.left_foreign, p.left_damaged), (0, 0));
    }

    #[test]
    fn another_projects_cards_stay_and_are_counted() {
        let p = plan(&[card("01B", "other", None)], "deck", false);
        assert!(p.moves.is_empty());
        assert_eq!(p.left_foreign, 1);
    }

    #[test]
    fn a_damaged_card_moves_out_of_our_own_folder() {
        // In `.cowork/tasks` every card is ours by construction, so leaving a
        // damaged one behind would orphan it into a folder the board no longer
        // reads.
        let p = plan(&[card("01C", "", Some("no project field"))], "deck", true);
        assert_eq!(moved_ids(&p), vec!["01C"]);
        assert_eq!(p.left_damaged, 0);
    }

    #[test]
    fn a_damaged_card_stays_in_a_shared_vault() {
        // It may be an unrelated note that merely has an `id:` field — the same
        // reason FsTaskProvider::resolve refuses to write into one.
        let p = plan(&[card("01D", "", Some("no project field"))], "deck", false);
        assert!(p.moves.is_empty());
        assert_eq!(p.left_damaged, 1);
    }

    #[test]
    fn a_damaged_card_whose_project_matches_moves_from_anywhere() {
        // "Damaged" and "someone else's" are different things: a card with an
        // unknown `kind:` is damaged while its `project:` is perfectly fine.
        // Checking `damaged` before the project match would leave it behind.
        let p = plan(&[card("01E", "deck", Some("unknown kind"))], "deck", false);
        assert_eq!(moved_ids(&p), vec!["01E"]);
        assert_eq!(p.left_damaged, 0);
    }

    #[test]
    fn a_duplicate_id_pair_moves_whole() {
        let mut a = card("01F", "deck", None);
        let mut b = card("01F", "deck", None);
        a.conflict = true;
        b.conflict = true;
        a.path = "/old/01F-one.md".to_string();
        b.path = "/old/01F-two.md".to_string();
        let p = plan(&[a, b], "deck", false);
        // Splitting the pair would be worse than moving it: `conflict` is
        // recomputed at the new root, so the flag survives either way.
        assert_eq!(p.moves.len(), 2);
    }

    #[test]
    fn a_card_whose_path_has_no_file_name_is_left_alone() {
        let mut c = card("01G", "deck", None);
        c.path = "/".to_string();
        let p = plan(&[c], "deck", false);
        assert!(p.moves.is_empty(), "nothing to name at the destination");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Register the module first — add `pub mod migrate;` to `src-tauri/src/tasks/mod.rs`.

Run: `cd src-tauri && cargo test tasks::migrate`
Expected: FAIL to compile — `cannot find type 'MigrationPlan'`, `cannot find function 'plan'`.

- [ ] **Step 3: Implement `plan`**

Prepend to `src-tauri/src/tasks/migrate.rs`:

```rust
//! Moving cards between tracker roots.
//!
//! The decision is separated from the doing: `plan` is pure over `&[Task]`, so
//! the rule about which cards belong to this project is testable without a
//! tempdir, and `apply` is the only part that touches the disk.
use crate::tasks::model::Task;
use std::path::PathBuf;

/// One card that would move, and the name it keeps at the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: PathBuf,
    pub file_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationPlan {
    pub moves: Vec<Move>,
    /// Cards belonging to another project. Counted rather than dropped so the
    /// banner can say "7 move, 2 stay" instead of naming a number that
    /// silently disagrees with the folder.
    pub left_foreign: usize,
    /// Damaged cards in a shared root, which we will not claim.
    pub left_damaged: usize,
}

/// Which of `cards` belong to `project` and should follow it to a new root.
///
/// `cards` must be every card at the old root, unfiltered — `list` cannot
/// supply that, because it filters by project before returning, and
/// `left_foreign` is exactly the count `list` throws away.
///
/// `was_project_root` says whether the old root was `<ws.path>/.cowork/tasks`,
/// where every card is ours by construction.
pub fn plan(cards: &[Task], project: &str, was_project_root: bool) -> MigrationPlan {
    let mut out = MigrationPlan::default();
    for c in cards {
        // The project match is checked FIRST, and the order carries meaning: a
        // card with `kind: nonsense` is damaged while its `project:` is fine,
        // and it is ours. Checking `damaged` first would leave it in the vault.
        let ours = if c.project == project {
            true
        } else if c.damaged.is_some() {
            if was_project_root {
                true
            } else {
                out.left_damaged += 1;
                false
            }
        } else {
            out.left_foreign += 1;
            false
        };
        if !ours {
            continue;
        }
        let from = PathBuf::from(&c.path);
        // No file name means nothing to write at the destination. Cannot happen
        // for a card that came out of a directory scan, but this function takes
        // whatever it is given and must not panic on it.
        let Some(file_name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        out.moves.push(Move { from, file_name });
    }
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test tasks::migrate`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/migrate.rs src-tauri/src/tasks/mod.rs
git commit -m "feat(tracker): decide which cards follow a project to a new root

Pure over &[Task] so the rule is testable without a tempdir. The project
match is checked before 'damaged' because the two are not alternatives: a
card with an unknown kind: is damaged while its project: is fine, and it is
ours. Reversing the checks leaves such a card behind in a shared vault, which
is what a_damaged_card_whose_project_matches_moves_from_anywhere pins down.

Damaged cards move out of .cowork/tasks, where everything is ours by
construction, but stay in a shared root, where one may be an unrelated note
that merely has an id: field."
```

---

## Task 5: Moving the cards

**Files:**
- Modify: `src-tauri/src/tasks/migrate.rs`
- Test: `src-tauri/src/tasks/migrate.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `plan`, `Move`, `MigrationPlan` (Task 4); `set_project` (Task 1).
- Produces:
  - `pub enum SkipReason { AlreadyAtDestination, Failed(String) }`
  - `pub struct Skipped { pub file_name: String, pub reason: SkipReason }`
  - `pub struct MigrationReport { pub moved: usize, pub skipped: Vec<Skipped> }` with `pub fn is_complete(&self) -> bool` — true when every skip is `AlreadyAtDestination`, i.e. no card is left unmigrated at the old root.
  - `pub fn apply(p: &MigrationPlan, to: &Path, rename_project_to: Option<&str>) -> MigrationReport`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks/migrate.rs`:

```rust
    use crate::tasks::frontmatter::parse_card;

    const CARD: &str = "---\nid: 01H\ntitle: t\nkind: task\nstatus: open\nproject: old-name\ncreated: c\norigin: human\ntags: [inbox]\n---\nbody\n";

    /// A plan over one real file on disk, built the way the commands do.
    fn one_card_at(dir: &std::path::Path, name: &str, text: &str, project: &str) -> MigrationPlan {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        let card = parse_card(text, &path.to_string_lossy()).expect("a card");
        plan(&[card], project, true)
    }

    #[test]
    fn apply_moves_the_file_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 1);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        assert!(report.is_complete());
        assert!(to.join("01H-t.md").is_file(), "destination must hold the card");
        assert!(!from.join("01H-t.md").exists(), "source must be gone");
    }

    #[test]
    fn apply_skips_a_card_already_at_the_destination_and_keeps_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("01H-t.md"), CARD).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 0);
        assert_eq!(report.skipped.len(), 1);
        assert!(matches!(report.skipped[0].reason, SkipReason::AlreadyAtDestination));
        // File names embed the ULID, so the same name is the same card: the move
        // already happened, and the leftover is not ours to delete.
        assert!(from.join("01H-t.md").is_file(), "source must be left intact");
        assert!(report.is_complete(), "an already-migrated card must not block clearing");
    }

    #[test]
    fn apply_rewrites_project_on_a_rename_and_keeps_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, Some("new-name"));

        assert_eq!(report.moved, 1);
        let text = std::fs::read_to_string(to.join("01H-t.md")).unwrap();
        assert!(text.contains("project: new-name"), "{text}");
        assert!(!text.contains("old-name"), "{text}");
        // Without this the first rename would eat a vault card's own fields.
        assert!(text.contains("tags: [inbox]"), "{text}");
        assert!(!from.join("01H-t.md").exists(), "source must be gone");
    }

    #[test]
    fn apply_reports_a_failure_and_says_the_work_is_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");

        // A destination that is not a directory: every write into it fails.
        let to = dir.path().join("not-a-dir");
        std::fs::write(&to, "file").unwrap();
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 0);
        assert_eq!(report.skipped.len(), 1);
        assert!(matches!(report.skipped[0].reason, SkipReason::Failed(_)));
        assert!(!report.is_complete(), "a real failure must keep the pointer alive");
        assert!(from.join("01H-t.md").is_file(), "the card must still exist somewhere");
    }

    #[test]
    fn apply_over_an_empty_plan_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let report = apply(&MigrationPlan::default(), dir.path(), None);
        assert_eq!(report.moved, 0);
        assert!(report.is_complete());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks::migrate`
Expected: FAIL to compile — `cannot find function 'apply'`, `cannot find type 'SkipReason'`.

- [ ] **Step 3: Implement `apply`**

Append to `src-tauri/src/tasks/migrate.rs`:

```rust
/// Why a planned card did not move.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum SkipReason {
    /// A file of this name is already at the destination. Names embed the
    /// card's ULID, so the same name is the same card: the move already
    /// happened, and this is a leftover rather than a failure.
    AlreadyAtDestination,
    /// The card is still at the old root and the person needs to know.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub file_name: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub moved: usize,
    pub skipped: Vec<Skipped>,
}

impl MigrationReport {
    /// Whether no card was left unmigrated at the old root, which is the
    /// condition for forgetting the previous location.
    ///
    /// An `AlreadyAtDestination` skip does not count against this: a copy of
    /// that card is at the destination, so keeping the pointer alive for it
    /// would make the banner nag forever about a move that has happened.
    pub fn is_complete(&self) -> bool {
        self.skipped
            .iter()
            .all(|s| matches!(s.reason, SkipReason::AlreadyAtDestination))
    }
}

/// Carry out `p` into `to`, rewriting `project:` when the workspace was renamed.
///
/// One card failing does not stop the rest — the same posture `scan` takes with
/// an unreadable entry. In every branch the source is removed only after the
/// destination is written, so no card is ever nowhere.
pub fn apply(
    p: &MigrationPlan,
    to: &std::path::Path,
    rename_project_to: Option<&str>,
) -> MigrationReport {
    let mut report = MigrationReport::default();
    for m in &p.moves {
        let dest = to.join(&m.file_name);
        if dest.exists() {
            report.skipped.push(Skipped {
                file_name: m.file_name.clone(),
                reason: SkipReason::AlreadyAtDestination,
            });
            continue;
        }
        match move_one(&m.from, &dest, rename_project_to) {
            Ok(()) => report.moved += 1,
            Err(e) => report.skipped.push(Skipped {
                file_name: m.file_name.clone(),
                reason: SkipReason::Failed(e),
            }),
        }
    }
    report
}

fn move_one(
    from: &std::path::Path,
    dest: &std::path::Path,
    rename_project_to: Option<&str>,
) -> Result<(), String> {
    if let Some(project) = rename_project_to {
        // The content changes either way, so `rename` has no part in this
        // branch. Line-level, not `render_card`: that knows nine keys and would
        // drop a vault card's `tags:`, `aliases:` and Dataview fields.
        let text = std::fs::read_to_string(from).map_err(|e| e.to_string())?;
        let updated = crate::tasks::frontmatter::set_project(&text, project)
            // Impossible for a card that came from `parse_card`, which requires
            // a frontmatter block — but an invariant that holds in another
            // module is not grounds for a panic in this one.
            .ok_or_else(|| "the card has no frontmatter block".to_string())?;
        std::fs::write(dest, updated).map_err(|e| e.to_string())?;
        return std::fs::remove_file(from).map_err(|e| {
            format!("copied, but the original could not be removed: {e}")
        });
    }

    if std::fs::rename(from, dest).is_ok() {
        return Ok(());
    }
    // Any rename failure falls back to copy + remove. `.cowork/tasks` to an
    // external vault is an ordinary EXDEV; enumerating error kinds to gate a
    // fallback that is correct unconditionally buys nothing.
    std::fs::copy(from, dest).map_err(|e| e.to_string())?;
    std::fs::remove_file(from)
        .map_err(|e| format!("copied, but the original could not be removed: {e}"))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test tasks::migrate`
Expected: PASS, 12 tests.

Note the coverage gap this task knowingly leaves, recorded in the spec: the decision "`rename` failed, so try copy + remove" is not exercised. Simulating `EXDEV` honestly needs a second filesystem, and a read-only destination would test permissions instead. The copy + remove code does run, in the `rename_project_to` branch.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tasks/migrate.rs
git commit -m "feat(tracker): move a project's cards to a new root

In every branch the source is removed only after the destination is written,
so no card is ever nowhere. A rename rewrites project: through the line-level
editor rather than render_card, or the first rename would eat a vault card's
tags: and aliases:.

Skips are classified rather than counted. 'Already at the destination' is not
a failure — names embed the ULID, so the same name is the same card and the
move has happened — and lumping it in with real failures would make the
banner nag forever about work that is done. is_complete() is what the caller
uses to decide whether to forget the previous location."
```

---

## Task 6: The IPC surface

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs`
- Modify: `src-tauri/src/main.rs:147-157` (the `invoke_handler` list)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `plan`, `apply`, `MigrationReport::is_complete` (Tasks 4-5); `seed_previous_location`, `tracker_workspaces` (Task 3); `FsTaskProvider::scan`, `RootCreation` (Task 2).
- Produces:
  - `pub struct MigrationOffer { from, to: String, moving, leaving_foreign, leaving_damaged: usize, renaming_project: bool }`, serialized `camelCase`.
  - `tasks_migration_status(workspace_id: String) -> Result<Option<MigrationOffer>, String>`
  - `tasks_migrate(workspace_id: String) -> Result<MigrationReport, String>`
  - `tasks_migration_dismiss(workspace_id: String) -> Result<(), String>`
  - `pub fn offer_for(ws: &Workspace) -> Result<Option<(MigrationOffer, MigrationPlan)>, String>` — the shared read path, so `status` and `migrate` cannot drift on which cards they mean.

- [ ] **Step 1: Write the failing test for the pure part of the offer**

The commands need `State<AppState>`, which is not constructible in a unit test, so the testable seam is `offer_for`, which takes a `Workspace` and reads the disk. Add to `mod tests` in `src-tauri/src/tasks_cmd.rs`:

```rust
    /// A workspace whose external root is `dir`, with `previous_location`
    /// pointing at `old` as a folder the cards were never moved out of.
    fn ws_with_previous(dir: &std::path::Path, name: &str, old: &std::path::Path) -> Workspace {
        Workspace {
            id: "w1".into(),
            name: name.into(),
            path: "/home/u/proj".into(),
            color: "#61afef".into(),
            tracker: Some(TrackerConfig {
                providers: vec![TrackerProvider::Fs {
                    root: TrackerRoot::Path { path: dir.to_string_lossy().to_string() },
                }],
                previous_location: Some(PreviousLocation {
                    root: old.to_string_lossy().to_string(),
                    project: "cowork-deck".into(),
                    was_project_root: false,
                }),
                version: TRACKER_CONFIG_VERSION,
            }),
        }
    }

    fn write_card(dir: &std::path::Path, id: &str, project: &str) {
        std::fs::write(
            dir.join(format!("{id}-t.md")),
            format!("---\nid: {id}\ntitle: t\nkind: task\nstatus: open\nproject: {project}\ncreated: c\norigin: human\n---\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn offer_counts_what_moves_and_what_stays() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Tasks");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01A", "cowork-deck");
        write_card(&old, "01B", "cowork-deck");
        write_card(&old, "01C", "other-project");

        let ws = ws_with_previous(dir.path(), "cowork-deck", &old);
        let (offer, _) = offer_for(&ws).expect("readable").expect("an offer");

        assert_eq!(offer.moving, 2);
        assert_eq!(offer.leaving_foreign, 1);
        assert_eq!(offer.from, old.to_string_lossy());
        assert_eq!(offer.to, dir.path().join("cowork-deck").to_string_lossy());
        assert!(!offer.renaming_project);
    }

    #[test]
    fn offer_says_project_gets_rewritten_after_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("cowork-deck");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01A", "cowork-deck");

        // previous_location.project is "cowork-deck", the workspace is now "deck".
        let ws = ws_with_previous(dir.path(), "deck", &old);
        let (offer, _) = offer_for(&ws).expect("readable").expect("an offer");

        assert!(offer.renaming_project, "cards still name the old project");
        assert_eq!(offer.moving, 1);
    }

    #[test]
    fn there_is_no_offer_when_the_old_root_holds_nothing_of_ours() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Tasks");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01C", "other-project");

        let ws = ws_with_previous(dir.path(), "cowork-deck", &old);
        assert!(offer_for(&ws).expect("readable").is_none());
    }

    #[test]
    fn a_missing_old_root_yields_no_offer_but_is_not_an_error() {
        // An unmounted volume, not a resolved migration. The caller must not
        // clear the pointer on this — the folder can come back.
        let dir = tempfile::tempdir().unwrap();
        let ws = ws_with_previous(dir.path(), "cowork-deck", &dir.path().join("gone"));
        assert!(offer_for(&ws).expect("not an error").is_none());
    }

    #[test]
    fn there_is_no_offer_without_a_previous_location() {
        let ws = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        assert!(offer_for(&ws).expect("readable").is_none());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL to compile — `cannot find function 'offer_for'`.

- [ ] **Step 3: Implement the offer and the three commands**

Add to `src-tauri/src/tasks_cmd.rs`:

```rust
/// What the board needs to describe a pending move.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOffer {
    /// Both paths in full: the person picked them and needs to recognise them.
    pub from: String,
    pub to: String,
    pub moving: usize,
    pub leaving_foreign: usize,
    pub leaving_damaged: usize,
    /// Whether `project:` inside the moved cards will be rewritten, which is
    /// true exactly when the workspace has been renamed since the cards were
    /// written.
    pub renaming_project: bool,
}

/// Read the old root and describe what a move would do, or `None` when there is
/// nothing to offer.
///
/// `None` covers three different situations, and only one of them means the
/// pointer can be forgotten — see `clear_previous_location`'s caller.
pub fn offer_for(ws: &Workspace) -> Result<Option<(MigrationOffer, MigrationPlan)>, String> {
    let Some(previous) = ws.tracker.as_ref().and_then(|c| c.previous_location.clone()) else {
        return Ok(None);
    };
    let Some((to, _)) = resolve_root(ws) else { return Ok(None) };
    let from = PathBuf::from(&previous.root);

    // A missing old root is an unmounted volume as often as a deleted folder,
    // so it is not an error and not a resolved migration either: no offer now,
    // and the caller leaves the pointer alone so the banner returns with the
    // volume.
    if !from.is_dir() {
        return Ok(None);
    }

    // `Never`: reading the old root must not create it, least of all when it is
    // a mount point that happens to be empty right now.
    let old = FsTaskProvider::new(from.clone(), RootCreation::Never);
    let cards = old.scan().map_err(|e| e.to_string())?;
    let p = plan(&cards, &previous.project, previous.was_project_root);
    if p.moves.is_empty() {
        return Ok(None);
    }

    Ok(Some((
        MigrationOffer {
            from: previous.root.clone(),
            to: to.to_string_lossy().to_string(),
            moving: p.moves.len(),
            leaving_foreign: p.left_foreign,
            leaving_damaged: p.left_damaged,
            renaming_project: previous.project != ws.name,
        },
        p,
    )))
}

/// Forget where the cards were. Stamps the version too, or the next read would
/// re-seed a version 1 config and the banner would come back.
fn clear_previous_location(state: &State<AppState>, workspace_id: &str) -> Result<(), String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    let mut all = store.workspaces();
    let Some(w) = all.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(());
    };
    if let Some(cfg) = w.tracker.as_mut() {
        cfg.previous_location = None;
        cfg.version = TRACKER_CONFIG_VERSION;
    }
    store.save_workspaces(&all).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_migration_status(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Option<MigrationOffer>, String> {
    let ws = workspace(&state, &workspace_id)?;
    let Some((offer, _)) = offer_for(&ws)? else {
        // Nothing of ours is at the old root any more, so the pointer has done
        // its job — but only when the folder is actually readable. A missing
        // root keeps its pointer: see `offer_for`.
        let has_pointer = ws
            .tracker
            .as_ref()
            .and_then(|c| c.previous_location.as_ref())
            .map(|p| PathBuf::from(&p.root).is_dir())
            .unwrap_or(false);
        if has_pointer {
            clear_previous_location(&state, &workspace_id)?;
        }
        return Ok(None);
    };
    Ok(Some(offer))
}

#[tauri::command]
pub fn tasks_migrate(
    state: State<AppState>,
    workspace_id: String,
) -> Result<MigrationReport, String> {
    let ws = workspace(&state, &workspace_id)?;
    let (root, creation) = resolve_root(&ws).ok_or_else(|| "not-configured".to_string())?;

    // Before planning anything: moving some cards and then discovering there is
    // nowhere to put the rest is worse than refusing up front.
    ensure_root_if_ours(&root, creation).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err(crate::tasks::model::TaskError::RootMissing(
            root.to_string_lossy().to_string(),
        )
        .to_string());
    }

    let Some((_, p)) = offer_for(&ws)? else {
        return Ok(MigrationReport::default());
    };
    let previous_project = ws
        .tracker
        .as_ref()
        .and_then(|c| c.previous_location.as_ref())
        .map(|prev| prev.project.clone())
        .unwrap_or_default();
    let rename = (previous_project != ws.name).then_some(ws.name.as_str());

    let report = apply(&p, &root, rename);
    if report.is_complete() {
        clear_previous_location(&state, &workspace_id)?;
    }
    Ok(report)
}

#[tauri::command]
pub fn tasks_migration_dismiss(
    state: State<AppState>,
    workspace_id: String,
) -> Result<(), String> {
    clear_previous_location(&state, &workspace_id)
}
```

Add to the `use` block at the top of `tasks_cmd.rs`:

```rust
use crate::tasks::migrate::{apply, plan, MigrationPlan, MigrationReport};
```

In `src-tauri/src/main.rs`, add to the `invoke_handler` list after `tasks_cmd::tasks_watch_sync,`:

```rust
            tasks_cmd::tasks_migration_status,
            tasks_cmd::tasks_migrate,
            tasks_cmd::tasks_migration_dismiss,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets`
Expected: PASS. Clippy must report the same seven pre-existing warnings and no new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(tracker): offer, run and dismiss a card migration

status and migrate share offer_for so they cannot drift on which cards they
mean. It reads the old root through a Never provider: reading must not create
a folder, least of all a mount point that is empty right now.

A missing old root is not an error and not a resolved migration. Clearing the
pointer there would silently forget cards on an unmounted volume, so the
pointer survives and the banner returns when the volume does.

migrate ensures the destination before planning: moving half the cards and
then finding nowhere to put the rest is worse than refusing up front."
```

---

## Task 7: The banner

**Files:**
- Modify: `src/ipc.ts:128-131` (after the existing tracker wrappers)
- Modify: `src/board.ts:4-17` (`BoardState`, `BoardHandlers`), `:45-56` (`render`)
- Modify: `src/main.ts:47-53` (the `BoardView` construction), `:171-190` (`refreshBoard`)
- Modify: `src/styles.css` (after the `.tk-empty` rule)
- Test: `tests/board.test.ts`

**Interfaces:**
- Consumes: the three commands from Task 6.
- Produces: `MigrationOffer` and `MigrationReport` types in `ipc.ts`; `BoardState.migration?: MigrationOffer | null`; `BoardHandlers.onMigrate` and `onDismissMigration`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/board.test.ts`:

```ts
describe("BoardView migration banner", () => {
  const offer = (over: Partial<MigrationOffer> = {}): MigrationOffer => ({
    from: "/home/u/vault/Tasks",
    to: "/home/u/vault/cowork-deck",
    moving: 7,
    leavingForeign: 0,
    leavingDamaged: 0,
    renamingProject: false,
    ...over,
  });

  const state = (migration: MigrationOffer | null) => ({
    project: "deck",
    caps: { canCreate: true, canResolve: true, statuses: ["open", "done"] },
    error: null,
    tasks: [],
    links: [],
    migration,
  });

  it("says how many cards are at the old location, and where it is", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer()) as never);
    const banner = v.mount.querySelector(".tk-migrate")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("7");
    expect(banner.textContent).toContain("/home/u/vault/Tasks");
  });

  it("spells out that leaving them hides them, because it is not obvious", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer()) as never);
    // Dismissing does not delete anything, but the cards do stop being visible.
    // A button that only says "Leave them" would not convey that.
    expect(v.mount.querySelector(".tk-migrate-consequence")).not.toBeNull();
  });

  it("mentions other projects' cards only when some are staying", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer({ leavingForeign: 2 })) as never);
    expect(v.mount.querySelector(".tk-migrate-foreign")!.textContent).toContain("2");

    const v2 = new BoardView({ ...handlers });
    v2.render(state(offer()) as never);
    expect(v2.mount.querySelector(".tk-migrate-foreign")).toBeNull();
  });

  it("has no banner when there is nothing to move", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(null) as never);
    expect(v.mount.querySelector(".tk-migrate")).toBeNull();
  });

  it("renders the banner even when the destination is unreachable", () => {
    // The two explain each other: the destination does not exist because its
    // parent does not.
    const v = new BoardView({ ...handlers });
    v.render({ ...state(offer()), caps: null, error: "the task folder is unreachable: /x" } as never);
    expect(v.mount.querySelector(".tk-migrate")).not.toBeNull();
    expect(v.mount.textContent).toContain("unreachable");
  });

  it("wires the two buttons to their handlers", () => {
    const onMigrate = vi.fn();
    const onDismissMigration = vi.fn();
    const v = new BoardView({ ...handlers, onMigrate, onDismissMigration });
    v.render(state(offer()) as never);
    v.mount.querySelector<HTMLButtonElement>(".tk-migrate-go")!.click();
    v.mount.querySelector<HTMLButtonElement>(".tk-migrate-skip")!.click();
    expect(onMigrate).toHaveBeenCalledTimes(1);
    expect(onDismissMigration).toHaveBeenCalledTimes(1);
  });
});
```

At the top of `tests/board.test.ts`, add `MigrationOffer` to the type import from `../src/ipc`, and define the shared handler stub next to the existing ones:

```ts
const handlers = {
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(),
};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — `Cannot find name 'MigrationOffer'`, and the banner assertions find nothing.

- [ ] **Step 3: Add the types, the wrappers, the banner and its styling**

In `src/ipc.ts`, after `onTasksChanged`:

```ts
/** A pending move of this workspace's cards from where they used to live. */
export interface MigrationOffer {
  from: string; to: string;
  moving: number;
  leavingForeign: number;
  leavingDamaged: number;
  /** Whether `project:` inside the moved cards will be rewritten. */
  renamingProject: boolean;
}
export type SkipReason =
  | { kind: "alreadyAtDestination" }
  | { kind: "failed"; detail: string };
export interface MigrationReport {
  moved: number;
  skipped: { fileName: string; reason: SkipReason }[];
}

export const taskMigrationStatus = (workspaceId: string) =>
  invoke<MigrationOffer | null>("tasks_migration_status", { workspaceId });
export const taskMigrate = (workspaceId: string) =>
  invoke<MigrationReport>("tasks_migrate", { workspaceId });
export const taskMigrationDismiss = (workspaceId: string) =>
  invoke<void>("tasks_migration_dismiss", { workspaceId });
```

In `src/board.ts`, extend the two interfaces:

```ts
export interface BoardState {
  project: string;
  caps: ProviderCapabilities | null;
  error: string | null;
  tasks: Task[];
  links: TaskSessionLink[];
  /** Optional so the pre-existing render tests keep compiling; absent means
   *  there is nothing to move. */
  migration?: MigrationOffer | null;
}

export interface BoardHandlers {
  onLaunch: (task: Task) => void;
  onResolve: (task: Task) => void;
  onNew: () => void;
  onConfigure: () => void;
  onMigrate: () => void;
  onDismissMigration: () => void;
}
```

Add `MigrationOffer` to the type import from `./ipc`.

In `render`, immediately after `this.mount.append(head);` and **before** the `if (caps === null || error)` early return:

```ts
    // Before the early return on purpose: when the destination's parent is
    // missing, the error and this banner explain each other.
    if (state.migration) this.mount.append(this.migrationBanner(state.migration));
```

Add the private method after `render`:

```ts
  /** Cards left at a previous root. Rendered as a banner rather than a modal so
   *  it survives an app restart and does not demand a decision at save time. */
  private migrationBanner(m: MigrationOffer): HTMLElement {
    const box = el("div", "tk-migrate");
    box.append(el(
      "p", "tk-migrate-count",
      `${m.moving} card${m.moving === 1 ? "" : "s"} ${m.moving === 1 ? "is" : "are"} still in the previous location:`,
    ));
    box.append(el("p", "tk-migrate-from", m.from));
    if (m.leavingForeign > 0) {
      box.append(el(
        "p", "tk-migrate-foreign",
        `${m.leavingForeign} card${m.leavingForeign === 1 ? "" : "s"} there belong${m.leavingForeign === 1 ? "s" : ""} to other projects and stay.`,
      ));
    }
    if (m.leavingDamaged > 0) {
      box.append(el(
        "p", "tk-migrate-foreign",
        `${m.leavingDamaged} damaged card${m.leavingDamaged === 1 ? "" : "s"} there stay too — a damaged card in a shared folder may not be ours.`,
      ));
    }

    const acts = el("div", "tk-migrate-acts");
    const go = el("button", "tk-migrate-go", "Move them here");
    go.onclick = () => this.h.onMigrate();
    const skip = el("button", "tk-migrate-skip", "Leave them there");
    skip.onclick = () => this.h.onDismissMigration();
    acts.append(go, skip);
    box.append(acts);

    // Not decoration: after this the cards are outside the effective root and
    // the board will not show them again. Recoverable by hand, but it reads as
    // disappearance, so the button cannot just say "Leave them" and stop.
    box.append(el(
      "p", "tk-migrate-consequence",
      "Left there, they stay on disk but this board will not show them.",
    ));
    if (m.renamingProject) {
      box.append(el(
        "p", "tk-migrate-consequence",
        "Moving them also updates the project name inside each card.",
      ));
    }
    return box;
  }
```

In `src/styles.css`, after the `.tk-empty` rule:

```css
/* --- Cards left at a previous tracker root ------------------------------- */

.tk-migrate {
  background: var(--bg-panel); border: 1px solid var(--st-working);
  border-radius: var(--r-md); padding: var(--sp-3); margin-bottom: var(--sp-3);
}
.tk-migrate p { margin: 0 0 var(--sp-1); }
.tk-migrate-count { color: var(--fg); font-size: var(--fs-base); }
/* A path is the one thing here the person has to recognise, so it does not get
   the muted treatment the rest of the explanation does. */
.tk-migrate-from {
  color: var(--fg); font-size: var(--fs-sm); word-break: break-all;
}
.tk-migrate-foreign, .tk-migrate-consequence {
  color: var(--fg-muted); font-size: var(--fs-xs);
}
.tk-migrate-acts { display: flex; gap: var(--sp-2); margin: var(--sp-2) 0; }
.tk-migrate-go, .tk-migrate-skip {
  font: inherit; font-size: var(--fs-sm);
  border-radius: var(--r-sm); min-height: 24px;
  padding: var(--sp-1) var(--sp-2); cursor: pointer;
}
.tk-migrate-go {
  background: var(--accent); color: var(--bg-app); border: none;
  font-weight: var(--fw-medium);
}
.tk-migrate-skip {
  background: var(--bg-raised); color: var(--fg-muted); border: 1px solid var(--border);
}
.tk-migrate-go:focus-visible, .tk-migrate-skip:focus-visible {
  outline: none; box-shadow: var(--focus-ring);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/board.test.ts && npx tsc --noEmit`
Expected: PASS, and a clean typecheck.

- [ ] **Step 5: Wire it into `main.ts`**

In `src/main.ts`, add to the imports from `./ipc`: `taskMigrationStatus, taskMigrate, taskMigrationDismiss`, and `import type { MigrationOffer } from "./ipc";` alongside the existing `Task` type import.

Extend the `BoardView` construction:

```ts
const board = new BoardView({
  onLaunch: (t) => void launchFromTask(t),
  onResolve: (t) => void closeTask(t),
  onNew: () => void captureTask(),
  onConfigure: () => void alertModal(
    "Configure the tracker in the workspace settings (✎): a folder in the project, or one of your own."),
  onMigrate: () => void migrateCards(),
  onDismissMigration: () => void dismissMigration(),
});
```

In `refreshBoard`, add the third fetch and pass it through:

```ts
  let migration: MigrationOffer | null = null;
  try { migration = await taskMigrationStatus(wsId); }
  catch (e) { console.debug("migration status failed", e); }
```

placed with the other fetches, and change the final render call to
`board.render({ project: ws.name, caps, error, tasks, links: deck.taskLinks(), migration });`

Add the two handlers next to `closeTask`:

```ts
/** Move the cards left at a previous root. The watcher has to be re-pointed
 *  afterwards: the destination may have been created moments ago, and without
 *  the re-sync the board would only update on the five-second poll. */
async function migrateCards() {
  const ws = workspaces.active;
  if (!ws) return;
  try {
    const report = await taskMigrate(ws.id);
    const failed = report.skipped.filter((s) => s.reason.kind === "failed");
    if (failed.length) {
      await alertModal(
        `Moved ${report.moved}. ${failed.length} could not be moved:\n` +
        failed.map((s) => `${s.fileName}: ${s.reason.kind === "failed" ? s.reason.detail : ""}`).join("\n"),
      );
    }
  } catch (e) {
    await alertModal(`Could not move the cards: ${String(e)}`);
  }
  await taskWatchSync().catch((e) => console.debug("watch sync failed", e));
  await refreshBoard();
  await refreshCounts();
}

async function dismissMigration() {
  const ws = workspaces.active;
  if (!ws) return;
  try { await taskMigrationDismiss(ws.id); }
  catch (e) { await alertModal(`Could not dismiss: ${String(e)}`); }
  await refreshBoard();
}
```

- [ ] **Step 6: Run the whole suite**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: all pass. Then `cd src-tauri && cargo test && cargo clippy --all-targets` — pass, with the same seven pre-existing clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(tracker): a board banner for cards left at a previous root

Rendered before the early return on a missing root on purpose: when the
destination's parent does not exist, the error and the banner explain each
other rather than competing.

The consequence line is the point of the banner, not decoration. Dismissing
deletes nothing, but the cards fall outside the effective root and the board
stops showing them, and a button reading only 'Leave them' would not say so.

Moving re-points the watcher: the destination may have been created moments
ago, and without the re-sync the board would only update on the five-second
poll, which reads as lag rather than as a missing watcher."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: root resolution and `RootCreation` → Task 2; `PreviousLocation`, the version discriminator and seeding → Tasks 2-3; `plan` → Task 4; `apply` and `set_project` → Tasks 1, 5; the three commands and `previousLocation` clearing → Task 6; the banner, the flow through `refreshBoard` and the `taskWatchSync` requirement → Task 7. The spec's error-handling table is covered by `a_missing_old_root_yields_no_offer_but_is_not_an_error` (unmounted volume), `renders the banner even when the destination is unreachable` (missing parent), the `copied, but the original could not be removed` message (double existence), and the `ok_or_else` on `set_project` (no frontmatter).

**Two spec defects, corrected above:** the verbatim `ws.name` join allowed a name to escape the picked folder, and the re-plan rule for clearing `previousLocation` could never clear after an `AlreadyAtDestination` skip.

**Type consistency.** `RootCreation` is spelled the same in `fs.rs`, `tasks_cmd.rs`, `commands.rs` and `bin/cowork_task.rs` (aliased there as `FsRootCreation` only because that file's import style needs it). `MigrationOffer`'s Rust fields serialize `camelCase`, matching the TS interface field-for-field: `from`, `to`, `moving`, `leavingForeign`, `leavingDamaged`, `renamingProject`. `SkipReason` is an internally tagged enum, so the TS union keys on `kind` with `detail` for the failure case — which is what `migrateCards` narrows on.

**One coverage gap, named in the spec and repeated in Task 5:** the `rename` → copy + remove fallback decision is not unit tested.
