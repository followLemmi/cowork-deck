//! Which two records are one project, and which only look alike.
//!
//! # The problem this exists for
//!
//! A workspace id is `crypto.randomUUID()` on whichever machine first added the
//! folder. Two machines that each added the same project before sync was
//! switched on never agreed on one, so the arriving record matches nothing local
//! and a second workspace is written for a project that already has one (#348).
//!
//! The path cannot stand in as identity — it is deliberately stripped on the way
//! out, because it is one machine's disk (#313). What is the same string on both
//! machines is the remote the folder points at, and that is what
//! [`crate::model::WorkspaceRepo`] remembers and `adopt` compares by.
//!
//! # Why the answer is written down rather than recomputed
//!
//! "Same project" and "not the same project" are both *decisions a person made*,
//! and neither can be re-derived: the first survives the remote being renamed,
//! and the second is the whole content of "no, those are two different checkouts
//! of the same fork". A ledger of the answers is the only place they can live.
//!
//! It travels with the repository, so the second machine does not ask the same
//! question again — the answer is about the projects, not about the machine that
//! happened to be asked. A merge in particular *has* to travel: withdrawing the
//! losing record without saying why would leave the machine that owns it
//! republishing it on its next cycle, forever.
//!
//! # Merging keeps both histories
//!
//! Nothing is dropped. `apply` moves the losing id's memory under the surviving
//! one — the first path segment is the search scope (ADR-0004), so moving the
//! files *is* the redirect — and rewrites the id in this machine's run journal,
//! deck layout, terminal drawer and scenarios.
//!
//! Tracker cards need nothing: a board root is derived from the workspace's path
//! and its name (`tasks_cmd::resolve_root`), never from its id, so cards for the
//! surviving workspace are already where it will look.

use crate::model::{Workspace, WorkspaceRepo};
use crate::sync::git;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- resolving

/// What repository this folder is, read from git rather than `gh`.
///
/// `gh` is not asked: `owner/name` would be prettier, but it costs a network
/// round trip and an authenticated account, and the comparison only needs a
/// string both machines produce. `normalise_repo` already makes the spellings
/// agree.
///
/// A workspace with no path yet — one that arrived from another machine and has
/// not been located here — resolves to nothing at all rather than to "asked, and
/// there is none": there was no folder to ask.
pub fn resolve(path: &str) -> Option<WorkspaceRepo> {
    let trimmed = path.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_dir() {
        return None;
    }
    Some(WorkspaceRepo { url: git::remote_url(Path::new(trimmed)), from: trimmed.to_string() })
}

/// Fill in what has not been asked, and re-ask where the folder moved.
///
/// Answers whether anything changed, so the caller can decide whether the store
/// is worth rewriting. Cheap by construction: a workspace whose cached answer
/// still names its current path is skipped, including the one whose answer was
/// "this folder has no remote" — that is exactly the record that would otherwise
/// be re-probed on every cycle for the rest of its life.
pub fn refresh(workspaces: &mut [Workspace]) -> bool {
    let mut changed = false;
    for w in workspaces.iter_mut() {
        if w.repo.as_ref().map(|r| r.from == w.path.trim()).unwrap_or(false) {
            continue;
        }
        let next = resolve(&w.path);
        if next != w.repo {
            w.repo = next;
            changed = true;
        }
    }
    changed
}

/// The remote of a workspace as the wire spells it, or `None` when this machine
/// has nothing to offer. One place, so the publishing side and the comparing
/// side cannot disagree about what counts as "has a repository".
pub fn repo_url(w: &Workspace) -> Option<&str> {
    w.repo.as_ref()?.url.as_deref()
}

// ---------------------------------------------------------------- the ledger

/// Where the answers live, inside the sync root so they reach the other machine.
pub fn ledger_path(root: &Path) -> PathBuf {
    root.join("identity.json")
}

/// One record folded into another, and the direction it went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Merge {
    /// The id that stops being a workspace.
    pub from: String,
    /// The id that keeps being one.
    pub into: String,
    /// When the answer was given, epoch seconds. Kept for the history screen
    /// this does not have yet, and because a bare pair of ids is unreadable in
    /// six months.
    #[serde(default)]
    pub at: i64,
}

/// Two records somebody has said are *not* the same project.
///
/// Stored with the ids sorted, so the pair is one fact rather than two — a
/// question raised from the other direction on the other machine has to find it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Distinct {
    pub a: String,
    pub b: String,
}

