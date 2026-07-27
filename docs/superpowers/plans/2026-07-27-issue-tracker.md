# Встроенный трекер задач — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Встроить в cowork-deck локальный трекер задач: карточки-markdown за портом `TaskProvider`, вид «Доска», запуск сессии из карточки и CLI, которым сессия оформляет тикет сама.

**Architecture:** Файлы — источник правды, но UI знает только IPC. Новый standalone-модуль `tasks/` в новом lib-таргете крейта (чтобы его линковал и главный бинарь, и CLI `cowork_task` — один формат, один писатель кода). Корень задаётся на воркспейс: `.cowork/tasks/` внутри проекта либо произвольный каталог. «В работе» не хранится, а выводится из живых сессий.

**Tech Stack:** Rust (Tauri v2, `notify`, `ulid`, `chrono`, `serde`), TypeScript (vanilla, без фреймворка), vitest, cargo test.

**Спека:** `docs/superpowers/specs/2026-07-27-issue-tracker-design.md` — читай её перед началом, план не дублирует обоснования решений.

## Global Constraints

- **Никогда `innerHTML` с данными пользователя или агента.** Заголовки и тела карточек приходят из файлов; DOM строить через `createElement` + `textContent`. (Ревью уже ловило XSS в `renderList`.)
- **Никакой анимации `box-shadow` / `filter` с `infinite`.** Индикатор «в работе» — только `transform`/`opacity`. (Ревью: бесконечная анимация тени вешала весь WindowServer.)
- **Не `unwrap()` на данных с диска в фоновых циклах.** Паника в фоновом таске — тихая смерть без следов в UI.
- **Скан каталога не прерывать на битой записи.** В цикле по `read_dir` — `match entry { Ok(e) => …, Err(_) => continue }`, не `entry.ok()?`.
- **Каждый асинхронный вызов в опросе — в своём `try/catch`.** Одна упавшая IPC не должна ронять весь тик.
- **Токены дизайн-системы сверять по `:root` в `src/styles.css`.** Существующие: `--st-idle --st-working --st-waiting --st-ended --st-error`, `--bg-app --bg-panel --bg-raised`, `--fg --fg-muted --fg-subtle`, `--border --border-strong`, `--accent --accent-weak`, `--sp-1..4`, `--r-sm --r-md`, `--fs-xs --fs-sm --fs-base`, `--dur-1 --dur-2`, `--ease`, `--focus-ring`. Новых токенов не вводить.
- **Модалки только свои** (`src/modal.ts`, `src/forms.ts`). `window.prompt/confirm/alert` в webview Tauri возвращают null молча.
- **`<label>` только для одиночного контрола.** Поле с несколькими кнопками (выбор `kind`) в `<label>` не оборачивать.
- **Гейт задачи = `npm test` И `npm run build` И `cargo test`.** Vitest идёт через esbuild и не проверяет типы; красный `tsc` за зелёными юнит-тестами не видно.
- **UI-строки русские**, в тон существующим (`готов`, `работает`, `ждёт ввода`).
- **Коммиты** — conventional commits со скоупом-номером issue, как в истории репозитория (`feat(#36): …`). Номер задачи указан под её заголовком. Тело на английском.
- **Epic:** #48 — зонтичная задача; issues задач #36–#47.

---

### Task 1: lib-таргет, модель задачи и парсер frontmatter

**Issue:** #36

Фундамент: чистые типы и формат карточки, без единого обращения к диску. Крейту нужен lib-таргет, потому что CLI из Task 5 обязан линковать **этот же** код формата, а не иметь свою реализацию.

**Files:**
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/tasks/mod.rs`
- Create: `src-tauri/src/tasks/model.rs`
- Create: `src-tauri/src/tasks/frontmatter.rs`
- Modify: `src-tauri/Cargo.toml` (секция `[lib]`)

**Interfaces:**
- Consumes: ничего.
- Produces: `cowork_deck::tasks::model::{Task, TaskDraft, TaskKind, TaskStatus, TaskOrigin, TaskError}`, `cowork_deck::tasks::frontmatter::{parse_card, render_card, slugify}`.

- [ ] **Step 1: Объявить lib-таргет**

`src-tauri/Cargo.toml` — добавить сразу после `[[bin]]`-секций:

```toml
[lib]
name = "cowork_deck"
path = "src/lib.rs"
```

`src-tauri/src/lib.rs`:

```rust
//! Library surface of cowork-deck. Deliberately minimal: it exposes only the
//! self-contained `tasks` module, so both the Tauri binary and the
//! `cowork_task` CLI link one implementation of the card format.
//!
//! `tasks` must not depend on `model`/`store`/`pty` — those stay private to the
//! main binary, which keeps declaring them with `mod`.
pub mod tasks;
```

`src-tauri/src/tasks/mod.rs`:

```rust
pub mod frontmatter;
pub mod model;
```

- [ ] **Step 2: Написать падающий тест на парсер**

Создать `src-tauri/src/tasks/frontmatter.rs` с одним только тест-модулем:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::{TaskKind, TaskOrigin, TaskStatus};

    const VALID: &str = "---\n\
id: 01K1B7QW9XZ3M4N5P6R7S8T9V0\n\
title: Пилюля мигает при переключении\n\
kind: bug\n\
status: open\n\
project: cowork-deck\n\
created: 2026-07-27T13:20:11Z\n\
origin: session\n\
session: a3f1c2\n\
---\n\
Репро: три воркспейса, Cmd+2.\n";

    #[test]
    fn parses_a_valid_card() {
        let card = parse_card(VALID, "/r/01K1-pill.md").expect("card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert_eq!(card.title, "Пилюля мигает при переключении");
        assert_eq!(card.kind, TaskKind::Bug);
        assert_eq!(card.status, TaskStatus::Open);
        assert_eq!(card.project, "cowork-deck");
        assert_eq!(card.origin, TaskOrigin::Session);
        assert_eq!(card.session.as_deref(), Some("a3f1c2"));
        assert_eq!(card.body.trim(), "Репро: три воркспейса, Cmd+2.");
        assert!(card.damaged.is_none());
    }

    #[test]
    fn a_file_without_id_is_not_a_card() {
        let text = "---\ntitle: Обычная заметка\n---\nтекст\n";
        assert!(parse_card(text, "/r/note.md").is_none());
    }

    #[test]
    fn a_file_without_frontmatter_is_not_a_card() {
        assert!(parse_card("# просто заметка\n", "/r/note.md").is_none());
    }

    #[test]
    fn id_present_but_broken_rest_is_damaged_not_dropped() {
        let text = "---\nid: 01K1B7QW9XZ3M4N5P6R7S8T9V0\nstatus: неизвестно\n---\nтело\n";
        let card = parse_card(text, "/r/01K1-x.md").expect("still a card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert!(card.damaged.is_some(), "must be flagged, never silently hidden");
        // Заголовок берётся из имени файла, чтобы карточку было видно на доске.
        assert_eq!(card.title, "01K1-x.md");
        assert_eq!(card.status, TaskStatus::Open);
    }

    #[test]
    fn title_may_contain_a_colon() {
        let text = "---\nid: 01K1\ntitle: Баг: пилюля мигает\nproject: p\n---\n";
        let card = parse_card(text, "/r/x.md").expect("card");
        assert_eq!(card.title, "Баг: пилюля мигает");
    }

    #[test]
    fn render_then_parse_round_trips() {
        let card = parse_card(VALID, "/r/01K1-pill.md").expect("card");
        let text = render_card(&card);
        let again = parse_card(&text, "/r/01K1-pill.md").expect("card");
        assert_eq!(again.id, card.id);
        assert_eq!(again.title, card.title);
        assert_eq!(again.kind, card.kind);
        assert_eq!(again.status, card.status);
        assert_eq!(again.project, card.project);
        assert_eq!(again.created, card.created);
        assert_eq!(again.origin, card.origin);
        assert_eq!(again.session, card.session);
        assert_eq!(again.body.trim(), card.body.trim());
    }

    #[test]
    fn slugify_keeps_cyrillic_and_strips_punctuation() {
        assert_eq!(slugify("Баг: пилюля мигает!"), "баг-пилюля-мигает");
        assert_eq!(slugify("  a//b  "), "a-b");
        assert_eq!(slugify(""), "task");
        assert_eq!(slugify(&"я".repeat(80)).chars().count(), 40);
    }
}
```

- [ ] **Step 3: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: FAIL — `cannot find function parse_card`, `cannot find crate tasks::model`.

- [ ] **Step 4: Написать модель**

`src-tauri/src/tasks/model.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind { Bug, Task, Idea }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Open, Done }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskOrigin { Human, Session }

/// A card as the UI sees it. `damaged` and `conflict` are presentation flags,
/// never written to disk: a card we cannot fully parse must still be visible,
/// because a silently vanished task is the worst possible tracker bug.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub project: String,
    pub created: String,
    pub resolved: Option<String>,
    pub origin: TaskOrigin,
    pub session: Option<String>,
    pub body: String,
    pub path: String,
    pub damaged: Option<String>,
    #[serde(default)]
    pub conflict: bool,
}

/// What a caller supplies to create a card; everything else is derived.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub title: String,
    pub kind: TaskKind,
    pub body: String,
    pub project: String,
    pub origin: TaskOrigin,
    pub session: Option<String>,
}

#[derive(Debug)]
pub enum TaskError {
    NotConfigured,
    RootMissing(String),
    Io(String),
    NotFound(String),
    Conflict(String),
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskError::NotConfigured => write!(f, "трекер не настроен для этого пространства"),
            TaskError::RootMissing(p) => write!(f, "каталог задач недоступен: {p}"),
            TaskError::Io(e) => write!(f, "ошибка файловой системы: {e}"),
            TaskError::NotFound(id) => write!(f, "карточка не найдена: {id}"),
            TaskError::Conflict(id) => {
                write!(f, "несколько файлов с одним id ({id}) — исправьте вручную")
            }
        }
    }
}
```

- [ ] **Step 5: Написать парсер**

Дописать в начало `src-tauri/src/tasks/frontmatter.rs` (перед `mod tests`):

```rust
use crate::tasks::model::{Task, TaskKind, TaskOrigin, TaskStatus};

const MAX_SLUG: usize = 40;

/// Split `---\n…\n---\n<body>` into the frontmatter block and the body.
fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let head = &rest[..end];
    let after = &rest[end + 4..];
    let body = after.strip_prefix('\n').or_else(|| after.strip_prefix("\r\n")).unwrap_or(after);
    Some((head, body))
}

fn field<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    for line in head.lines() {
        // Split on the FIRST colon only: titles legitimately contain colons.
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.trim() == key {
            let v = v.trim();
            return if v.is_empty() { None } else { Some(v) };
        }
    }
    None
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Parse a file into a card. Returns `None` when the file is not a card at all
/// (no frontmatter, or no `id`) — that is the condition for coexisting with an
/// Obsidian vault full of ordinary notes. When `id` parses but something else
/// does not, the card comes back with `damaged` set instead.
pub fn parse_card(text: &str, path: &str) -> Option<Task> {
    let (head, body) = split_frontmatter(text)?;
    let id = field(head, "id")?.to_string();

    let mut damaged: Option<String> = None;
    let mut damage = |msg: &str| {
        if damaged.is_none() {
            damaged = Some(msg.to_string());
        }
    };

    let title = match field(head, "title") {
        Some(t) => t.to_string(),
        None => {
            damage("нет поля title");
            file_name(path)
        }
    };

    let kind = match field(head, "kind") {
        None => TaskKind::Task,
        Some("bug") => TaskKind::Bug,
        Some("task") => TaskKind::Task,
        Some("idea") => TaskKind::Idea,
        Some(_) => { damage("неизвестный kind"); TaskKind::Task }
    };

    let status = match field(head, "status") {
        Some("open") => TaskStatus::Open,
        Some("done") => TaskStatus::Done,
        None => { damage("нет поля status"); TaskStatus::Open }
        Some(_) => { damage("неизвестный status"); TaskStatus::Open }
    };

    let project = match field(head, "project") {
        Some(p) => p.to_string(),
        None => { damage("нет поля project"); String::new() }
    };

    let created = match field(head, "created") {
        Some(c) => c.to_string(),
        None => { damage("нет поля created"); String::new() }
    };

    let origin = match field(head, "origin") {
        Some("human") => TaskOrigin::Human,
        Some("session") => TaskOrigin::Session,
        None => TaskOrigin::Human,
        Some(_) => { damage("неизвестный origin"); TaskOrigin::Human }
    };

    Some(Task {
        id,
        title,
        kind,
        status,
        project,
        created,
        resolved: field(head, "resolved").map(str::to_string),
        origin,
        session: field(head, "session").map(str::to_string),
        body: body.to_string(),
        path: path.to_string(),
        damaged,
        conflict: false,
    })
}

fn kind_str(k: TaskKind) -> &'static str {
    match k { TaskKind::Bug => "bug", TaskKind::Task => "task", TaskKind::Idea => "idea" }
}
fn status_str(s: TaskStatus) -> &'static str {
    match s { TaskStatus::Open => "open", TaskStatus::Done => "done" }
}
fn origin_str(o: TaskOrigin) -> &'static str {
    match o { TaskOrigin::Human => "human", TaskOrigin::Session => "session" }
}

/// Serialize a card back to markdown. Single-line fields are flattened so a
/// multi-line title can never break the frontmatter block.
pub fn render_card(t: &Task) -> String {
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", one_line(&t.id)));
    out.push_str(&format!("title: {}\n", one_line(&t.title)));
    out.push_str(&format!("kind: {}\n", kind_str(t.kind)));
    out.push_str(&format!("status: {}\n", status_str(t.status)));
    out.push_str(&format!("project: {}\n", one_line(&t.project)));
    out.push_str(&format!("created: {}\n", one_line(&t.created)));
    if let Some(r) = &t.resolved {
        out.push_str(&format!("resolved: {}\n", one_line(r)));
    }
    out.push_str(&format!("origin: {}\n", origin_str(t.origin)));
    if let Some(s) = &t.session {
        out.push_str(&format!("session: {}\n", one_line(s)));
    }
    out.push_str("---\n");
    if !t.body.is_empty() {
        if !t.body.starts_with('\n') { out.push('\n'); }
        out.push_str(&t.body);
        if !t.body.ends_with('\n') { out.push('\n'); }
    }
    out
}

/// Filename slug. Unicode-aware, so Russian titles stay readable instead of
/// collapsing to dashes; only alphanumerics survive, which also rules out every
/// character Windows forbids in a filename.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() { out.push(lc); }
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') { out.pop(); }
    let truncated: String = out.chars().take(MAX_SLUG).collect();
    let trimmed = truncated.trim_end_matches('-').to_string();
    if trimmed.is_empty() { "task".to_string() } else { trimmed }
}
```

