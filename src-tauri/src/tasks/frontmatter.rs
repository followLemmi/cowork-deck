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
            damage("no title field");
            file_name(path)
        }
    };

    let kind = match field(head, "kind") {
        None => TaskKind::Task,
        Some("bug") => TaskKind::Bug,
        Some("task") => TaskKind::Task,
        Some("idea") => TaskKind::Idea,
        Some(_) => { damage("unknown kind"); TaskKind::Task }
    };

    let status = match field(head, "status") {
        Some("open") => TaskStatus::Open,
        Some("done") => TaskStatus::Done,
        None => { damage("no status field"); TaskStatus::Open }
        Some(_) => { damage("unknown status"); TaskStatus::Open }
    };

    let project = match field(head, "project") {
        Some(p) => p.to_string(),
        None => { damage("no project field"); String::new() }
    };

    let created = match field(head, "created") {
        Some(c) => c.to_string(),
        None => { damage("no created field"); String::new() }
    };

    let origin = match field(head, "origin") {
        Some("human") => TaskOrigin::Human,
        Some("session") => TaskOrigin::Session,
        None => TaskOrigin::Human,
        Some(_) => { damage("unknown origin"); TaskOrigin::Human }
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

/// Close a card: `status: done` plus a `resolved:` timestamp.
///
/// This exists so `resolve` never goes through `render_card` (which only
/// knows nine keys) on a real vault file: a card that also carries `tags:`,
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
title: The pill blinks when switching\n\
kind: bug\n\
status: open\n\
project: cowork-deck\n\
created: 2026-07-27T13:20:11Z\n\
origin: session\n\
session: a3f1c2\n\
---\n\
Repro: three workspaces, Cmd+2.\n";

    #[test]
    fn parses_a_valid_card() {
        let card = parse_card(VALID, "/r/01K1-pill.md").expect("card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert_eq!(card.title, "The pill blinks when switching");
        assert_eq!(card.kind, TaskKind::Bug);
        assert_eq!(card.status, TaskStatus::Open);
        assert_eq!(card.project, "cowork-deck");
        assert_eq!(card.origin, TaskOrigin::Session);
        assert_eq!(card.session.as_deref(), Some("a3f1c2"));
        assert_eq!(card.body.trim(), "Repro: three workspaces, Cmd+2.");
        assert!(card.damaged.is_none());
    }

    #[test]
    fn a_file_without_id_is_not_a_card() {
        let text = "---\ntitle: An ordinary note\n---\ntext\n";
        assert!(parse_card(text, "/r/note.md").is_none());
    }

    #[test]
    fn a_file_without_frontmatter_is_not_a_card() {
        assert!(parse_card("# just a note\n", "/r/note.md").is_none());
    }

    #[test]
    fn id_present_but_broken_rest_is_damaged_not_dropped() {
        let text = "---\nid: 01K1B7QW9XZ3M4N5P6R7S8T9V0\nstatus: nonsense\n---\nbody\n";
        let card = parse_card(text, "/r/01K1-x.md").expect("still a card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert!(card.damaged.is_some(), "must be flagged, never silently hidden");
        // The title falls back to the file name so the card stays visible on the board.
        assert_eq!(card.title, "01K1-x.md");
        assert_eq!(card.status, TaskStatus::Open);
    }

    #[test]
    fn title_may_contain_a_colon() {
        let text = "---\nid: 01K1\ntitle: Bug: the pill blinks\nproject: p\n---\n";
        let card = parse_card(text, "/r/x.md").expect("card");
        assert_eq!(card.title, "Bug: the pill blinks");
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
    // Deliberately Cyrillic, like the placeholder fixtures in src/placeholders.ts:
    // a card title is written in whatever language its author thinks in, which the
    // interface language does not constrain. slugify keeps letters via `char::is_alphanumeric`
    // rather than an ASCII test, and the file name has to stay usable either way.
    // Rewriting these two cases in ASCII would delete the coverage, not translate it.
    fn slugify_keeps_cyrillic_and_strips_punctuation() {
        assert_eq!(slugify("Баг: пилюля мигает!"), "баг-пилюля-мигает");
        assert_eq!(slugify("  a//b  "), "a-b");
        assert_eq!(slugify(""), "task");
        assert_eq!(slugify(&"я".repeat(80)).chars().count(), 40);
    }

    #[test]
    fn set_status_done_preserves_an_unknown_key() {
        let text = "---\nid: 01K1\ntitle: t\nstatus: open\nproject: p\ntags: [inbox]\n---\nbody\n";
        let out = set_status_done(text, "2026-07-27T14:00:00Z").expect("has frontmatter");
        assert!(out.contains("tags: [inbox]"), "unknown key must survive: {out}");
        assert!(out.contains("status: done"));
        assert!(out.contains("resolved: 2026-07-27T14:00:00Z"));
    }

    #[test]
    fn set_status_done_inserts_resolved_when_missing() {
        let text = "---\nid: 01K1\nstatus: open\n---\nbody\n";
        let out = set_status_done(text, "2026-07-27T14:00:00Z").unwrap();
        assert_eq!(out.matches("resolved:").count(), 1);
        assert!(out.contains("resolved: 2026-07-27T14:00:00Z"));
    }

    #[test]
    fn set_status_done_replaces_resolved_when_already_present() {
        let text = "---\nid: 01K1\nstatus: open\nresolved: 2020-01-01T00:00:00Z\n---\nbody\n";
        let out = set_status_done(text, "2026-07-27T14:00:00Z").unwrap();
        assert_eq!(out.matches("resolved:").count(), 1, "must not duplicate the line");
        assert!(out.contains("resolved: 2026-07-27T14:00:00Z"));
        assert!(!out.contains("2020-01-01"));
    }

    #[test]
    fn set_status_done_leaves_the_body_untouched() {
        let text = "---\nid: 01K1\nstatus: open\n---\nFirst line.\nSecond line.\n";
        let out = set_status_done(text, "ts").unwrap();
        assert!(out.ends_with("First line.\nSecond line.\n"));
    }

    #[test]
    fn set_status_done_keeps_crlf_input_crlf() {
        let text = "---\r\nid: 01K1\r\nstatus: open\r\n---\r\nbody\r\n";
        let out = set_status_done(text, "ts").unwrap();
        assert!(!out.contains("open"));
        assert!(out.contains("\r\n"), "line endings must stay CRLF: {out:?}");
        assert!(!out.replace("\r\n", "").contains('\n'), "no stray bare LF: {out:?}");
    }

    #[test]
    fn set_status_done_returns_none_without_frontmatter() {
        assert!(set_status_done("just text\n", "ts").is_none());
    }

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

    #[test]
    fn crlf_line_endings_parse_the_same_as_lf() {
        let crlf = VALID.replace('\n', "\r\n");
        let card = parse_card(&crlf, "/r/01K1-pill.md").expect("card");
        assert_eq!(card.id, "01K1B7QW9XZ3M4N5P6R7S8T9V0");
        assert_eq!(card.title, "The pill blinks when switching");
        assert_eq!(card.status, TaskStatus::Open);
        assert_eq!(card.project, "cowork-deck");
        assert!(card.damaged.is_none(), "a stray \\r must not leak into a field value");
    }

    #[test]
    fn multiline_title_flattens_through_render_and_reparse() {
        let card = Task {
            id: "01K1".to_string(),
            title: "Bug:\nthe pill\nblinks".to_string(),
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
        assert_eq!(again.title, "Bug: the pill blinks");
        assert!(again.damaged.is_none());
    }
}