/// Every identity decision anyone has made about these records.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    /// Storage format. Present from the first write so a later shape has
    /// something to branch on.
    #[serde(rename = "v", default = "ledger_v1")]
    pub version: u8,
    #[serde(default)]
    pub merges: Vec<Merge>,
    #[serde(default)]
    pub distinct: Vec<Distinct>,
}

fn ledger_v1() -> u8 {
    1
}

pub const LEDGER_VERSION: u8 = 1;

impl Ledger {
    /// Read it, treating anything unreadable as empty.
    ///
    /// Quiet on purpose, and this is the one file where that is not the usual
    /// laziness: the cost of misreading it as empty is a duplicate question
    /// asked twice, and the cost of failing the pull instead is a machine that
    /// stops syncing over a file it can rewrite.
    pub fn load(root: &Path) -> Ledger {
        std::fs::read_to_string(ledger_path(root))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        std::fs::write(ledger_path(root), serde_json::to_string_pretty(self)? + "\n")
    }

    /// The id this one has become, following the chain to its end.
    ///
    /// Chains happen: merge B into A, then somebody on the other machine merges
    /// C into B. Bounded by the number of merges rather than trusting the data
    /// to be acyclic — this file is edited by two machines and resolved by git,
    /// and a cycle would otherwise be an app that hangs on the next pull.
    pub fn canonical(&self, id: &str) -> String {
        let mut cur = id.to_string();
        for _ in 0..=self.merges.len() {
            match self.merges.iter().find(|m| m.from == cur) {
                Some(m) => cur = m.into.clone(),
                None => return cur,
            }
        }
        id.to_string()
    }

    /// Whether somebody has already said these two are different projects.
    pub fn is_distinct(&self, a: &str, b: &str) -> bool {
        let (x, y) = sorted(a, b);
        self.distinct.iter().any(|d| d.a == x && d.b == y)
    }

    /// Record that `from` is the same project as `into`.
    ///
    /// A no-op when the answer is already known, so answering twice — or pulling
    /// an answer this machine gave before — does not grow the file.
    pub fn record_merge(&mut self, from: &str, into: &str, at: i64) {
        if from == into || self.merges.iter().any(|m| m.from == from) {
            return;
        }
        self.merges.push(Merge { from: from.into(), into: into.into(), at });
    }

    /// Record that these two are not the same project, which is what stops the
    /// question coming back on every tick.
    pub fn record_distinct(&mut self, a: &str, b: &str) {
        if a == b || self.is_distinct(a, b) {
            return;
        }
        let (x, y) = sorted(a, b);
        self.distinct.push(Distinct { a: x, b: y });
    }
}

fn sorted(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

// ---------------------------------------------------------------- applying

/// Everything one merge moved on this machine, for the caller to report.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Memory files that changed hands.
    pub notes: usize,
    /// Files whose workspace id was rewritten.
    pub rewritten: Vec<String>,
}

/// Make `from` be `into` on this machine.
///
/// Idempotent, because it has to be: the same merge is applied here when the
/// person answers the question, and again on the other machine when it pulls the
/// ledger. Everything below is "if there is anything to move, move it".
///
/// The losing record itself is not touched here — withdrawing it from the
/// repository is the caller's, because that is a publishing decision and this is
/// not the publishing module.
pub fn apply(root: &Path, from: &str, into: &str) -> Applied {
    let mut out = Applied::default();
    if from == into || from.is_empty() || into.is_empty() {
        return out;
    }

    out.notes = move_memory(&root.join(from), &root.join(into));

    for name in ["sessions.json", "skills.json", "ui_state.json", "terminals.json"] {
        if rewrite_json(&root.join(name), from, into) {
            out.rewritten.push(name.to_string());
        }
    }
    if rewrite_lines(&root.join("runs.jsonl"), from, into) {
        out.rewritten.push("runs.jsonl".to_string());
    }
    out
}

/// Move one workspace's notes under another's id.
///
/// The move *is* the redirect: the first path segment below the corpus root is
/// the search scope (ADR-0004), so a note that has been moved is a note the
/// surviving workspace's search finds, with no alias table anywhere to keep in
/// step.
///
/// `workspace.json` stays behind. It is the record, not memory, and it is
/// withdrawn rather than moved — moving it would overwrite the surviving
/// workspace's own record with the one that just lost.
fn move_memory(from: &Path, into: &Path) -> usize {
    let mut moved = 0;
    for src in walk(from) {
        let Ok(rel) = src.strip_prefix(from) else { continue };
        if rel == Path::new("workspace.json") {
            continue;
        }
        let dst = into.join(rel);
        if let Some(dir) = dst.parent() {
            if std::fs::create_dir_all(dir).is_err() {
                continue;
            }
        }
        if place(&src, &dst) {
            moved += 1;
        }
    }
    // Only the directories that emptied out. A workspace whose notes could not
    // all be moved keeps the ones that are left, where they can still be found.
    prune_empty(from);
    moved
}