- [ ] **Step 6: Запустить — должно пройти**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS, 7 тестов.

Заметь: `--lib` гоняет только новый lib-таргет. Существующие тесты бинаря — `cargo test --manifest-path src-tauri/Cargo.toml`, они должны остаться зелёными.

- [ ] **Step 7: Проверить, что бинарь не сломался**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — все существующие тесты (`main`, `listener`, `pty`, `store`, `model`, `commands`, `hooks`, `scheduler`).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/tasks/
git commit -m "feat(#36): card model and frontmatter parser behind a lib target

A file without frontmatter or without an id is not a card at all, so a
vault full of ordinary notes coexists with the backlog. A file that has
an id but is otherwise broken comes back flagged as damaged rather than
dropped — a silently vanished task is the worst tracker bug there is."
```

---

### Task 2: FsTaskProvider — трейт и файловая реализация

**Issue:** #37

**Files:**
- Create: `src-tauri/src/tasks/provider.rs`
- Create: `src-tauri/src/tasks/fs.rs`
- Modify: `src-tauri/src/tasks/mod.rs`
- Modify: `src-tauri/Cargo.toml` (`ulid`, dev-dep `tempfile`)

**Interfaces:**
- Consumes: `tasks::model::{Task, TaskDraft, TaskError, TaskStatus}`, `tasks::frontmatter::{parse_card, render_card, slugify}`.
- Produces: `tasks::provider::{TaskProvider, ProviderCapabilities}`, `tasks::fs::FsTaskProvider` с `FsTaskProvider::new(root: std::path::PathBuf, create_root: bool)`.

- [ ] **Step 1: Добавить зависимости**

`src-tauri/Cargo.toml` — в `[dependencies]`:

```toml
ulid = "3"
```

Версия и имя функции проверены на живом крейте: в `ulid` 3.x генератор — `Ulid::generate()`, **не** `Ulid::new()` (та была в 1.x). Результат — 26 символов, лексикографически монотонный во времени, на чём и держится сортировка карточек.

и новая секция в конце файла:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Написать падающие тесты**

`src-tauri/src/tasks/fs.rs` — сначала только тесты:

```rust
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
    fn no_partial_files_are_left_visible_and_temp_files_are_not_cards() {
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
```

- [ ] **Step 3: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: FAIL — `cannot find type FsTaskProvider`, `unresolved module tasks::provider`.

- [ ] **Step 4: Написать трейт**

`src-tauri/src/tasks/provider.rs`:

```rust
use crate::tasks::model::{Task, TaskDraft, TaskError};
use serde::{Deserialize, Serialize};

/// What a provider can actually do. Declared, never faked: `open → done` does
/// not map one-to-one onto Jira transitions, so the UI hides an action it is
/// told is unavailable instead of failing at call time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub can_create: bool,
    pub can_resolve: bool,
    pub statuses: Vec<String>,
}

pub trait TaskProvider {
    fn capabilities(&self) -> ProviderCapabilities;
    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError>;
    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError>;
    fn resolve(&self, id: &str) -> Result<Task, TaskError>;
}
```

- [ ] **Step 5: Написать файловую реализацию**

Дописать в начало `src-tauri/src/tasks/fs.rs` (перед `mod tests`):

```rust
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
```

Дописать в `src-tauri/src/tasks/mod.rs`:

```rust
pub mod fs;
pub mod provider;
```

- [ ] **Step 6: Запустить — должно пройти**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS, 17 тестов (7 из Task 1 + 10 новых).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/tasks/
git commit -m "feat(#37): file-backed provider behind the TaskProvider port

Cards resolve by id rather than by path, so renaming a note in a vault is
a legal operation. The scan is non-recursive, skips unreadable entries
instead of aborting, and writes go through a dotfile temp + rename so a
watcher can never observe a half-written card."
```

---

### Task 3: конфиг трекера на воркспейс и IPC-команды

**Issue:** #38

**Files:**
- Modify: `src-tauri/src/model.rs` (`Workspace`, новые `TrackerConfig`/`TrackerRoot`)
- Create: `src-tauri/src/tasks_cmd.rs`
- Modify: `src-tauri/src/main.rs` (`mod tasks_cmd;`, регистрация команд)
- Modify: `src/ipc.ts` (типы + обёртки)

**Interfaces:**
- Consumes: `tasks::fs::FsTaskProvider`, `tasks::provider::TaskProvider`, `tasks::model::*`, `commands::AppState`.
- Produces: Rust `crate::tasks_cmd::{tasks_list, tasks_create, tasks_resolve, tasks_capabilities, tasks_open_counts, resolve_root}`; TS `listTasks/createTask/resolveTask/taskCapabilities/taskOpenCounts` и типы `Task/TaskDraft/TrackerConfig/ProviderCapabilities` в `src/ipc.ts`.

- [ ] **Step 1: Написать падающий тест на конфиг и резолв корня**

Дописать в `#[cfg(test)] mod tests` в `src-tauri/src/model.rs`:

```rust
#[test]
fn workspace_without_tracker_still_deserializes() {
    // Настройки, записанные до этой фичи, должны читаться без потерь —
    // иначе первый же upsert усечёт файл пространств.
    // r##"…"## обязательно: внутри есть `"#` (из "#61afef"), и r#"…"# закрылся бы раньше времени.
    let old = r##"{"id":"w1","name":"deck","path":"/p","color":"#61afef"}"##;
    let ws: Workspace = serde_json::from_str(old).expect("old workspace must still parse");
    assert_eq!(ws.name, "deck");
    assert!(ws.tracker.is_none());
}

#[test]
fn tracker_config_round_trips_both_root_kinds() {
    let in_project = TrackerConfig {
        providers: vec![TrackerProvider::Fs { root: TrackerRoot::Project }],
    };
    let json = serde_json::to_string(&in_project).unwrap();
    let back: TrackerConfig = serde_json::from_str(&json).unwrap();
    assert!(matches!(back.providers[0], TrackerProvider::Fs { root: TrackerRoot::Project }));

    let external = TrackerConfig {
        providers: vec![TrackerProvider::Fs {
            root: TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
        }],
    };
    let json = serde_json::to_string(&external).unwrap();
    let back: TrackerConfig = serde_json::from_str(&json).unwrap();
    match &back.providers[0] {
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => assert_eq!(path, "/home/u/vault/Tasks"),
        other => panic!("wrong root: {other:?}"),
    }
}
```

Создать `src-tauri/src/tasks_cmd.rs` с одним тест-модулем:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{TrackerConfig, TrackerProvider, TrackerRoot, Workspace};

    fn ws(tracker: Option<TrackerConfig>) -> Workspace {
        Workspace {
            id: "w1".into(),
            name: "cowork-deck".into(),
            path: "/home/u/proj".into(),
            color: "#61afef".into(),
            tracker,
        }
    }

    #[test]
    fn project_root_lives_inside_the_workspace_and_is_ours_to_create() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Project }],
        }));
        let (root, create) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/proj/.cowork/tasks"));
        assert!(create);
    }

    #[test]
    fn external_root_is_used_verbatim_and_never_created() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Fs {
                root: TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
            }],
        }));
        let (root, create) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/Tasks"));
        assert!(!create);
    }

    #[test]
    fn no_tracker_is_a_legal_state_not_an_error() {
        assert!(resolve_root(&ws(None)).is_none());
        assert!(resolve_root(&ws(Some(TrackerConfig { providers: vec![] }))).is_none());
    }
}
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL — `Workspace has no field tracker`, `cannot find function resolve_root`.

- [ ] **Step 3: Расширить модель**

В `src-tauri/src/model.rs` заменить структуру `Workspace` и добавить типы конфига:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    /// Absent for every workspace created before the tracker existed, and for
    /// any workspace the user never configured. `default` is what keeps an old
    /// settings file readable — a failed read would let the next upsert
    /// truncate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<TrackerConfig>,
}

/// Per-workspace tracker configuration. A list of providers rather than a
/// single one, so GitHub/Jira arrive as an added element instead of a schema
/// rewrite. Tokens never live here — they belong in the system keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerConfig {
    #[serde(default)]
    pub providers: Vec<TrackerProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TrackerProvider {
    Fs { root: TrackerRoot },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TrackerRoot {
    /// `<workspace.path>/.cowork/tasks`, tracked in git like any other project file.
    Project,
    /// Any folder the user picked: a dedicated repo, an Obsidian vault, a synced dir.
    Path { path: String },
}
```

Затем найти все места, где `Workspace` конструируется в тестах внутри `src-tauri/`, и добавить `tracker: None`:

Run: `grep -rn "Workspace {" src-tauri/src/`
Ожидаемо: тесты в `commands.rs` и/или `store.rs`. Каждому конструктору добавить `tracker: None`.

- [ ] **Step 4: Написать команды**

`src-tauri/src/tasks_cmd.rs` — дописать перед `mod tests`:

```rust
//! IPC surface of the tracker. Resolves a workspace id to a provider and keeps
//! every path/config decision on this side, so the frontend never learns that
//! cards are files.
use crate::commands::AppState;
use crate::model::{TrackerProvider, TrackerRoot, Workspace};
use crate::tasks::fs::FsTaskProvider;
use crate::tasks::model::{Task, TaskDraft, TaskKind, TaskOrigin};
use serde::Deserialize;
use crate::tasks::provider::{ProviderCapabilities, TaskProvider};
use std::path::PathBuf;
use tauri::State;

/// The provider root for a workspace, plus whether we may create it.
/// `None` means "no tracker configured" — a legal, non-error state.
pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, bool)> {
    let cfg = ws.tracker.as_ref()?;
    let first = cfg.providers.first()?;
    match first {
        TrackerProvider::Fs { root: TrackerRoot::Project } => {
            Some((PathBuf::from(&ws.path).join(".cowork").join("tasks"), true))
        }
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => {
            Some((PathBuf::from(path), false))
        }
    }
}

fn workspace(state: &State<AppState>, id: &str) -> Result<Workspace, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    store
        .workspaces()
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("пространство не найдено: {id}"))
}

fn provider_for(ws: &Workspace) -> Result<FsTaskProvider, String> {
    let (root, create) = resolve_root(ws).ok_or_else(|| "not-configured".to_string())?;
    Ok(FsTaskProvider::new(root, create))
}

#[tauri::command]
pub fn tasks_capabilities(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Option<ProviderCapabilities>, String> {
    let ws = workspace(&state, &workspace_id)?;
    match provider_for(&ws) {
        Ok(p) => Ok(Some(p.capabilities())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn tasks_list(state: State<AppState>, workspace_id: String) -> Result<Vec<Task>, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    p.list(&ws.name).map_err(|e| e.to_string())
}

/// What the frontend may send. Deliberately NOT `tasks::model::TaskDraft`:
/// the internal model requires `project`/`origin`/`session`, which the caller
/// has no business supplying. Making `origin` inexpressible over IPC means a
/// draft cannot forge the "сессия" badge — the board's whole reason to trust it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDraftInput {
    pub title: String,
    pub kind: TaskKind,
    pub body: String,
}

#[tauri::command]
pub fn tasks_create(
    state: State<AppState>,
    workspace_id: String,
    draft: TaskDraftInput,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    // The project is always this workspace's name, so a shared root stays
    // sortable by project. Origin is always Human: the cowork_task CLI is the
    // only producer of session-filed cards, and it writes files directly.
    p.create(TaskDraft {
        title: draft.title,
        kind: draft.kind,
        body: draft.body,
        project: ws.name.clone(),
        origin: TaskOrigin::Human,
        session: None,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_resolve(
    state: State<AppState>,
    workspace_id: String,
    id: String,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    p.resolve(&id).map_err(|e| e.to_string())
}

/// Open-card count per workspace id, for the sidebar badges. One call instead of
/// one per workspace, and a workspace whose root is broken contributes 0 rather
/// than failing the whole map.
#[tauri::command]
pub fn tasks_open_counts(state: State<AppState>) -> Result<std::collections::HashMap<String, usize>, String> {
    let all = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces()
    };
    let mut out = std::collections::HashMap::new();
    for ws in all {
        let Ok(p) = provider_for(&ws) else { continue };
        let n = match p.list(&ws.name) {
            Ok(cards) => cards
                .iter()
                .filter(|c| matches!(c.status, crate::tasks::model::TaskStatus::Open))
                .count(),
            Err(_) => continue,
        };
        out.insert(ws.id.clone(), n);
    }
    Ok(out)
}
```

- [ ] **Step 5: Подключить модуль и команды**

`src-tauri/src/main.rs` — добавить объявления модулей после `mod commands;`:

```rust
mod tasks_cmd;
use cowork_deck::tasks;
```

и в `tauri::generate_handler![...]` добавить пять строк после `commands::scheduler_ready,`:

```rust
            tasks_cmd::tasks_list,
            tasks_cmd::tasks_create,
            tasks_cmd::tasks_resolve,
            tasks_cmd::tasks_capabilities,
            tasks_cmd::tasks_open_counts,
```

- [ ] **Step 6: Запустить — должно пройти**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — включая 2 новых теста в `model` и 3 в `tasks_cmd`.

- [ ] **Step 7: Добавить типы и обёртки во фронтенд**

В конец `src/ipc.ts`:

