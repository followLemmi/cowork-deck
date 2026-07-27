use crate::tasks::frontmatter::{parse_card, render_card, slugify};
use crate::tasks::model::{Task, TaskDraft, TaskError, TaskStatus};
use crate::tasks::provider::{ProviderCapabilities, TaskProvider};
use std::path::{Path, PathBuf};

pub struct FsTaskProvider {
    root: PathBuf,
    /// True only for the in-project `.cowork/tasks` root, which is ours to
    /// create. An arbitrary path the user typed is never created silently — a
    /// typo must surface as an error, not as an empty new folder.
    create_root: bool,
}

impl FsTaskProvider {
    pub fn new(root: PathBuf, create_root: bool) -> Self {
        Self { root, create_root }
    }

    fn ensure_root(&self) -> Result<(), TaskError> {
        if self.root.is_dir() {
            return Ok(());
        }
        if self.create_root {
            std::fs::create_dir_all(&self.root).map_err(|e| TaskError::Io(e.to_string()))?;
            return Ok(());
        }
        Err(TaskError::RootMissing(self.root.to_string_lossy().to_string()))
    }

    /// Every card in the root, unfiltered, with `conflict` already set. One
    /// unreadable entry is skipped, never fatal: aborting the scan would hide
    /// every card that sorts after the bad one.
    fn scan(&self) -> Result<Vec<Task>, TaskError> {
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
                let mut card = matches[0].clone();
                card.status = TaskStatus::Done;
                card.resolved = Some(Self::now_iso());
                card.conflict = false;
                let path = PathBuf::from(&card.path);
                self.write_atomic(&path, &render_card(&card))?;
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
            body: "тело".to_string(),
            project: project.to_string(),
            origin: TaskOrigin::Human,
            session: None,
        }
    }

    fn provider(dir: &std::path::Path) -> FsTaskProvider {
        FsTaskProvider::new(dir.to_path_buf(), false)
    }

    #[test]
    fn create_then_list_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let made = p.create(draft("Пилюля мигает", "deck")).unwrap();
        assert_eq!(made.status, TaskStatus::Open);
        assert!(!made.created.is_empty());

        let all = p.list("deck").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, made.id);
        assert_eq!(all[0].title, "Пилюля мигает");
        assert_eq!(all[0].body.trim(), "тело");
    }

    #[test]
    fn filename_carries_id_and_slug() {
        let dir = tempfile::tempdir().unwrap();
        let made = provider(dir.path()).create(draft("Баг: пилюля мигает", "deck")).unwrap();
        let name = std::path::Path::new(&made.path).file_name().unwrap().to_string_lossy();
        assert!(name.starts_with(&made.id), "got {name}");
        assert!(name.ends_with("-баг-пилюля-мигает.md"), "got {name}");
    }

    #[test]
    fn resolve_finds_the_card_after_the_file_was_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let made = p.create(draft("Переименуй меня", "deck")).unwrap();

        // Что и делает человек в Obsidian в первый же день.
        let renamed = dir.path().join("Человеческое имя.md");
        std::fs::rename(&made.path, &renamed).unwrap();

        let done = p.resolve(&made.id).unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert!(done.resolved.is_some(), "resolved timestamp is needed to sort the done column");
        assert_eq!(
            std::path::Path::new(&done.path).file_name().unwrap(),
            std::ffi::OsStr::new("Человеческое имя.md"),
            "resolve must write back to the renamed file, not recreate the old one"
        );
        assert_eq!(p.list("deck").unwrap().len(), 1, "no duplicate was left behind");
    }

    #[test]
    fn ordinary_notes_and_subdirectories_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Заметка.md"), "# просто заметка\n").unwrap();
        std::fs::write(dir.path().join("readme.txt"), "не markdown\n").unwrap();
        std::fs::create_dir(dir.path().join("Архив")).unwrap();
        std::fs::write(
            dir.path().join("Архив/скрытая.md"),
            "---\nid: 01DEEP\ntitle: t\nstatus: open\nproject: deck\ncreated: c\n---\n",
        )
        .unwrap();

        let p = provider(dir.path());
        p.create(draft("Настоящая", "deck")).unwrap();

        let all = p.list("deck").unwrap();
        assert_eq!(all.len(), 1, "only the real card; scan is non-recursive");
        assert_eq!(all[0].title, "Настоящая");
    }

    #[test]
    fn cards_of_other_projects_are_filtered_out_but_damaged_ones_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        p.create(draft("Наша", "deck")).unwrap();
        p.create(draft("Чужая", "other-project")).unwrap();
        // id есть, project нет → повреждена, и должна остаться видимой.
        std::fs::write(
            dir.path().join("01BROKEN-x.md"),
            "---\nid: 01BROKEN\ntitle: Битая\n---\nтело\n",
        )
        .unwrap();

        let ours = p.list("deck").unwrap();
        let titles: Vec<&str> = ours.iter().map(|t| t.title.as_str()).collect();
        assert!(titles.contains(&"Наша"));
        assert!(titles.contains(&"Битая"), "a damaged card must never be filtered away");
        assert!(!titles.contains(&"Чужая"));
    }

    #[test]
    fn duplicate_ids_are_flagged_and_resolve_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let card = "---\nid: 01DUP\ntitle: Копия\nkind: task\nstatus: open\nproject: deck\ncreated: c\norigin: human\n---\n";
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
    // Не проверяет саму атомарность записи: наблюдать промежуточное состояние
    // (файл-темп существует, целевой ещё не создан) можно только вставкой
    // сбоя, а её здесь нет. Что реально проверено — temp+rename не оставляет
    // мусора после успешной записи, и что даже уцелевший `.tmp`-файл никогда
    // не читается как карточка. Это второе — структурное свойство: скан
    // требует расширение `.md`, так что наблюдатель (watcher) не может
    // увидеть недописанную карточку в принципе, не благодаря этому тесту.
    fn write_leaves_no_temp_litter_and_temp_files_are_not_cards() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        p.create(draft("Атомарная", "deck")).unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 1, "temp file must be gone after rename: {names:?}");
        assert!(names[0].ends_with(".md"));

        // Даже если временный файл переживёт краш, карточкой он не станет.
        std::fs::write(dir.path().join(".01TMP.tmp"), "---\nid: 01TMP\n---\n").unwrap();
        assert_eq!(p.list("deck").unwrap().len(), 1);
    }

    #[test]
    fn missing_root_reports_the_path_instead_of_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("нет-такого");
        let p = FsTaskProvider::new(absent.clone(), false);
        match p.list("deck") {
            Err(TaskError::RootMissing(path)) => assert!(path.contains("нет-такого")),
            other => panic!("expected RootMissing, got {other:?}"),
        }
        assert!(!absent.exists(), "an arbitrary user path must never be created silently");
    }

    #[test]
    fn in_project_root_is_created_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".cowork").join("tasks");
        let p = FsTaskProvider::new(root.clone(), true);
        p.create(draft("Первая", "deck")).unwrap();
        assert!(root.is_dir(), ".cowork/tasks is ours to create");
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