/// Put `src` at `dst`, keeping whatever is already there.
///
/// Three cases, and the third is the one worth reading twice:
///
/// - Nothing at `dst` — rename.
/// - The same bytes at `dst` — the file is already there; drop the duplicate.
/// - Something else at `dst` — both are real history and neither may go.
///   `Facts.md` is appended to, because facts are appended and never rewritten
///   (ADR-0004) and concatenating two machines' lines is exactly what the format
///   means. Anything else gets a numbered neighbour.
///
/// The numbering inserts before the extension rather than after it deliberately:
/// what may be published is `*/Facts.md` and `*/Sessions/**/*.md`
/// (`sync::manifest`), so a note renamed to `24-topic.md.1` would still be a
/// note and would silently stop travelling.
fn place(src: &Path, dst: &Path) -> bool {
    if !dst.exists() {
        return std::fs::rename(src, dst).is_ok();
    }
    let (a, b) = (std::fs::read(src).ok(), std::fs::read(dst).ok());
    if a.is_some() && a == b {
        return std::fs::remove_file(src).is_ok();
    }
    if dst.file_name().map(|n| n == "Facts.md").unwrap_or(false) {
        return append_facts(src, dst);
    }
    let Some(free) = numbered(dst) else { return false };
    std::fs::rename(src, free).is_ok()
}

/// Append one Facts file to another, with a blank line between them so the two
/// runs of lines do not glue into one.
fn append_facts(src: &Path, dst: &Path) -> bool {
    use std::io::Write;
    let Ok(body) = std::fs::read_to_string(src) else { return false };
    let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(dst) else { return false };
    let sep = if std::fs::read_to_string(dst).map(|s| s.ends_with('\n')).unwrap_or(true) {
        "\n"
    } else {
        "\n\n"
    };
    if write!(f, "{sep}{body}").is_err() {
        return false;
    }
    std::fs::remove_file(src).is_ok()
}

/// `name.md` → `name-2.md`, `name-3.md`, … until one is free.
fn numbered(dst: &Path) -> Option<PathBuf> {
    let stem = dst.file_stem()?.to_str()?;
    let ext = dst.extension().and_then(|e| e.to_str());
    let dir = dst.parent()?;
    for n in 2..100 {
        let name = match ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let p = dir.join(name);
        if !p.exists() {
            return Some(p);
        }
    }
    None
}

/// Every file under `dir`, deepest last, so callers can move them and then drop
/// the directories they came from.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