```ts
export type TaskKind = "bug" | "task" | "idea";
export type TaskStatus = "open" | "done";
export type TaskOrigin = "human" | "session";

export interface Task {
  id: string; title: string; kind: TaskKind; status: TaskStatus; project: string;
  created: string; resolved: string | null; origin: TaskOrigin; session: string | null;
  body: string; path: string;
  /** Причина, если карточку не удалось разобрать до конца. Показывается, не скрывается. */
  damaged: string | null;
  /** Больше одного файла с этим id. */
  conflict: boolean;
}
/** Что фронтенд может отправить. `project` и `origin` задаёт бэкенд и они
 *  сознательно не настраиваются отсюда — иначе карточку можно было бы
 *  выдать за созданную сессией. */
export interface TaskDraft { title: string; kind: TaskKind; body: string; }
export interface ProviderCapabilities { canCreate: boolean; canResolve: boolean; statuses: string[] }
export type TrackerRoot = { kind: "project" } | { kind: "path"; path: string };
export interface TrackerConfig { providers: { type: "fs"; root: TrackerRoot }[] }

export const listTasks = (workspaceId: string) => invoke<Task[]>("tasks_list", { workspaceId });
export const createTask = (workspaceId: string, draft: TaskDraft) =>
  invoke<Task>("tasks_create", { workspaceId, draft });
export const resolveTask = (workspaceId: string, id: string) =>
  invoke<Task>("tasks_resolve", { workspaceId, id });
export const taskCapabilities = (workspaceId: string) =>
  invoke<ProviderCapabilities | null>("tasks_capabilities", { workspaceId });
export const taskOpenCounts = () => invoke<Record<string, number>>("tasks_open_counts");
```

И расширить существующий `Workspace` в `src/ipc.ts` (строка 5):

```ts
export interface Workspace { id: string; name: string; path: string; color: string; tracker?: TrackerConfig | null; }
```

- [ ] **Step 8: Проверить типы и тесты**

Run: `npm run build && npm test`
Expected: сборка проходит, все существующие vitest-тесты зелёные.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/ src/ipc.ts
git commit -m "feat(#38): per-workspace tracker config and IPC commands

The storage root is the user's choice: the in-project .cowork/tasks (ours
to create) or any folder they point at — a dedicated repo, an Obsidian
vault — which is never created silently, so a typo surfaces as an error.
Workspace.tracker is serde-default so settings written before this
feature still deserialize instead of being truncated on the next upsert."
```

---

### Task 4: watcher каталога и событие `tasks://changed`

**Issue:** #39

**Files:**
- Create: `src-tauri/src/tasks/watch.rs`
- Modify: `src-tauri/src/tasks/mod.rs`
- Modify: `src-tauri/src/tasks_cmd.rs` (`tasks_watch_sync`)
- Modify: `src-tauri/src/main.rs` (`TaskWatchers` в `AppState`-соседи, регистрация команды)
- Modify: `src-tauri/src/commands.rs` (`AppState` получает `watchers`)
- Modify: `src-tauri/Cargo.toml` (`notify`)
- Modify: `src/ipc.ts` (`onTasksChanged`, `taskWatchSync`)

Watcher — это только ускорение. Доска в Task 8 всё равно опрашивает раз в 5 с, пока открыта, поэтому падение watcher'а деградирует в задержку и не требует детекции отказа.

**Interfaces:**
- Consumes: `tasks_cmd::resolve_root`, `commands::AppState`.
- Produces: `tasks::watch::{TaskWatchers, card_hits, is_card_path}`; TS `onTasksChanged(cb)`, `taskWatchSync()`.

- [ ] **Step 1: Добавить зависимость**

`src-tauri/Cargo.toml`, в `[dependencies]`:

```toml
notify = "6"
```

- [ ] **Step 2: Написать падающий тест на чистую часть**

`src-tauri/src/tasks/watch.rs` — сначала только тесты:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_burst_has_no_hits() {
        assert_eq!(card_hits(&[]), 0);
    }

    #[test]
    fn only_markdown_paths_count_as_hits() {
        let burst: Vec<std::path::PathBuf> = vec![
            "/r/01ABC-slug.md".into(),
            "/r/.01ABC-slug.md.tmp".into(),
            "/r/readme.txt".into(),
        ];
        assert_eq!(card_hits(&burst), 1, "our own temp write must not wake the UI");
    }

    #[test]
    fn several_cards_in_one_burst_are_all_counted() {
        let burst: Vec<std::path::PathBuf> =
            vec!["/r/a.md".into(), "/r/b.md".into(), "/r/c.md".into()];
        assert_eq!(card_hits(&burst), 3, "a count, not a boolean");
    }

    #[test]
    fn ignores_temp_and_non_markdown_paths() {
        assert!(!is_card_path(std::path::Path::new("/r/.01ABC.md.tmp")));
        assert!(!is_card_path(std::path::Path::new("/r/readme.txt")));
        assert!(is_card_path(std::path::Path::new("/r/01ABC-slug.md")));
    }
}
```

- [ ] **Step 3: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: FAIL — `cannot find function card_hits`.

- [ ] **Step 4: Написать watcher**

Дописать в начало `src-tauri/src/tasks/watch.rs`:

```rust
//! Directory watching. Deliberately thin: the parts testable without a real
//! filesystem live in `card_hits`/`is_card_path`. The deadline loop itself is
//! verified by reasoning rather than by a test — a real-inotify test is flaky,
//! and the loop's termination follows from the deadline being fixed at
//! first-event time rather than sliding. A watcher that fails to start is not
//! an error: the board polls anyway, so the only consequence is latency.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(200);

/// How many paths in one burst are cards. The thread calls this; it is the
/// filter that decides whether a burst is worth waking the UI for.
pub fn card_hits(paths: &[PathBuf]) -> usize {
    paths.iter().filter(|p| is_card_path(p)).count()
}

/// Only `.md` files are cards; our temp files end in `.tmp` and must not wake
/// the UI mid-write.
pub fn is_card_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
}

/// One watcher per watched root, rebuilt whenever the workspace set changes.
pub struct TaskWatchers {
    inner: Mutex<HashMap<String, (PathBuf, RecommendedWatcher)>>,
}

impl TaskWatchers {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// Make the live watcher set match `wanted` (workspace id -> root). Roots
    /// that vanished are dropped; new ones get a watcher. Failing to watch one
    /// root never affects the others.
    pub fn sync<F>(&self, wanted: &[(String, PathBuf)], on_change: F)
    where
        F: Fn(String) + Send + Clone + 'static,
    {
        // Which roots are already watched — read under the lock, then release it.
        // Creating a watcher touches the filesystem (`inotify_add_watch`) and
        // spawns a thread; holding the map lock across either would violate the
        // project's "no lock across blocking IO" rule, and a panic in
        // `spawn` while holding it would poison the lock and silently disable
        // every future sync.
        let already: Vec<String> = match self.inner.lock() {
            Ok(map) => map.keys().cloned().collect(),
            Err(_) => return,
        };

        let mut created: Vec<(String, PathBuf, RecommendedWatcher)> = Vec::new();
        for (id, root) in wanted {
            if already.contains(id) { continue; }
            if !root.is_dir() { continue; }
            let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
            let Ok(mut watcher) = RecommendedWatcher::new(tx, notify::Config::default()) else {
                continue;
            };
            if watcher.watch(root, RecursiveMode::NonRecursive).is_err() {
                continue;
            }

            let id_for_thread = id.clone();
            let cb = on_change.clone();
            let spawned = std::thread::Builder::new().spawn(move || {
                // Coalesce a burst into a single notification: an editor save
                // is several events, and the UI only needs to know "reload".
                while let Ok(first) = rx.recv() {
                    let mut hits = match first {
                        Ok(ev) => card_hits(&ev.paths),
                        Err(_) => 0,
                    };
                    let deadline = std::time::Instant::now() + DEBOUNCE;
                    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                        match rx.recv_timeout(left) {
                            Ok(Ok(ev)) => hits += card_hits(&ev.paths),
                            Ok(Err(_)) => {}
                            Err(_) => break,
                        }
                    }
                    if hits > 0 {
                        cb(id_for_thread.clone());
                    }
                }
            });
            // Thread-creation failure joins the same per-root isolation path as
            // every other failure here.
            if spawned.is_err() { continue; }

            created.push((id.clone(), root.clone(), watcher));
        }

        // Now the only lock-holding work is bookkeeping.
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|id, (root, _)| wanted.iter().any(|(w, r)| w == id && r == root));
            for (id, root, watcher) in created {
                map.insert(id, (root, watcher));
            }
        }
    }
}

impl Default for TaskWatchers {
    fn default() -> Self { Self::new() }
}
```

Дописать в `src-tauri/src/tasks/mod.rs`:

```rust
pub mod watch;
```

- [ ] **Step 5: Пробросить watcher в состояние приложения**

`src-tauri/src/commands.rs` — добавить поле в `AppState`:

```rust
    /// Live directory watchers for configured tracker roots. Rebuilt via
    /// `tasks_watch_sync` whenever the workspace set or its config changes.
    pub watchers: std::sync::Arc<cowork_deck::tasks::watch::TaskWatchers>,
```

`src-tauri/src/main.rs` — в `app.manage(AppState { ... })` добавить:

```rust
                watchers: std::sync::Arc::new(tasks::watch::TaskWatchers::new()),
```

- [ ] **Step 6: Добавить команду синхронизации**

В конец `src-tauri/src/tasks_cmd.rs` (перед `mod tests`):

```rust
/// Point the watcher set at every configured tracker root. Called by the
/// frontend at boot and after any workspace change, because a root can appear,
/// move, or disappear at runtime.
#[tauri::command]
pub fn tasks_watch_sync(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let all = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces()
    };
    let wanted: Vec<(String, PathBuf)> = all
        .iter()
        .filter_map(|ws| resolve_root(ws).map(|(root, _)| (ws.id.clone(), root)))
        .collect();

    let handle = app.clone();
    state.watchers.sync(&wanted, move |workspace_id| {
        use tauri::Emitter;
        let _ = handle.emit("tasks://changed", TasksChanged { workspace_id });
    });
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TasksChanged {
    workspace_id: String,
}
```

Зарегистрировать в `src-tauri/src/main.rs`, в `generate_handler!`:

```rust
            tasks_cmd::tasks_watch_sync,
```

- [ ] **Step 7: Добавить обёртки во фронтенд**

В конец `src/ipc.ts`:

```ts
export const taskWatchSync = () => invoke<void>("tasks_watch_sync");
export const onTasksChanged = (cb: (workspaceId: string) => void): Promise<UnlistenFn> =>
  listen<{ workspaceId: string }>("tasks://changed", (e) => cb(e.payload.workspaceId));
```

- [ ] **Step 8: Запустить всё**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run build && npm test`
Expected: PASS везде.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/ src/ipc.ts
git commit -m "feat(#39): watch tracker roots and emit tasks://changed

Bursts are coalesced over 200ms and .tmp writes are ignored, so the UI is
never woken mid-write. A root that cannot be watched is skipped rather
than failing the sync: the board polls while open, so a dead watcher
costs latency, not correctness."
```

---

### Task 5: CLI `cowork_task` — карточка от сессии

**Issue:** #40

**Files:**
- Create: `src-tauri/src/bin/cowork_task.rs`
- Modify: `src-tauri/Cargo.toml` (`[[bin]]`)

**Interfaces:**
- Consumes: `cowork_deck::tasks::{fs::FsTaskProvider, model::*, provider::TaskProvider}`.
- Produces: исполняемый файл `cowork_task` с подкомандами `new` и `done`; чистая `parse_args`.

- [ ] **Step 1: Объявить бинарь**

`src-tauri/Cargo.toml`, после существующей секции `cowork_report`:

```toml
[[bin]]
name = "cowork_task"
path = "src/bin/cowork_task.rs"
```

- [ ] **Step 2: Написать падающие тесты**

`src-tauri/src/bin/cowork_task.rs` — сначала только тесты:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_new_with_kind_and_title() {
        let argv = ["cowork_task", "new", "--kind", "bug", "--title", "Пилюля мигает"]
            .map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::New { kind, title }) => {
                assert_eq!(kind, "bug");
                assert_eq!(title, "Пилюля мигает");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn kind_defaults_to_task() {
        let argv = ["cowork_task", "new", "--title", "Просто задача"].map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::New { kind, .. }) => assert_eq!(kind, "task"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn new_without_title_is_a_usage_error() {
        let argv = ["cowork_task", "new"].map(String::from).to_vec();
        assert!(parse_args(&argv).is_err());
    }

    #[test]
    fn parses_done_with_an_id() {
        let argv = ["cowork_task", "done", "01ABC"].map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::Done { id }) => assert_eq!(id, "01ABC"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn unknown_subcommand_is_an_error_not_a_silent_noop() {
        let argv = ["cowork_task", "frobnicate"].map(String::from).to_vec();
        assert!(parse_args(&argv).is_err());
    }

    #[test]
    fn kind_strings_map_to_the_model() {
        assert_eq!(kind_from_str("bug"), Some(TaskKind::Bug));
        assert_eq!(kind_from_str("idea"), Some(TaskKind::Idea));
        assert_eq!(kind_from_str("task"), Some(TaskKind::Task));
        assert_eq!(kind_from_str("нечто"), None);
    }
}
```

- [ ] **Step 3: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --bin cowork_task`
Expected: FAIL — `cannot find function parse_args`.

- [ ] **Step 4: Написать CLI**

Дописать в начало `src-tauri/src/bin/cowork_task.rs`:

```rust
//! CLI a Claude Code session uses to file its own ticket:
//!
//!     "$COWORK_TASK_BIN" new --kind bug --title "…"   # body on stdin
//!     "$COWORK_TASK_BIN" done <id>
//!
//! It links the same `tasks` module the app does, so there is exactly one
//! implementation of the card format. It writes the file directly — no TCP, no
//! listener — so filing a ticket works even when the app window is busy.
use cowork_deck::tasks::fs::FsTaskProvider;
use cowork_deck::tasks::model::{TaskDraft, TaskKind, TaskOrigin};
use cowork_deck::tasks::provider::TaskProvider;
use std::io::Read;

#[derive(Debug, PartialEq, Eq)]
pub enum Cmd {
    New { kind: String, title: String },
    Done { id: String },
}

pub fn kind_from_str(s: &str) -> Option<TaskKind> {
    match s {
        "bug" => Some(TaskKind::Bug),
        "task" => Some(TaskKind::Task),
        "idea" => Some(TaskKind::Idea),
        _ => None,
    }
}

