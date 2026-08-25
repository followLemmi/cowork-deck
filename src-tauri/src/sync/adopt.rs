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
use crate::sync::projection::{merge_skill, merge_workspace, WireSkill, WireWorkspace};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// Something the person has to decide, carried out of a pull rather than
/// decided for them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Question {
    /// A workspace with no folder on this machine. `clone_from` is set when the
    /// record names a repository, which is what makes "clone it" offerable.
    NeedsPath { workspace_id: String, name: String, clone_from: Option<String> },
    /// Two records for what looks like one project: this machine made a
    /// workspace before sync was switched on, and now the other machine's
    /// record for the same repository has arrived under a different id.
    ///
    /// Never resolved automatically. Merging means one of the two memories
    /// stops being findable under the surviving id, and that is a loss of
    /// history rather than a tidy-up.
    Duplicate { arriving_id: String, local_id: String, name: String },
    /// A folder-based board whose folder is on the other machine.
    NeedsBoardPath { workspace_id: String, name: String },
}

#[derive(Debug, Default)]
pub struct Adopted {
    pub workspaces: Vec<Workspace>,
    pub skills: Vec<Skill>,
    pub questions: Vec<Question>,
    /// Files that would not parse, by path. Reported rather than skipped in
    /// silence: a workspace that quietly fails to arrive looks exactly like one
    /// that was never synced.
    pub unreadable: Vec<String>,
}

/// How this machine recognises that two records are the same project.
///
/// The remote URL, normalised — it is the same string on every machine, which a
/// path and a name are not. Resolution is the caller's, because working it out
/// means asking `gh` per workspace and this module is worth testing without one.
pub type RepoOf<'a> = &'a dyn Fn(&Workspace) -> Option<String>;

/// Read a synced root and merge it over what is already here.
pub fn adopt(root: &Path, local: &[Workspace], local_skills: &[Skill], repo_of: RepoOf) -> Adopted {
    let mut out = Adopted::default();
    let by_id: BTreeMap<&str, &Workspace> = local.iter().map(|w| (w.id.as_str(), w)).collect();

    // Same project, different id — only worth computing for workspaces that
    // have a repository to compare by.
    let mut local_by_repo: BTreeMap<String, &Workspace> = BTreeMap::new();
    for w in local {
        if let Some(r) = repo_of(w) {
            local_by_repo.insert(normalise_repo(&r), w);
        }
    }

    for (path, wire) in read_dir_of::<WireWorkspace>(root, |p| {
        p.file_name().map(|n| n == "workspace.json").unwrap_or(false)
    }) {
        let Some(wire) = wire else {
            out.unreadable.push(path);
            continue;
        };
        let existing = by_id.get(wire.id.as_str()).copied();
        let merged = merge_workspace(&wire, existing);

        // Only for a record that is new here. One already known by its id is the
        // same workspace arriving again, not a second one.
        if existing.is_none() {
            if let Some(other) = wire.repo.as_deref().and_then(|r| local_by_repo.get(&normalise_repo(r))) {
                out.questions.push(Question::Duplicate {
                    arriving_id: wire.id.clone(),
                    local_id: other.id.clone(),
                    name: wire.name.clone(),
                });
            }
        }

        if merged.path.trim().is_empty() {
            out.questions.push(Question::NeedsPath {
                workspace_id: merged.id.clone(),
                name: merged.name.clone(),
                clone_from: wire.repo.clone(),
            });
        }
        if wire.tracker_needs_path {
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
    use crate::model::{Schedule, SchedulePreset};
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
        }
    }

    fn publish(root: &Path, w: &Workspace, repo: Option<&str>) {
        let wire = project_workspace(w, repo);
        let p = root.join(&w.id).join("workspace.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, serde_json::to_string_pretty(&wire).unwrap()).unwrap();
    }

    fn no_repos(_: &Workspace) -> Option<String> {
        None
    }

    #[test]
    fn a_fresh_machine_gets_every_record_and_a_question_for_each() {
        let r = root("fresh");
        publish(&r, &ws("ws-1", "deck", "/elsewhere/deck"), Some("me/deck"));
        publish(&r, &ws("ws-2", "site", "/elsewhere/site"), None);

        let a = adopt(&r, &[], &[], &no_repos);
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
        publish(&r, &ws("ws-1", "renamed elsewhere", "/elsewhere/deck"), None);

        let a = adopt(&r, std::slice::from_ref(&here), &[], &no_repos);
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
        publish(&r, &ws("ws-remote", "deck", "/elsewhere/deck"), Some("git@github.com:me/deck.git"));

        let here = ws("ws-local", "deck", "/here/deck");
        let repo_of = |_: &Workspace| Some("https://github.com/Me/deck".to_string());

        let a = adopt(&r, std::slice::from_ref(&here), &[], &repo_of);
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
        publish(&r, &ws("ws-remote", "site", "/elsewhere/site"), Some("me/site"));

        let here = ws("ws-local", "deck", "/here/deck");
        let repo_of = |_: &Workspace| Some("https://github.com/me/deck".to_string());

        let a = adopt(&r, std::slice::from_ref(&here), &[], &repo_of);
        assert!(
            !a.questions.iter().any(|q| matches!(q, Question::Duplicate { .. })),
            "different repositories, same account: {:?}",
            a.questions
        );
    }

    #[test]
    fn a_record_that_will_not_parse_is_reported_rather_than_skipped() {
        let r = root("bad");
        publish(&r, &ws("ws-1", "deck", "/elsewhere/deck"), None);
        let p = r.join("ws-2/workspace.json");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "{ not json").unwrap();

        let a = adopt(&r, &[], &[], &no_repos);
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

        let a = adopt(&r, &[], &[], &no_repos);
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
        publish(&r, &w, None);

        let a = adopt(&r, &[], &[], &no_repos);
        assert!(
            a.questions.iter().any(|q| matches!(q, Question::NeedsBoardPath { .. })),
            "{:?}",
            a.questions
        );
    }

    #[test]
    fn an_absent_root_is_empty_rather_than_an_error() {
        let a = adopt(Path::new("/nonexistent-root"), &[], &[], &no_repos);
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
