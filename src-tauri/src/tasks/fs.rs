use crate::tasks::board::{self, BoardConfig};
use crate::tasks::frontmatter::{one_line, parse_card, render_card, set_step, slugify};
use crate::tasks::model::{Task, TaskDraft, TaskError};
use crate::tasks::provider::{ProviderCapabilities, TaskPatch, TaskProvider};
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
    board: BoardConfig,
    board_error: Option<String>,
}

impl FsTaskProvider {
    /// Reads the configuration beside the cards, creating the default when there
    /// is none. Once, at construction: `list` runs on every board tick and every
    /// sidebar count, and re-reading the file per call would put a filesystem
    /// round trip in front of each of them.
    pub fn new(root: PathBuf, creation: RootCreation) -> Self {
        // A root that does not exist yet is not a configuration problem: the
        // provider is constructed before `ensure_root` runs, so loading here
        // would try to write the default into a missing directory and report a
        // failure the person can do nothing about. The default applies until the
        // root exists, and the next construction writes the file.
        if !root.is_dir() {
            return Self { root, creation, board: BoardConfig::default_config(), board_error: None };
        }
        let loaded = board::load_or_create(&root);
        Self { root, creation, board: loaded.config, board_error: loaded.error }
    }

    /// For tests and for callers that already hold a configuration. Touches no
    /// file, so a test does not need a `board.json` on disk to describe a
    /// workflow.
    pub fn with_board(root: PathBuf, creation: RootCreation, board: BoardConfig) -> Self {
        Self { root, creation, board, board_error: None }
    }

    pub fn board(&self) -> &BoardConfig { &self.board }
    pub fn board_error(&self) -> Option<&str> { self.board_error.as_deref() }

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

    /// The one card with this id, refusing the two states we will not write
    /// into. Shared by `resolve` and `update` so the refusals cannot drift apart.
    fn writable_card(&self, id: &str) -> Result<Task, TaskError> {
        let cards = self.scan()?;
        let matches: Vec<&Task> = cards.iter().filter(|c| c.id == id).collect();
        match matches.len() {
            0 => Err(TaskError::NotFound(id.to_string())),
            n if n > 1 => Err(TaskError::Conflict(id.to_string())),
            _ => {
                let card = matches[0];
                // May well be an unrelated Obsidian note that merely has an
                // `id:` field. Refuse before touching the filesystem.
                if card.damaged.is_some() {
                    return Err(TaskError::Damaged(card.path.clone()));
                }
                Ok(card.clone())
            }
        }
    }
}