pub fn parse_args(argv: &[String]) -> Result<Cmd, String> {
    let sub = argv.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "new" => {
            let mut kind = "task".to_string();
            let mut title: Option<String> = None;
            let mut i = 2;
            while i < argv.len() {
                match argv[i].as_str() {
                    "--kind" => {
                        kind = argv.get(i + 1).ok_or("--kind без значения")?.clone();
                        i += 2;
                    }
                    "--title" => {
                        title = Some(argv.get(i + 1).ok_or("--title без значения")?.clone());
                        i += 2;
                    }
                    other => return Err(format!("неизвестный аргумент: {other}")),
                }
            }
            let title = title.ok_or("нужен --title")?;
            if title.trim().is_empty() {
                return Err("--title пустой".into());
            }
            Ok(Cmd::New { kind, title })
        }
        "done" => {
            let id = argv.get(2).ok_or("нужен id карточки")?.clone();
            Ok(Cmd::Done { id })
        }
        "" => Err("нужна подкоманда: new | done".into()),
        other => Err(format!("неизвестная подкоманда: {other}")),
    }
}

const USAGE: &str = "\
cowork_task — оформить карточку в трекере cowork-deck.

  cowork_task new --kind bug|task|idea --title \"…\"   (тело читается со stdin)
  cowork_task done <id>

Требует переменных окружения, которые дека выставляет сессии:
  COWORK_TASKS_DIR  каталог карточек
  COWORK_PROJECT    имя проекта (пишется в поле project:)
  COWORK_SESSION    id сессии (необязательно)
";

fn env_var(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("не задана переменная окружения {name}\n\n{USAGE}")),
    }
}

fn run() -> Result<String, String> {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = parse_args(&argv).map_err(|e| format!("{e}\n\n{USAGE}"))?;

    // Env is read only after the arguments parse, so a usage error never
    // depends on where the command was run from.
    let dir = env_var("COWORK_TASKS_DIR")?;
    let project = env_var("COWORK_PROJECT")?;
    let session = std::env::var("COWORK_SESSION").ok().filter(|s| !s.trim().is_empty());

    // The in-project root is created by the app on first use; the CLI never
    // creates a root, so a stale env var cannot scatter empty folders.
    let provider = FsTaskProvider::new(std::path::PathBuf::from(&dir), false);

    match cmd {
        Cmd::New { kind, title } => {
            let kind = kind_from_str(&kind)
                .ok_or_else(|| format!("неизвестный --kind: {kind} (bug|task|idea)"))?;
            let mut body = String::new();
            // Best effort: a session may pipe a body or may not pipe anything.
            let _ = std::io::stdin().read_to_string(&mut body);
            let card = provider
                .create(TaskDraft {
                    title,
                    kind,
                    body,
                    project,
                    origin: TaskOrigin::Session,
                    session,
                })
                .map_err(|e| e.to_string())?;
            Ok(format!("создана карточка {} — {}", card.id, card.path))
        }
        Cmd::Done { id } => {
            let card = provider.resolve(&id).map_err(|e| e.to_string())?;
            Ok(format!("закрыта карточка {}", card.id))
        }
    }
}

fn main() {
    match run() {
        Ok(msg) => println!("{msg}"),
        Err(e) => {
            eprintln!("cowork_task: {e}");
            std::process::exit(1);
        }
    }
}
```

- [ ] **Step 5: Запустить — должно пройти**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --bin cowork_task`
Expected: PASS, 6 тестов.

- [ ] **Step 6: Проверить поведение без окружения руками**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin cowork_task
env -u COWORK_TASKS_DIR -u COWORK_PROJECT \
  src-tauri/target/debug/cowork_task new --title "Проверка" ; echo "exit=$?"
```

Expected: сообщение `не задана переменная окружения COWORK_TASKS_DIR` с usage, `exit=1`, и ни одного созданного файла.

- [ ] **Step 7: Проверить happy path руками**

```bash
mkdir -p /tmp/cowork-task-check
COWORK_TASKS_DIR=/tmp/cowork-task-check COWORK_PROJECT=demo COWORK_SESSION=s1 \
  src-tauri/target/debug/cowork_task new --kind bug --title "Баг: пилюля мигает" <<'EOF'
Репро: три воркспейса.
EOF
cat /tmp/cowork-task-check/*.md
```

Expected: файл `<ulid>-баг-пилюля-мигает.md` с `origin: session`, `session: s1`, `project: demo`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/bin/cowork_task.rs
git commit -m "feat(#40): cowork_task CLI so a session can file its own ticket

Links the app's tasks module rather than reimplementing the card format,
and writes the file directly — no TCP, no listener — so filing a ticket
works even when the app window is busy. Missing env exits non-zero with
usage instead of guessing a path."
```

---

### Task 6: окружение сессии и упаковка сайдкара

**Issue:** #41

Без этого CLI из Task 5 недостижим для агента: он не знает ни каталога, ни своего пути. И, как уже случалось с `cowork_report`, бинарь не попадёт в установочный пакет, если его не объявить сайдкаром.

**Files:**
- Modify: `src-tauri/src/pty.rs` (`spawn` получает `env`)
- Modify: `src-tauri/src/commands.rs` (`start_session` получает `workspace_id`, собирает env)
- Modify: `src-tauri/src/main.rs` (`task_bin_path`)
- Create: `scripts/stage-sidecar.sh`
- Modify: `scripts/stage-reporter.sh` (становится тонкой обёрткой)
- Modify: `package.json` (`stage:task`)
- Modify: `src-tauri/tauri.conf.json` (`externalBin`, `beforeDevCommand`, `beforeBuildCommand`)
- Modify: `src/ipc.ts` (`startSession` получает `workspaceId`)
- Modify: `src/sessions.ts` (передача `workspaceId` в `startSession`)

**Interfaces:**
- Consumes: `tasks_cmd::resolve_root`, `main::resolve_reporter_path`.
- Produces: `commands::session_env(root: Option<&Path>, project: &str, task_bin: &str, session: &str) -> Vec<(String, String)>`; `PtyManager::spawn(..., env: &[(String, String)], ...)`; TS `startSession(session, cwd, workspaceId, initialPrompt, cols, rows, resume)`.

- [ ] **Step 1: Написать падающий тест на сборку окружения**

В `#[cfg(test)] mod tests` в `src-tauri/src/commands.rs`:

```rust
#[test]
fn session_env_carries_tracker_paths_when_configured() {
    let root = std::path::PathBuf::from("/home/u/vault/Tasks");
    let env = session_env(Some(&root), "cowork-deck", "/opt/cowork_task", "sess-9");
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(get("COWORK_TASKS_DIR"), Some("/home/u/vault/Tasks"));
    assert_eq!(get("COWORK_PROJECT"), Some("cowork-deck"));
    assert_eq!(get("COWORK_TASK_BIN"), Some("/opt/cowork_task"));
    assert_eq!(get("COWORK_SESSION"), Some("sess-9"));
}

#[test]
fn session_env_omits_tracker_vars_when_not_configured() {
    // Иначе агент увидит пустой путь и начнёт угадывать.
    let env = session_env(None, "cowork-deck", "/opt/cowork_task", "sess-9");
    assert!(env.iter().all(|(n, _)| n != "COWORK_TASKS_DIR"));
    assert!(env.iter().all(|(n, _)| n != "COWORK_TASK_BIN"));
}
```

В `#[cfg(test)] mod tests` в `src-tauri/src/main.rs`:

```rust
#[test]
fn task_bin_resolves_next_to_the_exe_like_the_reporter() {
    let dir = Path::new("/app");
    let got = resolve_reporter_path(dir, task_bin_name(), |p| p == Path::new("/app/cowork_task"));
    assert_eq!(got, Path::new("/app/cowork_task"));
}
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL — `cannot find function session_env`, `cannot find function task_bin_name`.

- [ ] **Step 3: Научить PTY принимать окружение**

`src-tauri/src/pty.rs` — в сигнатуру `spawn` добавить параметр после `rows: u16,`:

```rust
        env: &[(String, String)],
```

и сразу после `cmd.cwd(cwd);` добавить:

```rust
        for (k, v) in env {
            cmd.env(k, v);
        }
```

Обновить существующий вызов в тесте `spawns_streams_output_and_exits`:

```rust
        mgr.spawn(
            "s1", prog, &args, ".", 80, 24, &[],
            move |bytes| { let _ = tx.send(bytes); },
```

- [ ] **Step 4: Собрать окружение в `start_session`**

`src-tauri/src/commands.rs` — добавить функцию рядом с `build_claude_args`:

```rust
/// Environment a session needs to file its own tickets. When the workspace has
/// no tracker, the tracker vars are omitted entirely rather than set to an
/// empty string — the CLI then fails loudly instead of writing somewhere
/// arbitrary, and the agent has no empty path to misread.
pub fn session_env(
    root: Option<&std::path::Path>,
    project: &str,
    task_bin: &str,
    session: &str,
) -> Vec<(String, String)> {
    let mut env = vec![("COWORK_SESSION".to_string(), session.to_string())];
    if let Some(root) = root {
        env.push(("COWORK_TASKS_DIR".to_string(), root.to_string_lossy().to_string()));
        env.push(("COWORK_PROJECT".to_string(), project.to_string()));
        env.push(("COWORK_TASK_BIN".to_string(), task_bin.to_string()));
    }
    env
}
```

Изменить `start_session`: добавить параметр `workspace_id: Option<String>` после `cwd: String,`, и перед вызовом `state.pty.spawn` собрать окружение:

```rust
    // Tracker env, resolved from the workspace's config. A missing or
    // unconfigured workspace simply yields no tracker vars.
    let (root, project) = match workspace_id.as_deref() {
        Some(id) => {
            let ws = {
                let store = state.store.lock().map_err(|_| "store lock".to_string())?;
                store.workspaces().into_iter().find(|w| w.id == id)
            };
            match ws {
                Some(ws) => {
                    let root = crate::tasks_cmd::resolve_root(&ws).map(|(r, _)| r);
                    (root, ws.name)
                }
                None => (None, String::new()),
            }
        }
        None => (None, String::new()),
    };
    let env = session_env(root.as_deref(), &project, &state.task_bin_path, &session);
```

и передать его в spawn:

```rust
    state.pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &env, on_output, on_exit)
        .map_err(|e| e.to_string())
```

Добавить поле в `AppState`:

```rust
    /// Absolute path to the `cowork_task` sidecar, handed to sessions via
    /// COWORK_TASK_BIN.
    pub task_bin_path: String,
```

- [ ] **Step 5: Разрешить путь до бинаря**

`src-tauri/src/main.rs` — рядом с `reporter_name`/`reporter_path` добавить:

```rust
fn task_bin_name() -> &'static str {
    if cfg!(windows) { "cowork_task.exe" } else { "cowork_task" }
}

fn task_bin_path() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    resolve_reporter_path(&dir, task_bin_name(), |p| p.exists())
        .to_string_lossy()
        .to_string()
}
```

и в `app.manage(AppState { ... })`:

```rust
                task_bin_path: task_bin_path(),
```

- [ ] **Step 6: Обобщить стейджинг сайдкаров**

Создать `scripts/stage-sidecar.sh`:

```bash
#!/usr/bin/env bash
# Builds a helper binary and stages it as a Tauri "externalBin" sidecar so
# `tauri build` bundles it next to the main executable. Tauri sidecars must be
# named "<name>-<target-triple>" (plus ".exe" on Windows) and live where
# tauri.conf.json's bundle.externalBin points.
#
#   scripts/stage-sidecar.sh cowork_report
#   scripts/stage-sidecar.sh cowork_task
set -euo pipefail

BIN="${1:?usage: stage-sidecar.sh <bin-name>}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="$(rustc -Vv | grep host | cut -d' ' -f2)"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/${BIN}-${TARGET_TRIPLE}${EXT}"

# tauri-build's build.rs validates that every bundle.externalBin resource
# already exists on disk, and it runs on *any* cargo build of this crate.
# Seed a placeholder first so that build doesn't fail before we've produced
# the real binary.
if [ ! -e "$DEST" ]; then
  : > "$DEST"
fi

cargo build --release --bin "$BIN" --manifest-path src-tauri/Cargo.toml

cp "src-tauri/target/release/${BIN}${EXT}" "$DEST"
echo "Staged sidecar: $DEST"
```

Заменить содержимое `scripts/stage-reporter.sh` на обёртку:

```bash
#!/usr/bin/env bash
# Kept for compatibility: stages the reporter sidecar.
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/stage-sidecar.sh" cowork_report
```

```bash
chmod +x scripts/stage-sidecar.sh
```

`package.json` — в `scripts` добавить:

```json
    "stage:task": "bash scripts/stage-sidecar.sh cowork_task"
```

- [ ] **Step 7: Объявить сайдкар в конфиге Tauri**

`src-tauri/tauri.conf.json`:

```json
    "beforeDevCommand": "cargo build --manifest-path src-tauri/Cargo.toml --bin cowork_report --bin cowork_task && npm run dev",
    "beforeBuildCommand": "npm run build && npm run stage:reporter && npm run stage:task"
```

и в `bundle`:

```json
    "externalBin": ["binaries/cowork_report", "binaries/cowork_task"]
```

- [ ] **Step 8: Обновить фронтенд-вызов**

`src/ipc.ts` — заменить `startSession`:

```ts
export const startSession = (
  session: string, cwd: string, workspaceId: string | null,
  initialPrompt: string | null, cols: number, rows: number, resume: boolean,
) => invoke<void>("start_session", { session, cwd, workspaceId, initialPrompt, cols, rows, resume });
```

`src/sessions.ts` — найти единственный вызов `startSession(` внутри `spawnTile` и добавить `workspaceId ?? null` третьим аргументом:

Run: `grep -n "startSession(" src/sessions.ts`

- [ ] **Step 9: Запустить всё**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run build && npm test`
Expected: PASS везде.

- [ ] **Step 10: Проверить, что сайдкар реально стейджится**

```bash
npm run stage:task && ls -l src-tauri/binaries/
```

Expected: файл `cowork_task-<target-triple>` непустого размера рядом с `cowork_report-<target-triple>`.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/ scripts/ package.json src/ipc.ts src/sessions.ts
git commit -m "feat(#41): hand tracker env to sessions and bundle the CLI

Sessions get COWORK_TASKS_DIR/PROJECT/TASK_BIN/SESSION at PTY spawn, and
the vars are omitted (not blanked) when a workspace has no tracker so the
CLI fails loudly instead of writing somewhere arbitrary. cowork_task is
declared an externalBin sidecar — the reporter once shipped missing from
the installer for exactly this reason."
```

---

### Task 7: чистые хелперы доски

**Issue:** #42

Вся логика доски — до всякого DOM, чтобы её можно было проверить тестами.

**Files:**
- Create: `src/tasks.ts`
- Create: `tests/tasks.test.ts`

**Interfaces:**
- Consumes: типы `Task`, `SessionState` из `src/ipc.ts`.
- Produces: `taskPrompt(task, taskBinHint?)`, `derivedStatus(task, links)`, `liveSessionForTask(taskId, links)`, `boardColumns(tasks, project, doneLimit?)`, `kindLabel(kind)`, тип `TaskSessionLink`.

- [ ] **Step 1: Написать падающие тесты**

`tests/tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  taskPrompt, derivedStatus, liveSessionForTask, boardColumns, kindLabel,
  type TaskSessionLink,
} from "../src/tasks";
import type { Task } from "../src/ipc";

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "Пилюля мигает", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "Репро: три воркспейса.", path: "/r/01AAA-pill.md", damaged: null, conflict: false,
    ...over,
  };
}

describe("taskPrompt", () => {
  it("carries title, kind, body and the close instruction", () => {
    const p = taskPrompt(card());
    expect(p).toContain("Пилюля мигает");
    expect(p).toContain("баг");
    expect(p).toContain("Репро: три воркспейса.");
    expect(p).toContain("01AAA");
    expect(p).toContain("COWORK_TASK_BIN");
  });

  it("works for a card with no body", () => {
    const p = taskPrompt(card({ body: "" }));
    expect(p).toContain("Пилюля мигает");
    expect(p).not.toContain("undefined");
    expect(p.trim().endsWith(" ")).toBe(false);
  });
});

describe("derivedStatus", () => {
  const links = (l: Partial<TaskSessionLink>[]): TaskSessionLink[] =>
    l.map((x) => ({ session: "s", taskId: "01AAA", state: "working", ...x }));

  it("is working while a session launched from the card is alive", () => {
    expect(derivedStatus(card(), links([{ state: "working" }]))).toBe("working");
    expect(derivedStatus(card(), links([{ state: "waitingInput" }]))).toBe("working");
  });

  it("falls back to open when that session died", () => {
    expect(derivedStatus(card(), links([{ state: "ended" }]))).toBe("open");
    expect(derivedStatus(card(), links([{ state: "error" }]))).toBe("open");
    expect(derivedStatus(card(), [])).toBe("open");
  });

  it("ignores sessions belonging to other cards", () => {
    expect(derivedStatus(card(), links([{ taskId: "01OTHER", state: "working" }]))).toBe("open");
    expect(derivedStatus(card(), links([{ taskId: undefined, state: "working" }]))).toBe("open");
  });

  it("done always wins — a stray live session cannot reopen a closed card", () => {
    expect(derivedStatus(card({ status: "done" }), links([{ state: "working" }]))).toBe("done");
  });

  it("is working if any of several linked sessions is alive", () => {
    const l = links([{ session: "a", state: "ended" }, { session: "b", state: "working" }]);
    expect(derivedStatus(card(), l)).toBe("working");
  });
});

describe("liveSessionForTask", () => {
  it("finds an idle session too — it is alive and must not be duplicated", () => {
    const l: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "idle" }];
    expect(liveSessionForTask("01AAA", l)).toBe("s1");
  });

  it("ignores dead sessions so the card can be launched again", () => {
    const l: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "ended" }];
    expect(liveSessionForTask("01AAA", l)).toBeNull();
  });
});

describe("boardColumns", () => {
  it("splits open and done, newest first", () => {
    const cards = [
      card({ id: "a", created: "2026-07-01T00:00:00Z" }),
      card({ id: "b", created: "2026-07-05T00:00:00Z" }),
      card({ id: "c", status: "done", resolved: "2026-07-02T00:00:00Z" }),
      card({ id: "d", status: "done", resolved: "2026-07-06T00:00:00Z" }),
    ];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["b", "a"]);
    expect(b.done.map((t) => t.id)).toEqual(["d", "c"]);
    expect(b.doneHidden).toBe(0);
  });

  it("caps the done column and reports how many are hidden", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      card({ id: `d${i}`, status: "done", resolved: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const b = boardColumns(many, "deck", 20);
    expect(b.done).toHaveLength(20);
    expect(b.doneHidden).toBe(5);
  });

  it("lists foreign projects instead of hiding those cards without a trace", () => {
    const cards = [card({ id: "a" }), card({ id: "x", project: "other" }), card({ id: "y", project: "other" })];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["a"]);
    expect(b.foreign).toEqual([{ project: "other", count: 2 }]);
  });

  it("keeps damaged cards in the open column whatever their project says", () => {
    const cards = [card({ id: "bad", project: "", damaged: "нет поля project" })];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["bad"]);
    expect(b.foreign).toEqual([]);
  });

  it("sorts cards with no timestamp last instead of throwing", () => {
    const cards = [card({ id: "a", created: "" }), card({ id: "b", created: "2026-07-05T00:00:00Z" })];
    expect(boardColumns(cards, "deck").open.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("kindLabel", () => {
  it("is Russian, matching the rest of the UI", () => {
    expect(kindLabel("bug")).toBe("баг");
    expect(kindLabel("task")).toBe("задача");
    expect(kindLabel("idea")).toBe("идея");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npx vitest run tests/tasks.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tasks"`.

- [ ] **Step 3: Написать хелперы**

`src/tasks.ts`:

```ts
import type { SessionState, Task, TaskKind } from "./ipc";

/** A live tile, as far as the board cares: which card it came from and how it is doing. */
export interface TaskSessionLink { session: string; taskId?: string; state: SessionState }

