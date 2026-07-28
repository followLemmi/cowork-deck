# Tracker Root Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external tracker path resolves to `<picked>/cowork-deck-tasks/<project-slug>` so the app grows one recognisable folder in the person's space instead of one per project, and the workspace form names the folders it is about to create before the save rather than after.

**Architecture:** `resolve_root` in `src-tauri/src/tasks_cmd.rs` stays the single choke point and gains a pure `append_layout` implementing three recognition cases. `RootCreation::LeafInsideExistingParent` becomes `InsideExisting { base }`, carrying the folder the human picked so "the base must exist, everything below it is ours" is one rule for zero, one and two levels. `TRACKER_CONFIG_VERSION` goes to 3 and `seed_previous_location` decides per version where the cards physically are, reusing the migration banner built in the previous plan. A `tracker_root_preview` command shares `append_layout` and `slugify` with `resolve_root` so the form never reimplements either.

**Tech Stack:** Rust + Tauri 2 backend (`serde`, `tempfile` for tests), TypeScript frontend with Vitest + jsdom. No new dependencies.

## Global Constraints

- **English only.** Every string, comment, test name and doc is English. See `CLAUDE.md`; the only Cyrillic exceptions are the existing fixtures in `placeholders.ts`, `commands.ts`, `frontmatter.rs::slugify_keeps_cyrillic_and_strips_punctuation` and the filename assertion in `fs.rs`.
- **The container name is fixed:** `TRACKER_CONTAINER = "cowork-deck-tasks"`, declared once in `tasks_cmd.rs` and never spelled as a literal anywhere else outside test assertions.
- **A user-supplied path is never created silently.** The base — the folder the human picked — must already exist. A typo must surface as `TaskError::RootMissing`, never as a new tree, at any depth.
- **Recognition is name-based, never content-based.** `resolve_root` runs on every list, count and watcher sync; it must not depend on a directory read that can fail.
- **The layout lives in exactly one function.** `append_layout` is the only place that knows about the container, and `tracker_root_preview` calls it rather than restating it.
- **`TRACKER_CONFIG_VERSION = 3`.** Every code path that persists a `TrackerConfig` stamps this value, or a dismissed banner comes back on the next read.
- **Clippy baseline is 6 warnings after Task 1** (4 × `std::io::Error::other`, 2 × too-many-arguments). Task 1 removes the seventh. Every later task must report those 6 and no more.

## File Structure

**Modified**

- `src-tauri/src/store.rs` — move a test-only import into the test module (Task 1).
- `index.html` — the document language (Task 1).
- `src-tauri/src/tasks/fs.rs` — `RootCreation::InsideExisting { base }` replaces `LeafInsideExistingParent`; `ensure_root` honours it; the enum loses `Copy` (Task 2).
- `src-tauri/src/tasks_cmd.rs` — `ensure_root_if_ours` takes `&RootCreation` (Task 2); `TRACKER_CONTAINER` and `append_layout` (Task 3); per-version seeding (Task 4); `TrackerRootPreview`, `root_preview` and the `tracker_root_preview` command (Task 5).
- `src-tauri/src/commands.rs` — the `ensure_root_if_ours` call in `start_session` (Task 2).
- `src-tauri/src/model.rs` — `TRACKER_CONFIG_VERSION` to 3 (Task 4).
- `src-tauri/src/main.rs` — register `tracker_root_preview` (Task 5).
- `src/ipc.ts` — `TrackerRootPreview` type and its wrapper (Task 5).
- `src/forms.ts` — the preview block under the tracker folder picker (Task 6).
- `src/styles.css` — preview styling (Task 6).
- `tests/forms.test.ts` — preview tests (Task 6).

**Nothing is created.** Every change lands in a file that already exists.

---

## Task 1: Clear the build noise

Two unrelated blemishes, done first because the second one changes the warning baseline every later task is measured against.

**Files:**
- Modify: `src-tauri/src/store.rs:1` and its `mod tests` import block (`:159-161`)
- Modify: `index.html:2`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. No signature changes.

- [ ] **Step 1: Confirm the import is test-only before touching it**

Run: `cd src-tauri && grep -n "SCHEDULE_STATE_VERSION" src/store.rs`
Expected: exactly two hits — the import on line 1, and one use on line 298, which is **inside `mod tests`** (the module starts at line 159).

This is why the fix is not "delete the unused import": deleting it from line 1 compiles the binary and breaks `cargo test` with `cannot find value SCHEDULE_STATE_VERSION`. The warning appears only in the non-test build because that is the only build where the import really is unused.

- [ ] **Step 2: Move the import into the test module**

In `src-tauri/src/store.rs`, line 1, drop the constant from the crate-level import:

```rust
use crate::model::{ScheduleRun, SessionEntry, Skill, UiState, Workspace};
```

In the same file's `mod tests`, extend its existing import:

```rust
    use super::*;
    use crate::model::{SessionEntry, UiState, Workspace, SCHEDULE_STATE_VERSION};
```

- [ ] **Step 3: Fix the document language**

`index.html` still declares Russian, from before the English-only sweep. Line 2:

```html
<html lang="en">
```

- [ ] **Step 4: Verify both builds are clean and the baseline moved**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: tests PASS, and the count is **6**. The `unused import: SCHEDULE_STATE_VERSION` line is gone; the 4 `std::io::Error::other` and 2 too-many-arguments warnings remain and are out of scope here.

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Nothing in the suite asserts on the document language, so this is a regression check, not a new-behaviour check.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs index.html
git commit -m "chore: quiet the build and say the page is English

SCHEDULE_STATE_VERSION is used only by store.rs's test module, so the
crate-level import is unused in the binary and warned about on every build.
Deleting it outright would break cargo test; it moves into the test module
instead.