impl TaskProvider for FsTaskProvider {
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            can_create: true,
            can_resolve: true,
            statuses: self.board.step_ids(),
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
            status: self.board.initial_step().clone(),
            project: draft.project,
            created: Self::now_iso(),
            resolved: None,
            origin: draft.origin,
            session: draft.session,
            body: draft.body,
            path: path.to_string_lossy().to_string(),
            damaged: None,
            conflict: false,
            labels: Vec::new(),
        };
        self.write_atomic(&path, &render_card(&card))?;
        Ok(card)
    }

    fn resolve(&self, id: &str) -> Result<Task, TaskError> {
        let mut card = self.writable_card(id)?;
        let path = PathBuf::from(&card.path);
        let step = self.board.first_terminal().clone();
        let resolved = Self::now_iso();
        // Edit the frontmatter in place rather than re-rendering the whole
        // card: `render_card` only knows nine keys, so closing a card that
        // also carries `tags:`, `aliases:`, or Dataview fields through it
        // would silently drop them.
        let text = std::fs::read_to_string(&path).map_err(|e| TaskError::Io(e.to_string()))?;
        let updated = set_step(&text, &step, Some(&resolved))
            .ok_or_else(|| TaskError::Io("the card has no frontmatter block".to_string()))?;
        self.write_atomic(&path, &updated)?;

        card.status = step;
        card.resolved = Some(resolved);
        card.conflict = false;
        Ok(card)
    }

    fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError> {
        if let Some(k) = &patch.kind {
            if !self.board.has_kind(k) {
                return Err(TaskError::UnknownKind(k.0.clone()));
            }
        }
        if let Some(s) = &patch.status {
            if !self.board.has_step(s) {
                return Err(TaskError::UnknownStep(s.0.clone()));
            }
        }
        let mut card = self.writable_card(id)?;
        let path = PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).map_err(|e| TaskError::Io(e.to_string()))?;

        // Frontmatter first, one `set_fields` pass, so a card carrying keys we do
        // not know keeps them.
        let mut fields: Vec<(&str, String)> = Vec::new();
        if let Some(t) = &patch.title {
            // The returned `Task` must match what landed on disk: both calls go
            // through the one shared `one_line`, so a caller never renders a
            // title the file does not contain until the next `list`.
            fields.push(("title", one_line(t)));
            card.title = one_line(t);
        }
        if let Some(k) = &patch.kind {
            fields.push(("kind", k.0.clone()));
            card.kind = k.clone();
        }
        if let Some(s) = &patch.status {
            // Keyed on the *transition*, not merely the destination: entering a
            // terminal step from a non-terminal one is a resolution and stamps;
            // leaving one for a non-terminal step is a reopening and clears.
            // Terminal-to-terminal or non-terminal-to-non-terminal is a plain
            // relabelling — `done` to `shipped`, or `todo` to `doing` — and must
            // leave `resolved` exactly as it was, or a rewrite that moves a
            // step's cards to a same-kind destination would silently erase or
            // refresh dates nobody asked to change.
            let was_terminal = self.board.is_terminal(&card.status);
            let now_terminal = self.board.is_terminal(s);
            let resolved = match (was_terminal, now_terminal) {
                (false, true) => Some(Self::now_iso()),
                (true, false) => None,
                _ => card.resolved.clone(),
            };
            fields.push(("status", s.0.clone()));
            // Empty clears it: `field()` treats an empty value as absent, and
            // `set_fields` cannot delete a line. But a plain relabelling
            // leaves `resolved` unchanged (the `_` arm above), so writing it
            // unconditionally would still push an empty `resolved: ` line
            // into a card that never had one — `card.resolved` here is still
            // the value *before* this patch, which is what makes the
            // comparison meaningful; only push when the transition actually
            // changes it.
            if resolved != card.resolved {
                fields.push(("resolved", resolved.clone().unwrap_or_default()));
            }
            card.status = s.clone();
            card.resolved = resolved;
        }

        let mut updated = text;
        if !fields.is_empty() {
            let refs: Vec<(&str, &str)> =
                fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
            updated = crate::tasks::frontmatter::set_fields(&updated, &refs)
                .ok_or_else(|| TaskError::Io("the card has no frontmatter block".to_string()))?;
        }
        if let Some(b) = &patch.body {
            updated = crate::tasks::frontmatter::replace_body(&updated, b)
                .ok_or_else(|| TaskError::Io("the card has no frontmatter block".to_string()))?;
            card.body = b.clone();
        }
        self.write_atomic(&path, &updated)?;
        card.conflict = false;
        Ok(card)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::board::{KindId, StepId};
    use crate::tasks::model::TaskOrigin;
    use crate::tasks::provider::TaskProvider;

    fn draft(title: &str, project: &str) -> TaskDraft {
        TaskDraft {
            title: title.to_string(),
            kind: KindId("bug".into()),
            body: "body".to_string(),
            project: project.to_string(),
            origin: TaskOrigin::Human,
            session: None,
        }
    }

    fn provider(dir: &std::path::Path) -> FsTaskProvider {
        FsTaskProvider::new(dir.to_path_buf(), RootCreation::Never)
    }

    // The steps `provider()` above ends up with: its tempdir has no board.json,
    // so `new` writes the default and reads it back. Asked of the configuration
    // rather than spelled out, because which ids those are is
    // `default_config`'s business and not this module's.
    fn initial() -> StepId { BoardConfig::default_config().initial_step().clone() }
    fn terminal() -> StepId { BoardConfig::default_config().first_terminal().clone() }

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
        assert_eq!(made.status, initial(), "the default configuration's first step");
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
        assert_eq!(done.status, terminal());
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

        // `board.json` is expected beside the cards — the provider's constructor
        // wrote it — so the question this asks is about everything *else*.
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != board::BOARD_FILE)
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
    fn a_provider_built_on_a_missing_root_reports_no_configuration_error() {
        // `provider_for` constructs the provider before `ensure_root` runs, so
        // on a brand-new external root there is nowhere yet to write the
        // default `board.json`. That absence must not surface as an error the
        // person can do nothing about — the default configuration applies
        // until the root exists, and the next construction writes the file.
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("not-here-yet");
        let p = FsTaskProvider::new(absent, RootCreation::Never);
        assert_eq!(p.board_error(), None);
        assert_eq!(p.board().step_ids(), vec!["open", "done"]);
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
        assert_eq!(done.status, terminal());
        assert!(done.resolved.is_some());

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("tags: [inbox]"), "unknown key must survive resolve: {after}");
        assert!(after.contains("aliases: [alt]"), "unknown key must survive resolve: {after}");
        assert!(after.contains("status: done"));
        assert!(after.ends_with("The body, unchanged.\n"), "body must be untouched: {after:?}");
    }

    #[test]
    fn resolve_moves_a_card_to_the_first_terminal_step_of_the_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"shipped","label":"Shipped","terminal":true}],
                "kinds":[{"id":"task","label":"Task"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::with_board(dir.path().to_path_buf(), RootCreation::Always, cfg);
        let card = p.create(TaskDraft {
            title: "T".into(), kind: KindId("task".into()), body: String::new(),
            project: "proj".into(), origin: TaskOrigin::Human, session: None,
        }).unwrap();
        assert_eq!(card.status.as_str(), "todo", "a new card lands in the first non-terminal step");
        let closed = p.resolve(&card.id).unwrap();
        assert_eq!(closed.status.as_str(), "shipped");
        assert!(closed.resolved.is_some());
    }

    #[test]
    fn capabilities_report_the_configured_steps_in_board_order() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"z","label":"Z","terminal":true}],
                "kinds":[{"id":"k","label":"K"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::with_board(dir.path().to_path_buf(), RootCreation::Always, cfg);
        assert_eq!(p.capabilities().statuses, vec!["a", "b", "z"]);
    }

    #[test]
    fn a_provider_built_without_a_configuration_reads_the_one_beside_the_cards() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(crate::tasks::board::BOARD_FILE),
            r#"{"steps":[{"id":"only","label":"Only","terminal":true}],"kinds":[{"id":"k","label":"K"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::new(dir.path().to_path_buf(), RootCreation::Always);
        assert_eq!(p.board().step_ids(), vec!["only"]);
        assert_eq!(p.board_error(), None);
    }

    #[test]
    fn capabilities_allow_everything_for_files() {
        let dir = tempfile::tempdir().unwrap();
        let caps = provider(dir.path()).capabilities();
        assert!(caps.can_create);
        assert!(caps.can_resolve);
        assert_eq!(caps.statuses, BoardConfig::default_config().step_ids());
    }

    fn three_step_provider(dir: &std::path::Path) -> FsTaskProvider {
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"todo","label":"To do"},{"id":"doing","label":"Doing","working":true},
                         {"id":"done","label":"Done","terminal":true}],
                "kinds":[{"id":"bug","label":"Bug"},{"id":"task","label":"Task"}]}"#,
        ).unwrap();
        FsTaskProvider::with_board(dir.to_path_buf(), RootCreation::Always, cfg)
    }

    fn a_card(p: &FsTaskProvider) -> Task {
        p.create(TaskDraft {
            title: "Original".into(), kind: KindId("task".into()), body: "Body.\n".into(),
            project: "proj".into(), origin: TaskOrigin::Human, session: None,
        }).unwrap()
    }

    #[test]
    fn update_writes_only_the_fields_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let after = p.update(&card.id, TaskPatch {
            title: Some("Renamed".into()), kind: None, status: None, body: None,
        }).unwrap();
        assert_eq!(after.title, "Renamed");
        assert_eq!(after.kind.as_str(), "task", "an untouched field is untouched");
        assert_eq!(after.status.as_str(), "todo");
        assert_eq!(after.body, "Body.\n");
    }

    #[test]
    fn a_title_and_kind_patch_both_land_on_disk_with_the_title_flattened() {
        // A returned `Task` is not evidence of a write — only a fresh read of
        // the file is. A multi-line title covers two things at once: that the
        // title actually reached the frontmatter block, and that what reached
        // it is flattened the same way the returned `Task` reports it, through
        // the one `frontmatter::one_line` both call.
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let after = p.update(&card.id, TaskPatch {
            title: Some("Bug:\nthe pill\nblinks".into()),
            kind: Some(KindId("bug".into())),
            status: None, body: None,
        }).unwrap();
        assert_eq!(after.title, "Bug: the pill blinks");
        assert_eq!(after.kind.as_str(), "bug");

        let text = std::fs::read_to_string(&card.path).unwrap();
        let reread = crate::tasks::frontmatter::parse_card(&text, &card.path).expect("still a card");
        assert_eq!(reread.title, "Bug: the pill blinks", "{text}");
        assert_eq!(reread.kind.as_str(), "bug", "{text}");
    }

    #[test]
    fn update_never_renames_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let before = card.path.clone();
        let after = p.update(&card.id, TaskPatch {
            title: Some("A completely different title".into()),
            kind: None, status: None, body: None,
        }).unwrap();
        // The id is the identity. A rename would break Obsidian links and make
        // the watcher report a delete plus a create instead of an edit.
        assert_eq!(after.path, before);
        assert!(std::path::Path::new(&before).exists());
    }

    #[test]
    fn update_preserves_frontmatter_keys_it_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let path = std::path::PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("---\nid:", "---\ntags: [inbox]\nid:")).unwrap();
        p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("doing".into())), body: None }).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("tags: [inbox]"), "{after}");
        // The status write itself has to land on disk, not merely on the
        // returned `Task` — that struct is assembled in memory regardless of
        // whether the frontmatter write actually happened.
        assert!(after.contains("status: doing"), "{after}");
        // `todo` -> `doing` is non-terminal to non-terminal: a plain move,
        // not a resolution or a reopening, so `resolved` must not appear at
        // all — not even as an empty `resolved: ` line. A fresh card never
        // had the key, and this patch must not be the one that adds it.
        assert!(!after.contains("resolved"), "a plain move must not add a resolved line: {after}");
    }

    #[test]
    fn a_step_only_patch_moves_the_card_and_stamps_or_clears_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let closed = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("done".into())), body: None }).unwrap();
        assert!(closed.resolved.is_some(), "a terminal step stamps when");
        // The returned `Task` is assembled in memory regardless of whether the
        // `resolved` write actually reached the file — only a fresh read proves
        // the stamp landed on disk, not just in the struct handed back.
        let on_disk = std::fs::read_to_string(&card.path).unwrap();
        assert!(on_disk.contains("resolved: "), "{on_disk}");

        let back = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("todo".into())), body: None }).unwrap();
        assert_eq!(back.resolved, None, "moving back out clears it");
        let on_disk = std::fs::read_to_string(&card.path).unwrap();
        let reread = crate::tasks::frontmatter::parse_card(&on_disk, &card.path).expect("still a card");
        assert_eq!(reread.resolved, None, "the clear must land on disk too: {on_disk}");
    }

    #[test]
    fn update_rewrites_the_body_only_when_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let after = p.update(&card.id, TaskPatch { title: None, kind: None, status: None,
            body: Some("Replaced.\n".into()) }).unwrap();
        assert_eq!(after.body, "Replaced.\n");
        let on_disk = std::fs::read_to_string(&card.path).unwrap();
        assert!(on_disk.contains("Replaced.\n"), "{on_disk}");
        assert!(!on_disk.contains("Body.\n"));
    }

    #[test]
    fn a_body_only_patch_round_trips_byte_for_byte_on_the_next_read() {
        // The `Task` `update` returns is not evidence of what landed on disk:
        // `update` assigns `card.body` from the patch directly, without re-reading
        // the file. Only a fresh parse of the bytes on disk proves the write itself
        // is exact — in particular, that no separator blank line was inserted
        // between the frontmatter block and the body, which `split_frontmatter`
        // would not strip back out on the next read.
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        p.update(&card.id, TaskPatch { title: None, kind: None, status: None,
            body: Some("Replaced.\n".into()) }).unwrap();

        let text = std::fs::read_to_string(&card.path).unwrap();
        let reread = crate::tasks::frontmatter::parse_card(&text, &card.path).expect("still a card");
        assert_eq!(reread.body, "Replaced.\n", "a stray leading blank line survived: {text:?}");
    }

    #[test]
    fn moving_between_two_terminal_steps_preserves_resolved_byte_for_byte() {
        // Review round 1, Important #2: `resolved` must reflect the transition,
        // not merely the destination — a terminal-to-terminal move is a
        // relabelling, not a fresh resolution, and must not restamp.
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::tasks::board::parse(
            r#"{"steps":[{"id":"todo","label":"To do"},
                         {"id":"done","label":"Done","terminal":true},
                         {"id":"shipped","label":"Shipped","terminal":true}],
                "kinds":[{"id":"task","label":"Task"}]}"#,
        ).unwrap();
        let p = FsTaskProvider::with_board(dir.path().to_path_buf(), RootCreation::Always, cfg);
        let card = p.create(TaskDraft {
            title: "T".into(), kind: KindId("task".into()), body: String::new(),
            project: "proj".into(), origin: TaskOrigin::Human, session: None,
        }).unwrap();
        p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("done".into())), body: None }).unwrap();

        // Backdate the stamp on disk so a restamp (which would use "now") is
        // distinguishable from a preserved value, regardless of test timing.
        let path = std::path::PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).unwrap();
        let old_line = text.lines().find(|l| l.starts_with("resolved:")).expect("stamped").to_string();
        std::fs::write(&path, text.replace(&old_line, "resolved: 2020-01-01T00:00:00Z")).unwrap();

        let moved = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("shipped".into())), body: None }).unwrap();
        assert_eq!(
            moved.resolved.as_deref(), Some("2020-01-01T00:00:00Z"),
            "moving between two terminal steps must not restamp",
        );
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("resolved: 2020-01-01T00:00:00Z"), "{on_disk}");
    }

    #[test]
    fn update_refuses_a_damaged_card() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        // A card with an `id` and nothing else may be an ordinary vault note.
        std::fs::write(dir.path().join("note.md"), "---\nid: 01ABC\n---\nA note.\n").unwrap();
        let e = p.update("01ABC", TaskPatch { title: Some("Mine now".into()),
            kind: None, status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::Damaged(_)), "{e}");
    }

    #[test]
    fn update_refuses_a_conflicting_id() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let text = std::fs::read_to_string(&card.path).unwrap();
        std::fs::write(dir.path().join("copy.md"), text).unwrap();
        let e = p.update(&card.id, TaskPatch { title: Some("X".into()),
            kind: None, status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::Conflict(_)), "{e}");
    }

    #[test]
    fn update_refuses_a_step_the_configuration_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let e = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("invented".into())), body: None }).unwrap_err();
        assert!(matches!(e, TaskError::UnknownStep(ref s) if s == "invented"), "{e}");
    }

    #[test]
    fn update_refuses_a_kind_the_configuration_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let e = p.update(&card.id, TaskPatch { title: None, kind: Some(KindId("chore".into())),
            status: None, body: None }).unwrap_err();
        assert!(matches!(e, TaskError::UnknownKind(ref s) if s == "chore"), "{e}");
    }

    #[test]
    fn update_accepts_a_card_currently_sitting_in_an_unknown_step() {
        // The whole point of the unknown-step column: the card is alive, and the
        // modal is how it gets out.
        let dir = tempfile::tempdir().unwrap();
        let p = three_step_provider(dir.path());
        let card = a_card(&p);
        let path = std::path::PathBuf::from(&card.path);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("status: todo", "status: legacy")).unwrap();
        let after = p.update(&card.id, TaskPatch { title: None, kind: None,
            status: Some(StepId("todo".into())), body: None }).unwrap();
        assert_eq!(after.status.as_str(), "todo");
    }
}
