//! Where a memory note goes, and what it looks like when it gets there.
//!
//! Nothing here spawns anything, embeds anything or calls a model. It decides
//! paths and it writes markdown, which under ADR-0004 is the memory itself —
//! the index over it is a cache that may be thrown away and rebuilt.
//!
//! # This module does not choose the root
//!
//! ADR-0004 left the corpus root a parameter on purpose, and ADR-0006 answered
//! it: the root is the app's config directory, which is also [`crate::store`]'s
//! directory and also the sync repository root. So a [`Corpus`] is constructed
//! with a root and never resolves one, which is what lets every test here run
//! against a temporary directory.
//!
//! # The layout is the scope, and it is not negotiable
//!
//! ```text
//! <root>/{workspace_id}/Facts.md
//! <root>/{workspace_id}/Sessions/YYYY-MM/DD-topic.md
//! <root>/Diaries/{room}/YYYY-MM.md
//! ```
//!
//! The sidecar's `detect_scope` reads the *first* path segment as the scope and
//! refuses a path with fewer than two segments. Three consequences, all of them
//! silent if got wrong: a note nested under a `workspaces/` prefix gives every
//! workspace the same scope and collapses per-project search; a note written to
//! the root has no scope and is skipped without a word; and `Diaries` needs a
//! room, because `Diaries/2026-08.md` is two segments but the room is where the
//! scope's second half comes from.
//!
//! Every shape written here is also on `sync::manifest::ALLOWED`. A shape that
//! is written but not allowed is written and then ignored by git, which on the
//! second machine looks like data loss and reads like a sync bug —
//! [`tests::every_shape_this_module_writes_is_allowed_to_travel`] is what keeps
//! the two lists from drifting apart.
//!
//! # The shapes come from the reference, not from taste
//!
//! ADR-0003 ported a working indexer rather than designing one, and the corpus
//! it indexes has conventions of its own that are just as load-bearing as the
//! chunking: a `## TL;DR` section is the priority chunk, a fact is a dated
//! bullet that is marked rather than deleted, a diary is one pipe-separated
//! bullet per lesson and rotates monthly. Those are what this module writes.
//!
//! Note in particular that the sidecar strips frontmatter only when it is
//! exactly `---\n` … `\n---\n` at the very start of the file. Off by a blank
//! line and the frontmatter becomes prose, indexed as content. [`Note::render`]
//! is the only thing that produces a note, so that shape is asserted there
//! rather than hoped for at the call sites.
//!
//! The sidecar is deliberately not a dependency of this crate — it is a
//! separate binary outside the workspace (ADR-0003), so the agreement between
//! what this writes and what that parses is held by the tests below naming the
//! exact bytes, and by nothing else.

use chrono::{Datelike, NaiveDate};
use std::io;
use std::path::{Path, PathBuf};

/// The reserved global scope: a diary belongs to a room rather than to a
/// project, and that is what makes a lesson learned in one repository reach the
/// next one.
pub const DIARIES: &str = "Diaries";

const SESSIONS: &str = "Sessions";
const FACTS: &str = "Facts.md";

/// Longest slug, in **characters**. Bytes would cut a Cyrillic character in
/// half — ADR-0003 names character-versus-byte handling as the port's standing
/// hazard, and a filename is no more exempt from it than a chunk is.
const SLUG_CHARS: usize = 48;

/// How many same-day, same-topic notes one workspace can hold before the write
/// is refused. Past this something is wrong with the caller rather than with
/// the day.
const MAX_SAME_NAME: u32 = 99;

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// A filesystem-safe fragment of a note's name: lowercase, single dashes, and
/// short enough to keep the path within sane limits.
///
/// Deliberately **not** [`crate::tasks::slug`], which keeps only
/// `is_ascii_alphanumeric` and therefore turns any Cyrillic topic into the
/// single word `branch`. That is right for a git branch name and wrong here:
/// a session's topic is written in whatever language the work happened in, and
/// collapsing every Russian session of a day onto one filename would make the
/// collision suffix below the only thing telling them apart. `is_alphanumeric`
/// is the same choice `placeholders.ts` makes with `\p{L}`, for the same reason.
///
/// Path separators and dots are not alphanumeric and so become dashes rather
/// than being escaped — nothing this returns can climb out of the directory it
/// is joined to.
pub fn slug(topic: &str) -> String {
    let mut out = String::with_capacity(topic.len());
    for c in topic.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let cut = trimmed
        .char_indices()
        .nth(SLUG_CHARS)
        .map_or(trimmed.len(), |(i, _)| i);
    let cut = trimmed[..cut].trim_end_matches('-');
    if cut.is_empty() {
        "session".to_string()
    } else {
        cut.to_string()
    }
}

/// One plain path segment, or a refusal.
///
/// A workspace id is a `crypto.randomUUID()` and a room name is slugged before
/// it gets here, so in practice nothing reaches this that would fail it. It is
/// checked anyway because the root is the sync repository *and* the config
/// directory: a segment of `..` would put a note next to `accounts.json`, and
/// the cost of being wrong once is much higher than the cost of the check.
fn segment(s: &str) -> io::Result<&str> {
    if s.is_empty() {
        return Err(invalid("empty path segment"));
    }
    if s == "." || s == ".." {
        return Err(invalid(format!("path segment {s:?} climbs out of the corpus")));
    }
    if s.contains('/') || s.contains('\\') || s.contains('\0') {
        return Err(invalid(format!("path segment {s:?} is not a single segment")));
    }
    Ok(s)
}

/// `{workspace_id}/Sessions/YYYY-MM/DD-topic.md`, relative to the root.
///
/// The name is not unique and is not meant to be: see
/// [`Corpus::write_session_note`] for what happens when a day repeats itself.
pub fn session_note_rel(workspace_id: &str, date: NaiveDate, topic: &str) -> io::Result<String> {
    let ws = segment(workspace_id)?;
    Ok(format!(
        "{ws}/{SESSIONS}/{}/{:02}-{}.md",
        month(date),
        date.day(),
        slug(topic)
    ))
}