index.html still declared lang=ru from before the English-only sweep, which
tells a screen reader to pronounce an English interface as Russian."
```

---

## Task 2: A creation policy that carries its base

`LeafInsideExistingParent` means "create exactly one level, and only if the parent exists". The container layout needs two, and the variant that replaces it names the boundary explicitly instead of encoding a depth.

This task is deliberately **behaviour-preserving**: the layout is still `<picked>/<slug>`, so the base is the parent and one level gets created, exactly as today. Task 3 changes the path.

**Files:**
- Modify: `src-tauri/src/tasks/fs.rs:6-51` (the enum and `ensure_root`)
- Modify: `src-tauri/src/tasks_cmd.rs:35-79` (`resolve_root`, `ensure_root_if_ours`), `:267-271` (`tasks_watch_sync`), `:397` (`tasks_migrate`)
- Modify: `src-tauri/src/commands.rs:220-226` (`start_session`)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `pub enum RootCreation { Always, InsideExisting { base: PathBuf }, Never }` in `crate::tasks::fs`, deriving `Debug, Clone, PartialEq, Eq` — **not `Copy`**, because it now owns a `PathBuf`.
  - `pub fn ensure_root_if_ours(root: &Path, creation: &RootCreation) -> std::io::Result<()>` — note the borrow; the old signature took the enum by value.
  - `pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, RootCreation)>` — unchanged signature, new variant inside.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/tasks_cmd.rs`, replace `an_external_root_gets_a_per_project_subfolder`, `ensure_root_if_ours_creates_a_project_root_but_never_a_path_root` and `ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo` with these four:

```rust
    #[test]
    fn an_external_root_gets_a_per_project_subfolder() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault/Tasks".into() })));
        let (root, creation) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/Tasks/cowork-deck"));
        // The base is the folder the human picked, whatever the layout adds
        // below it. That is the whole point of the variant.
        assert_eq!(
            creation,
            RootCreation::InsideExisting { base: "/home/u/vault/Tasks".into() },
        );
    }

    #[test]
    fn ensure_root_if_ours_creates_a_project_root_and_a_subtree_inside_a_picked_folder() {
        let dir = tempfile::tempdir().unwrap();

        let project_root = dir.path().join("proj").join(".cowork").join("tasks");
        ensure_root_if_ours(&project_root, &RootCreation::Always).unwrap();
        assert!(project_root.is_dir(), "the in-project root is ours to create");

        // The picked folder exists, so everything below it is ours — one level
        // today, two once the container lands, and this must not care which.
        let picked = dir.path().join("vault");
        std::fs::create_dir(&picked).unwrap();
        let deep = picked.join("container").join("deck");
        ensure_root_if_ours(&deep, &RootCreation::InsideExisting { base: picked.clone() }).unwrap();
        assert!(deep.is_dir(), "a subtree inside an existing base is ours to make");
    }

    #[test]
    fn ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo() {
        let dir = tempfile::tempdir().unwrap();
        // The typo guarantee, now stated once for any depth. If anyone drops the
        // base check and calls create_dir_all unconditionally, this is what
        // fails.
        let base = dir.path().join("vualt");
        let leaf = base.join("cowork-deck-tasks").join("deck");
        ensure_root_if_ours(&leaf, &RootCreation::InsideExisting { base: base.clone() }).unwrap();
        assert!(!leaf.exists(), "a typo'd base must not be created");
        assert!(!base.exists(), "nor the base itself");

        let never = dir.path().join("cli-root");
        ensure_root_if_ours(&never, &RootCreation::Never).unwrap();
        assert!(!never.exists(), "the CLI creates nothing");
    }

    #[test]
    fn a_provider_refuses_to_read_a_root_whose_base_is_missing() {
        // ensure_root_if_ours is best-effort and silent; FsTaskProvider is the
        // half that has to be loud, and it is what the board surfaces.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("vualt");
        let root = base.join("deck");
        let p = FsTaskProvider::new(root, RootCreation::InsideExisting { base });
        assert!(p.scan().is_err(), "a missing base is RootMissing, not an empty list");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL to compile — `struct variant RootCreation::InsideExisting not found` (the compiler suggests `LeafInsideExistingParent`), plus mismatched-types errors on `ensure_root_if_ours` now being passed a reference.

- [ ] **Step 3: Replace the variant and honour it**

In `src-tauri/src/tasks/fs.rs`, replace the enum (lines 6-20):

```rust
/// How much of a root a provider may bring into existence.
///
/// Not `Copy`: `InsideExisting` owns the base path. Passing it by reference at
/// the four call sites is cheaper than recomputing the base from the root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootCreation {
    /// The whole chain is ours: on a fresh project `<ws.path>/.cowork/tasks`
    /// has neither `.cowork` nor `tasks` yet, so a rule that required an
    /// existing parent would refuse the case it is meant to handle.
    Always,
    /// `base` — the folder the human picked — must already exist; everything
    /// below it is ours to create. This is what keeps a typo'd external path
    /// surfacing as `RootMissing` instead of scattering a tree across the disk,
    /// and it says so once for any number of levels.
    InsideExisting { base: PathBuf },
    /// Create nothing. `cowork_task` is handed an already-resolved
    /// `COWORK_TASKS_DIR` and must not invent folders from a stale env var.
    Never,
}
```

Replace `ensure_root` (lines 32-51):

```rust
    fn ensure_root(&self) -> Result<(), TaskError> {
        if self.root.is_dir() {
            return Ok(());
        }
        let missing = || TaskError::RootMissing(self.root.to_string_lossy().to_string());
        match &self.creation {
            RootCreation::Always => {
                std::fs::create_dir_all(&self.root).map_err(|e| TaskError::Io(e.to_string()))
            }
            // `create_dir_all` is safe precisely because the base was checked:
            // recursion can only ever run below a directory the human pointed
            // at, however many levels the layout adds.
            RootCreation::InsideExisting { base } if base.is_dir() => {
                std::fs::create_dir_all(&self.root).map_err(|e| TaskError::Io(e.to_string()))
            }
            // The picked folder itself is missing: a typo, an unmounted volume,
            // a deleted directory. Say so instead of creating it.
            RootCreation::InsideExisting { .. } => Err(missing()),
            RootCreation::Never => Err(missing()),
        }
    }