const KIND_LABEL: Record<TaskKind, string> = { bug: "баг", task: "задача", idea: "идея" };
export function kindLabel(kind: TaskKind): string { return KIND_LABEL[kind]; }

/** States in which a session still counts as alive — launching a second session
 *  for the same card would duplicate the work. */
const ALIVE: SessionState[] = ["idle", "working", "waitingInput"];
/** States in which the card should read as "в работе" on the board. */
const BUSY: SessionState[] = ["working", "waitingInput"];

export function liveSessionForTask(taskId: string, links: TaskSessionLink[]): string | null {
  const hit = links.find((l) => l.taskId === taskId && ALIVE.includes(l.state));
  return hit ? hit.session : null;
}

/** Board status. Never stored: a dead session simply stops being counted, so a
 *  card cannot get stuck "in progress". */
export function derivedStatus(task: Task, links: TaskSessionLink[]): "open" | "done" | "working" {
  if (task.status === "done") return "done";
  const busy = links.some((l) => l.taskId === task.id && BUSY.includes(l.state));
  return busy ? "working" : "open";
}

/** Initial prompt for a session launched from a card. */
export function taskPrompt(task: Task): string {
  const lines = [
    "Задача из трекера cowork-deck.",
    "",
    `Заголовок: ${task.title}`,
    `Тип: ${kindLabel(task.kind)}`,
    `id: ${task.id}`,
    `Файл карточки: ${task.path}`,
  ];
  const body = task.body.trim();
  if (body) lines.push("", body);
  lines.push(
    "",
    `Когда работа закончена, закрой карточку: "$COWORK_TASK_BIN" done ${task.id}`,
  );
  return lines.join("\n");
}

export interface BoardColumns {
  open: Task[];
  done: Task[];
  /** Сколько закрытых карточек не показано из-за лимита. */
  doneHidden: number;
  /** Карточки чужих проектов в общем корне — считаем, а не прячем молча. */
  foreign: { project: string; count: number }[];
}

/** Descending by timestamp; an empty timestamp sorts last rather than throwing. */
function byTimeDesc(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

export function boardColumns(tasks: Task[], project: string, doneLimit = 20): BoardColumns {
  const mine: Task[] = [];
  const foreignCount = new Map<string, number>();
  for (const t of tasks) {
    // A damaged card is always ours to show: it may be damaged *because* the
    // project field is missing, and hiding it would lose the task silently.
    if (t.damaged || t.project === project) mine.push(t);
    else foreignCount.set(t.project, (foreignCount.get(t.project) ?? 0) + 1);
  }

  const open = mine.filter((t) => t.status === "open")
    .sort((a, b) => byTimeDesc(a.created, b.created));
  const doneAll = mine.filter((t) => t.status === "done")
    .sort((a, b) => byTimeDesc(a.resolved ?? "", b.resolved ?? ""));

  return {
    open,
    done: doneAll.slice(0, doneLimit),
    doneHidden: Math.max(0, doneAll.length - doneLimit),
    foreign: [...foreignCount.entries()].map(([p, count]) => ({ project: p, count })),
  };
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npx vitest run tests/tasks.test.ts`
Expected: PASS, 15 тестов.

- [ ] **Step 5: Проверить типы**

Run: `npm run build`
Expected: сборка проходит.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.ts tests/tasks.test.ts
git commit -m "feat(#42): pure board helpers

derivedStatus reads 'in progress' off live sessions instead of storing
it, so a card cannot get stuck. boardColumns keeps damaged cards visible
whatever their project field says, and counts foreign-project cards in a
shared root rather than hiding them without a trace."
```

---

### Task 8: доска, переключатель вида и счётчики в сайдбаре

**Issue:** #43

**Files:**
- Create: `src/board.ts`
- Create: `tests/board.test.ts`
- Modify: `src/main.ts` (переключатель вида, проводка событий, опрос)
- Modify: `src/workspaces.ts` (бейдж счётчика)
- Modify: `src/styles.css`
- Modify: `index.html` (контейнер доски)

**Interfaces:**
- Consumes: `src/tasks.ts` (`boardColumns`, `derivedStatus`, `kindLabel`), `src/ipc.ts` (`listTasks`, `resolveTask`, `taskCapabilities`, `taskOpenCounts`, `onTasksChanged`, `taskWatchSync`).
- Produces: `BoardView` с методами `render(state)`, `mount: HTMLElement`; чистая `emptyStateMessage(caps, error)`.

- [ ] **Step 1: Написать падающие тесты**

`tests/board.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { BoardView, emptyStateMessage } from "../src/board";
import type { Task } from "../src/ipc";

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "Пилюля мигает", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "тело", path: "/r/01AAA-pill.md", damaged: null, conflict: false, ...over,
  };
}

describe("emptyStateMessage", () => {
  it("invites configuration when no tracker is set up — that is not an error", () => {
    const m = emptyStateMessage(null, null);
    expect(m.text).toContain("не настроен");
    expect(m.canConfigure).toBe(true);
  });

  it("shows the failing path verbatim so a typo is findable", () => {
    const m = emptyStateMessage({ canCreate: true, canResolve: true, statuses: [] },
      "каталог задач недоступен: /home/u/опечатка");
    expect(m.text).toContain("/home/u/опечатка");
  });
});

describe("BoardView", () => {
  const caps = { canCreate: true, canResolve: true, statuses: ["open", "done"] };

  it("renders titles as text, never as markup", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ title: "<img src=x onerror=alert(1)>" })],
    });
    expect(v.mount.querySelector("img")).toBeNull();
    expect(v.mount.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("marks a card whose session is alive as в работе", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null,
      links: [{ session: "s1", taskId: "01AAA", state: "working" }],
      tasks: [card()],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("working")).toBe(true);
    expect(el.querySelector(".tk-run")).toBeNull(); // повторный запуск не предлагаем
  });

  it("flags a bot-filed card so agent work is never silent", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ origin: "session" })] });
    expect(v.mount.querySelector(".tk-card")!.textContent).toContain("сессия");
  });

  it("shows damaged and conflicting cards with their reason", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "нет поля status", conflict: true })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("damaged")).toBe(true);
    expect(el.textContent).toContain("нет поля status");
    expect(el.textContent).toContain("id");
    expect(el.querySelector(".tk-done")).toBeNull(); // закрывать конфликтную нельзя
  });

  it("hides create and close when the provider says it cannot", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps: { canCreate: false, canResolve: false, statuses: [] },
      error: null, links: [], tasks: [card()],
    });
    expect(v.mount.querySelector(".tk-new")).toBeNull();
    expect(v.mount.querySelector(".tk-done")).toBeNull();
  });

  it("reports foreign-project cards instead of hiding them", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ project: "other" })] });
    expect(v.mount.textContent).toContain("other");
  });

  it("calls back with the card when ▶ is clicked", () => {
    let launched: string | null = null;
    const v = new BoardView({
      onLaunch: (t) => { launched = t.id; }, onResolve: () => {}, onNew: () => {}, onConfigure: () => {},
    });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    v.mount.querySelector<HTMLButtonElement>(".tk-run")!.click();
    expect(launched).toBe("01AAA");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npx vitest run tests/board.test.ts`
Expected: FAIL — `Failed to resolve import "../src/board"`.

- [ ] **Step 3: Написать доску**

`src/board.ts`:

```ts
import type { ProviderCapabilities, Task } from "./ipc";
import { boardColumns, derivedStatus, kindLabel, type TaskSessionLink } from "./tasks";

export interface BoardState {
  project: string;
  caps: ProviderCapabilities | null;
  error: string | null;
  tasks: Task[];
  links: TaskSessionLink[];
}

export interface BoardHandlers {
  onLaunch: (task: Task) => void;
  onResolve: (task: Task) => void;
  onNew: () => void;
  onConfigure: () => void;
}

/** `caps === null` means no tracker is configured — a legal state, not a failure. */
export function emptyStateMessage(
  caps: ProviderCapabilities | null,
  error: string | null,
): { text: string; canConfigure: boolean } {
  if (caps === null) {
    return { text: "Трекер не настроен для этого пространства.", canConfigure: true };
  }
  if (error) return { text: error, canConfigure: true };
  return { text: "Задач нет.", canConfigure: false };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always textContent: titles and bodies come from files written by the user
  // or by an agent, and must never be parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

export class BoardView {
  readonly mount = el("div", "tk-board");
  constructor(private h: BoardHandlers) {}

  render(state: BoardState) {
    this.mount.replaceChildren();
    const { caps, error } = state;

    const head = el("div", "tk-head");
    head.append(el("h3", "tk-title", "Задачи"));
    if (caps?.canCreate) {
      const add = el("button", "tk-new", "+ задача");
      add.onclick = () => this.h.onNew();
      head.append(add);
    }
    this.mount.append(head);

    if (caps === null || error) {
      const msg = emptyStateMessage(caps, error);
      const box = el("div", "tk-empty");
      box.append(el("p", undefined, msg.text));
      if (msg.canConfigure) {
        const btn = el("button", "tk-configure", "Настроить");
        btn.onclick = () => this.h.onConfigure();
        box.append(btn);
      }
      this.mount.append(box);
      return;
    }

    const cols = boardColumns(state.tasks, state.project);
    const wrap = el("div", "tk-cols");
    wrap.append(
      this.column(`open (${cols.open.length})`, cols.open, state, caps),
      this.column(
        cols.doneHidden > 0 ? `done (${cols.done.length}+${cols.doneHidden})` : `done (${cols.done.length})`,
        cols.done, state, caps,
      ),
    );
    this.mount.append(wrap);

    if (cols.open.length === 0 && cols.done.length === 0) {
      this.mount.append(el("div", "tk-empty", emptyStateMessage(caps, null).text));
    }

    for (const f of cols.foreign) {
      this.mount.append(el(
        "p", "tk-foreign",
        `${f.count} карточк(и) с другим project: ${f.project} — переименовано пространство?`,
      ));
    }
  }

  private column(label: string, tasks: Task[], state: BoardState, caps: ProviderCapabilities) {
    const col = el("div", "tk-col");
    col.append(el("div", "tk-col-head", label));
    for (const t of tasks) col.append(this.card(t, state, caps));
    return col;
  }

  private card(t: Task, state: BoardState, caps: ProviderCapabilities) {
    const status = derivedStatus(t, state.links);
    const box = el("div", `tk-card ${status}`);
    if (t.damaged) box.classList.add("damaged");

    box.append(el("div", "tk-card-title", t.title));

    const meta = el("div", "tk-meta");
    meta.append(el("span", "tk-kind", kindLabel(t.kind)));
    if (t.origin === "session") meta.append(el("span", "tk-bot", "сессия"));
    if (status === "working") meta.append(el("span", "tk-busy", "в работе"));
    box.append(meta);

    if (t.damaged) {
      box.append(el("p", "tk-warn", `повреждена: ${t.damaged} · id ${t.id} · ${t.path}`));
    }
    if (t.conflict) {
      box.append(el("p", "tk-warn", `несколько файлов с id ${t.id} — исправьте вручную`));
    }

    const acts = el("div", "tk-acts");
    // No ▶ while a session for this card is alive: a second one would duplicate
    // the work, exactly as a scheduled scenario skips an overlapping run.
    if (status === "open") {
      const run = el("button", "tk-run", "▶");
      run.title = "Запустить сессию из задачи";
      run.onclick = () => this.h.onLaunch(t);
      acts.append(run);
    }
    // A conflicting card is never closed automatically: we will not guess which
    // of two files to write into.
    if (caps.canResolve && t.status === "open" && !t.conflict) {
      const done = el("button", "tk-done", "✓");
      done.title = "Закрыть задачу";
      done.onclick = () => this.h.onResolve(t);
      acts.append(done);
    }
    if (acts.childElementCount > 0) box.append(acts);
    return box;
  }
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `npx vitest run tests/board.test.ts`
Expected: PASS, 9 тестов.

- [ ] **Step 5: Добавить контейнер и стили**

`index.html` — рядом с `<div id="deck">` добавить (посмотри разметку и вставь соседом):

```html
    <div id="board" class="hidden"></div>
```

`src/styles.css` — дописать в конец, используя только существующие токены:

```css
/* ——— Доска задач ——— */
#board { overflow: auto; padding: var(--sp-3); background: var(--bg-app); }
#board.hidden, .tk-hidden { display: none; }

.tk-views { display: inline-flex; gap: 2px; background: var(--bg-raised); border-radius: var(--r-sm); padding: 2px; }
.tk-views button {
  font: inherit; font-size: var(--fs-sm); color: var(--fg-muted);
  background: transparent; border: 0; border-radius: var(--r-sm);
  padding: var(--sp-1) var(--sp-2); cursor: pointer;
}
.tk-views button.active { background: var(--accent-weak); color: var(--fg); }
.tk-views button:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.tk-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.tk-title { margin: 0; font-size: var(--fs-base); color: var(--fg); }
.tk-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); align-items: start; }
.tk-col-head { font-size: var(--fs-xs); color: var(--fg-subtle); margin-bottom: var(--sp-2); }