/// `{workspace_id}/Facts.md`, relative to the root.
pub fn facts_rel(workspace_id: &str) -> io::Result<String> {
    Ok(format!("{}/{FACTS}", segment(workspace_id)?))
}

/// `Diaries/{room}/YYYY-MM.md`, relative to the root.
///
/// Monthly rotation, which is the reference's choice and also the reason a room
/// with years of lessons stays readable: a diary is grepped and appended to far
/// more often than it is read end to end.
pub fn diary_rel(room: &str, date: NaiveDate) -> io::Result<String> {
    let room = segment(room)?;
    Ok(format!("{DIARIES}/{room}/{}.md", month(date)))
}

fn month(date: NaiveDate) -> String {
    format!("{:04}-{:02}", date.year(), date.month())
}

fn day(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// The day a note is filed under, in the person's own timezone.
///
/// `Utc::now()` would file an evening session in the Americas under tomorrow,
/// and a note is looked for on the day the work felt like it happened.
pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// One `## heading` and its prose.
#[derive(Debug, Clone)]
pub struct Section {
    pub heading: String,
    pub body: String,
}

/// A session note, assembled rather than accepted.
///
/// Capture (#365) hands over a title, a TL;DR and some sections; the
/// frontmatter, the H1 and the exact heading syntax are decided here. That
/// split is the point: a model asked for markdown will occasionally return
/// markdown that is *almost* right, and "almost" here means frontmatter parsed
/// as prose or a TL;DR the indexer does not recognise — a fault that shows up
/// months later as a note that never comes back from a search.
#[derive(Debug, Clone)]
pub struct Note {
    pub title: String,
    pub tldr: String,
    pub sections: Vec<Section>,
}

/// The first line of `s`, trimmed, with any leading heading hashes removed.
///
/// A heading is one line by definition. A model-supplied title carrying a
/// newline would otherwise put its tail in the body as prose, directly above
/// the TL;DR, where it becomes the first thing a reader sees and no chunk's
/// heading.
fn one_line(s: &str) -> String {
    s.lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_start_matches('#')
        .trim()
        .to_string()
}

impl Note {
    /// The note as it is written to disk.
    ///
    /// The frontmatter block is byte-exact on purpose: the sidecar strips it
    /// only when the file starts with `---\n` and the block ends with `\n---\n`.
    /// A blank line before it, a BOM, or `--- \n` and every key below is indexed
    /// as prose.
    pub fn render(&self, workspace_id: &str, date: NaiveDate) -> String {
        let mut s = String::new();
        s.push_str("---\n");
        s.push_str(&format!("date: {}\n", day(date)));
        s.push_str(&format!("workspace: {workspace_id}\n"));
        // A list, as the reference writes it. `parse_frontmatter` skips lines
        // beginning with a dash, so `tags` arrives with an empty value and the
        // block still terminates where it should.
        s.push_str("tags:\n  - session\n");
        // What distinguishes a note this app wrote from one a person wrote by
        // hand in the same directory. Nothing reads it yet; a corpus that
        // cannot tell the two apart later cannot be cleaned up either.
        s.push_str("saved: auto\n");
        s.push_str("---\n\n");

        let title = one_line(&self.title);
        let title = if title.is_empty() { "session".to_string() } else { title };
        s.push_str(&format!("# {} — {}\n\n", day(date), title));

        s.push_str("## TL;DR\n");
        s.push_str(self.tldr.trim());
        s.push('\n');

        for sec in &self.sections {
            let heading = one_line(&sec.heading);
            let body = sec.body.trim();
            if heading.is_empty() || body.is_empty() {
                continue;
            }
            s.push_str(&format!("\n## {heading}\n{body}\n"));
        }
        s
    }
}

/// One lesson, on its way to a room's diary.
///
/// Pipe-separated and one line, which is the reference's shape and the reason a
/// diary is grepped rather than read. `date` and `workspace` are prepended by
/// this module rather than supplied: they are facts the app knows exactly, and
/// a model asked to format them will eventually format one of them wrong.
#[derive(Debug, Clone)]
pub struct DiaryEntry {
    /// Which project the lesson came out of. A label, not an id — the id means
    /// nothing to somebody reading the diary in a text editor, and the diary is
    /// global precisely so that it is read outside the project it came from.
    pub workspace: String,
    pub severity: String,
    pub category: String,
    /// What happened.
    pub what: String,
    /// How to avoid it next time. The half that makes the entry worth keeping.
    pub avoid: String,
}

impl DiaryEntry {
    fn line(&self, date: NaiveDate) -> String {
        let f = |s: &str| one_line(s).replace('|', "/");
        format!(
            "- {} | {} | {} | {} | {} | {}",
            day(date),
            f(&self.workspace),
            f(&self.severity),
            f(&self.category),
            f(&self.what),
            f(&self.avoid),
        )
    }
}

/// The corpus under one root.
///
/// # One writer at a time
///
/// Every method here reads, decides and writes without holding a lock, which is
/// sound because the wrapup queue (#364) drains one job at a time and nothing
/// else writes the corpus. Two concurrent writers would race in two places: a
/// collision suffix chosen by both, and a `Facts.md` read-modify-write that
/// loses whichever append lands first. If the queue ever drains in parallel,
/// this is where the cost shows up.
pub struct Corpus {
    root: PathBuf,
}

impl Corpus {
    pub fn new(root: PathBuf) -> Corpus {
        Corpus { root }
    }

    /// Write a session note under a name that does not collide, and return the
    /// path it landed on.
    ///
    /// `DD-topic.md` is not unique: two sessions on the same day about the same
    /// thing produce the same name. The second gets `-2`, and so on. It is
    /// deliberately not resolved by appending one summary to another's note —
    /// that would give the indexer one chunk set spanning two unrelated pieces
    /// of work, which is exactly the noise summarising exists to avoid.
    ///
    /// A note with no TL;DR is refused rather than written. This is where
    /// #365's "not written as-is" is actually enforced: the indexer's priority
    /// chunk is the TL;DR, it is the only chunk allowed to be terser than the
    /// letter floor, and above the big-file threshold it is very nearly the only
    /// thing indexed at all. A note without one is a note that does not come
    /// back from a search, which is indistinguishable from never having been
    /// written except that it takes up space and looks fine.
    pub fn write_session_note(
        &self,
        workspace_id: &str,
        date: NaiveDate,
        topic: &str,
        note: &Note,
    ) -> io::Result<PathBuf> {
        if note.tldr.trim().is_empty() {
            return Err(invalid("a session note without a TL;DR is not written"));
        }
        let rel = session_note_rel(workspace_id, date, topic)?;
        let first = self.root.join(&rel);
        let dir = first
            .parent()
            .ok_or_else(|| invalid("a session note has no parent directory"))?
            .to_path_buf();
        let stem = format!("{:02}-{}", date.day(), slug(topic));

        let text = note.render(workspace_id, date);
        for n in 1..=MAX_SAME_NAME {
            let name = if n == 1 {
                format!("{stem}.md")
            } else {
                format!("{stem}-{n}.md")
            };
            let path = dir.join(&name);
            if path.try_exists()? {
                continue;
            }
            write_atomic(&path, &text)?;
            return Ok(path);
        }
        Err(invalid(format!(
            "{MAX_SAME_NAME} notes already named {stem} on {}",
            day(date)
        )))
    }

    /// Append facts to a workspace's `Facts.md`, each as a dated `[active]`
    /// bullet, and return the file's path.
    ///
    /// Each entry is the `subject — predicate — object` half only. The date and
    /// the marker are this module's to write, for the reason [`DiaryEntry`]
    /// gives: they are known exactly here, and a model formatting them will get
    /// one of them wrong eventually — after which grep stops finding the fact
    /// and nothing reports a fault.
    pub fn append_facts(
        &self,
        workspace_id: &str,
        date: NaiveDate,
        facts: &[String],
    ) -> io::Result<PathBuf> {
        let path = self.root.join(facts_rel(workspace_id)?);
        let mut text = read_or_empty(&path)?;
        let mut wrote = false;
        for fact in facts {
            let fact = one_line(fact);
            if fact.is_empty() {
                continue;
            }
            ensure_trailing_newline(&mut text);
            text.push_str(&format!("- {} [active] {}\n", day(date), fact));
            wrote = true;
        }
        if wrote {
            write_atomic(&path, &text)?;
        }
        Ok(path)
    }

    /// Mark a fact superseded and add its replacement directly below it.
    ///
    /// Returns whether anything matched. `old` is the text after the marker —
    /// the `subject — predicate — object` half, exactly as it was appended.
    ///
    /// The line is never deleted and never rewritten in place beyond its marker.
    /// ADR-0004 makes that a rule rather than a habit: the history of a fact is
    /// the useful part, and a corpus that quietly loses the old value cannot
    /// answer "when did this change, and to what".
    ///
    /// Every matching `[active]` line is marked, not just the first. A duplicate
    /// is already a defect, and marking one of two leaves the fact still
    /// asserted by the other — a half-superseded fact is worse than either
    /// state, because grep finds both and neither is wrong.
    // No caller yet, and worth saying why rather than deleting: ADR-0004 makes
    // "marked, never rewritten" the rule for facts, and this is that rule made
    // executable and tested. What is missing is something that *knows* a fact
    // has been superseded, which means showing the model the existing Facts.md
    // and asking — a feature with a cost, and not one #365 was asked for.
    #[allow(dead_code)]
    pub fn supersede_fact(
        &self,
        workspace_id: &str,
        date: NaiveDate,
        old: &str,
        replacement: &str,
    ) -> io::Result<bool> {
        let path = self.root.join(facts_rel(workspace_id)?);
        let text = read_or_empty(&path)?;
        let old = one_line(old);
        let replacement = one_line(replacement);
        if old.is_empty() {
            return Err(invalid("nothing named to supersede"));
        }

        let marker = format!("[superseded {}]", day(date));
        let mut out = String::with_capacity(text.len() + replacement.len() + 64);
        let mut last_hit: Option<usize> = None;
        let lines: Vec<&str> = text.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            match active_fact_body(line) {
                Some(body) if body == old => {
                    out.push_str(&line.replacen("[active]", &marker, 1));
                    out.push('\n');
                    last_hit = Some(i);
                }
                _ => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
            // Directly below the last line it replaces, so a reader scanning
            // for the fact finds the correction without scrolling.
            if last_hit == Some(i) && !replacement.is_empty() {
                let next_is_hit = lines
                    .get(i + 1)
                    .and_then(|l| active_fact_body(l))
                    .is_some_and(|b| b == old);
                if !next_is_hit {
                    out.push_str(&format!("- {} [active] {}\n", day(date), replacement));
                }
            }
        }

        if last_hit.is_none() {
            return Ok(false);
        }
        write_atomic(&path, &out)?;
        Ok(true)
    }

    /// Append a lesson to a room's diary for the month, and return its path.
    pub fn append_diary(
        &self,
        room: &str,
        date: NaiveDate,
        entry: &DiaryEntry,
    ) -> io::Result<PathBuf> {
        let path = self.root.join(diary_rel(&slug(room), date)?);
        let mut text = read_or_empty(&path)?;
        if text.trim().is_empty() {
            // A heading, so a month opened in an editor says which month it is,
            // and so the file is not a bare list with no context.
            text = format!("# {} — {}\n\n", month(date), slug(room));
        } else {
            ensure_trailing_newline(&mut text);
        }
        text.push_str(&entry.line(date));
        text.push('\n');
        write_atomic(&path, &text)?;
        Ok(path)
    }
}

/// One note as the corpus holds it, without having been read whole.
///
/// Everything here is either the path's or the filesystem's, except the title,
/// which costs the first few lines of the file. That is the whole bargain of
/// this listing: a corpus that has been filling for a year is hundreds of
/// files, and reading them whole to draw a column of names would be a page that
/// gets slower every month it is useful.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Listed {
    /// Relative to the corpus root, slash-separated — what
    /// [`crate::memory::memory_read_note`] takes back.
    pub file: String,
    /// The workspace id, or [`DIARIES`] for a lesson.
    pub scope: String,
    /// The room, for a diary, and nothing otherwise.
    pub room: Option<String>,
    /// `session`, `facts`, `diary`, or `other` for a file somebody put here
    /// themselves.
    pub kind: &'static str,
    /// `YYYY-MM-DD` for a session note, `YYYY-MM` for a diary, empty otherwise.
    ///
    /// From the path, which is where the day the work happened on is recorded.
    /// The mtime cannot say it: editing a note two months later would move it.
    pub when: String,
    /// The first `# ` heading, or the file stem when there is none.
    pub title: String,
    pub size: u64,
    /// Seconds since the epoch, and the only sort key that spans the three
    /// shapes: a session note's name carries a day, a diary's a month, and
    /// `Facts.md` carries nothing at all.
    pub mtime: f64,
}

