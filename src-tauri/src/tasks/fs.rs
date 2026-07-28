use crate::tasks::frontmatter::{parse_card, render_card, set_status_done, slugify};
use crate::tasks::model::{Task, TaskDraft, TaskError, TaskStatus};
use crate::tasks::provider::{ProviderCapabilities, TaskProvider};
use std::path::{Path, PathBuf};

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
    /// `base` — the folder the human picked, or the container they picked inside
    /// of — must already exist; everything below it is ours to create. This is
    /// what keeps a typo'd external path surfacing as `RootMissing` instead of
    /// scattering a tree across the disk, and it says so once for any number of
    /// levels. `tasks_cmd::append_layout` decides the base together with the
    /// root, so the base is always an ancestor of the root it guards.
    InsideExisting { base: PathBuf },
    /// Create nothing. `cowork_task` is handed an already-resolved
    /// `COWORK_TASKS_DIR` and must not invent folders from a stale env var.
    Never,
}

impl RootCreation {
    /// Whether a missing root is ours to bring into existence.
    ///
    /// The one place the policy is written. Both callers ask this question —
    /// `FsTaskProvider::ensure_root` and `tasks_cmd::ensure_root_if_ours` — and
    /// they differ only in how they *react* to `false`: the provider reports
    /// `RootMissing` where the best-effort helper stays silent. Two copies of
    /// the match would agree today and drift apart at the next variant.
    ///
    /// Takes no root: nothing in the decision depends on the root itself, only
    /// on the base it must sit inside. The caller has already established that
    /// the root is absent.
    pub fn may_create(&self) -> bool {
        match self {
            RootCreation::Always => true,
            // `create_dir_all` below the base is safe precisely because the base
            // was checked: recursion can only ever run below a directory the
            // human pointed at or pointed inside of, however many levels the
            // layout adds. A missing base is a typo, an unmounted volume, a
            // deleted directory.
            RootCreation::InsideExisting { base } => base.is_dir(),
            RootCreation::Never => false,
        }
    }
}

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
        // This is the half that has to be loud: a root we may not create is what
        // the board surfaces to the person, not an empty list.
        if !self.creation.may_create() {
            return Err(TaskError::RootMissing(self.root.to_string_lossy().to_string()));
        }
        std::fs::create_dir_all(&self.root).map_err(|e| TaskError::Io(e.to_string()))
    }

    /// Every card in the root, unfiltered, with `conflict` already set. One
    /// unreadable entry is skipped, never fatal: aborting the scan would hide
    /// every card that sorts after the bad one.
    ///
    /// Public because the migration reads an old root's cards unfiltered, which
    /// `list` cannot supply: it filters by project before returning, and the
    /// cards it throws away are exactly the ones the banner has to count.
    /// `pub(crate)` would not reach the caller — `tasks_cmd` is part of the
    /// binary crate, which links this one through `use cowork_deck::tasks`.
    pub fn scan(&self) -> Result<Vec<Task>, TaskError> {
        self.ensure_root()?;
        let entries = std::fs::read_dir(&self.root).map_err(|e| TaskError::Io(e.to_string()))?;
        let mut cards: Vec<Task> = Vec::new();
        for entry in entries {
            let entry = match entry { Ok(e) => e, Err(_) => continue };
            let path = entry.path();
            if !path.is_file() { continue; }
            if path.extension().and_then(|e| e.to_str()) != Some("md") { continue; }
            let text = match std::fs::read_to_string(&path) { Ok(t) => t, Err(_) => continue };
            let as_str = path.to_string_lossy().to_string();
            if let Some(card) = parse_card(&text, &as_str) {
                cards.push(card);
            }
        }

        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for c in &cards { *seen.entry(c.id.clone()).or_insert(0) += 1; }
        for c in &mut cards {
            c.conflict = seen.get(&c.id).copied().unwrap_or(0) > 1;
        }
        Ok(cards)
    }

    fn write_atomic(&self, path: &Path, text: &str) -> Result<(), TaskError> {
        let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        // Leading dot + `.tmp`: invisible to vaults, and never parsed as a card
        // because the scan requires a `.md` extension.
        let tmp = self.root.join(format!(".{name}.tmp"));
        std::fs::write(&tmp, text).map_err(|e| TaskError::Io(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            TaskError::Io(e.to_string())
        })
    }

    fn now_iso() -> String {
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }
}