```

In `src-tauri/src/tasks_cmd.rs`, the path arm of `resolve_root` becomes:

```rust
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => {
            let base = PathBuf::from(path);
            // Slugified, not joined verbatim: a workspace name is free text,
            // and `join("../..")` would put the cards outside the picked
            // folder entirely. `slugify` yields exactly one component and never
            // returns empty.
            let root = base.join(slugify(&ws.name));
            Some((root, RootCreation::InsideExisting { base }))
        }
```

and `ensure_root_if_ours` becomes:

```rust
/// Create as much of `root` as `creation` allows. An `InsideExisting` root whose
/// base is missing is left alone here rather than reported:
/// `FsTaskProvider::ensure_root` surfaces the same `RootMissing` loudly the
/// moment a card is actually read or written, and this function's callers
/// (`tasks_watch_sync`, `start_session`) are best-effort by design.
pub fn ensure_root_if_ours(
    root: &std::path::Path,
    creation: &RootCreation,
) -> std::io::Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    match creation {
        RootCreation::Always => std::fs::create_dir_all(root),
        RootCreation::InsideExisting { base } if base.is_dir() => std::fs::create_dir_all(root),
        RootCreation::InsideExisting { .. } => Ok(()),
        RootCreation::Never => Ok(()),
    }
}
```

Three call sites now pass a reference:

- `src-tauri/src/tasks_cmd.rs:271` (in `tasks_watch_sync`) → `let _ = ensure_root_if_ours(&root, &creation);`
- `src-tauri/src/tasks_cmd.rs:397` (in `tasks_migrate`) → `ensure_root_if_ours(&root, &creation).map_err(|e| e.to_string())?;`
- `src-tauri/src/commands.rs:226` (in `start_session`) → `let _ = crate::tasks_cmd::ensure_root_if_ours(root, creation);`

The `commands.rs` site already destructures with `if let Some((root, creation)) = &resolved`, so `creation` is already a `&RootCreation`; only the `*creation` deref that `Copy` allowed has to go.

Add `FsTaskProvider` to the test module's imports in `tasks_cmd.rs` if it is not already there — the new `a_provider_refuses_to_read_a_root_whose_base_is_missing` test constructs one:

```rust
    use crate::tasks::fs::{FsTaskProvider, RootCreation};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS. Nothing about the resolved path changed in this task, so every migration test still asserts the same strings.

Run: `cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: **6**, the baseline Task 1 established.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "refactor(tracker): a creation policy that carries its base

LeafInsideExistingParent encoded a depth: exactly one level, parent must
exist. The container layout needs two, and a variant named after a depth
would have to be renamed or duplicated for every layout change.

InsideExisting { base } names the boundary instead. The base is the folder the
human picked, everything below it is ours, and the typo guarantee is one
condition covering zero, one and two levels. create_dir_all below the base is
safe exactly because the base was checked first.

The PathBuf costs the enum its Copy derive, which is why four call sites now
pass a reference. Behaviour is unchanged: the layout is still <picked>/<slug>."
```

---

## Task 3: One container instead of one folder per project

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs:35-57` (`resolve_root`, plus the new constant and helper above it)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `RootCreation::InsideExisting` (Task 2); `slugify` from `crate::tasks::frontmatter`.
- Produces:
  - `pub const TRACKER_CONTAINER: &str = "cowork-deck-tasks";`
  - `fn append_layout(picked: &Path, slug: &str) -> PathBuf` — private; `resolve_root` and `root_preview` (Task 5) are its only callers.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/tasks_cmd.rs`, replace `an_external_root_gets_a_per_project_subfolder` (the version Task 2 just wrote) with these four, and update the two assertions in `the_subfolder_is_a_slug_so_a_workspace_name_cannot_escape_the_picked_folder`:

```rust
    #[test]
    fn an_external_root_gets_a_container_and_a_project_folder() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let (root, creation) = resolve_root(&w).expect("configured");
        // One folder of ours in the person's space, not one per project.
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
        assert_eq!(creation, RootCreation::InsideExisting { base: "/home/u/vault".into() });
    }

    #[test]
    fn picking_the_container_itself_does_not_nest_a_second_one() {
        // The case that matters in practice: after the first migration the
        // container exists, so it is what the picker shows and what a person
        // naturally chooses. A rule that only appended would hand them
        // cowork-deck-tasks/cowork-deck-tasks/cowork-deck.
        let w = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks".into(),
        })));
        let (root, creation) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
        // The base is still the picked folder, so only the project level is ours.
        assert_eq!(
            creation,
            RootCreation::InsideExisting { base: "/home/u/vault/cowork-deck-tasks".into() },
        );
    }

    #[test]
    fn picking_the_project_folder_itself_resolves_to_it_unchanged() {
        // Re-pointing the tracker at the folder the board already reads must be
        // a no-op, not another doubling.
        let w = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks/cowork-deck".into(),
        })));
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
    }

    #[test]
    fn a_folder_merely_sharing_the_project_name_is_an_ordinary_pick() {
        // Only `<container>/<slug>` counts as already-resolved. Without the
        // parent check, any folder named after the project would be mistaken
        // for one of ours and never get a container.
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/cowork-deck".into() })));
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(
            root,
            std::path::Path::new("/home/u/cowork-deck/cowork-deck-tasks/cowork-deck"),
        );
    }
```

The updated escape test — same guarantee, one level deeper:

