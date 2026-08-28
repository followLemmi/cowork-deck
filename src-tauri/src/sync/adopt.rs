//! Reading a synced repository into the local store, and working out what a
//! person still has to answer.
//!
//! Everything that arrives describes another computer. The records are useful
//! immediately — memory is searchable without the folder existing — but a
//! workspace cannot start a session until somebody says where its project is on
//! this machine.
//!
//! The questions are collected rather than asked here. They are asked lazily,
//! when the person first opens the workspace, because a wall of them after the
//! first pull is a poor greeting for someone with a dozen projects.

use crate::model::{Skill, Workspace};
use crate::sync::identity::{repo_url, Ledger};
use crate::sync::projection::{merge_skill, merge_workspace, WireSkill, WireWorkspace};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Something the person has to decide, carried out of a pull rather than
/// decided for them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Question {
    /// A workspace with no folder on this machine. `clone_from` is set when the
    /// record names a repository, which is what makes "clone it" offerable.
    NeedsPath { workspace_id: String, name: String, clone_from: Option<String> },
    /// Two records for what looks like one project: this machine made a
    /// workspace before sync was switched on, and now the other machine's
    /// record for the same repository has arrived under a different id — or two
    /// records here point at one folder, which for a project with no repository
    /// is the only identity there is (`identity_key`).
    ///
    /// Never resolved automatically. Merging means one of the two memories
    /// stops being findable under the surviving id, and that is a loss of
    /// history rather than a tidy-up. What it means when somebody *does* answer
    /// it is `sync::identity`.
    Duplicate { arriving_id: String, local_id: String, name: String },
    /// A folder-based board whose folder is on the other machine.
    NeedsBoardPath { workspace_id: String, name: String },
}

#[derive(Debug, Default)]
pub struct Adopted {
    pub workspaces: Vec<Workspace>,
    pub skills: Vec<Skill>,
    pub questions: Vec<Question>,
    /// Records still in the repository under an id that has since been merged
    /// into another. Withdrawing them is the caller's, because publishing is
    /// not this module's job — but if nobody does, the machine that still owns
    /// the id republishes it on its next cycle and the merge never settles.
    pub withdrawn: Vec<String>,
    /// Files that would not parse, by path. Reported rather than skipped in
    /// silence: a workspace that quietly fails to arrive looks exactly like one
    /// that was never synced.
    pub unreadable: Vec<String>,
}