.tk-card {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: var(--r-md); padding: var(--sp-3); margin-bottom: var(--sp-2);
}
.tk-card.working { border-color: var(--st-working); }
.tk-card.done { opacity: 0.6; }
.tk-card.damaged { border-color: var(--st-error); }
.tk-card-title { color: var(--fg); font-size: var(--fs-base); font-weight: var(--fw-medium); }
.tk-meta { display: flex; gap: var(--sp-2); margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--fg-subtle); }
.tk-bot { color: var(--st-ended); }
/* Пульсация только через opacity: анимация box-shadow однажды вешала всю систему. */
.tk-busy { color: var(--st-working); animation: tk-pulse 1.6s var(--ease) infinite; }
@keyframes tk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.tk-warn { color: var(--st-error); font-size: var(--fs-xs); margin: var(--sp-1) 0 0; }
.tk-foreign { color: var(--fg-subtle); font-size: var(--fs-xs); margin-top: var(--sp-3); }
.tk-empty { color: var(--fg-muted); font-size: var(--fs-sm); }

.tk-acts { display: flex; gap: var(--sp-1); margin-top: var(--sp-2); }
.tk-acts button, .tk-new, .tk-configure {
  font: inherit; font-size: var(--fs-sm); color: var(--fg-muted);
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-sm); min-width: 24px; min-height: 24px; cursor: pointer;
  transition: color var(--dur-1) var(--ease);
}
.tk-acts button:hover, .tk-new:hover, .tk-configure:hover { color: var(--fg); }
.tk-acts button:focus-visible, .tk-new:focus-visible, .tk-configure:focus-visible {
  outline: none; box-shadow: var(--focus-ring);
}

.ws-count { margin-left: auto; font-size: var(--fs-xs); color: var(--fg-subtle); }
```

- [ ] **Step 6: Добавить бейдж в сайдбар**

`src/workspaces.ts` — в `WorkspacesPanel` добавить поле и сеттер, затем в построении строки (после `label`) вставить счётчик:

```ts
  /** Открытых задач на пространство; заполняет main.ts. */
  private counts = new Map<string, number>();
  setCounts(counts: Record<string, number>) {
    this.counts = new Map(Object.entries(counts));
    this.renderList();
  }
```

и внутри цикла построения строки, сразу после `row.append(label)` (или после добавления `label` в существующем порядке):

```ts
      const n = this.counts.get(w.id) ?? 0;
      if (n > 0) {
        const count = document.createElement("span");
        count.className = "ws-count";
        count.textContent = String(n);
        count.title = `${n} открытых задач`;
        row.append(count);
      }
```

Если приватный метод рендера называется иначе — Run: `grep -n "private render\|renderList" src/workspaces.ts` и используй существующее имя.

- [ ] **Step 7: Проводка в `main.ts`**

`src/main.ts` — добавить импорты:

```ts
import { BoardView } from "./board";
import {
  listTasks, resolveTask, taskCapabilities, taskOpenCounts, onTasksChanged, taskWatchSync,
} from "./ipc";
import type { Task } from "./ipc";
```

Получить контейнер доски и завести переключатель вида (после объявления `deckEl`):

```ts
const boardEl = document.querySelector<HTMLElement>("#board")!;

// Переключатель «Терминалы | Доска»: доска берёт всю ширину, потому что позже
// сюда приедут доски GitHub/Jira, которым нужно место, а не полоска.
const views = document.createElement("div");
views.className = "tk-views";
const termBtn = document.createElement("button");
termBtn.textContent = "Терминалы"; termBtn.className = "active";
const boardBtn = document.createElement("button");
boardBtn.textContent = "Доска";
views.append(termBtn, boardBtn);
sidebar.prepend(views);

const board = new BoardView({
  onLaunch: (t) => void launchFromTask(t),
  onResolve: (t) => void closeTask(t),
  onNew: () => void captureTask(),
  onConfigure: () => void alertModal(
    "Настройте трекер в свойствах пространства (✎): каталог в проекте или свой путь."),
});
boardEl.append(board.mount);

let boardVisible = false;
let boardTimer: ReturnType<typeof setInterval> | null = null;

function setView(showBoard: boolean) {
  boardVisible = showBoard;
  deckEl.classList.toggle("tk-hidden", showBoard);
  boardEl.classList.toggle("hidden", !showBoard);
  termBtn.classList.toggle("active", !showBoard);
  boardBtn.classList.toggle("active", showBoard);
  if (showBoard) {
    void refreshBoard();
    // Опрос — основной путь обновления; watcher лишь ускоряет его, поэтому
    // его отказ деградирует в задержку и не требует детекции.
    if (boardTimer === null) boardTimer = setInterval(() => void refreshBoard(), 5000);
  } else if (boardTimer !== null) {
    clearInterval(boardTimer); boardTimer = null;
  }
}
termBtn.onclick = () => setView(false);
boardBtn.onclick = () => setView(true);
```

Добавить функции обновления и действий (рядом с `handleScheduledFire`):

```ts
/** Перерисовать доску активного пространства. Каждый вызов IPC изолирован:
 *  одна упавшая ручка не должна ронять весь тик. */
async function refreshBoard() {
  const ws = workspaces.active;
  if (!ws) {
    board.render({ project: "", caps: null, error: null, tasks: [], links: [] });
    return;
  }
  let caps = null;
  try { caps = await taskCapabilities(ws.id); } catch (e) { console.debug("caps failed", e); }
  let tasks: Task[] = [];
  let error: string | null = null;
  if (caps) {
    try { tasks = await listTasks(ws.id); }
    catch (e) { error = String(e); }
  }
  board.render({ project: ws.name, caps, error, tasks, links: deck.taskLinks() });
}

/** Счётчики в сайдбаре — одна ручка на все пространства. */
async function refreshCounts() {
  try { workspaces.setCounts(await taskOpenCounts()); }
  catch (e) { console.debug("taskOpenCounts failed", e); }
}