/// How far into a file the title is looked for.
///
/// A note written by this module has its `# ` heading within a dozen lines —
/// frontmatter, a blank line, the heading. The cap is what keeps a stray
/// megabyte of markdown in the corpus from being read in full by a listing, and
/// a file whose heading is past it is shown by its stem, which is the same
/// fallback a file with no heading at all gets.
const TITLE_SCAN_BYTES: u64 = 8 * 1024;

impl Corpus {
    /// Every note in the corpus, newest first.
    ///
    /// **A directory walk, not a search**, and that difference is the reason the
    /// memory page is useful on a machine that has downloaded nothing: searching
    /// needs the sidecar spawned and a 479 MB model, and this needs neither. The
    /// layout is this module's own, so walking it here is a second reader of a
    /// thing we already own rather than a second guess at somebody else's.
    ///
    /// It skips exactly what the sidecar's `scan::scan` skips — a dotted name, a
    /// symlink, anything that is not `.md`, and anything too shallow to have a
    /// scope — because a listing that showed a `.tmp` the index can never return
    /// would be a page promising a note that no search will ever find.
    pub fn notes(&self) -> Vec<Listed> {
        let mut out = Vec::new();
        list_dir(&self.root, &self.root, &mut out);
        // Newest first, and by mtime because it is the only key all three shapes
        // have. Ties broken by path so the order is stable between reads — two
        // notes written in the same second are otherwise in whatever order the
        // directory happened to be walked in, which changes under a person for
        // no reason they can see.
        out.sort_by(|a, b| b.mtime.total_cmp(&a.mtime).then_with(|| a.file.cmp(&b.file)));
        out
    }
}