```rust
    #[test]
    fn the_subfolder_is_a_slug_so_a_workspace_name_cannot_escape_the_picked_folder() {
        // A workspace name is free text from a form. Joined verbatim, "../.."
        // would put the cards outside the folder the person picked.
        let mut w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        w.name = "../../etc".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/etc"));

        w.name = "My Project".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/my-project"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL — four assertion failures reading `left: /home/u/vault/cowork-deck` / `right: /home/u/vault/cowork-deck-tasks/cowork-deck` and similar. This is an assertion failure, not a compile error: `resolve_root` already exists and simply resolves to the old layout.

- [ ] **Step 3: Add the constant, the helper, and use them**

In `src-tauri/src/tasks_cmd.rs`, immediately above `resolve_root`:

```rust
/// The one folder cowork-deck creates inside a picked tracker path. Every
/// project's cards live in a subfolder of it, so pointing three workspaces at
/// one vault grows one directory there instead of three interleaved with
/// whatever the person keeps in it.
pub const TRACKER_CONTAINER: &str = "cowork-deck-tasks";

/// Where the cards go inside the folder the human picked.
///
/// Recognition is name-based on purpose. `resolve_root` runs on every list,
/// count and watcher sync, and asking the filesystem "does this folder look
/// like one of ours" would make all of them depend on a directory read that can
/// fail. A folder the person happens to have named `cowork-deck-tasks` is
/// treated as ours, which is the answer we would want anyway.
fn append_layout(picked: &std::path::Path, slug: &str) -> PathBuf {
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

Replace the path arm of `resolve_root` with:

```rust
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => {
            let base = PathBuf::from(path);
            // Slugified, not joined verbatim: a workspace name is free text,
            // and `join("../..")` would put the cards outside the picked
            // folder entirely. `slugify` yields exactly one component and never
            // returns empty.
            let root = append_layout(&base, &slugify(&ws.name));
            Some((root, RootCreation::InsideExisting { base }))
        }
```

- [ ] **Step 4: Update the migration tests the new layout moved**

Three existing tests assert a resolved path that is now one level deeper. They are not wrong about behaviour; their expected strings changed.

In `renaming_the_workspace_records_the_old_name_and_the_old_root`:

```rust
        // The folder is named for the project, so a rename moves the root too.
        assert_eq!(prev.root, "/home/u/vault/cowork-deck-tasks/cowork-deck");
```

In `moving_back_to_where_the_cards_are_clears_the_pointer`, the whole body — pointing the tracker straight at the folder the cards are in is now the third recognition case, which is a cleaner statement of what the test was always about:

```rust
    #[test]
    fn moving_back_to_where_the_cards_are_clears_the_pointer() {
        // The cards are at /home/u/vault/cowork-deck-tasks/tasks, and pointing
        // the tracker straight at that folder resolves to it unchanged — the
        // third recognition case. There is nothing to migrate.
        let old = seed_previous_location(ws(Some(v1_external(
            "/home/u/vault/cowork-deck-tasks/tasks",
        ))));
        let mut new = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks/tasks".into(),
        })));
        new.name = "Tasks".into();
        let out = with_previous_location(Some(&old), new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }
```

In `offer_counts_what_moves_and_what_stays`:

```rust
        assert_eq!(
            offer.to,
            dir.path().join("cowork-deck-tasks").join("cowork-deck").to_string_lossy(),
        );
```

- [ ] **Step 5: Run the whole suite**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: PASS and **6**. If `offer_says_project_gets_rewritten_after_a_rename` fails, the recognition rule is matching on the wrong component — it asserts nothing about `to`, so only a resolution bug reaches it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src
git commit -m "feat(tracker): one container folder instead of one per project

An external path resolved to <picked>/<slug>, which spent the person's own
folder to keep projects apart: three workspaces pointed at ~/vault grew three
directories there. They now share <picked>/cowork-deck-tasks/<slug>, one name
the person can recognise, move or delete as a unit.

Resolution recognises a folder already inside that layout. After the first
migration the container exists, so it is what the picker shows and what gets
chosen next — and a rule that only appended would nest a second copy. The
project folder itself resolves to itself, so re-pointing the tracker at the
folder the board already reads is a no-op.

The check is name-based, not content-based: resolve_root runs on every list,
count and watcher sync, and none of them should depend on a directory read."
```

---

## Task 4: Version 3, and where each older version put the cards

**Files:**
- Modify: `src-tauri/src/model.rs` (`TRACKER_CONFIG_VERSION`)
- Modify: `src-tauri/src/tasks_cmd.rs:143-176` (`seed_previous_location`)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `append_layout` indirectly through `effective_root` (Task 3); `slugify`.
- Produces: no new signatures. `seed_previous_location` keeps `fn(Workspace) -> Workspace`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks_cmd.rs`, next to the existing `v1_external` helper:

```rust
    fn v2_external(path: &str) -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Path { path: path.into() } }],
            previous_location: None,
            version: 2,
        }
    }

    #[test]
    fn a_v2_config_is_seeded_with_the_project_folder_it_used_to_resolve_to() {
        // Version 2 added the project folder but no container, so that is where
        // the cards physically are.
        let out = seed_previous_location(ws(Some(v2_external("/home/u/vault"))));
        let prev = out.tracker.unwrap().previous_location.expect("seeded");
        assert_eq!(prev.root, "/home/u/vault/cowork-deck");
        assert_eq!(prev.project, "cowork-deck");
        assert!(!prev.was_project_root);
    }

    #[test]
    fn a_v2_config_pointing_at_the_container_is_not_seeded() {
        // Its v2 root and its v3 root are the same folder: v2 appended the slug
        // to the container, and v3 recognises the container and does the same.
        // A pointer here would offer to move cards from a folder into itself.
        let out = seed_previous_location(ws(Some(v2_external("/home/u/vault/cowork-deck-tasks"))));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn a_v3_config_is_left_alone_by_seeding() {
        let out = seed_previous_location(ws(Some(tracker(
            TrackerRoot::Path { path: "/home/u/vault".into() },
        ))));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn an_unanswered_v1_pointer_survives_the_upgrade_to_v3() {
        // Someone who never answered the v1 banner still has a pointer at the
        // picked folder, which is where the cards are. Recomputing it for v3
        // would send the migration into an empty directory.
        let mut seeded = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        // Simulate the config being read again by a newer build.
        seeded.tracker.as_mut().unwrap().version = 2;
        let out = seed_previous_location(seeded);
        let prev = out.tracker.unwrap().previous_location.expect("kept");
        assert_eq!(prev.root, "/home/u/vault/Tasks");
    }
```

Delete the now-duplicated `a_current_config_is_left_alone_by_seeding` — `a_v3_config_is_left_alone_by_seeding` is the same test under a name that says which version it means.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL — `a_v2_config_is_seeded_with_the_project_folder_it_used_to_resolve_to` gets `/home/u/vault` instead of `/home/u/vault/cowork-deck`, because the current code treats every below-current version as "the cards are in the picked folder". `a_v2_config_pointing_at_the_container_is_not_seeded` fails for the same reason.

- [ ] **Step 3: Bump the version and decide per version**

In `src-tauri/src/model.rs`:

```rust
pub const TRACKER_CONFIG_VERSION: u8 = 3;
```

Update the doc comment on `TrackerConfig::version` in the same file so it does not describe only version 1:

```rust
    /// Storage format for the layout below a picked path. Version 1 used the
    /// picked folder verbatim; version 2 added a project subfolder; version 3
    /// puts that subfolder inside a `cowork-deck-tasks` container. Records
    /// without the field are version 1 and are seeded on read.
    #[serde(rename = "v", default = "tracker_v1")]
    pub version: u8,
```

Replace `seed_previous_location` in `src-tauri/src/tasks_cmd.rs`:

```rust
/// An older config resolved a picked path to a different folder than this
/// version does, so its cards are not where the board is about to look. Seed
/// that folder as the previous location, or updating the app would empty the
/// board with no explanation.
pub fn seed_previous_location(mut ws: Workspace) -> Workspace {
    let name = ws.name.clone();
    // Computed before the mutable borrow below, and needed for the guard at the
    // end: some picks resolve to the same folder under both layouts.
    let current_root = effective_root(&ws);
    let Some(cfg) = ws.tracker.as_mut() else { return ws };
    if cfg.version >= TRACKER_CONFIG_VERSION || cfg.previous_location.is_some() {
        return ws;
    }
    let picked = match cfg.providers.first() {
        Some(TrackerProvider::Fs { root: TrackerRoot::Path { path } }) => PathBuf::from(path),
        // A project root never moved: `<ws.path>/.cowork/tasks` is what every
        // version resolved to.
        _ => return ws,
    };
    // Where that version's resolution actually put the files.
    let was = if cfg.version <= 1 {
        // Version 1 used the picked folder verbatim.
        picked
    } else {
        // Version 2 appended the project folder and nothing else.
        picked.join(slugify(&name))
    };
    let was = was.to_string_lossy().to_string();
    // Picking the container itself resolves to the same folder under both
    // layouts. Seeding here would offer to move cards from a folder into
    // itself, and the banner could never be satisfied.
    if current_root.as_deref() == Some(was.as_str()) {
        return ws;
    }
    cfg.previous_location = Some(PreviousLocation {
        root: was,
        project: name,
        was_project_root: false,
    });
    ws
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, including `every_save_stamps_the_current_config_version` (it reads the constant, so 3 needs no edit), `a_v1_external_config_is_seeded_with_the_picked_folder_itself`, and `store::tests::upsert_refuses_to_truncate_on_non_not_found_read_error`.

Run: `cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: **6**.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(tracker): seed the previous location per config version

Two older layouts now exist, and 'anything below the current version keeps its
cards in the picked folder' was only ever true of version 1. Version 2 put
them in <picked>/<slug>, so seeding decides per version instead.

The trap version 3 has and version 2 did not: when the picked folder is the
container, the old root and the new root are the same path, and a pointer
there would offer to move cards from a folder into itself. Seeding gains the
equal-roots guard with_previous_location already had."
```

---

## Task 5: Telling the caller what would be created

**Files:**
- Modify: `src-tauri/src/tasks_cmd.rs` (the type, `root_preview`, the command)
- Modify: `src-tauri/src/main.rs` (the `invoke_handler` list, after `tasks_cmd::tasks_migration_dismiss`)
- Modify: `src/ipc.ts` (after the migration wrappers)
- Test: `src-tauri/src/tasks_cmd.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: `append_layout`, `TRACKER_CONTAINER`, `slugify` (Task 3).
- Produces:
  - `pub struct TrackerRootPreview { root: String, creating: Vec<String>, base_missing: bool }`, serialized `camelCase`.
  - `pub fn root_preview(workspace_name: &str, picked_path: &str) -> TrackerRootPreview` — the testable seam; takes no `State`.
  - `tracker_root_preview(workspace_name: String, picked_path: String) -> TrackerRootPreview` — the command, a one-line wrapper.
  - `export interface TrackerRootPreview { root: string; creating: string[]; baseMissing: boolean }` and `trackerRootPreview(workspaceName, pickedPath)` in `src/ipc.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/tasks_cmd.rs`:

```rust
    #[test]
    fn preview_names_both_folders_when_neither_exists() {
        let dir = tempfile::tempdir().unwrap();
        let p = root_preview("cowork-deck", &dir.path().to_string_lossy());
        // Outermost first, so the form can read them out in the order they
        // appear in the path.
        assert_eq!(p.creating, vec!["cowork-deck-tasks", "cowork-deck"]);
        assert!(!p.base_missing);
        assert_eq!(
            p.root,
            dir.path().join("cowork-deck-tasks").join("cowork-deck").to_string_lossy(),
        );
    }

    #[test]
    fn preview_names_only_the_project_folder_when_the_container_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("cowork-deck-tasks")).unwrap();
        let p = root_preview("cowork-deck", &dir.path().to_string_lossy());
        assert_eq!(p.creating, vec!["cowork-deck"]);
        assert!(!p.base_missing);
    }

    #[test]
    fn preview_promises_nothing_when_everything_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("cowork-deck-tasks").join("cowork-deck")).unwrap();
        let p = root_preview("cowork-deck", &dir.path().to_string_lossy());
        // Silence means there is nothing to create. An "already exists" line
        // would be noise on every later edit of the same workspace.
        assert!(p.creating.is_empty());
        assert!(!p.base_missing);
    }

    #[test]
    fn preview_promises_nothing_when_the_picked_folder_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = root_preview("cowork-deck", &dir.path().join("vualt").to_string_lossy());
        assert!(p.base_missing);
        assert!(p.creating.is_empty(), "nothing is created when the base is absent");
    }

    #[test]
    fn preview_resolves_a_picked_container_the_same_way_resolve_root_does() {
        // The two share append_layout by construction; this pins that they are
        // still wired to the same function.
        let dir = tempfile::tempdir().unwrap();
        let container = dir.path().join("cowork-deck-tasks");
        std::fs::create_dir(&container).unwrap();
        let p = root_preview("cowork-deck", &container.to_string_lossy());
        assert_eq!(p.root, container.join("cowork-deck").to_string_lossy());
        assert_eq!(p.creating, vec!["cowork-deck"]);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tasks_cmd`
Expected: FAIL to compile — `cannot find function 'root_preview' in this scope`.

- [ ] **Step 3: Implement the preview and register the command**

Add to `src-tauri/src/tasks_cmd.rs`, below `append_layout`:

```rust
/// What the workspace form shows under the folder picker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerRootPreview {
    /// The resolved effective root, in full: the person picked the folder and
    /// needs to recognise where the cards will land.
    pub root: String,
    /// Single folder names, outermost first, that do not exist yet — never full
    /// paths. Empty when `base_missing`, because then nothing is created.
    pub creating: Vec<String>,
    /// The picked folder itself is absent, so nothing will be created.
    pub base_missing: bool,
}

/// Describe what configuring `picked_path` for a workspace called
/// `workspace_name` would resolve to, and which folders that would create.
///
/// Shares `append_layout` and `slugify` with `resolve_root` rather than
/// recomputing them. Two implementations of the layout would agree on the day
/// they were written and disagree after the next change to either — and one of
/// them would be in a language that cannot call the other.
pub fn root_preview(workspace_name: &str, picked_path: &str) -> TrackerRootPreview {
    let base = PathBuf::from(picked_path);
    let root = append_layout(&base, &slugify(workspace_name));
    let root_str = root.to_string_lossy().to_string();

    if !base.is_dir() {
        return TrackerRootPreview { root: root_str, creating: Vec::new(), base_missing: true };
    }

    // Every component between the base and the root, outermost first, keeping
    // only what is absent. `root` always starts with `base`: all three
    // recognition cases either return the base itself or join onto it.
    let mut creating = Vec::new();
    let mut walk = base.clone();
    let below = root.strip_prefix(&base).unwrap_or(std::path::Path::new(""));
    for part in below.components() {
        walk = walk.join(part);
        if !walk.is_dir() {
            creating.push(part.as_os_str().to_string_lossy().to_string());
        }
    }
    TrackerRootPreview { root: root_str, creating, base_missing: false }
}

#[tauri::command]
pub fn tracker_root_preview(workspace_name: String, picked_path: String) -> TrackerRootPreview {
    root_preview(&workspace_name, &picked_path)
}
```

In `src-tauri/src/main.rs`, add to the `invoke_handler` list after `tasks_cmd::tasks_migration_dismiss,`:

```rust
            tasks_cmd::tracker_root_preview,
```

In `src/ipc.ts`, after `taskMigrationDismiss`:

```ts
/** What configuring a picked folder would resolve to, and what it would create. */
export interface TrackerRootPreview {
  root: string;
  /** Single folder names, outermost first, that do not exist yet. */
  creating: string[];
  /** The picked folder itself is absent, so nothing will be created. */
  baseMissing: boolean;
}

export const trackerRootPreview = (workspaceName: string, pickedPath: string) =>
  invoke<TrackerRootPreview>("tracker_root_preview", { workspaceName, pickedPath });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: PASS and **6**.

Run: `npx tsc --noEmit`
Expected: clean. Nothing imports the new wrapper yet; that is Task 6.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src/ipc.ts
git commit -m "feat(tracker): a command describing the folders a pick would create

The form has to name the folders before creating them, and the only honest way
to get that string is from the code that resolves the path. Computing it in
TypeScript would mean a second slugify and a second copy of the recognition
rule, in a language that cannot call the first.

creating lists single folder names, outermost first, and only the absent ones:
an 'already exists' line would be noise on every later edit of the same
workspace. A missing base promises nothing, because nothing is what gets
created."
```

---

## Task 6: The form says it before it does it

**Files:**
- Modify: `src/forms.ts:90-93` (the `name` input), `:100-104` (the project `pick` handler), `:157-186` (the tracker block), `:200-202` (the `box.append` list)
- Modify: `src/styles.css` (after the `.form-pathrow` rule)
- Test: `tests/forms.test.ts`

**Interfaces:**
- Consumes: `trackerRootPreview`, `TrackerRootPreview` (Task 5).
- Produces: no exported signatures. `workspaceForm`'s parameters and result are unchanged, so neither call site in `src/workspaces.ts` moves.

- [ ] **Step 1: Write the failing tests**

At the top of `tests/forms.test.ts`, add the Tauri mock next to the existing dialog mock. The established pattern is `tests/ipc.test.ts`'s:

```ts
vi.mock("@tauri-apps/api/core");
```

and, after the existing imports:

```ts
import { invoke } from "@tauri-apps/api/core";
```

Add to the `workspaceForm` describe block:

```ts
  /** The form debounces nothing, but it does await IPC — let the microtasks run. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  const fillTracker = (path: string, wsName = "deck") => {
    (document.querySelector(".form-name") as HTMLInputElement).value = wsName;
    document.querySelector<HTMLInputElement>(".tk-f-on")!.checked = true;
    const pathRadio = document.querySelector<HTMLInputElement>("input[value='path']")!;
    pathRadio.checked = true;
    pathRadio.dispatchEvent(new Event("change"));
    const tp = document.querySelector(".tk-f-path") as HTMLInputElement;
    tp.value = path;
    tp.dispatchEvent(new Event("input"));
  };

  it("names the folders it will create before the save", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck",
      creating: ["cowork-deck-tasks", "deck"],
      baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    expect(document.querySelector(".tk-f-preview-path")!.textContent)
      .toBe("/vault/cowork-deck-tasks/deck");
    const made = document.querySelector(".tk-f-preview-creating")!.textContent!;
    expect(made).toContain("cowork-deck-tasks/");
    expect(made).toContain("deck/");
  });

  it("says nothing about creating when both folders are already there", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    expect(document.querySelector(".tk-f-preview-path")).not.toBeNull();
    expect(document.querySelector(".tk-f-preview-creating")).toBeNull();
  });

  it("warns instead of promising folders when the picked path does not exist", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vualt/cowork-deck-tasks/deck", creating: [], baseMissing: true,
    });
    void workspaceForm();
    fillTracker("/vualt");
    await settle();
    expect(document.querySelector(".tk-f-preview-warn")).not.toBeNull();
    expect(document.querySelector(".tk-f-preview-creating")).toBeNull();
  });

  it("asks nothing while the workspace name is blank", async () => {
    // slugify("") is "task", so a preview here would promise a folder that will
    // never exist.
    void workspaceForm();
    fillTracker("/vault", "");
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
  });

  it("recomputes when the name changes, because the folder is named after it", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    const before = vi.mocked(invoke).mock.calls.length;
    const nameInput = document.querySelector(".form-name") as HTMLInputElement;
    nameInput.value = "renamed";
    nameInput.dispatchEvent(new Event("input"));
    await settle();
    expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(before);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
      "tracker_root_preview", { workspaceName: "renamed", pickedPath: "/vault" },
    );
  });

  it("keeps the form usable when the preview call fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    // An explanatory line is not worth failing a form over.
    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
    expect(document.querySelector(".modal-ok")).not.toBeNull();
  });
```

The tracker checkbox needs a class for `fillTracker` to find. In `src/forms.ts`, the `labeledCheck("Task tracker", onInput, …)` call builds it — give `onInput` the class `tk-f-on` where it is created:

```ts
    onInput.className = "tk-f-on";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/forms.test.ts`
Expected: FAIL — `.tk-f-preview-path` is null in the first three tests, and the name-change test finds no `invoke` calls.

- [ ] **Step 3: Build the preview block**

In `src/forms.ts`, add the runtime import at the top (the file currently imports only types from `./ipc`):

```ts
import { trackerRootPreview } from "./ipc";
import type { Schedule, SchedulePreset, TaskDraft, TaskKind, TrackerConfig, TrackerRootPreview } from "./ipc";
```

Inside `workspaceForm`, after `trackerPathRow` is assembled:

```ts
    // Cards land in folders the app creates, so the form names them before the
    // save rather than leaving the person to find them afterwards.
    const trackerPreview = document.createElement("div");
    trackerPreview.className = "tk-f-preview";

    const renderPreview = (p: TrackerRootPreview | null) => {
      trackerPreview.replaceChildren();
      if (!p) return;
      const head = document.createElement("p");
      head.className = "tk-f-preview-head";
      head.textContent = "Cards will live in:";
      const where = document.createElement("p");
      where.className = "tk-f-preview-path";
      where.textContent = p.root;
      trackerPreview.append(head, where);
      if (p.baseMissing) {
        const warn = document.createElement("p");
        warn.className = "tk-f-preview-warn";
        warn.textContent = "That folder does not exist, so nothing will be created.";
        trackerPreview.append(warn);
        return;
      }
      // Absent when there is nothing to create: an "already exists" line would
      // be noise on every later edit of the same workspace.
      if (p.creating.length) {
        const made = document.createElement("p");
        made.className = "tk-f-preview-creating";
        made.textContent =
          `${p.creating.map((n) => `${n}/`).join(" and ")} will be created for you.`;
        trackerPreview.append(made);
      }
    };

    // A newer request must win even if an older one replies later. The token
    // is consumed before the guard, not after: a guard failure (tracker
    // turned off, root switched back to project, name blanked mid-flight) has
    // to invalidate an in-flight request too, or a stale success can redraw
    // the very preview the guard just cleared.
    let previewToken = 0;
    const refreshPreview = async () => {
      const token = ++previewToken;
      const picked = trackerPath.value.trim();
      // The project folder is a slug of the name, so a blank name would resolve
      // to slugify("") — "task" — and promise a folder that will never exist.
      const wsName = name.value.trim();
      if (!onInput.checked || !pathRadio.checked || !picked || !wsName) {
        renderPreview(null);
        return;
      }
      try {
        const p = await trackerRootPreview(wsName, picked);
        if (token === previewToken) renderPreview(p);
      } catch {
        // An explanatory line in a form is not worth a visible failure.
        if (token === previewToken) renderPreview(null);
      }
    };
```

The token must be consumed at the very top of `refreshPreview`, before the guard runs, not after it. If it is bumped only on the valid branch, a guard failure — the tracker turned off, the root switched back to project, or (as here) the name blanked mid-flight — leaves `previewToken` untouched, so an older in-flight request that later resolves still matches it and redraws the very preview the guard just cleared. Every call has to invalidate whatever came before it, whether or not that call goes on to fire an IPC request.

Wire every input that can move the resolved path. The name field is one of them, which is the whole reason `refreshPreview` reads both:

```ts
    trackerPath.oninput = () => void refreshPreview();
    name.oninput = () => void refreshPreview();
```

`trackerPick.onclick` sets the value programmatically, and assigning `.value` fires no `input` event:

```ts
    trackerPick.onclick = async () => {
      const p = await pickFolder();
      if (p) { trackerPath.value = p; void refreshPreview(); }
    };
```

The project-folder picker at `:100-104` can fill the name field, which moves the tracker folder too — add the same call at the end of its handler:

```ts
    pick.onclick = async () => {
      const p = await pickFolder();
      if (p) {
        path.value = p;
        if (!name.value.trim()) name.value = p.split("/").filter(Boolean).pop() ?? "";
        void refreshPreview();
      }
    };
```

Extend `syncTracker` so switching the root kind or turning the tracker off clears the line:

```ts
    const syncTracker = () => {
      rootRow.classList.toggle("tk-hidden", !onInput.checked);
      // Hide the row, not just the input: the pick button lives beside it and
      // would otherwise stay behind on its own.
      trackerPathRow.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
      void refreshPreview();
    };
```

Add `trackerPreview` to the append list:

```ts
    box.append(title, labeled("Name", name), labeled("Folder", pathRow), colorRow,
      onRow, rootRow, trackerPathRow, trackerPreview, error, row);
```

- [ ] **Step 4: Style it**

In `src/styles.css`, after the `.form-pathrow` rule:

```css
/* --- Where a picked tracker folder resolves to --------------------------- */

.tk-f-preview { margin: var(--sp-1) 0 0; }
.tk-f-preview p { margin: 0 0 2px; }
.tk-f-preview-head { color: var(--fg-muted); font-size: var(--fs-xs); }
/* The path is the one thing here the person has to recognise. */
.tk-f-preview-path {
  color: var(--fg); font-size: var(--fs-sm); word-break: break-all;
}
.tk-f-preview-creating { color: var(--fg-muted); font-size: var(--fs-xs); }
.tk-f-preview-warn { color: var(--st-error); font-size: var(--fs-xs); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/forms.test.ts && npx tsc --noEmit`
Expected: PASS and a clean typecheck. If a pre-existing `workspaceForm` test now fails on an unexpected `invoke` call, it is filling the tracker path without a name mock — assert the mock's resolved value in that test rather than loosening the guard.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: all pass.

Run: `cd src-tauri && cargo test && cargo clippy --all-targets 2>&1 | grep -c "^warning: [a-z]"`
Expected: PASS and **6**.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(tracker): the form names the folders before creating them

A folder picker that quietly grows two levels inside the chosen directory is a
surprise even when the layout is right. The form now states the resolved path
and names only the folders that do not exist yet; silence means there is
nothing to create.

The preview recomputes on the name field as well as the path, because the
project folder is a slug of the name — watching only the path would show a
stale folder to anyone who renames and repoints in one sitting. A blank name
asks nothing at all: slugify('') is 'task', and promising a 'task' folder that
will never exist is worse than saying nothing.

A rejected preview call leaves the form usable and silent. It explains a save;
it is not worth blocking one."
```

---

## Self-Review

**Spec coverage.** Every section of `2026-07-28-tracker-root-container-design.md` maps to a task: root resolution and the three recognition cases → Task 3; the creation policy and `InsideExisting { base }` → Task 2; the preview command and its "one source of truth" argument → Task 5; the form's three lines, the blank-name rule and the swallowed failure → Task 6; version 3, per-version seeding and the equal-roots guard → Task 4. The spec's error-handling section is covered by `ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo` and `a_provider_refuses_to_read_a_root_whose_base_is_missing` (missing base, silent and loud halves), and `preview_promises_nothing_when_the_picked_folder_is_missing` (what the form says about it). The two blemishes the spec does not cover are Task 1, which the user asked for explicitly.

**Ordering.** Task 1 first because it changes the clippy baseline every later task is measured against, from 7 warnings to 6. Task 2 is behaviour-preserving on purpose, so the layout change in Task 3 arrives with the creation policy already in place and reviewable on its own. Task 4 depends on Task 3's `append_layout` through `effective_root`, and its container test would pass for the wrong reason if run before it.

**Type consistency.** `RootCreation::InsideExisting { base }` is spelled identically in `fs.rs`, `tasks_cmd.rs` and `commands.rs`; `bin/cowork_task.rs` still passes `FsRootCreation::Never` and needs no edit, since only the variant it does not use changed. `TrackerRootPreview`'s Rust fields serialize `camelCase` and match the TS interface field for field: `root`, `creating`, `baseMissing`. `root_preview` is the pure seam and `tracker_root_preview` the command — the plan never uses one name where it means the other.

**Test updates called out rather than discovered.** Task 3 Step 4 names the three existing tests whose expected paths move (`renaming_the_workspace_records_the_old_name_and_the_old_root`, `moving_back_to_where_the_cards_are_clears_the_pointer`, `offer_counts_what_moves_and_what_stays`). Leaving these to be found at Step 5 would read as a regression rather than as the layout change they are.

**One gap, named.** Nothing tests that `root_preview` and `resolve_root` agree, because they call the same `append_layout`. `preview_resolves_a_picked_container_the_same_way_resolve_root_does` pins the wiring, not the equality; if a future change gives the preview its own resolution, that agreement becomes untested and the duplication this design exists to avoid is back.