/// Read a synced root and merge it over what is already here.
///
/// How this machine recognises that two records are the same project: the
/// remote URL, normalised — it is the same string on every machine, which a name
/// is not. It is read off the local record rather than asked for here, because
/// asking means a subprocess per workspace and this runs on a five-minute timer
/// (`identity::refresh` is what fills it in). Where there is no repository, the
/// folder on this disk stands in — see `identity_key`.
pub fn adopt(root: &Path, local: &[Workspace], local_skills: &[Skill]) -> Adopted {
    let ledger = Ledger::load(root);
    let mut out = Adopted::default();

    // Local records under the id they have *become*. A workspace somebody
    // merged on the other machine is the surviving one here too, and it is this
    // record — not the arriving one — that knows where the folder is on this
    // disk.
    let mut by_id: BTreeMap<String, &Workspace> = BTreeMap::new();
    for w in local {
        let id = ledger.canonical(&w.id);
        match by_id.get(id.as_str()) {
            // Both sides of a merge are still in the store on the machine that
            // owned the losing id. The one with a path is the one that has been
            // located here, and keeping it is the whole point of the merge.
            Some(kept) if !kept.path.trim().is_empty() => {}
            _ => {
                by_id.insert(id, w);
            }
        }
    }

    // Read first, ask afterwards. Whether two records are one project is a fact
    // about the whole set, not about one record as it goes past — and asking it
    // per record is how the question used to disappear the moment the arriving
    // record was adopted, which is to say on the pull that raised it.
    let mut arrived: Vec<(WireWorkspace, Workspace)> = Vec::new();
    for (path, wire) in read_dir_of::<WireWorkspace>(root, |p| {
        p.file_name().map(|n| n == "workspace.json").unwrap_or(false)
    }) {
        let Some(wire) = wire else {
            out.unreadable.push(path);
            continue;
        };
        // Merged already. Its content is in the surviving record, and the only
        // thing left to do with it is stop publishing it.
        if ledger.canonical(&wire.id) != wire.id {
            out.withdrawn.push(wire.id.clone());
            continue;
        }
        let merged = merge_workspace(&wire, by_id.get(wire.id.as_str()).copied());
        arrived.push((wire, merged));
    }

    // Same project, different id. Never from the name: two real projects are
    // often called the same thing, and merging them is a loss of history. Only
    // from a repository, or — for a project that has none — from the folder both
    // records point at (`identity_key`).
    //
    // Over everything this machine knows about, not only over what arrived: the
    // local record is normally on the wire too, because the cycle publishes
    // before it pulls — but `sync_questions` can be called in between, and a
    // question that depends on that ordering is a question that appears and
    // disappears for no reason a person could follow.
    let mut cands: Vec<Candidate> = Vec::new();
    for (i, (wire, merged)) in arrived.iter().enumerate() {
        if let Some(key) = identity_key(wire.repo.as_deref().or_else(|| repo_url(merged)), &merged.path)
        {
            cands.push(Candidate {
                key,
                id: merged.id.clone(),
                name: merged.name.clone(),
                located: !merged.path.trim().is_empty(),
                wire: Some(i),
            });
        }
    }
    let on_the_wire: BTreeSet<&str> = arrived.iter().map(|(_, m)| m.id.as_str()).collect();
    for w in local {
        let id = ledger.canonical(&w.id);
        if on_the_wire.contains(id.as_str()) {
            continue;
        }
        if let Some(key) = identity_key(repo_url(w), &w.path) {
            cands.push(Candidate {
                key,
                id,
                name: w.name.clone(),
                located: !w.path.trim().is_empty(),
                wire: None,
            });
        }
    }

    let mut by_repo: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, c) in cands.iter().enumerate() {
        by_repo.entry(c.key.as_str()).or_default().push(i);
    }

    let mut folds_into: BTreeSet<usize> = BTreeSet::new();
    for group in by_repo.into_values().filter(|g| g.len() > 1) {
        // The record that survives a merge is the one with a folder on this
        // machine, because that is exactly what the other one is missing. With
        // none located here yet, the first — so the answer does not depend on
        // the order the directory happened to be read in.
        let keep = group.iter().copied().find(|i| cands[*i].located).unwrap_or(group[0]);
        for i in group {
            if i == keep {
                continue;
            }
            // An answered question does not come back. "Not the same project"
            // is a decision, and re-asking it every tick would train people to
            // ignore the indicator that raises it.
            if ledger.is_distinct(&cands[i].id, &cands[keep].id) {
                continue;
            }
            folds_into.extend(cands[i].wire);
            out.questions.push(Question::Duplicate {
                arriving_id: cands[i].id.clone(),
                local_id: cands[keep].id.clone(),
                name: cands[i].name.clone(),
            });
        }
    }

    for (i, (wire, merged)) in arrived.into_iter().enumerate() {
        // Not "where is this project on this machine?" for a record that is
        // about to stop being a workspace. One project, one question — and the
        // duplicate is the one worth answering, because answering it settles
        // the path too.
        let folding = folds_into.contains(&i);
        if merged.path.trim().is_empty() && !folding {
            out.questions.push(Question::NeedsPath {
                workspace_id: merged.id.clone(),
                name: merged.name.clone(),
                clone_from: wire.repo.clone(),
            });
        }
        if wire.tracker_needs_path && !folding {
            out.questions.push(Question::NeedsBoardPath {
                workspace_id: merged.id.clone(),
                name: merged.name.clone(),
            });
        }
        out.workspaces.push(merged);
    }

    let skills_by_id: BTreeMap<&str, &Skill> =
        local_skills.iter().map(|s| (s.id.as_str(), s)).collect();
    for (path, wire) in read_dir_of::<WireSkill>(&root.join("scenarios"), |_| true) {
        match wire {
            Some(w) => {
                let local = skills_by_id.get(w.id.as_str()).copied();
                out.skills.push(merge_skill(&w, local));
            }
            None => out.unreadable.push(path),
        }
    }

    out
}