fn list_dir(root: &Path, dir: &Path, out: &mut Vec<Listed>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // Best-effort, exactly as the sidecar's walk is: one unreadable subtree
        // must not empty the page.
        eprintln!("memory: could not list {}", dir.display());
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // The dot rule, and it is load-bearing rather than tidy: `.index/`,
        // `.model/` and a half-written `.tmp` all live in this tree, and
        // `write_atomic` names its temporary file with a leading dot precisely
        // so that neither the indexer nor this sees it.
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // `file_type` does not follow the link, unlike `Path::is_dir`: a symlink
        // out of the corpus would list somebody's home directory, and a loop
        // would recurse until the stack ran out.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            list_dir(root, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        // Two segments at least, which is the sidecar's `detect_scope` rule: a
        // note at the root has no scope and is not indexed, so listing it would
        // promise something search cannot deliver.
        let Some((scope, room, kind, when)) = locate(&rel) else { continue };
        let (size, mtime) = match entry.metadata() {
            Ok(md) => (
                md.len(),
                md.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0),
            ),
            Err(_) => continue,
        };
        out.push(Listed {
            title: title_of(&path, &rel),
            file: rel,
            scope,
            room,
            kind,
            when,
            size,
            mtime,
        });
    }
}

/// What a relative path says about the note at it: its scope, its room, its
/// shape and its date.
///
/// The three shapes are the ones this module writes and `sync::manifest::ALLOWED`
/// allows, so the fourth arm is not a fallback for a bug — it is a file somebody
/// put in the corpus themselves, which is a directory of markdown and theirs.
/// Shown by what can be read off it rather than dropped.
fn locate(rel: &str) -> Option<(String, Option<String>, &'static str, String)> {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    if parts[0] == DIARIES {
        if parts.len() != 3 {
            return None;
        }
        let month = parts[2].trim_end_matches(".md").to_string();
        return Some((
            DIARIES.to_string(),
            Some(parts[1].to_string()),
            "diary",
            if is_month(&month) { month } else { String::new() },
        ));
    }
    if parts.len() == 2 && parts[1] == FACTS {
        return Some((parts[0].to_string(), None, "facts", String::new()));
    }
    if parts.len() == 4 && parts[1] == SESSIONS {
        let month = parts[2];
        let day = &parts[3][..parts[3].len().min(2)];
        let when = if is_month(month) && day.len() == 2 && day.chars().all(|c| c.is_ascii_digit()) {
            format!("{month}-{day}")
        } else {
            String::new()
        };
        return Some((parts[0].to_string(), None, "session", when));
    }
    Some((parts[0].to_string(), None, "other", String::new()))
}

fn is_month(s: &str) -> bool {
    s.len() == 7
        && s.as_bytes()[4] == b'-'
        && s[..4].chars().all(|c| c.is_ascii_digit())
        && s[5..].chars().all(|c| c.is_ascii_digit())
}

/// The first `# ` heading, or the file stem.
///
/// The same answer the sidecar's `corpus::find_title` gives, including its
/// insistence on the space — `#нет пробела` is not a heading — so a note is not
/// called one thing in the index and another on the page. It reads only as far
/// as the heading, and never past [`TITLE_SCAN_BYTES`].
fn title_of(path: &Path, rel: &str) -> String {
    use std::io::{BufRead, Read};
    let stem = || {
        Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let Ok(file) = std::fs::File::open(path) else { return stem() };
    let mut reader = std::io::BufReader::new(file).take(TITLE_SCAN_BYTES);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return stem(),
            Ok(_) => {}
        }
        if let Some(rest) = line.strip_prefix("# ") {
            let rest = rest.trim();
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
}

/// The text after the `[active]` marker of a fact bullet, if it is one.
#[allow(dead_code)] // Reached only from `supersede_fact` and the tests; see above.
fn active_fact_body(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix("- ")?;
    let at = rest.find("[active]")?;
    // Only a marker that follows the date, so a line merely mentioning
    // `[active]` in its prose is not mistaken for a fact's marker.
    if !rest[..at].trim().chars().all(|c| c.is_ascii_digit() || c == '-') {
        return None;
    }
    Some(rest[at + "[active]".len()..].trim())
}

fn read_or_empty(path: &Path) -> io::Result<String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}