impl TaskProvider for FsTaskProvider {
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            can_create: true,
            can_resolve: true,
            statuses: vec!["open".to_string(), "done".to_string()],
        }
    }

    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError> {
        let mut cards = self.scan()?;
        // A damaged card is kept whatever its `project` says: it may be damaged
        // *because* the project field is missing, and dropping it here would
        // make the task disappear without a trace.
        cards.retain(|c| c.damaged.is_some() || c.project == project);
        Ok(cards)
    }

    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError> {
        self.ensure_root()?;
        let id = ulid::Ulid::generate().to_string();
        let name = format!("{}-{}.md", id, slugify(&draft.title));
        let path = self.root.join(&name);
        let card = Task {
            id,
            title: draft.title,
            kind: draft.kind,
            status: TaskStatus::Open,
            project: draft.project,
            created: Self::now_iso(),
            resolved: None,
            origin: draft.origin,
            session: draft.session,
            body: draft.body,
            path: path.to_string_lossy().to_string(),
            damaged: None,
            conflict: false,
        };
        self.write_atomic(&path, &render_card(&card))?;
        Ok(card)
    }

    fn resolve(&self, id: &str) -> Result<Task, TaskError> {
        let cards = self.scan()?;
        let matches: Vec<&Task> = cards.iter().filter(|c| c.id == id).collect();
        match matches.len() {
            0 => Err(TaskError::NotFound(id.to_string())),
            // Refuse rather than guess which of two copies to write into.
            n if n > 1 => Err(TaskError::Conflict(id.to_string())),
            _ => {
                let card = matches[0];
                // A damaged card may well be an unrelated Obsidian note that
                // merely has an `id:` field. Writing into it — from the UI or
                // from `cowork_task done` — would rewrite a file we do not
                // own. Refuse before touching the filesystem at all.
                if card.damaged.is_some() {
                    return Err(TaskError::Damaged(card.path.clone()));
                }
                let path = PathBuf::from(&card.path);
                let resolved = Self::now_iso();
                // Edit the frontmatter in place rather than re-rendering the
                // whole card: `render_card` only knows nine keys, so closing a
                // card that also carries `tags:`, `aliases:`, or Dataview
                // fields through it would silently drop them.
                let text = std::fs::read_to_string(&path).map_err(|e| TaskError::Io(e.to_string()))?;
                let updated = set_status_done(&text, &resolved).ok_or_else(|| {
                    TaskError::Io("the card has no frontmatter block".to_string())
                })?;
                self.write_atomic(&path, &updated)?;

                let mut card = card.clone();
                card.status = TaskStatus::Done;
                card.resolved = Some(resolved);
                card.conflict = false;
                Ok(card)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::{TaskKind, TaskOrigin, TaskStatus};
    use crate::tasks::provider::TaskProvider;

    fn draft(title: &str, project: &str) -> TaskDraft {
        TaskDraft {
            title: title.to_string(),
            kind: TaskKind::Bug,
            body: "body".to_string(),
            project: project.to_string(),
            origin: TaskOrigin::Human,
            session: None,
        }
    }

    fn provider(dir: &std::path::Path) -> FsTaskProvider {
        FsTaskProvider::new(dir.to_path_buf(), RootCreation::Never)
    }

    #[test]
    fn the_first_read_builds_the_whole_layout_below_a_base_that_exists() {
        // The primary production path of the external root: the person picked a
        // folder that exists and neither level below it has been made yet, so
        // the first list or the first card write has to bring both into being.
        // Two levels on purpose — a `create_dir` here would leave the deeper one
        // missing and report Io instead of listing an empty board.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("vault");
        std::fs::create_dir(&base).unwrap();
        let middle = base.join("container");
        let root = middle.join("deck");

        let p = FsTaskProvider::new(root.clone(), RootCreation::InsideExisting { base });
        let cards = p.scan().expect("a fresh root is an empty board, not an error");

        assert!(cards.is_empty());
        assert!(middle.is_dir(), "the intermediate level is created too");
        assert!(root.is_dir(), "and the root itself");
    }

    #[test]
    fn the_first_card_write_builds_the_layout_too() {
        // `create` calls ensure_root on its own: filing a card into a workspace
        // whose board was never opened must not fail for want of a folder.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("vault");
        std::fs::create_dir(&base).unwrap();
        let root = base.join("container").join("deck");

        let p = FsTaskProvider::new(root.clone(), RootCreation::InsideExisting { base });
        let made = p.create(draft("The pill blinks", "deck")).expect("the root is ours to make");

        assert!(root.is_dir());
        assert_eq!(p.list("deck").unwrap()[0].id, made.id);
    }

    #[test]
    fn create_then_list_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let made = p.create(draft("The pill blinks", "deck")).unwrap();
        assert_eq!(made.status, TaskStatus::Open);
        assert!(!made.created.is_empty());

        let all = p.list("deck").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, made.id);
        assert_eq!(all[0].title, "The pill blinks");
        assert_eq!(all[0].body.trim(), "body");
    }

    #[test]
    fn filename_carries_id_and_slug() {
        let dir = tempfile::tempdir().unwrap();
        // Cyrillic on purpose, same reason as frontmatter.rs's slugify test: a card
        // title is written in whatever language its author thinks in, and the file
        // name it produces has to stay readable. ASCII here would drop the coverage.
        let made = provider(dir.path()).create(draft("Баг: пилюля мигает", "deck")).unwrap();
        let name = std::path::Path::new(&made.path).file_name().unwrap().to_string_lossy();
        assert!(name.starts_with(&made.id), "got {name}");
        assert!(name.ends_with("-баг-пилюля-мигает.md"), "got {name}");
    }

    #[test]
    fn resolve_finds_the_card_after_the_file_was_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let made = p.create(draft("Rename me", "deck")).unwrap();

        // Which is what a human does in Obsidian on day one.
        let renamed = dir.path().join("A human name.md");
        std::fs::rename(&made.path, &renamed).unwrap();

        let done = p.resolve(&made.id).unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert!(done.resolved.is_some(), "resolved timestamp is needed to sort the done column");
        assert_eq!(
            std::path::Path::new(&done.path).file_name().unwrap(),
            std::ffi::OsStr::new("A human name.md"),
            "resolve must write back to the renamed file, not recreate the old one"
        );
        assert_eq!(p.list("deck").unwrap().len(), 1, "no duplicate was left behind");
    }

    #[test]
    fn ordinary_notes_and_subdirectories_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Note.md"), "# just a note\n").unwrap();
        std::fs::write(dir.path().join("readme.txt"), "not markdown\n").unwrap();
        std::fs::create_dir(dir.path().join("Archive")).unwrap();
        std::fs::write(
            dir.path().join("Archive/hidden.md"),
            "---\nid: 01DEEP\ntitle: t\nstatus: open\nproject: deck\ncreated: c\n---\n",
        )
        .unwrap();

        let p = provider(dir.path());
        p.create(draft("A real one", "deck")).unwrap();

        let all = p.list("deck").unwrap();
        assert_eq!(all.len(), 1, "only the real card; scan is non-recursive");
        assert_eq!(all[0].title, "A real one");
    }

    #[test]
    fn cards_of_other_projects_are_filtered_out_but_damaged_ones_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        p.create(draft("Ours", "deck")).unwrap();
        p.create(draft("Theirs", "other-project")).unwrap();
        // id present, project missing → damaged, and it must stay visible.
        std::fs::write(
            dir.path().join("01BROKEN-x.md"),
            "---\nid: 01BROKEN\ntitle: Broken\n---\nbody\n",
        )
        .unwrap();

        let ours = p.list("deck").unwrap();
        let titles: Vec<&str> = ours.iter().map(|t| t.title.as_str()).collect();
        assert!(titles.contains(&"Ours"));
        assert!(titles.contains(&"Broken"), "a damaged card must never be filtered away");
        assert!(!titles.contains(&"Theirs"));
    }

    #[test]
    fn duplicate_ids_are_flagged_and_resolve_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let card = "---\nid: 01DUP\ntitle: Duplicate\nkind: task\nstatus: open\nproject: deck\ncreated: c\norigin: human\n---\n";
        std::fs::write(dir.path().join("01DUP-a.md"), card).unwrap();
        std::fs::write(dir.path().join("01DUP-b.md"), card).unwrap();

        let p = provider(dir.path());
        let all = p.list("deck").unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|t| t.conflict), "both copies must be flagged");

        match p.resolve("01DUP") {
            Err(TaskError::Conflict(_)) => {}
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    // Does not test atomicity itself: observing the intermediate state (the temp
    // file exists, the target does not yet) needs injected failure, and there is
    // none here. What is actually covered is that temp+rename leaves no litter
    // behind a successful write, and that even a surviving `.tmp` file is never
    // read as a card. The second one is structural: the scan requires a `.md`
    // extension, so the watcher cannot see a half-written card in principle —
    // not thanks to this test.
    fn write_leaves_no_temp_litter_and_temp_files_are_not_cards() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        p.create(draft("Atomic", "deck")).unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 1, "temp file must be gone after rename: {names:?}");
        assert!(names[0].ends_with(".md"));

        // Even if a temp file survives a crash, it never becomes a card.
        std::fs::write(dir.path().join(".01TMP.tmp"), "---\nid: 01TMP\n---\n").unwrap();
        assert_eq!(p.list("deck").unwrap().len(), 1);
    }

    #[test]
    fn missing_root_reports_the_path_instead_of_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("no-such-thing");
        let p = FsTaskProvider::new(absent.clone(), RootCreation::Never);
        match p.list("deck") {
            Err(TaskError::RootMissing(path)) => assert!(path.contains("no-such-thing")),
            other => panic!("expected RootMissing, got {other:?}"),
        }
        assert!(!absent.exists(), "an arbitrary user path must never be created silently");
    }

    #[test]
    fn in_project_root_is_created_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".cowork").join("tasks");
        let p = FsTaskProvider::new(root.clone(), RootCreation::Always);
        p.create(draft("The first", "deck")).unwrap();
        assert!(root.is_dir(), ".cowork/tasks is ours to create");
    }

    #[test]
    fn resolve_refuses_a_damaged_card_and_leaves_the_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        // project and created are missing — the card is "damaged", not discarded.
        let text = "---\nid: 01BROKEN\ntitle: Somebody's note\n---\nsomebody else's text\n";
        let path = dir.path().join("01BROKEN-note.md");
        std::fs::write(&path, text).unwrap();
        let before = std::fs::read(&path).unwrap();

        let p = provider(dir.path());
        match p.resolve("01BROKEN") {
            Err(TaskError::Damaged(reported_path)) => {
                assert!(reported_path.contains("01BROKEN-note.md"), "got {reported_path}");
            }
            other => panic!("expected Damaged, got {other:?}"),
        }

        let after = std::fs::read(&path).unwrap();
        assert_eq!(before, after, "a damaged card must never be rewritten");
    }

    #[test]
    fn resolve_edits_frontmatter_in_place_and_keeps_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let text = "---\n\
id: 01K1\n\
title: A real card\n\
kind: task\n\
status: open\n\
project: deck\n\
created: 2026-07-27T10:00:00Z\n\
origin: human\n\
tags: [inbox]\n\
aliases: [alt]\n\
---\n\
The body, unchanged.\n";
        let path = dir.path().join("01K1-real.md");
        std::fs::write(&path, text).unwrap();

        let p = provider(dir.path());
        let done = p.resolve("01K1").unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert!(done.resolved.is_some());

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("tags: [inbox]"), "unknown key must survive resolve: {after}");
        assert!(after.contains("aliases: [alt]"), "unknown key must survive resolve: {after}");
        assert!(after.contains("status: done"));
        assert!(after.ends_with("The body, unchanged.\n"), "body must be untouched: {after:?}");
    }

    #[test]
    fn capabilities_allow_everything_for_files() {
        let dir = tempfile::tempdir().unwrap();
        let caps = provider(dir.path()).capabilities();
        assert!(caps.can_create);
        assert!(caps.can_resolve);
        assert_eq!(caps.statuses, vec!["open".to_string(), "done".to_string()]);
    }
}