/// One record that could turn out to be the same project as another.
///
/// Both sides of the comparison in one shape: a record that arrived, and a local
/// one that has not reached the repository yet.
struct Candidate {
    /// The normalised repository, which is what makes two of these one project.
    key: String,
    id: String,
    name: String,
    /// Whether this machine knows where the folder is. The located record is the
    /// one a merge keeps.
    located: bool,
    /// Its place in the arriving set, when it is in it. `None` is a record this
    /// machine has and has not published — it can be the survivor of a merge,
    /// but it is never the one asked about.
    wire: Option<usize>,
}

/// What this record's project *is*, in the one spelling both sides of a
/// comparison agree on. `None` is a record with nothing to compare — never
/// equal to anything, including another `None`.
///
/// A repository first: it is the same string on every machine, which is what
/// makes it the only identity that crosses one. For an arriving record the wire
/// carries it; for a record this machine has located but not published yet the
/// local cache does — the cycle publishes before it pulls, so that window is one
/// `sync_questions` call wide, and closing it costs one line.
///
/// The folder second, and only where there is no repository at all. Two records
/// pointing at one directory on this disk are one project, and no remote is
/// needed to see it: a config folder, a scratch checkout, anything somebody
/// keeps without a repository (#359). Canonicalised, because `~/.claude/` and
/// `~/.claude` are the same folder and a plain string comparison says otherwise.
///
/// This never travels. A path is one machine's disk (#313) and is stripped on
/// the way out; both records in a path comparison are ones this machine holds,
/// and what it produces is a question, answered by a person, whose *answer*
/// travels as a pair of ids.
///
/// The two kinds are prefixed apart. A repository that happened to read like a
/// path must not match a folder that happened to read like a repository.
fn identity_key(repo: Option<&str>, path: &str) -> Option<String> {
    if let Some(url) = repo.map(str::trim).filter(|r| !r.is_empty()) {
        return Some(format!("repo:{}", normalise_repo(url)));
    }
    canonical_folder(path).map(|p| format!("path:{p}"))
}

/// One spelling of a folder: symlinks resolved and the trailing slash gone.
///
/// A path that is not there is kept as written rather than dropped — it is still
/// this machine's answer for that record, and two records that were located from
/// the same typed-in path are still the same project after the folder is
/// renamed out from under them.
fn canonical_folder(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let canonical = std::fs::canonicalize(trimmed)
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| trimmed.trim_end_matches('/').to_string());
    Some(match canonical.is_empty() {
        true => "/".to_string(),
        false => canonical,
    })
}

/// Two spellings of one repository — `git@host:o/r.git` and
/// `https://host/o/r` — have to compare equal, or the same project on two
/// machines looks like two projects.
pub fn normalise_repo(url: &str) -> String {
    let s = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let s = s
        .strip_prefix("git@")
        .map(|r| r.replacen(':', "/", 1))
        .unwrap_or_else(|| s.to_string());
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .or_else(|| s.strip_prefix("ssh://git@"))
        .unwrap_or(&s)
        .to_string();
    s.to_lowercase()
}

