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

    #[test]
    fn crlf_line_endings_parse_the_same_as_lf() {
        let crlf = VALID.replace('\n', "\r\n");
        let card = parse_card(&crlf, "/r/01K1-pill.md").expect("card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert_eq!(card.title, "Пилюля мигает при переключении");
        assert_eq!(card.status, TaskStatus::Open);
        assert_eq!(card.project, "cowork-deck");
        assert!(card.damaged.is_none(), "a stray \\r must not leak into a field value");
    }

    #[test]
    fn multiline_title_flattens_through_render_and_reparse() {
        let card = Task {
            id: "01K1".to_string(),
            title: "Баг:\nпилюля\nмигает".to_string(),
            kind: TaskKind::Bug,
            status: TaskStatus::Open,
            project: "cowork-deck".to_string(),
            created: "2026-07-27T13:20:11Z".to_string(),
            resolved: None,
            origin: TaskOrigin::Human,
            session: None,
            body: String::new(),
            path: "/r/x.md".to_string(),
            damaged: None,
            conflict: false,
        };
        let text = render_card(&card);
        assert_eq!(
            text.matches("---").count(),
            2,
            "exactly one opening and one closing delimiter"
        );
        let again = parse_card(&text, "/r/x.md").expect("card");
        assert_eq!(again.title, "Баг: пилюля мигает");
        assert!(again.damaged.is_none());
    }
}