async function closeTask(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  try { await resolveTask(ws.id, t.id); }
  catch (e) { await alertModal(`Не удалось закрыть задачу: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}
```

В `boot()` — после `await skills.load();` добавить:

```ts
  await onTasksChanged((workspaceId) => {
    if (boardVisible && workspaces.active?.id === workspaceId) void refreshBoard();
    void refreshCounts();
  });
  await taskWatchSync();
  await refreshCounts();
```

Переключение пространства должно обновлять доску — заменить колбэк `WorkspacesPanel`:

```ts
const workspaces = new WorkspacesPanel(wsMount, (ws) => {
  deck.setActiveWorkspace(ws.id);
  if (boardVisible) void refreshBoard();
});
```

Добавить пункты в палитру, в `paletteCommands()`:

```ts
    { id: "board", title: "Открыть доску задач", run: () => setView(true) },
    { id: "new-task", title: "Новая задача", run: () => { void captureTask(); } },
```

и в `COMMANDS`:

```ts
  "board": () => setView(true),
  "new-task": () => { void captureTask(); },
```

`captureTask` и `launchFromTask` появляются в Task 9 и Task 10 — до тех пор объяви заглушки прямо над `refreshBoard`, чтобы задача собиралась и была самостоятельной:

```ts
// Реализуются в следующих задачах плана.
async function captureTask() { await alertModal("Захват задачи ещё не реализован."); }
async function launchFromTask(t: Task) { await alertModal(`Запуск из задачи ещё не реализован: ${t.title}`); }
```

Также нужен `deck.taskLinks()` — добавить в `src/sessions.ts` в класс `Deck`:

```ts
  /** Живые тайлы в виде, который нужен доске. */
  taskLinks(): { session: string; taskId?: string; state: SessionState }[] {
    return [...this.tiles.values()].map((t) => ({ session: t.session, taskId: t.taskId, state: t.state }));
  }
```

и объявить поле в интерфейсе `Tile` (строка ~19, рядом с `scheduledSkillId`):

```ts
  /** Set when the tile was launched from a tracker card — keys the "в работе" state. */
  taskId?: string;
```

- [ ] **Step 8: Запустить всё**

Run: `npm test && npm run build`
Expected: PASS; сборка проходит.

- [ ] **Step 9: Commit**

```bash
git add index.html src/board.ts src/main.ts src/sessions.ts src/styles.css src/workspaces.ts tests/board.test.ts
git commit -m "feat(#43): board view, view switch and sidebar counts

Every card field goes in via textContent — titles and bodies are written
by the user or by an agent. Damaged and conflicting cards are rendered
with their reason instead of being dropped, and the busy indicator
animates opacity only. The board polls while visible, so tasks://changed
is pure latency improvement rather than a correctness dependency."
```

---

### Task 9: захват карточки — модалка, хоткей, палитра

**Issue:** #44

**Files:**
- Modify: `src/forms.ts` (`taskForm`)
- Create: `tests/task-form.test.ts`
- Modify: `src/commands.ts` (`matchHotkey`)
- Modify: `tests/commands.test.ts`
- Modify: `src/main.ts` (реальная `captureTask`)

**Interfaces:**
- Consumes: `src/modal.ts`, `createTask` из `src/ipc.ts`, тип `TaskDraft`.
- Produces: `taskForm(): Promise<TaskDraft | null>`; хоткей-id `"new-task"`.

- [ ] **Step 1: Написать падающие тесты**

`tests/task-form.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { taskForm } from "../src/forms";

describe("taskForm", () => {
  // Селекторы по классам, а не по [name]: в forms.ts у полей нет атрибута
  // name — там используются классы вида .form-name / .form-path.
  const ov = () => document.querySelector(".modal-overlay")!;

  it("returns the draft that was filled in", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "Пилюля мигает";
    ov().querySelector<HTMLTextAreaElement>(".tk-f-body")!.value = "Репро: три воркспейса.";
    ov().querySelector<HTMLButtonElement>("button[data-kind=bug]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();

    await expect(p).resolves.toEqual({
      title: "Пилюля мигает", kind: "bug", body: "Репро: три воркспейса.",
    });
  });

  it("defaults to kind=task when nothing is picked", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "Просто задача";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const draft = await p;
    expect(draft?.kind).toBe("task");
  });

  it("resolves null on cancel", async () => {
    const p = taskForm();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("closes on a backdrop click, like the other forms", async () => {
    const p = taskForm();
    const overlay = ov() as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it("refuses an empty title instead of creating a nameless card", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "   ";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    // Модалка осталась открытой, промис не разрешён.
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("does not nest the kind buttons in a label", async () => {
    const p = taskForm();
    const btn = ov().querySelector("button[data-kind=bug]")!;
    expect(btn.closest("label")).toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });
});
```

Дописать в `tests/commands.test.ts`:

```ts
it("maps the capture hotkey without shadowing readline", () => {
  const ev = { key: "T", metaKey: true, ctrlKey: false, shiftKey: true };
  expect(matchHotkey(ev, true)).toBe("new-task");
  // Без shift это не наш хоткей.
  expect(matchHotkey({ ...ev, shiftKey: false }, true)).toBeNull();
  // На Linux/Windows — только ctrl+shift, чтобы не глотать readline.
  expect(matchHotkey({ key: "T", metaKey: false, ctrlKey: true, shiftKey: true }, false)).toBe("new-task");
});
```

Смотри существующие импорты в `tests/commands.test.ts` — `matchHotkey` там уже импортирован.

- [ ] **Step 2: Запустить — должно упасть**

Run: `npx vitest run tests/task-form.test.ts tests/commands.test.ts`
Expected: FAIL — `taskForm is not exported`, и хоткей возвращает `null`.

- [ ] **Step 3: Написать форму**

Важно: `forms.ts` **не** использует хелперы из `modal.ts` — у него свои локальные (`overlay()` сам добавляет себя в `document.body`, `labeled(text, field)` оборачивает в `<label class="form-row">`, `actions()` без аргументов возвращает `{ row, ok, cancel }` с ненулевым `cancel` и текстом OK). Код ниже повторяет ровно структуру `workspaceForm`, включая закрытие по клику на подложку.

`src/forms.ts` — дописать в конец:

```ts
/** Быстрый захват карточки. Заголовок обязателен: карточка без имени
 *  бесполезна в бэклоге, поэтому пустой ввод не закрывает модалку. */
export function taskForm(): Promise<TaskDraft | null> {
  return new Promise((resolve) => {
    const { overlay: ov, box } = overlay();
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Новая задача";

    const titleInput = document.createElement("input");
    titleInput.className = "modal-input tk-f-title";
    titleInput.type = "text";
    titleInput.placeholder = "что случилось или что сделать";

    // Строка типа устроена как colorRow в workspaceForm: span-подпись + контролы
    // в <div>, а НЕ labeled() — клик по тексту <label> форвардится на первую
    // кнопку и молча менял бы выбор.
    let kind: TaskKind = "task";
    const kindRow = document.createElement("div");
    kindRow.className = "form-row";
    const kindLabelEl = document.createElement("span");
    kindLabelEl.className = "form-label";
    kindLabelEl.textContent = "Тип";
    const kindBox = document.createElement("div");
    kindBox.className = "tk-f-kinds";
    const kinds: [TaskKind, string][] = [["bug", "баг"], ["task", "задача"], ["idea", "идея"]];
    for (const [value, label] of kinds) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.kind = value;
      b.textContent = label;
      b.className = "tk-f-kind";
      b.classList.toggle("selected", value === kind);
      b.onclick = () => {
        kind = value;
        kindBox.querySelectorAll(".tk-f-kind").forEach((o) => o.classList.remove("selected"));
        b.classList.add("selected");
      };
      kindBox.append(b);
    }
    kindRow.append(kindLabelEl, kindBox);

    const bodyInput = document.createElement("textarea");
    bodyInput.className = "modal-input tk-f-body";
    bodyInput.rows = 5;
    bodyInput.placeholder = "репро, ссылки на файлы — что угодно";

    const { row, ok, cancel } = actions();
    box.append(title, labeled("Заголовок", titleInput), kindRow, labeled("Описание", bodyInput), row);

    const close = (v: TaskDraft | null) => { ov.remove(); resolve(v); };
    ok.onclick = () => {
      const t = titleInput.value.trim();
      if (!t) { titleInput.focus(); return; } // безымянную карточку не создаём
      close({ title: t, kind, body: bodyInput.value });
    };
    cancel.onclick = () => close(null);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
    titleInput.focus();
  });
}
```

Добавить импорт типов в начало `src/forms.ts` (в существующую строку `import type { Schedule, SchedulePreset } from "./ipc";`):

```ts
import type { Schedule, SchedulePreset, TaskDraft, TaskKind } from "./ipc";
```

И стили в конец `src/styles.css`:

```css
.tk-f-kinds { display: inline-flex; gap: var(--sp-1); }
.tk-f-kind {
  font: inherit; font-size: var(--fs-sm); color: var(--fg-muted);
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: var(--sp-1) var(--sp-2);
  min-height: 24px; cursor: pointer;
}
.tk-f-kind.selected { border-color: var(--accent); color: var(--fg); }
.tk-f-kind:focus-visible { outline: none; box-shadow: var(--focus-ring); }
```

- [ ] **Step 4: Запустить тесты формы**

Run: `npx vitest run tests/task-form.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Добавить хоткей**

`src/commands.ts` — в `matchHotkey`, перед строкой с `focus-`:

```ts
  if (k === "t" && e.shiftKey) return "new-task";
```

- [ ] **Step 6: Реализовать `captureTask`**

`src/main.ts` — заменить заглушку:

```ts
/** Быстрый захват: модалка, карточка в активное пространство, доска и
 *  счётчики обновляются сразу, не дожидаясь watcher'а. */
async function captureTask() {
  const ws = workspaces.active;
  if (!ws) { await alertModal("Выберите пространство."); return; }
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps?.canCreate) {
    await alertModal("Трекер не настроен для этого пространства. Настройте его в свойствах пространства (✎).");
    return;
  }
  const draft = await taskForm();
  if (!draft) return;
  try {
    await createTask(ws.id, draft);
  } catch (e) {
    await alertModal(`Не удалось создать задачу: ${String(e)}`);
    return;
  }
  if (boardVisible) await refreshBoard();
  await refreshCounts();
}
```

и добавить в импорты `main.ts`: `createTask` из `./ipc`, `taskForm` из `./forms`.

- [ ] **Step 7: Запустить всё**

Run: `npm test && npm run build`
Expected: PASS; сборка проходит.

- [ ] **Step 8: Commit**

```bash
git add src/commands.ts src/forms.ts src/main.ts tests/
git commit -m "feat(#44): capture a card from a hotkey, palette or the board

Cmd/Ctrl+Shift+T, so the binding does not shadow readline inside the
terminal the way bare Ctrl+K/F/N do. An empty title keeps the modal open
rather than filing a nameless card, and the kind buttons are not nested
in a label — a label click used to forward to the first control."
```

---

### Task 10: ▶ запуск сессии из карточки

**Issue:** #45

**Files:**
- Modify: `src/sessions.ts` (`launchFromTask`, `taskId` в `spawnTile`, персист в layout)
- Modify: `tests/sessions.test.ts`
- Modify: `src/ipc.ts` (`SessionEntry.taskId`)
- Modify: `src-tauri/src/model.rs` (`SessionEntry.task_id`)
- Modify: `src/main.ts` (реальная `launchFromTask`)

Связка `taskId` переживает перезапуск приложения: иначе после автовосстановления доска покажет карточку как `open`, и ▶ поднимет **вторую** сессию на ту же задачу.

**Interfaces:**
- Consumes: `tasks.ts` (`taskPrompt`, `liveSessionForTask`), `Deck.taskLinks()`.
- Produces: `Deck.launchFromTask(workspace, task, prompt): Promise<"launched" | "focused">`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/sessions.test.ts` (посмотри, как файл уже мокает IPC — используй тот же способ; для мок-переменных обязателен `vi.hoisted()`):

```ts
describe("serializeTiles + taskId", () => {
  it("persists the task link so a restored tile is still linked", () => {
    const tiles = [
      { session: "s1", workspacePath: "/p", name: "n", workspaceId: "w1", taskId: "01AAA" },
      { session: "s2", workspacePath: "/p", name: "n2", workspaceId: "w1" },
    ];
    const out = serializeTiles(tiles as never);
    expect(out[0].taskId).toBe("01AAA");
    expect(out[1].taskId).toBeUndefined();
  });
});
```

`tests/tasks.test.ts` — дописать тест на правило «не поднимать вторую»:

```ts
describe("launch guard", () => {
  it("an alive session for the card means focus, not a second launch", () => {
    const links: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "waitingInput" }];
    expect(liveSessionForTask("01AAA", links)).toBe("s1");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL — `taskId` отсутствует в результате `serializeTiles`.

- [ ] **Step 3: Провести `taskId` через сериализацию слоя**

`src/ipc.ts` — расширить `SessionEntry`:

```ts
export interface SessionEntry { sessionId: string; cwd: string; name: string; workspaceId?: string; taskId?: string; }
```

`src-tauri/src/model.rs` — в `SessionEntry` добавить поле (сохранив совместимость со старым файлом слоя):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
```

Посмотри фактическое имя полей и serde-атрибуты структуры — Run: `grep -n "struct SessionEntry" -A 10 src-tauri/src/model.rs` — и добавь поле в том же стиле (если структура использует `rename_all = "camelCase"`, ничего дополнительно не нужно).

`src/sessions.ts` — в `serializeTiles` добавить `taskId` в возвращаемый объект, и в `restore(entries)` передать `taskId: e.taskId` в `spawnTile`. Run: `grep -n "serializeTiles\|async restore" -A 12 src/sessions.ts`.

- [ ] **Step 4: Добавить запуск из карточки в `Deck`**

`src/sessions.ts` — в `spawnTile(opts)` добавить `taskId?: string` в тип `opts`, положить его в создаваемый `Tile`, и добавить публичный метод рядом с `launchScheduled`:

```ts
  /** Запуск сессии из карточки трекера. Если по карточке уже есть живая
   *  сессия — фокусируем её, а не поднимаем вторую: так же, как плановый
   *  сценарий пропускает наложившийся прогон. */
  async launchFromTask(
    workspace: Workspace, task: { id: string; title: string }, prompt: string,
  ): Promise<"launched" | "focused"> {
    const alive = liveSessionForTask(task.id, this.taskLinks());
    if (alive) { this.focusTile(alive); return "focused"; }
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText: `☑ ${task.title}`,
      prompt,
      resume: false,
      taskId: task.id,
    });
    return "launched";
  }
```

и импорт в начало `src/sessions.ts`:

```ts
import { liveSessionForTask } from "./tasks";
```

- [ ] **Step 5: Реализовать `launchFromTask` в `main.ts`**

Заменить заглушку:

```ts
/** ▶ на карточке. Пространство берётся из `project:` карточки, а не активное:
 *  на общем корне (например, папка волта на три проекта) активное пространство
 *  уронило бы работу в чужой каталог. */
async function launchFromTask(t: Task) {
  const target = workspaces.all.find((w) => w.name === t.project);
  if (!target) {
    await alertModal(
      `Не найдено пространство с именем «${t.project}» из поля project: карточки. ` +
      `Переименовано пространство? Запуск отменён, чтобы не начать работу в чужом каталоге.`);
    return;
  }
  const outcome = await deck.launchFromTask(target, t, taskPrompt(t));
  if (outcome === "launched") setView(false); // показать поднятый терминал
  if (boardVisible) await refreshBoard();
}
```

и добавить импорт `taskPrompt` из `./tasks`.

- [ ] **Step 6: Запустить всё**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm test && npm run build`
Expected: PASS везде.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/model.rs src/ipc.ts src/main.ts src/sessions.ts tests/
git commit -m "feat(#45): launch a session from a card

The workspace comes from the card's project field, not the active one: a
shared root would otherwise drop work into the wrong directory. An alive
session for the card focuses instead of launching a second one, and the
link is persisted in the layout so auto-restore cannot orphan it into a
duplicate launch."
```

---

### Task 11: настройка трекера в свойствах пространства

**Issue:** #46

Пока этого нет, фичу нельзя включить из UI вообще — только правкой JSON руками.

**Files:**
- Modify: `src/forms.ts` (`workspaceForm` получает секцию трекера)
- Modify: `tests/forms.test.ts`
- Modify: `src/main.ts` / `src/workspaces.ts` (передача `tracker` при сохранении)

**Interfaces:**
- Consumes: типы `TrackerConfig`, `TrackerRoot`, `Workspace`.
- Produces: `workspaceForm` возвращает объект, включающий `tracker: TrackerConfig | null`.

Точная текущая сигнатура (менять её надо аддитивно):

```ts
export function workspaceForm(
  initial?: { name: string; path: string; color: string },
): Promise<{ name: string; path: string; color: string } | null>
```

Поля адресуются классами, а не атрибутом `name`: `.form-name`, `.form-path`, свотчи `.form-swatch`. Подложка закрывает форму по `mousedown`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/forms.test.ts` (файл уже с `// @vitest-environment jsdom` в первой строке и уже импортирует `workspaceForm`):

```ts
describe("workspaceForm — трекер", () => {
  const ov = () => document.querySelector(".modal-overlay")!;
  const fill = () => {
    ov().querySelector<HTMLInputElement>(".form-name")!.value = "deck";
    ov().querySelector<HTMLInputElement>(".form-path")!.value = "/p";
  };

  it("off by default for a new workspace", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker ?? null).toBeNull();
  });

  it("in-project root produces a project provider", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=project]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker).toEqual({ providers: [{ type: "fs", root: { kind: "project" } }] });
  });

  it("external root carries the path the user typed", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-path")!.value = "/home/u/vault/Tasks";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker).toEqual({
      providers: [{ type: "fs", root: { kind: "path", path: "/home/u/vault/Tasks" } }],
    });
  });

  it("an external root with an empty path keeps the modal open", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    // Пустой путь — опечатка, а не «выключено»: форма остаётся открытой.
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("pre-fills from an existing workspace so editing does not wipe the config", async () => {
    const p = workspaceForm({
      name: "deck", path: "/p", color: "#61afef",
      tracker: { providers: [{ type: "fs", root: { kind: "path", path: "/v/T" } }] },
    });
    expect(ov().querySelector<HTMLInputElement>(".tk-f-on")!.checked).toBe(true);
    expect(ov().querySelector<HTMLInputElement>(".tk-f-path")!.value).toBe("/v/T");
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });

  it("still returns name/path/color unchanged", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.name).toBe("deck");
    expect(res?.path).toBe("/p");
    expect(typeof res?.color).toBe("string");
  });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `npx vitest run tests/forms.test.ts`
Expected: FAIL — в форме нет полей трекера.

- [ ] **Step 3: Расширить сигнатуру формы**

В `src/forms.ts` — заменить сигнатуру и тип результата `workspaceForm` (аддитивно, чтобы существующие вызовы продолжали компилироваться):

```ts
type WorkspaceFormResult = { name: string; path: string; color: string; tracker: TrackerConfig | null };

export function workspaceForm(
  initial?: { name: string; path: string; color: string; tracker?: TrackerConfig | null },
): Promise<WorkspaceFormResult | null> {
```

и обновить тип локального `close`:

```ts
    const close = (v: WorkspaceFormResult | null) => { ov.remove(); resolve(v); };
```

Добавить `TrackerConfig` в существующий импорт типов:

```ts
import type { Schedule, SchedulePreset, TaskDraft, TaskKind, TrackerConfig } from "./ipc";
```

- [ ] **Step 4: Добавить секцию трекера**

В `workspaceForm`, после блока `colorRow` и **до** `const { row, ok, cancel } = actions();`:

```ts
    // ——— Трекер задач ———
    // Чекбокс — одиночный контрол, <label> здесь уместен. Радиокнопки живут
    // каждая в своём <label>, тоже по одному контролу на label.
    const onLabel = document.createElement("label");
    onLabel.className = "form-row";
    const onInput = document.createElement("input");
    onInput.type = "checkbox";
    onInput.className = "tk-f-on";
    const onText = document.createElement("span");
    onText.className = "form-label";
    onText.textContent = "Трекер задач";
    onLabel.append(onInput, onText);

    const rootRow = document.createElement("div");
    rootRow.className = "form-row";
    const mkRadio = (value: "project" | "path", text: string) => {
      const l = document.createElement("label");
      const i = document.createElement("input");
      i.type = "radio";
      i.className = "tk-f-root";
      i.name = "trackerRoot";
      i.value = value;
      l.append(i, document.createTextNode(` ${text}`));
      rootRow.append(l);
      return i;
    };
    const projectRadio = mkRadio("project", "в проекте (.cowork/tasks)");
    const pathRadio = mkRadio("path", "своя папка");

    const trackerPath = document.createElement("input");
    trackerPath.className = "modal-input tk-f-path";
    trackerPath.type = "text";
    trackerPath.placeholder = "/home/…/vault/Tasks";

    const syncTracker = () => {
      rootRow.classList.toggle("tk-hidden", !onInput.checked);
      trackerPath.classList.toggle("tk-hidden", !onInput.checked || !pathRadio.checked);
    };
    onInput.onchange = syncTracker;
    projectRadio.onchange = syncTracker;
    pathRadio.onchange = syncTracker;

    // Предзаполнение: правка имени пространства не должна молча снести
    // настройку трекера.
    const initialRoot = initial?.tracker?.providers[0]?.root ?? null;
    if (initialRoot) {
      onInput.checked = true;
      if (initialRoot.kind === "path") { pathRadio.checked = true; trackerPath.value = initialRoot.path; }
      else projectRadio.checked = true;
    } else {
      projectRadio.checked = true;
    }
    syncTracker();
```

Затем добавить эти три узла в `box.append(...)` — заменить существующую строку на:

```ts
    box.append(title, labeled("Имя", name), labeled("Папка", pathRow), colorRow,
      onLabel, rootRow, trackerPath, row);
```

И расширить `ok.onclick`:

```ts
    ok.onclick = () => {
      const n = name.value.trim(); const p = path.value.trim();
      if (!n || !p) return; // требуются оба
      let tracker: TrackerConfig | null = null;
      if (onInput.checked) {
        if (pathRadio.checked) {
          const tp = trackerPath.value.trim();
          // Пустой путь — это не «выключено», это опечатка: не закрываем форму.
          if (!tp) { trackerPath.focus(); return; }
          tracker = { providers: [{ type: "fs", root: { kind: "path", path: tp } }] };
        } else {
          tracker = { providers: [{ type: "fs", root: { kind: "project" } }] };
        }
      }
      close({ name: n, path: p, color, tracker });
    };
```

- [ ] **Step 5: Донести `tracker` до сохранения**

Run: `grep -n "workspaceForm\|saveWorkspace" -B 4 -A 8 src/workspaces.ts`

Нужны две правки в одном месте:

1. **На вход формы** при редактировании передать существующий трекер, иначе правка имени его снесёт: в объект `initial` добавить `tracker: w.tracker ?? null`.
2. **На выход** — донести `tracker` до `saveWorkspace`: в собираемый `Workspace` добавить `tracker: res.tracker`.

После успешного сохранения нужно пересобрать watcher'ы и счётчики — в `main.ts` в колбэк изменения пространств (или сразу после `saveWorkspace` в `workspaces.ts`, если панель это инкапсулирует) добавить:

```ts
  await taskWatchSync();
  await refreshCounts();
```

- [ ] **Step 6: Добавить стиль скрытия**

`src/styles.css` — `.tk-hidden` уже добавлен в Task 8; убедись, что он применим к `input` (правило `display: none` универсально).

- [ ] **Step 7: Запустить всё**

Run: `npm test && npm run build && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS везде.

- [ ] **Step 8: Commit**

```bash
git add src/forms.ts src/main.ts src/workspaces.ts src/styles.css tests/forms.test.ts
git commit -m "feat(#46): configure the tracker per workspace

Storage is the user's choice: the in-project .cowork/tasks or any folder
they point at — a dedicated repo, an Obsidian vault. An external root
with an empty path keeps the modal open, because a blank path is a typo
rather than 'disabled'. Editing a workspace pre-fills the config so
renaming cannot silently wipe it."
```

---

### Task 12: навык для агента, документация и ручная проверка волта

**Issue:** #47

Без навыка агент не знает конвенции, и «сессия оформляет тикет сама» остаётся теоретической возможностью.

**Files:**
- Create: `.claude/skills/file-a-task/SKILL.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/RELEASE-1.0-CHECKLIST.md` (если пункты трекера уместны)

**Interfaces:**
- Consumes: CLI `cowork_task`, переменные `COWORK_TASKS_DIR`/`COWORK_PROJECT`/`COWORK_TASK_BIN`.
- Produces: документация; ручные проверки.

- [ ] **Step 1: Написать навык**

`.claude/skills/file-a-task/SKILL.md`:

```markdown
---
name: file-a-task
description: Use when you notice a problem, bug, or improvement that is outside the current task's scope - files it as a tracker card instead of expanding scope or forgetting it
---

# Оформить задачу в трекер

Ты работаешь внутри cowork-deck. Если по ходу дела ты замечаешь проблему,
которая **не входит** в текущую задачу, — не расширяй скоуп и не забывай о ней.
Оформи карточку и продолжай своё.

## Когда применять

- Нашёл баг в коде, который не трогаешь.
- Увидел TODO/хак, который стоит починить отдельно.
- Придумал улучшение, о котором тебя не просили.

## Когда НЕ применять

- Проблема **входит** в твою задачу — просто почини её.
- Ты не уверен, что это проблема, — сначала проверь, потом оформляй.
- Карточка уже есть: сначала посмотри `ls "$COWORK_TASKS_DIR"`.

## Как

```bash
"$COWORK_TASK_BIN" new --kind bug --title "Короткий заголовок" <<'EOF'
Что не так, как воспроизвести, где смотреть.
EOF
```

`--kind` — `bug`, `task` или `idea`. Тело читается со stdin и необязательно, но
без репро карточка почти бесполезна.

Если переменных окружения нет, трекер для этого пространства не настроен —
скажи об этом человеку и не пытайся угадать путь.

## Закрыть карточку

Если ты работаешь **по** карточке (её id есть в твоём первом промпте) и работа
закончена:

```bash
"$COWORK_TASK_BIN" done <id>
```

Не закрывай карточки, по которым не работал.

## Прочитать бэклог

Обычными тулами, никаких обёрток: `ls "$COWORK_TASKS_DIR"`, grep по каталогу.
Карточки — markdown с frontmatter.
```

- [ ] **Step 2: Обновить README**

В `README.md`, в список **Features**, после строки про `Run a schedule now`:

```markdown
- **Task tracker** — a per-workspace backlog of markdown cards (`.cowork/tasks/` in the project, or any folder you point at — a dedicated repo, an Obsidian vault). A Board view next to Terminals, `Cmd/Ctrl+Shift+T` to file one without leaving the deck, and ▶ on a card launches a session with the card as its prompt. Sessions file their own tickets via a bundled `cowork_task` CLI, so a side finding becomes a card instead of scope creep. "In progress" is derived from live sessions, never stored, so nothing gets stuck.
```

и в **Roadmap → Next** добавить:

```markdown
- **Tracker providers** — GitHub Issues and Jira boards inside the deck, configured per workspace on top of the existing `TaskProvider` port (needs system-keychain token storage).
```

- [ ] **Step 3: Ручная проверка — сосуществование с волтом**

Автотестом это не покрыть: нужен настоящий каталог с обычными заметками.

```bash
mkdir -p /tmp/fake-vault && cd /tmp/fake-vault
for i in $(seq 1 100); do printf '# Заметка %s\n\nтекст\n' "$i" > "заметка-$i.md"; done
mkdir -p Подпапка && printf -- '---\nid: 01DEEP\ntitle: t\n---\n' > Подпапка/глубокая.md
cd -
```

Затем: `npm run tauri dev`, создать пространство с трекером типа «своя папка» → `/tmp/fake-vault`, открыть «Доска».

Expected:
- Доска пустая («Задач нет»), **не** 100 повреждённых карточек.
- `+ задача` создаёт карточку, и она — единственная в списке.
- Карточка из `Подпапка/` не появилась (скан не рекурсивный).
- Переименовать файл карточки в «Человеческое имя.md» → карточка на месте, ✓ закрывает именно её.

- [ ] **Step 4: Ручная проверка — карточка от сессии**

В dev-сборке: открыть сессию в пространстве с трекером, ввести в терминале

```bash
"$COWORK_TASK_BIN" new --kind bug --title "Проверка из сессии" <<'EOF'
Тело из сессии.
EOF
```

Expected: карточка появилась на доске в пределах ~5 с (или мгновенно, если watcher жив) с бейджем `сессия`.

- [ ] **Step 5: Ручная проверка — сборка пакета содержит сайдкар**

Диарий ревьюера: бинарь-докладчик однажды не попал в установочный пакет, и определение состояния было мертво в установленном приложении.

```bash
npm run tauri build
```

Затем найти собранный бандл и убедиться, что `cowork_task` лежит рядом с основным исполняемым файлом (на Linux — в `src-tauri/target/release/bundle/`, внутри AppImage/deb; проще всего проверить `ls src-tauri/target/release/cowork_task` **и** содержимое бандла).

Expected: `cowork_task` присутствует в бандле, не только в `target/release`.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/file-a-task/ README.md
git commit -m "docs(#47): agent skill for filing tickets, README coverage

The skill is what makes 'a session files its own ticket' real rather than
theoretical: it tells the agent when a side finding becomes a card
instead of scope creep, and when to leave it alone."
```

---

## Self-Review

Проверено против спеки:

**Покрытие спеки.** Каждое из 13 ключевых решений имеет задачу: файлы за портом (1, 2), корень на воркспейс (3, 11), markdown+frontmatter (1), правило git (документируется в 12; кода не требует — именно в этом и был смысл решения), ULID (2), `id` в файле и резолв по нему (1, 2), `project:` всегда (2, 3, 10), карточка = файл с `id`+`title` (1, 2, 12), `status` полем (1), env+CLI (5, 6), «в работе» выводится (7, 8, 10), закрытие только явное (8, 12), capabilities и деградация UI (2, 3, 8). Таблица ошибок из спеки: watcher (4, 8), корень недоступен (2, 8), CLI без env (5), файл без `id` (1), битый с `id` (1, 8), дубликаты (2, 8), ▶ без пространства (10), живая сессия по карточке (10), пространство без трекера (3, 8).

**Один пробел найден и закрыт:** спека требует настройки трекера на воркспейс, но ни одна задача не давала UI для этого — добавлена Task 11, иначе фичу нельзя включить, не редактируя JSON руками.

**Второй пробел:** спека не оговаривала, что происходит со связкой `task_id → session` при автовосстановлении тайлов. Оставить как есть значило бы дать дубликат сессии на карточку после перезапуска приложения, поэтому Task 10 персистит связку в слое.

**Согласованность типов.** `Task`/`TaskDraft`/`ProviderCapabilities` определены в Task 1–2 (Rust, `rename_all = "camelCase"`) и в Task 3 (TS) одними именами полей; `TaskSessionLink` объявлен в Task 7 и потребляется в 8 и 10; `resolve_root` объявлен в Task 3 и используется в 4 и 6; `session_env` — в Task 6; `liveSessionForTask`/`taskPrompt`/`boardColumns` — в Task 7, потребляются в 8 и 10. `PtyManager::spawn` меняет сигнатуру в Task 6, там же обновляются оба существующих вызова.

**Третья правка после сверки с кодом.** Первая версия плана предполагала, что `forms.ts` использует хелперы `modal.ts`. Это не так: у него свои локальные `overlay()` (сам добавляет себя в `document.body`), `labeled()` и `actions()` без аргументов, а поля адресуются классами (`.form-name`, `.form-path`), а не атрибутом `name`. Код и селекторы в Task 9 и Task 11 приведены к фактическому виду, включая закрытие по клику на подложку — иначе исполнитель писал бы тесты под несуществующую разметку.

**Места, где план сознательно велит сверяться с кодом, а не угадывать:** приватное имя метода рендера в `WorkspacesPanel` (Task 8, Step 6), фактические поля и serde-атрибуты `SessionEntry` (Task 10, Step 3), точное место вызова `workspaceForm`/`saveWorkspace` в `workspaces.ts` (Task 11, Step 5), места конструирования `Workspace` в существующих тестах (Task 3, Step 3). Это не плейсхолдеры: каждый шаг говорит, что именно проверить и чем это заменить.