/// Every JSON file under `dir` that the filter accepts, parsed. `None` marks one
/// that would not parse — kept rather than dropped, because a record that
/// quietly fails to arrive is indistinguishable from one that was never there.
fn read_dir_of<T: serde::de::DeserializeOwned>(
    dir: &Path,
    accept: impl Fn(&Path) -> bool,
) -> Vec<(String, Option<T>)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let nested = p.join("workspace.json");
            if nested.is_file() && accept(&nested) {
                paths.push(nested);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some("json") && accept(&p) {
            paths.push(p);
        }
    }
    paths.sort();
    for p in paths {
        let parsed = std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<T>(&s).ok());
        out.push((p.display().to_string(), parsed));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Schedule, SchedulePreset, WorkspaceRepo};
    use crate::sync::projection::project_workspace;
    use std::fs;
    use std::path::PathBuf;

    fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cd-adopt-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn ws(id: &str, name: &str, path: &str) -> Workspace {
        Workspace {
            id: id.into(),
            name: name.into(),
            path: path.into(),
            color: "#8ab4f8".into(),
            github: None,
            tracker: None,
            repo: None,
        }
    }

    /// The same workspace with its repository already resolved, as
    /// `identity::refresh` would have left it.
    fn at_repo(mut w: Workspace, url: &str) -> Workspace {
        w.repo = Some(WorkspaceRepo { url: Some(url.into()), from: w.path.clone() });
        w
    }

    fn publish(root: &Path, w: &Workspace) {
        let wire = project_workspace(w);
        let p = root.join(&w.id).join("workspace.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, serde_json::to_string_pretty(&wire).unwrap()).unwrap();
    }

    #[test]
    fn a_fresh_machine_gets_every_record_and_a_question_for_each() {
        let r = root("fresh");
        publish(&r, &at_repo(ws("ws-1", "deck", "/elsewhere/deck"), "me/deck"));
        publish(&r, &ws("ws-2", "site", "/elsewhere/site"));

        let a = adopt(&r, &[], &[]);
        assert_eq!(a.workspaces.len(), 2);
        assert!(a.workspaces.iter().all(|w| w.path.is_empty()), "no local paths to invent");
        assert!(a.unreadable.is_empty());

        let paths: Vec<&Question> = a
            .questions
            .iter()
            .filter(|q| matches!(q, Question::NeedsPath { .. }))
            .collect();
        assert_eq!(paths.len(), 2, "{:?}", a.questions);
        assert!(
            matches!(paths[0], Question::NeedsPath { clone_from: Some(r), .. } if r == "me/deck"),
            "a record naming a repository can be offered a clone: {:?}",
            paths[0]
        );
        assert!(
            matches!(paths[1], Question::NeedsPath { clone_from: None, .. }),
            "and one that names none cannot: {:?}",
            paths[1]
        );
    }

    #[test]
    fn a_workspace_already_here_keeps_its_path_and_asks_nothing() {
        let r = root("known");
        let here = ws("ws-1", "deck", "/here/deck");
        publish(&r, &ws("ws-1", "renamed elsewhere", "/elsewhere/deck"));

        let a = adopt(&r, std::slice::from_ref(&here), &[]);
        assert_eq!(a.workspaces[0].path, "/here/deck", "this machine's disk wins");
        assert_eq!(a.workspaces[0].name, "renamed elsewhere", "shared fields still arrive");
        assert!(a.questions.is_empty(), "{:?}", a.questions);
    }

    /// The collision: this machine made a workspace for the project before sync
    /// was switched on, and the other machine's record for the same repository
    /// arrives under a different id.
    #[test]
    fn the_same_project_under_two_ids_becomes_a_question_not_a_decision() {
        let r = root("dupe");
        publish(&r, &at_repo(ws("ws-remote", "deck", "/elsewhere/deck"), "git@github.com:me/deck.git"));

        let here = at_repo(ws("ws-local", "deck", "/here/deck"), "https://github.com/Me/deck");

        let a = adopt(&r, std::slice::from_ref(&here), &[]);
        assert!(
            a.questions.iter().any(|q| matches!(
                q,
                Question::Duplicate { arriving_id, local_id, .. }
                    if arriving_id == "ws-remote" && local_id == "ws-local"
            )),
            "two spellings of one repository must compare equal: {:?}",
            a.questions
        );
        assert_eq!(a.workspaces.len(), 1, "and nothing is merged behind their back");
    }

    #[test]
    fn two_workspaces_on_one_account_are_not_duplicates_of_each_other() {
        let r = root("notdupe");
        publish(&r, &at_repo(ws("ws-remote", "site", "/elsewhere/site"), "https://github.com/me/site"));

        let here = at_repo(ws("ws-local", "deck", "/here/deck"), "https://github.com/me/deck");

        let a = adopt(&r, std::slice::from_ref(&here), &[]);
        assert!(
            !a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "different repositories, same account: {:?}",
            a.questions
        );
    }

    /// Name plus something else is a guess, and guessing wrong merges two real
    /// projects. With no repository and no folder on this machine — which is
    /// every record that arrived and has not been located yet — there is nothing
    /// left to compare, and the pair is fairly left unrecognised.
    #[test]
    fn a_workspace_with_no_remote_and_no_folder_here_is_not_offered_as_a_duplicate() {
        let r = root("noremote");
        publish(&r, &ws("ws-remote", "deck", "/elsewhere/deck"));

        // Asked, and there is none — the state the cache exists to record.
        let mut here = ws("ws-local", "deck", "/here/deck");
        here.repo = Some(WorkspaceRepo { url: None, from: "/here/deck".into() });

        let a = adopt(&r, std::slice::from_ref(&here), &[]);
        assert!(
            !a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "same name, no shared identity: {:?}",
            a.questions
        );
    }

    /// A question answered "no" that comes back on the next tick is a question
    /// nobody will read the third time.
    #[test]
    fn declining_leaves_both_and_is_not_asked_again() {
        let r = root("declined");
        publish(&r, &at_repo(ws("ws-remote", "deck", "/elsewhere/deck"), "https://github.com/me/deck"));
        let here = at_repo(ws("ws-local", "deck", "/here/deck"), "https://github.com/me/deck");

        let mut ledger = Ledger::default();
        ledger.record_distinct("ws-remote", "ws-local");
        ledger.save(&r).unwrap();

        let a = adopt(&r, std::slice::from_ref(&here), &[]);
        assert!(
            !a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "{:?}",
            a.questions
        );
        assert_eq!(a.workspaces.len(), 1, "the arriving record is still adopted");
        assert!(a.withdrawn.is_empty(), "declining withdraws nothing");
    }

    /// The pair on this machine that no remote can explain: one project kept
    /// without a repository, added twice, and the two records differ by a
    /// trailing slash and a colour (#359).
    #[test]
    fn two_records_on_one_folder_are_one_project_without_any_repository() {
        let r = root("onefolder");
        let dir = r.join("config");
        fs::create_dir_all(&dir).unwrap();
        let with_slash = format!("{}/", dir.display());

        publish(&r, &ws("ws-remote", "claude-config", &with_slash));
        let mut here = ws("ws-remote", "claude-config", &with_slash);
        here.repo = Some(WorkspaceRepo { url: None, from: with_slash.clone() });
        let mut also_here = ws("ws-local", "claude-config", &dir.display().to_string());
        also_here.repo = Some(WorkspaceRepo { url: None, from: dir.display().to_string() });

        let a = adopt(&r, &[here, also_here], &[]);
        assert!(
            a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "one folder, two spellings, no repository anywhere: {:?}",
            a.questions
        );
    }

    #[test]
    fn two_folders_with_no_repository_are_two_projects() {
        let r = root("twofolders");
        publish(&r, &ws("ws-remote", "notes", "/here/notes"));
        let mut here = ws("ws-remote", "notes", "/here/notes");
        here.repo = Some(WorkspaceRepo { url: None, from: "/here/notes".into() });
        let mut other = ws("ws-local", "notes", "/here/other-notes");
        other.repo = Some(WorkspaceRepo { url: None, from: "/here/other-notes".into() });

        let a = adopt(&r, &[here, other], &[]);
        assert!(
            !a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "same name is not identity: {:?}",
            a.questions
        );
    }

    /// A repository and a folder are different kinds of claim, and one must never
    /// be read as the other.
    #[test]
    fn a_repository_and_a_folder_are_never_the_same_identity() {
        assert_eq!(
            identity_key(Some("git@github.com:me/deck.git"), "/here/deck"),
            identity_key(Some("https://github.com/Me/deck/"), "/elsewhere/deck"),
            "the repository decides, whatever the folder is called"
        );
        assert_ne!(
            identity_key(Some("/here/deck"), ""),
            identity_key(None, "/here/deck"),
            "a repository that reads like a path is still not that folder"
        );
        assert_eq!(identity_key(None, "   "), None, "nothing to compare is not a key");
        assert_eq!(
            identity_key(Some(""), "/here/deck"),
            identity_key(None, "/here/deck"),
            "an empty repository is no repository, and the folder still answers"
        );
    }

    /// The other machine answered. This one has to arrive at the same single
    /// workspace — under the surviving id, and still pointed at its own folder.
    #[test]
    fn a_merge_answered_elsewhere_re_keys_this_machines_record_and_keeps_its_path() {
        let r = root("merged");
        publish(&r, &at_repo(ws("ws-a", "deck", "/on/a/deck"), "https://github.com/me/deck"));

        let mut ledger = Ledger::default();
        ledger.record_merge("ws-b", "ws-a", 1);
        ledger.save(&r).unwrap();

        // This machine still holds both: its own record, and the one it pulled
        // from the other machine before either was merged.
        let mine = at_repo(ws("ws-b", "deck", "/on/b/deck"), "https://github.com/me/deck");
        let theirs = ws("ws-a", "deck", "");

        let a = adopt(&r, &[mine, theirs], &[]);
        assert_eq!(a.workspaces.len(), 1, "one project, one workspace: {:?}", a.workspaces);
        assert_eq!(a.workspaces[0].id, "ws-a", "under the surviving id");
        assert_eq!(a.workspaces[0].path, "/on/b/deck", "and this machine's own folder");
        assert!(a.questions.is_empty(), "nothing is left to ask: {:?}", a.questions);
    }

    /// The one cycle where the losing record can still be in the repository: the
    /// machine that owned it published before it pulled the answer. Left alone,
    /// it would be republished forever.
    #[test]
    fn a_record_under_a_merged_id_is_named_for_withdrawal_rather_than_adopted() {
        let r = root("stale");
        publish(&r, &ws("ws-a", "deck", "/on/a/deck"));
        publish(&r, &ws("ws-b", "deck", "/on/b/deck"));

        let mut ledger = Ledger::default();
        ledger.record_merge("ws-b", "ws-a", 1);
        ledger.save(&r).unwrap();

        let a = adopt(&r, &[], &[]);
        assert_eq!(a.withdrawn, vec!["ws-b".to_string()]);
        assert_eq!(a.workspaces.len(), 1);
        assert_eq!(a.workspaces[0].id, "ws-a");
    }

    #[test]
    fn a_record_that_will_not_parse_is_reported_rather_than_skipped() {
        let r = root("bad");
        publish(&r, &ws("ws-1", "deck", "/elsewhere/deck"));
        let p = r.join("ws-2/workspace.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "{ not json").unwrap();

        let a = adopt(&r, &[], &[]);
        assert_eq!(a.workspaces.len(), 1, "the readable one still arrives");
        assert_eq!(a.unreadable.len(), 1, "and the other is named");
        assert!(a.unreadable[0].contains("ws-2"), "{:?}", a.unreadable);
    }

    #[test]
    fn scenarios_arrive_and_their_schedules_do_not_start_firing() {
        let r = root("scen");
        let sk = Skill {
            id: "sk-1".into(),
            name: "Nightly".into(),
            icon: "📰".into(),
            prompt: "go".into(),
            workspace_id: None,
            schedule: Some(Schedule {
                preset: SchedulePreset::Daily { hour: 3, minute: 0 },
                defaults: Default::default(),
                enabled: true,
            }),
        };
        let dir = r.join("scenarios");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("sk-1.json"),
            serde_json::to_string(&crate::sync::projection::project_skill(&sk)).unwrap(),
        )
        .unwrap();

        let a = adopt(&r, &[], &[]);
        assert_eq!(a.skills.len(), 1);
        assert!(
            !a.skills[0].schedule.as_ref().unwrap().enabled,
            "a scenario arriving must not fire at 03:00 on this machine too"
        );
    }

    #[test]
    fn a_board_folder_on_the_other_machine_is_asked_about() {
        let r = root("board");
        let mut w = ws("ws-1", "deck", "/elsewhere/deck");
        w.tracker = Some(crate::model::TrackerConfig {
            providers: vec![crate::model::TrackerProvider::Fs {
                root: crate::model::TrackerRoot::Path { path: "/elsewhere/vault".into() },
            }],
            previous_location: None,
            version: 3,
        });
        publish(&r, &w);

        let a = adopt(&r, &[], &[]);
        assert!(
            a.questions.iter().any(|q| matches!(q, Question::NeedsBoardPath { .. })),
            "{:?}",
            a.questions
        );
    }

    #[test]
    fn an_absent_root_is_empty_rather_than_an_error() {
        let a = adopt(Path::new("/nonexistent-root"), &[], &[]);
        assert!(a.workspaces.is_empty() && a.questions.is_empty() && a.unreadable.is_empty());
    }

    #[test]
    fn repository_spellings_normalise_to_one() {
        let want = "github.com/me/deck";
        for s in [
            "https://github.com/me/deck",
            "https://github.com/me/deck.git",
            "https://github.com/Me/Deck/",
            "git@github.com:me/deck.git",
            "ssh://git@github.com/me/deck",
        ] {
            assert_eq!(normalise_repo(s), want, "{s}");
        }
        assert_ne!(normalise_repo("me/deck"), want, "a bare pair is not a URL");
    }
}