fn ensure_trailing_newline(text: &mut String) {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
}

/// Write through a temp file and rename over the target.
///
/// The temp name is `.{name}.tmp`, and it is invisible to the sidecar's scanner
/// for two independent reasons: `walk` skips every entry whose name starts with
/// a dot, and it requires a `.md` extension. Either alone would do; relying on
/// only one of them is how a torn write becomes an indexed half note. `.tmp`
/// after the `.md` rather than before it, so the extension check fails too.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| invalid("a corpus path has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::Command;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cd-memory-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn note(tldr: &str) -> Note {
        Note {
            title: "the sidecar staged for the wrong target".into(),
            tldr: tldr.into(),
            sections: vec![Section { heading: "What we did".into(), body: "- read the script".into() }],
        }
    }

    // ----- the listing -----

    /// A corpus with one of each shape, so the walk has something to name.
    fn filled(root: &Path) {
        let c = Corpus::new(root.to_path_buf());
        c.write_session_note("ws-1", d(2026, 8, 31), "the wrapup queue", &note("It drains."))
            .unwrap();
        c.append_facts("ws-1", d(2026, 8, 31), &["memory — is — a port".to_string()])
            .unwrap();
        c.append_diary(
            "reviewer",
            d(2026, 8, 31),
            &DiaryEntry {
                workspace: "cowork-deck".into(),
                severity: "medium".into(),
                category: "review".into(),
                what: "a listing read every file whole".into(),
                avoid: "read as far as the heading".into(),
            },
        )
        .unwrap();
    }

    #[test]
    fn every_shape_is_listed_with_its_scope_its_date_and_its_title() {
        let root = tmp("listing");
        filled(&root);
        let notes = Corpus::new(root.clone()).notes();

        let session = notes.iter().find(|n| n.kind == "session").unwrap();
        assert_eq!(session.file, "ws-1/Sessions/2026-08/31-the-wrapup-queue.md");
        assert_eq!(session.scope, "ws-1");
        assert_eq!(session.room, None);
        assert_eq!(session.when, "2026-08-31");
        // Verbatim, including the date `Note::render` puts in the H1: the title
        // is what the file says, and a listing that edited it would disagree with
        // the note a person then opens. A row showing the date beside it is what
        // has to avoid saying it twice (#382).
        assert_eq!(session.title, "2026-08-31 — the sidecar staged for the wrong target");
        assert!(session.size > 0);

        let facts = notes.iter().find(|n| n.kind == "facts").unwrap();
        assert_eq!(facts.file, "ws-1/Facts.md");
        assert_eq!(facts.scope, "ws-1");
        // `Facts.md` carries no date at all, which is why the sort key cannot be
        // one — see `notes`.
        assert_eq!(facts.when, "");

        let diary = notes.iter().find(|n| n.kind == "diary").unwrap();
        assert_eq!(diary.file, "Diaries/reviewer/2026-08.md");
        assert_eq!(diary.scope, DIARIES);
        assert_eq!(diary.room.as_deref(), Some("reviewer"));
        assert_eq!(diary.when, "2026-08");
    }

    /// The dot rule, and it is the same one `scan.rs` applies. A listing that
    /// showed `.index/`, `.model/` or a torn `.tmp` would offer a person a note
    /// no search can ever return.
    #[test]
    fn the_walk_skips_what_the_indexer_skips() {
        let root = tmp("listing-skips");
        filled(&root);
        std::fs::create_dir_all(root.join(".index")).unwrap();
        std::fs::write(root.join(".index/cache.md"), "# not a note\n").unwrap();
        std::fs::write(root.join("ws-1/.31-torn.md.tmp"), "# torn\n").unwrap();
        std::fs::write(root.join("ws-1/notes.txt"), "not markdown").unwrap();
        // Two segments at least, which is `detect_scope`'s floor: a note at the
        // root has no scope and is not indexed.
        std::fs::write(root.join("loose.md"), "# loose\n").unwrap();

        let files: Vec<String> = Corpus::new(root).notes().into_iter().map(|n| n.file).collect();
        assert_eq!(
            files.iter().filter(|f| f.contains(".index") || f.contains("tmp")).count(),
            0,
        );
        assert!(!files.contains(&"loose.md".to_string()));
        assert!(!files.iter().any(|f| f.ends_with(".txt")));
        assert_eq!(files.len(), 3);
    }

    /// A file somebody put here themselves is theirs, and is shown rather than
    /// dropped — the same choice `labelHit` makes on the other side of the IPC.
    #[test]
    fn a_hand_written_file_is_listed_by_what_can_be_read_off_it() {
        let root = tmp("listing-hand");
        std::fs::create_dir_all(root.join("ws-1")).unwrap();
        std::fs::write(root.join("ws-1/scratch.md"), "no heading at all\n").unwrap();

        let notes = Corpus::new(root).notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].kind, "other");
        assert_eq!(notes[0].scope, "ws-1");
        // The stem, which is what `find_title` falls back to in the sidecar.
        assert_eq!(notes[0].title, "scratch");
    }

    /// Newest first, by mtime, because it is the only key the three shapes share.
    #[test]
    fn the_newest_note_comes_first() {
        let root = tmp("listing-order");
        filled(&root);
        let c = Corpus::new(root.clone());
        // Written last, so it is the newest whatever the filenames say — and its
        // filename deliberately sorts before the other session note's.
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.write_session_note("ws-2", d(2026, 1, 2), "an older day", &note("Still newest."))
            .unwrap();

        let notes = c.notes();
        assert_eq!(notes[0].file, "ws-2/Sessions/2026-01/02-an-older-day.md");
        assert_eq!(notes[0].when, "2026-01-02", "the date shown is the path's, not the clock's");
    }

    /// The scale the page has to survive: a corpus filling for a year is
    /// hundreds of files, and the listing reads the first lines of each rather
    /// than any of them whole.
    #[test]
    fn a_corpus_of_several_hundred_notes_is_listed() {
        let root = tmp("listing-scale");
        let c = Corpus::new(root.clone());
        for i in 0..300 {
            let day = 1 + (i % 28);
            c.write_session_note("ws-1", d(2026, 1, day), &format!("topic {i}"), &note("Done."))
                .unwrap();
        }
        let notes = c.notes();
        assert_eq!(notes.len(), 300);
        assert!(notes.iter().all(|n| !n.title.is_empty()));
    }

    /// The bargain of the listing, asserted rather than assumed: a note whose
    /// heading is past the cap is named by its stem instead of being read whole.
    #[test]
    fn a_title_is_looked_for_only_so_far_into_a_file() {
        let root = tmp("listing-title-cap");
        std::fs::create_dir_all(root.join("ws-1")).unwrap();
        let mut body = "x".repeat(TITLE_SCAN_BYTES as usize + 1024);
        body.push_str("\n# far too late\n");
        std::fs::write(root.join("ws-1/late.md"), body).unwrap();

        let notes = Corpus::new(root).notes();
        assert_eq!(notes[0].title, "late");
    }

    // ----- slug -----

    #[test]
    fn a_slug_is_lowercase_single_dashed_and_trimmed() {
        assert_eq!(slug("  The Sidecar's PATH!! "), "the-sidecar-s-path");
        assert_eq!(slug("a//b"), "a-b");
    }

    /// The reason this module does not reuse `tasks::slug`, which keeps only
    /// ASCII alphanumerics and would turn every one of these into `branch`.
    #[test]
    fn a_cyrillic_topic_keeps_its_letters() {
        assert_eq!(slug("Память проекта"), "память-проекта");
        assert_ne!(slug("Память проекта"), slug("Очередь wrapup"));
    }

    #[test]
    fn a_slug_is_cut_by_characters_not_bytes() {
        // 60 Cyrillic characters: 120 bytes. A byte-counting cut would take 24
        // of them, and a naive byte slice would panic mid-character.
        let s = slug(&"я".repeat(60));
        assert_eq!(s.chars().count(), SLUG_CHARS);
    }

    #[test]
    fn a_topic_with_no_letters_at_all_still_has_a_name() {
        assert_eq!(slug("///"), "session");
        assert_eq!(slug(""), "session");
    }

    #[test]
    fn a_slug_cannot_climb_out_of_its_directory() {
        assert_eq!(slug("../../accounts"), "accounts");
        assert_eq!(slug(".."), "session");
    }

    // ----- paths -----

    #[test]
    fn the_paths_are_the_layout_the_sidecar_expects() {
        assert_eq!(
            session_note_rel("ws-1", d(2026, 8, 24), "a topic").unwrap(),
            "ws-1/Sessions/2026-08/24-a-topic.md"
        );
        assert_eq!(facts_rel("ws-1").unwrap(), "ws-1/Facts.md");
        assert_eq!(diary_rel("reviewer", d(2026, 8, 24)).unwrap(), "Diaries/reviewer/2026-08.md");
    }

    #[test]
    fn a_single_digit_day_is_padded_so_a_month_sorts() {
        assert_eq!(
            session_note_rel("ws-1", d(2026, 8, 3), "x").unwrap(),
            "ws-1/Sessions/2026-08/03-x.md"
        );
    }

    #[test]
    fn a_workspace_id_that_is_not_a_segment_is_refused() {
        for bad in ["..", ".", "", "a/b", "a\\b"] {
            assert!(
                session_note_rel(bad, d(2026, 8, 24), "x").is_err(),
                "{bad:?} should not be accepted as a workspace id"
            );
            assert!(facts_rel(bad).is_err(), "{bad:?} should not name a Facts.md");
        }
    }

    // ----- the note's shape -----

    /// The frontmatter contract, asserted on the bytes because the parser that
    /// has to agree with it lives in another crate that this one deliberately
    /// does not depend on.
    #[test]
    fn a_rendered_note_starts_with_frontmatter_the_sidecar_will_strip() {
        let text = note("what happened").render("ws-1", d(2026, 8, 24));
        assert!(text.starts_with("---\n"), "no leading blank line, no BOM:\n{text}");
        let after = text.strip_prefix("---\n").unwrap();
        let end = after.find("\n---\n").expect("the block has to terminate exactly so");
        let block = &after[..end];
        assert!(block.contains("date: 2026-08-24"));
        assert!(block.contains("workspace: ws-1"));
        // The body starts after the block, and nothing of the block leaks into it.
        let body = &after[end + "\n---\n".len()..];
        assert!(!body.contains("saved:"), "frontmatter must not appear in the body");
    }

    #[test]
    fn a_rendered_note_has_an_h1_and_a_tldr_the_indexer_recognises() {
        let text = note("three lines of what actually happened").render("ws-1", d(2026, 8, 24));
        assert!(
            text.contains("\n# 2026-08-24 — the sidecar staged for the wrong target\n"),
            "{text}"
        );
        // `find_tldr` matches a heading line of `## TL;DR` and nothing after it
        // on that line, then takes everything up to the next `## `.
        assert!(text.contains("\n## TL;DR\nthree lines of what actually happened\n"), "{text}");
        assert!(text.contains("\n## What we did\n- read the script\n"), "{text}");
    }

    #[test]
    fn a_title_carrying_a_newline_does_not_spill_into_the_body() {
        let mut n = note("x");
        n.title = "## a heading\nand a second line".into();
        let text = n.render("ws-1", d(2026, 8, 24));
        assert!(text.contains("# 2026-08-24 — a heading\n"), "{text}");
        assert!(!text.contains("and a second line"), "{text}");
    }

    #[test]
    fn an_empty_section_is_left_out_rather_than_written_hollow() {
        let mut n = note("x");
        n.sections = vec![
            Section { heading: "Kept".into(), body: "something".into() },
            Section { heading: "Dropped".into(), body: "   ".into() },
            Section { heading: "  ".into(), body: "orphaned".into() },
        ];
        let text = n.render("ws-1", d(2026, 8, 24));
        assert!(text.contains("## Kept"));
        assert!(!text.contains("## Dropped"));
        assert!(!text.contains("orphaned"));
    }

    // ----- writing a note -----

    #[test]
    fn a_note_is_written_where_its_scope_says() {
        let root = tmp("note");
        let c = Corpus::new(root.clone());
        let p = c.write_session_note("ws-1", d(2026, 8, 24), "the queue", &note("x")).unwrap();
        assert_eq!(p, root.join("ws-1/Sessions/2026-08/24-the-queue.md"));
        assert!(std::fs::read_to_string(&p).unwrap().contains("## TL;DR"));
    }

    #[test]
    fn a_note_without_a_tldr_is_refused_and_writes_nothing() {
        let root = tmp("no-tldr");
        let c = Corpus::new(root.clone());
        let e = c
            .write_session_note("ws-1", d(2026, 8, 24), "t", &note("   \n  "))
            .expect_err("a note with no TL;DR must not be written");
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
        assert!(!root.join("ws-1").exists(), "and it does not even make the directory");
    }

    #[test]
    fn a_second_session_on_one_day_about_one_thing_does_not_overwrite_the_first() {
        let root = tmp("collide");
        let c = Corpus::new(root.clone());
        let mut first = note("the first session");
        first.title = "first".into();
        let mut second = note("the second session");
        second.title = "second".into();

        let a = c.write_session_note("ws-1", d(2026, 8, 24), "one topic", &first).unwrap();
        let b = c.write_session_note("ws-1", d(2026, 8, 24), "one topic", &second).unwrap();

        assert_eq!(a.file_name().unwrap(), "24-one-topic.md");
        assert_eq!(b.file_name().unwrap(), "24-one-topic-2.md");
        assert!(std::fs::read_to_string(&a).unwrap().contains("the first session"));
        assert!(std::fs::read_to_string(&b).unwrap().contains("the second session"));
    }

    /// The temp file has to be invisible to the scanner for both of the reasons
    /// the sidecar's `walk` gives, not just one of them.
    #[test]
    fn the_temp_name_is_hidden_and_is_not_markdown() {
        let root = tmp("torn");
        let dir = root.join("ws-1/Sessions/2026-08");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("24-topic.md");
        // What a kill between the write and the rename leaves behind.
        let tmp_path = dir.join(".24-topic.md.tmp");
        std::fs::write(&tmp_path, "half a note").unwrap();

        let name = tmp_path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.'), "walk skips dot-prefixed entries");
        assert_ne!(
            tmp_path.extension().and_then(|e| e.to_str()),
            Some("md"),
            "walk requires a .md extension"
        );
        assert!(!target.exists(), "and the target is not there at all until the rename");
    }

    // ----- facts -----

    #[test]
    fn facts_are_appended_as_dated_active_bullets() {
        let root = tmp("facts");
        let c = Corpus::new(root.clone());
        let p = c
            .append_facts(
                "ws-1",
                d(2026, 8, 24),
                &["the root is the config directory".into(), "sync is opt-in".into()],
            )
            .unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            text,
            "- 2026-08-24 [active] the root is the config directory\n\
             - 2026-08-24 [active] sync is opt-in\n"
        );
    }

    #[test]
    fn a_second_append_keeps_the_first_and_does_not_run_the_lines_together() {
        let root = tmp("facts-2");
        let c = Corpus::new(root.clone());
        c.append_facts("ws-1", d(2026, 8, 24), &["one".into()]).unwrap();
        // A file somebody edited by hand and left without a trailing newline.
        let p = root.join("ws-1/Facts.md");
        let mut text = std::fs::read_to_string(&p).unwrap();
        text = text.trim_end().to_string();
        std::fs::write(&p, &text).unwrap();

        c.append_facts("ws-1", d(2026, 8, 25), &["two".into()]).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("[active] one\n"), "{text}");
        assert!(text.ends_with("- 2026-08-25 [active] two\n"), "{text}");
        assert_eq!(text.lines().count(), 2, "{text}");
    }

    #[test]
    fn an_empty_fact_is_not_written_and_neither_is_the_file() {
        let root = tmp("facts-empty");
        let c = Corpus::new(root.clone());
        c.append_facts("ws-1", d(2026, 8, 24), &["  ".into()]).unwrap();
        assert!(!root.join("ws-1/Facts.md").exists());
    }

    #[test]
    fn a_superseded_fact_is_marked_in_place_and_the_replacement_goes_below_it() {
        let root = tmp("supersede");
        let c = Corpus::new(root.clone());
        c.append_facts(
            "ws-1",
            d(2026, 8, 24),
            &["memory lives in app_data_dir".into(), "sync is opt-in".into()],
        )
        .unwrap();

        let hit = c
            .supersede_fact(
                "ws-1",
                d(2026, 8, 31),
                "memory lives in app_data_dir",
                "memory lives in the config directory",
            )
            .unwrap();
        assert!(hit);

        let text = std::fs::read_to_string(root.join("ws-1/Facts.md")).unwrap();
        assert_eq!(
            text,
            "- 2026-08-24 [superseded 2026-08-31] memory lives in app_data_dir\n\
             - 2026-08-31 [active] memory lives in the config directory\n\
             - 2026-08-24 [active] sync is opt-in\n",
            "the old line survives, marked, and the correction sits directly under it"
        );
    }

    #[test]
    fn superseding_a_fact_nobody_recorded_changes_nothing() {
        let root = tmp("supersede-miss");
        let c = Corpus::new(root.clone());
        c.append_facts("ws-1", d(2026, 8, 24), &["one".into()]).unwrap();
        let before = std::fs::read_to_string(root.join("ws-1/Facts.md")).unwrap();

        assert!(!c.supersede_fact("ws-1", d(2026, 8, 31), "never recorded", "x").unwrap());
        assert_eq!(std::fs::read_to_string(root.join("ws-1/Facts.md")).unwrap(), before);
    }

    /// A duplicate is already a defect; marking one of two would leave the fact
    /// asserted by the other, with grep finding both.
    #[test]
    fn every_active_copy_of_a_fact_is_marked_and_one_replacement_is_added() {
        let root = tmp("supersede-dupes");
        let c = Corpus::new(root.clone());
        c.append_facts("ws-1", d(2026, 8, 24), &["the same fact".into(), "the same fact".into()])
            .unwrap();

        assert!(c.supersede_fact("ws-1", d(2026, 8, 31), "the same fact", "the new one").unwrap());
        let text = std::fs::read_to_string(root.join("ws-1/Facts.md")).unwrap();
        assert_eq!(text.matches("[superseded 2026-08-31]").count(), 2, "{text}");
        assert_eq!(text.matches("[active] the new one").count(), 1, "{text}");
    }

    #[test]
    fn a_line_merely_mentioning_the_marker_is_not_a_fact() {
        assert_eq!(active_fact_body("- 2026-08-24 [active] a fact"), Some("a fact"));
        assert_eq!(active_fact_body("- the word [active] appears here"), None);
        assert_eq!(active_fact_body("not a bullet [active] x"), None);
        assert_eq!(active_fact_body("- 2026-08-24 [superseded 2026-08-31] old"), None);
    }

    // ----- diaries -----

    #[test]
    fn a_diary_rotates_monthly_and_gets_one_line_per_lesson() {
        let root = tmp("diary");
        let c = Corpus::new(root.clone());
        let entry = DiaryEntry {
            workspace: "cowork-deck".into(),
            severity: "high".into(),
            category: "packaging".into(),
            what: "the sidecar was staged for the host triple on a cross build".into(),
            avoid: "read TAURI_ENV_TARGET_TRIPLE, never rustc -Vv, inside a tauri hook".into(),
        };
        let p = c.append_diary("reviewer", d(2026, 8, 24), &entry).unwrap();
        assert_eq!(p, root.join("Diaries/reviewer/2026-08.md"));

        c.append_diary("reviewer", d(2026, 8, 25), &entry).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("# 2026-08 — reviewer\n"), "{text}");
        assert_eq!(text.matches("\n- 2026-08-").count(), 2, "{text}");
        assert!(text.contains("| high | packaging |"), "{text}");

        // A new month is a new file, and the old one is untouched.
        let q = c.append_diary("reviewer", d(2026, 9, 1), &entry).unwrap();
        assert_eq!(q, root.join("Diaries/reviewer/2026-09.md"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), text);
    }

    /// A pipe inside a field would make one entry look like it had seven, which
    /// is a diary that cannot be split by the thing that reads it.
    #[test]
    fn a_pipe_inside_a_lesson_does_not_become_a_field_separator() {
        let root = tmp("diary-pipe");
        let c = Corpus::new(root.clone());
        let entry = DiaryEntry {
            workspace: "w".into(),
            severity: "low".into(),
            category: "c".into(),
            what: "ran `a | b` and lost the exit code".into(),
            avoid: "set -o pipefail".into(),
        };
        let p = c.append_diary("reviewer", d(2026, 8, 24), &entry).unwrap();
        let line = std::fs::read_to_string(&p)
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .to_string();
        assert_eq!(line.matches('|').count(), 5, "{line}");
    }

    #[test]
    fn a_room_name_is_slugged_before_it_becomes_a_directory() {
        let root = tmp("diary-room");
        let c = Corpus::new(root.clone());
        let entry = DiaryEntry {
            workspace: "w".into(),
            severity: "s".into(),
            category: "c".into(),
            what: "x".into(),
            avoid: "y".into(),
        };
        let p = c.append_diary("Code Reviewer", d(2026, 8, 24), &entry).unwrap();
        assert_eq!(p, root.join("Diaries/code-reviewer/2026-08.md"));
    }

    // ----- the contract with sync -----

    /// The guarantee that this module and `sync::manifest` cannot drift apart,
    /// asserted against real git for the reason the manifest's own test gives:
    /// what travels is decided by git, so git is what has to agree.
    ///
    /// A shape written here but not allowed there is written and then silently
    /// ignored — on the second machine that is a note that never arrived, and it
    /// reads like a sync bug rather than like a missing line in a list.
    #[test]
    fn every_shape_this_module_writes_is_allowed_to_travel() {
        let root = tmp("travels");
        let c = Corpus::new(root.clone());

        let entry = DiaryEntry {
            workspace: "w".into(),
            severity: "s".into(),
            category: "c".into(),
            what: "x".into(),
            avoid: "y".into(),
        };
        let mut expected: BTreeSet<String> = BTreeSet::new();
        for rel in [
            c.write_session_note("ws-1", d(2026, 8, 24), "a topic", &note("x")).unwrap(),
            c.write_session_note("ws-1", d(2026, 8, 24), "a topic", &note("x")).unwrap(),
            c.write_session_note("ws-1", d(2026, 8, 24), "Память проекта", &note("x")).unwrap(),
            c.append_facts("ws-1", d(2026, 8, 24), &["a fact".into()]).unwrap(),
            c.append_diary("reviewer", d(2026, 8, 24), &entry).unwrap(),
        ] {
            expected.insert(
                rel.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
        expected.insert(".gitignore".to_string());

        std::fs::write(root.join(".gitignore"), crate::sync::manifest::gitignore()).unwrap();
        // `core.quotePath=false`, or `ls-files` returns the Cyrillic note as
        // `"ws-1/Sessions/2026-08/24-\320\277..."` — C-quoted and octal-escaped,
        // which compares equal to nothing and looks exactly like a path that did
        // not travel. The neighbouring test in `sync::manifest` never meets this
        // because every fixture it writes is ASCII.
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(["-c", "core.quotePath=false"])
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        let tracked: BTreeSet<String> = git(&["ls-files"]).lines().map(str::to_string).collect();

        assert_eq!(
            tracked, expected,
            "every path this module writes must be on sync::manifest::ALLOWED\n  \
             not travelling: {:?}",
            expected.difference(&tracked).collect::<Vec<_>>()
        );
    }
}