/// Drop `dir` and any directory left inside it, but only where nothing is left.
/// `remove_dir` refuses a non-empty directory, which is the guard rather than
/// something this has to check for itself.
fn prune_empty(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for p in entries.flatten().map(|e| e.path()) {
        if p.is_dir() {
            prune_empty(&p);
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// The keys that name a workspace, wherever they appear.
///
/// A list rather than a typed rewrite of each file, because the files it has to
/// cover — the deck layout, the drawer, scenarios, the remembered active
/// workspace — have four different shapes and one shared question, and a typed
/// pass per file is four places to forget when a fifth arrives.
const ID_KEYS: &[&str] = &["workspaceId", "activeWorkspaceId"];

/// Rewrite one id to another throughout a JSON document. Answers whether
/// anything changed, so an untouched file is not rewritten — see
/// `publish::write_if_changed` for why churning mtimes here is not free.
fn rewrite_json(path: &Path, from: &str, into: &str) -> bool {
    let Ok(body) = std::fs::read_to_string(path) else { return false };
    if !body.contains(from) {
        return false;
    }
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&body) else { return false };
    if !retarget(&mut v, from, into) {
        return false;
    }
    serde_json::to_string_pretty(&v)
        .ok()
        .map(|s| std::fs::write(path, s + "\n").is_ok())
        .unwrap_or(false)
}

/// The same, line by line, for the append-only run journal.
///
/// Rewritten in place rather than folded through `RunRecord`: a line this build
/// cannot parse is somebody's history too, and re-emitting the journal from
/// parsed records would drop it. Editing the value under a known key leaves
/// everything else on the line exactly as it was.
fn rewrite_lines(path: &Path, from: &str, into: &str) -> bool {
    let Ok(body) = std::fs::read_to_string(path) else { return false };
    // Every merge in the ledger is re-applied on every pull, so the common case
    // is a journal with nothing to change in it. A substring test is what keeps
    // that from being a full parse of the file each time: an id is a UUID, so
    // JSON escaping cannot hide one that is there.
    if !body.contains(from) {
        return false;
    }
    let mut out = String::with_capacity(body.len());
    let mut changed = false;
    for line in body.lines() {
        let rewritten = serde_json::from_str::<serde_json::Value>(line).ok().and_then(|mut v| {
            retarget(&mut v, from, into).then(|| serde_json::to_string(&v).ok()).flatten()
        });
        match rewritten {
            Some(s) => {
                changed = true;
                out.push_str(&s);
            }
            None => out.push_str(line),
        }
        out.push('\n');
    }
    changed && std::fs::write(path, out).is_ok()
}

/// Walk a value and repoint every workspace id in it. Also rewrites *keys*,
/// which `terminals.json` needs: the tab in front is stored per workspace, in a
/// map whose keys are the ids.
fn retarget(v: &mut serde_json::Value, from: &str, into: &str) -> bool {
    match v {
        serde_json::Value::Object(map) => {
            let mut changed = false;
            let renamed: Vec<String> = map
                .iter()
                .filter(|(_, val)| val.as_str() == Some(from))
                .filter(|(k, _)| ID_KEYS.contains(&k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            for k in renamed {
                map.insert(k, serde_json::Value::String(into.to_string()));
                changed = true;
            }
            if let Some(val) = map.remove(from) {
                // A per-workspace map. Whatever the surviving id already had
                // wins: it is the workspace that is still here.
                map.entry(into.to_string()).or_insert(val);
                changed = true;
            }
            for (_, val) in map.iter_mut() {
                changed |= retarget(val, from, into);
            }
            changed
        }
        serde_json::Value::Array(items) => {
            let mut changed = false;
            for it in items.iter_mut() {
                // A bare list of workspace ids — `terminals.open` is one.
                if it.as_str() == Some(from) {
                    *it = serde_json::Value::String(into.to_string());
                    changed = true;
                } else {
                    changed |= retarget(it, from, into);
                }
            }
            changed
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cd-identity-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn ws(id: &str, path: &str) -> Workspace {
        Workspace {
            id: id.into(),
            name: id.into(),
            path: path.into(),
            color: "#8ab4f8".into(),
            github: None,
            tracker: None,
            repo: None,
        }
    }

    #[test]
    fn a_folder_that_is_not_there_resolves_to_nothing_rather_than_to_no_remote() {
        assert_eq!(resolve(""), None);
        assert_eq!(resolve("   "), None);
        assert_eq!(resolve("/nonexistent-folder-for-a-test"), None);
    }

    /// The distinction the cache exists for: a folder with no remote has been
    /// *asked*, and must not be asked again on every cycle.
    #[test]
    fn a_folder_with_no_remote_records_that_and_is_not_re_probed() {
        let r = root("norepo");
        let mut items = vec![ws("ws-1", r.to_str().unwrap())];

        assert!(refresh(&mut items), "the first pass has to look");
        let cached = items[0].repo.clone().expect("the absence is an answer");
        assert_eq!(cached.url, None);
        assert_eq!(cached.from, r.to_str().unwrap());

        assert!(!refresh(&mut items), "and the second pass must not look again");
        assert_eq!(repo_url(&items[0]), None, "which offers no identity to anyone");
    }

    #[test]
    fn a_workspace_pointed_somewhere_else_resolves_again() {
        let r = root("moved");
        let mut items = vec![ws("ws-1", r.to_str().unwrap())];
        refresh(&mut items);

        let elsewhere = r.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        items[0].path = elsewhere.to_str().unwrap().into();
        assert!(refresh(&mut items), "the old answer described the old folder");
        assert_eq!(items[0].repo.as_ref().unwrap().from, elsewhere.to_str().unwrap());
    }

    #[test]
    fn the_ledger_round_trips_and_an_unreadable_one_is_empty() {
        let r = root("ledger");
        let mut l = Ledger { version: LEDGER_VERSION, ..Default::default() };
        l.record_merge("ws-b", "ws-a", 1_756_000_000);
        l.record_distinct("ws-d", "ws-c");
        l.save(&r).unwrap();

        let back = Ledger::load(&r);
        assert_eq!(back, l);
        assert_eq!(back.distinct[0], Distinct { a: "ws-c".into(), b: "ws-d".into() }, "sorted");

        fs::write(ledger_path(&r), "{ not json").unwrap();
        assert_eq!(Ledger::load(&r), Ledger::default());
        assert_eq!(Ledger::load(Path::new("/nonexistent")), Ledger::default());
    }

    #[test]
    fn the_same_answer_twice_is_one_record() {
        let mut l = Ledger::default();
        l.record_merge("ws-b", "ws-a", 1);
        l.record_merge("ws-b", "ws-a", 2);
        l.record_distinct("ws-c", "ws-d");
        l.record_distinct("ws-d", "ws-c");
        assert_eq!(l.merges.len(), 1);
        assert_eq!(l.distinct.len(), 1);
        assert!(l.is_distinct("ws-c", "ws-d") && l.is_distinct("ws-d", "ws-c"));
    }

    /// Merge B into A here, C into B there, and both machines have to agree
    /// where C ended up.
    #[test]
    fn a_chain_of_merges_resolves_to_its_end() {
        let mut l = Ledger::default();
        l.record_merge("ws-b", "ws-a", 1);
        l.record_merge("ws-c", "ws-b", 2);
        assert_eq!(l.canonical("ws-c"), "ws-a");
        assert_eq!(l.canonical("ws-a"), "ws-a");
        assert_eq!(l.canonical("ws-unknown"), "ws-unknown");
    }

    /// Two machines editing one file, resolved by git, can produce a cycle no
    /// person ever asked for. It must not be an app that hangs on the next pull.
    #[test]
    fn a_cycle_terminates_instead_of_hanging() {
        let l = Ledger {
            version: 1,
            merges: vec![
                Merge { from: "a".into(), into: "b".into(), at: 0 },
                Merge { from: "b".into(), into: "a".into(), at: 0 },
            ],
            distinct: Vec::new(),
        };
        assert_eq!(l.canonical("a"), "a", "and says so by answering with the id it was given");
    }

    #[test]
    fn merging_moves_the_memory_under_the_surviving_id() {
        let r = root("mem");
        write(&r, "ws-b/Facts.md", "- from b\n");
        write(&r, "ws-b/Sessions/2026-08/24-topic.md", "# b's session\n");
        write(&r, "ws-b/workspace.json", "{\"id\":\"ws-b\"}");
        write(&r, "ws-a/Sessions/2026-08/25-other.md", "# a's session\n");

        let applied = apply(&r, "ws-b", "ws-a");
        assert_eq!(applied.notes, 2, "the record is not memory: {applied:?}");

        assert_eq!(fs::read_to_string(r.join("ws-a/Facts.md")).unwrap(), "- from b\n");
        assert!(r.join("ws-a/Sessions/2026-08/24-topic.md").is_file());
        assert!(r.join("ws-a/Sessions/2026-08/25-other.md").is_file(), "and a's own is untouched");
        assert!(r.join("ws-b/workspace.json").is_file(), "withdrawing that is publishing's job");
        assert!(!r.join("ws-b/Sessions").exists(), "nothing is left to be found twice");
    }

    /// Both machines have facts for this project. Concatenating them is what the
    /// format means — facts are appended, never rewritten (ADR-0004).
    #[test]
    fn two_sets_of_facts_become_one_file_rather_than_one_of_them() {
        let r = root("facts");
        write(&r, "ws-a/Facts.md", "- 2026-08-01 a\n");
        write(&r, "ws-b/Facts.md", "- 2026-08-02 b\n");

        apply(&r, "ws-b", "ws-a");
        let merged = fs::read_to_string(r.join("ws-a/Facts.md")).unwrap();
        assert!(merged.contains("- 2026-08-01 a") && merged.contains("- 2026-08-02 b"), "{merged}");
        assert!(!r.join("ws-b/Facts.md").exists());
    }

    /// The rename has to keep the file publishable: what travels is
    /// `Sessions/**/*.md`, so a suffix after the extension would quietly stop
    /// the note leaving the machine.
    #[test]
    fn a_note_that_collides_keeps_its_extension_and_both_survive() {
        let r = root("collide");
        write(&r, "ws-a/Sessions/2026-08/24-topic.md", "# a\n");
        write(&r, "ws-b/Sessions/2026-08/24-topic.md", "# b\n");

        apply(&r, "ws-b", "ws-a");
        assert_eq!(fs::read_to_string(r.join("ws-a/Sessions/2026-08/24-topic.md")).unwrap(), "# a\n");
        let neighbour = r.join("ws-a/Sessions/2026-08/24-topic-2.md");
        assert_eq!(fs::read_to_string(&neighbour).unwrap(), "# b\n");
        assert_eq!(neighbour.extension().unwrap(), "md", "or it stops travelling");
    }

    #[test]
    fn an_identical_note_on_both_sides_does_not_become_two() {
        let r = root("same");
        write(&r, "ws-a/Sessions/2026-08/24-topic.md", "# one\n");
        write(&r, "ws-b/Sessions/2026-08/24-topic.md", "# one\n");

        apply(&r, "ws-b", "ws-a");
        assert!(!r.join("ws-a/Sessions/2026-08/24-topic-2.md").exists());
        assert!(!r.join("ws-b").exists());
    }

    #[test]
    fn the_run_journal_and_the_deck_follow_the_surviving_id() {
        let r = root("rewrite");
        fs::write(
            r.join("runs.jsonl"),
            "{\"runId\":\"r1\",\"workspaceId\":\"ws-b\",\"name\":\"nightly\"}\n\
             {\"runId\":\"r2\",\"workspaceId\":\"ws-a\"}\n\
             not json at all\n",
        )
        .unwrap();
        fs::write(r.join("sessions.json"), "[{\"sessionId\":\"s1\",\"workspaceId\":\"ws-b\"}]").unwrap();
        fs::write(r.join("skills.json"), "[{\"id\":\"sk-1\",\"workspaceId\":\"ws-b\"}]").unwrap();
        fs::write(r.join("ui_state.json"), "{\"activeWorkspaceId\":\"ws-b\"}").unwrap();
        fs::write(
            r.join("terminals.json"),
            "{\"items\":[{\"sessionId\":\"t1\",\"workspaceId\":\"ws-b\"}],\
              \"active\":{\"ws-b\":\"t1\"},\"open\":[\"ws-b\"]}",
        )
        .unwrap();

        let applied = apply(&r, "ws-b", "ws-a");
        assert_eq!(applied.rewritten.len(), 5, "{applied:?}");

        let runs = fs::read_to_string(r.join("runs.jsonl")).unwrap();
        assert!(runs.contains("\"workspaceId\":\"ws-a\""), "{runs}");
        assert!(!runs.contains("ws-b"), "{runs}");
        assert!(runs.contains("nightly"), "the rest of the line is untouched: {runs}");
        assert!(runs.contains("not json at all"), "a line we cannot read is history too: {runs}");

        for (name, want) in [
            ("sessions.json", "ws-a"),
            ("skills.json", "ws-a"),
            ("ui_state.json", "ws-a"),
        ] {
            let body = fs::read_to_string(r.join(name)).unwrap();
            assert!(body.contains(want) && !body.contains("ws-b"), "{name}: {body}");
        }

        let drawer: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(r.join("terminals.json")).unwrap()).unwrap();
        assert_eq!(drawer["active"]["ws-a"], "t1", "the tab in front is keyed by workspace");
        assert_eq!(drawer["open"][0], "ws-a", "and so is whether the drawer is up");
        assert_eq!(drawer["items"][0]["workspaceId"], "ws-a");
    }

    /// The same merge is applied here when it is answered and again on the other
    /// machine when it pulls the ledger. Twice must be the same as once.
    #[test]
    fn applying_the_same_merge_again_changes_nothing() {
        let r = root("twice");
        write(&r, "ws-b/Facts.md", "- once\n");
        fs::write(r.join("ui_state.json"), "{\"activeWorkspaceId\":\"ws-b\"}").unwrap();

        apply(&r, "ws-b", "ws-a");
        let second = apply(&r, "ws-b", "ws-a");
        assert_eq!(second, Applied::default(), "there is nothing left to do");
        assert_eq!(fs::read_to_string(r.join("ws-a/Facts.md")).unwrap(), "- once\n");
    }

    #[test]
    fn merging_a_record_into_itself_is_refused_rather_than_destructive() {
        let r = root("self");
        write(&r, "ws-a/Facts.md", "- keep me\n");
        assert_eq!(apply(&r, "ws-a", "ws-a"), Applied::default());
        assert_eq!(fs::read_to_string(r.join("ws-a/Facts.md")).unwrap(), "- keep me\n");
    }
}
