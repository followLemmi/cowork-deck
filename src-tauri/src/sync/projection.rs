//! The runtime store on one side, the repository on the other, and the
//! translation between them.
//!
//! # Why a projection at all
//!
//! `workspaces.json` is one array, and one array is one conflict surface. Two
//! machines each adding a different workspace touch the same file on the same
//! lines, and a bad resolution there is #117 again: one unreadable record, and
//! the next save makes the emptiness permanent. Split into a file per workspace,
//! those two machines touch different files and git has nothing to resolve.
//!
//! # Why hand-written wire types
//!
//! Serialising the model directly would be less code and exactly wrong: a field
//! added to `Workspace` later would travel by default, which is the same failure
//! the ignore file is written inside out to avoid (`manifest`).
//!
//! Every `project_*` below destructures its input exhaustively — no `..` — so a
//! new field on the model does not compile until somebody decides whether it
//! travels. That decision is the whole point, and a compiler error is a better
//! place to be asked for it than a code review.

use crate::model::{
    Schedule, Skill, TrackerConfig, TrackerProvider, TrackerRoot, Workspace, WorkspaceGithub,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- paths

/// `{workspace_id}/workspace.json` — beside the memory it describes, not above
/// it. The sidecar reads the first path segment as a scope, so a `workspaces/`
/// prefix would collapse every workspace into one (ADR-0004); and the walk
/// indexes only `.md`, so this file is invisible to it.
pub fn workspace_path(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("workspace.json")
}

pub fn scenario_path(root: &Path, id: &str) -> PathBuf {
    root.join("scenarios").join(format!("{id}.json"))
}

/// The journal is append-only, so each machine gets its own file. Two machines
/// appending to one would conflict on every single sync.
pub fn runs_shard(root: &Path, machine_id: &str) -> PathBuf {
    root.join("runs").join(machine_id).join("runs.jsonl")
}

/// The label beside the shard it names.
///
/// This is the answer to the question `machine.rs` deliberately left open: with
/// the label local-only, the repository could not say which shard was the
/// laptop, and a history screen reduced to "another machine" is no use to
/// someone with three.
///
/// It does mean the host's name reaches the repository. That is a small
/// disclosure into a private, single-owner store that already holds the person's
/// session history — and it does *not* undo the reason the id is random. That
/// reason is stability: a machine gets renamed, and an id derived from the
/// hostname would split its journal in two at the moment it happened.
pub fn machine_label_path(root: &Path, machine_id: &str) -> PathBuf {
    root.join("runs").join(machine_id).join("machine.json")
}

// ---------------------------------------------------------------- workspaces

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireGithub {
    pub host: String,
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitName")]
    pub git_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitEmail")]
    pub git_email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireWorkspace {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<WireGithub>,
    /// Board providers that mean the same thing on any machine: the GitHub
    /// issues of the workspace's own repository, or `.cowork/tasks` inside its
    /// folder. Both are relative to a path that is resolved locally.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracker: Vec<WireTracker>,
    /// The remote this workspace's folder points at.
    ///
    /// It travels because it is the only thing that can carry identity between
    /// machines: the id is generated locally, and the path is one machine's
    /// disk. A machine that has never seen this project has nothing else to
    /// recognise it by, and without this field two records for one project stay
    /// two records forever (#348).
    ///
    /// Absent when the folder has no remote, and when the record has never been
    /// resolved on the machine that wrote it. Both mean the same thing to a
    /// reader — this record offers no identity — which is why they are one
    /// value here and two on the local side (`model::WorkspaceRepo`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// A folder-based board pointed somewhere only this machine knows about.
    ///
    /// The path itself cannot travel, so what travels is the fact that there was
    /// one — otherwise the configuration vanishes silently and the person is
    /// left to work out that their board used to exist. #316 is what asks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tracker_needs_path: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireTracker {
    Github,
    ProjectFolder,
}

/// Everything a workspace record loses on the way out.
///
/// `path` is this machine's disk. `ssh_key` is a path to a private key, and a
/// path to a key on a machine that does not have it is worse than nothing: it
/// makes `GIT_SSH_COMMAND` name a file that is not there. `previous_location`
/// records where cards used to be *here*, which is meaningless anywhere else.
///
/// `repo` is the one field that is half local and half not: the cached answer
/// records the folder it was read in, which is this machine's disk, and the URL
/// inside it is the same string everywhere. So the URL travels and the rest of
/// the record does not.
pub fn project_workspace(ws: &Workspace) -> WireWorkspace {
    // Exhaustive on purpose. A new field must not compile until it is decided.
    let Workspace { id, name, path: _this_machines_disk, color, github, tracker, repo } = ws;
    let repo = repo.as_ref().and_then(|r| r.url.as_deref());

    let github = github.as_ref().map(|g| {
        let WorkspaceGithub { host, login, git_name, git_email, ssh_key: _a_local_key } = g;
        WireGithub {
            host: host.clone(),
            login: login.clone(),
            git_name: git_name.clone(),
            git_email: git_email.clone(),
        }
    });

    let (mut wire_tracker, mut needs_path) = (Vec::new(), false);
    if let Some(t) = tracker {
        let TrackerConfig { providers, previous_location: _local_history, version: _local_format } = t;
        for p in providers {
            match p {
                TrackerProvider::GitHub => wire_tracker.push(WireTracker::Github),
                TrackerProvider::Fs { root: TrackerRoot::Project } => {
                    wire_tracker.push(WireTracker::ProjectFolder)
                }
                TrackerProvider::Fs { root: TrackerRoot::Path { .. } } => needs_path = true,
                // Written by a newer build. It round-trips verbatim in the local
                // store (#117) but must not be re-published from here: this build
                // cannot tell whether it names a path, an account or a secret.
                TrackerProvider::Unknown(_) => {}
            }
        }
    }

    WireWorkspace {
        id: id.clone(),
        name: name.clone(),
        color: color.clone(),
        github,
        repo: repo.map(str::to_string),
        tracker: wire_tracker,
        tracker_needs_path: needs_path,
    }
}

/// A wire record back into a local one.
///
/// `local` is the record already here under this id, when there is one. Its
/// machine-local fields survive: the arriving record has nothing to say about
/// this machine's disk, and letting it blank a working path would break a
/// workspace on every pull.
pub fn merge_workspace(wire: &WireWorkspace, local: Option<&Workspace>) -> Workspace {
    let providers: Vec<TrackerProvider> = wire
        .tracker
        .iter()
        .map(|t| match t {
            WireTracker::Github => TrackerProvider::GitHub,
            WireTracker::ProjectFolder => TrackerProvider::Fs { root: TrackerRoot::Project },
        })
        .collect();

    let tracker = match (local.and_then(|l| l.tracker.as_ref()), providers.is_empty()) {
        // Nothing arrived and nothing is here: no tracker, rather than an empty
        // one, which reads as "configured, with no sources".
        (None, true) => None,
        (None, false) => Some(TrackerConfig {
            providers,
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }),
        // Keep this machine's `previous_location` and format version: both
        // describe cards on this disk, and the arriving record never saw them.
        (Some(l), _) => Some(TrackerConfig {
            providers,
            previous_location: l.previous_location.clone(),
            version: l.version,
        }),
    };

    Workspace {
        id: wire.id.clone(),
        name: wire.name.clone(),
        color: wire.color.clone(),
        // Empty means "not resolved on this machine yet" — #316 asks, and until
        // it does the record is still worth having, because its memory is
        // searchable without the folder existing.
        path: local.map(|l| l.path.clone()).unwrap_or_default(),
        github: wire.github.as_ref().map(|g| WorkspaceGithub {
            host: g.host.clone(),
            login: g.login.clone(),
            git_name: g.git_name.clone(),
            git_email: g.git_email.clone(),
            ssh_key: local.and_then(|l| l.github.as_ref()).and_then(|g| g.ssh_key.clone()),
        }),
        tracker,
        // Local, like the path it was read beside — and re-derived rather than
        // carried, because the arriving record's answer describes the *other*
        // machine's checkout of the project. Blanking it here would only mean
        // asking git again on the next cycle, which is what the cache exists to
        // avoid.
        repo: local.and_then(|l| l.repo.clone()),
    }
}

// ---------------------------------------------------------------- scenarios

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireSchedule {
    pub preset: crate::model::SchedulePreset,
    #[serde(default)]
    pub defaults: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireSkill {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub prompt: String,
    #[serde(rename = "workspaceId", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<WireSchedule>,
}

/// A scenario travels; whether it *fires* does not.
///
/// `enabled` is left behind deliberately, and not merely defaulted to false on
/// arrival. Projected at all, the sequence is: machine B pulls the scenario
/// disabled, the person enables it there, the next pull from A sets it back, and
/// a scheduled scenario silently stops running. The codebase already draws this
/// line once — the schedule *definition* lives on the `Skill` and the runtime
/// `lastRun` lives in `schedule_state.json` "so editing a scenario cannot
/// clobber it" (`model.rs`). `enabled` belongs on the same side of it.
///
/// Without that, a scenario firing at 03:00 fires at 03:00 on both machines: two
/// commits, two pull requests, or two digests.
pub fn project_skill(sk: &Skill) -> WireSkill {
    let Skill { id, name, icon, prompt, workspace_id, schedule } = sk;
    WireSkill {
        id: id.clone(),
        name: name.clone(),
        icon: icon.clone(),
        prompt: prompt.clone(),
        workspace_id: workspace_id.clone(),
        schedule: schedule.as_ref().map(|s| {
            let Schedule { preset, defaults, enabled: _this_machines_choice } = s;
            WireSchedule {
                preset: preset.clone(),
                defaults: defaults.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            }
        }),
    }
}

/// Arriving scenario into a local one. A schedule that is already enabled here
/// stays enabled; one arriving for the first time is off until someone says
/// otherwise on this machine.
pub fn merge_skill(wire: &WireSkill, local: Option<&Skill>) -> Skill {
    let was_enabled = local
        .and_then(|l| l.schedule.as_ref())
        .map(|s| s.enabled)
        .unwrap_or(false);

    Skill {
        id: wire.id.clone(),
        name: wire.name.clone(),
        icon: wire.icon.clone(),
        prompt: wire.prompt.clone(),
        workspace_id: wire.workspace_id.clone(),
        schedule: wire.schedule.as_ref().map(|s| Schedule {
            preset: s.preset.clone(),
            defaults: s.defaults.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            enabled: was_enabled,
        }),
    }
}

// ---------------------------------------------------------------- run journal

/// Every shard's lines, oldest first, for a history screen that wants the whole
/// story rather than this machine's half of it.
///
/// Shards are read in id order and concatenated, not interleaved by timestamp:
/// the journal's own folding already keys on run id, and two machines' clocks
/// are not comparable closely enough to justify pretending otherwise.
#[allow(dead_code)] // Read by the history screen once it shows every machine's runs, not only this one's.
pub fn read_run_shards(root: &Path) -> Vec<String> {
    let dir = root.join("runs");
    let mut shards: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path().join("runs.jsonl"))
            .filter(|p| p.is_file())
            .collect(),
        Err(_) => return Vec::new(),
    };
    shards.sort();

    let mut out = Vec::new();
    for p in shards {
        if let Ok(s) = std::fs::read_to_string(&p) {
            out.extend(s.lines().filter(|l| !l.trim().is_empty()).map(|l| l.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PreviousLocation, SchedulePreset};

    fn ws() -> Workspace {
        Workspace {
            id: "ws-1".into(),
            name: "cowork-deck".into(),
            path: "/Users/someone/code/cowork-deck".into(),
            color: "#8ab4f8".into(),
            github: Some(WorkspaceGithub {
                host: "github.com".into(),
                login: "followLemmi".into(),
                git_name: Some("Someone".into()),
                git_email: Some("someone@example.com".into()),
                ssh_key: Some("/Users/someone/.ssh/id_ed25519".into()),
            }),
            tracker: Some(TrackerConfig {
                providers: vec![
                    TrackerProvider::GitHub,
                    TrackerProvider::Fs { root: TrackerRoot::Project },
                ],
                previous_location: Some(PreviousLocation {
                    root: "/Users/someone/old".into(),
                    project: "cowork-deck".into(),
                    was_project_root: true,
                }),
                version: 3,
            }),
            repo: Some(crate::model::WorkspaceRepo {
                url: Some("https://github.com/followLemmi/cowork-deck".into()),
                from: "/Users/someone/code/cowork-deck".into(),
                resolver: crate::sync::identity::RESOLVER,
            }),
        }
    }

    fn sk() -> Skill {
        Skill {
            id: "sk-1".into(),
            name: "Nightly digest".into(),
            icon: "📰".into(),
            prompt: "Summarise {{branch}}".into(),
            workspace_id: Some("ws-1".into()),
            schedule: Some(Schedule {
                preset: SchedulePreset::Daily { hour: 3, minute: 0 },
                defaults: [("branch".to_string(), "dev".to_string())].into_iter().collect(),
                enabled: true,
            }),
        }
    }

    #[test]
    fn no_absolute_path_survives_the_projection() {
        let json = serde_json::to_string(&project_workspace(&ws())).unwrap();
        for leak in [
            "/Users/someone/code/cowork-deck",
            "/Users/someone/.ssh/id_ed25519",
            "/Users/someone/old",
        ] {
            assert!(!json.contains(leak), "{leak} reached the wire format: {json}");
        }
        // And nothing that merely looks like one, either.
        assert!(!json.contains("/Users/"), "a path leaked: {json}");
    }

    #[test]
    fn a_workspace_round_trips_apart_from_what_is_local() {
        let original = ws();
        let back = merge_workspace(&project_workspace(&original), Some(&original));
        assert_eq!(back.id, original.id);
        assert_eq!(back.name, original.name);
        assert_eq!(back.color, original.color);
        assert_eq!(back.path, original.path, "the local path is kept, not carried");
        let (a, b) = (back.github.unwrap(), original.github.unwrap());
        assert_eq!(a.login, b.login);
        assert_eq!(a.git_email, b.git_email);
        assert_eq!(a.ssh_key, b.ssh_key, "the local key path is kept, not carried");
        let t = back.tracker.unwrap();
        assert_eq!(t.providers.len(), 2);
        assert!(t.previous_location.is_some(), "local card history survives a pull");
    }

    #[test]
    fn a_workspace_arriving_for_the_first_time_has_no_path() {
        let arrived = merge_workspace(&project_workspace(&ws()), None);
        assert!(arrived.path.is_empty(), "there is no local path to invent");
        assert!(arrived.github.unwrap().ssh_key.is_none(), "nor a local key");
        assert!(arrived.tracker.unwrap().previous_location.is_none());
        assert!(arrived.repo.is_none(), "nor an answer about a folder that is not here");
    }

    /// The one field that is half local and half not. Recognising a duplicate
    /// needs the URL on the wire; nothing needs the folder it was read in.
    #[test]
    fn the_repository_travels_and_the_folder_it_was_read_in_does_not() {
        let wire = project_workspace(&ws());
        assert_eq!(wire.repo.as_deref(), Some("https://github.com/followLemmi/cowork-deck"));
        assert!(!serde_json::to_string(&wire).unwrap().contains("/Users/"));

        let no_remote = {
            let mut w = ws();
            w.repo = Some(crate::model::WorkspaceRepo {
                url: None,
                from: "/Users/someone/code/cowork-deck".into(),
                resolver: crate::sync::identity::RESOLVER,
            });
            project_workspace(&w)
        };
        assert_eq!(no_remote.repo, None, "a folder with no remote offers no identity");
    }

    /// The arriving record's answer describes the *other* machine's checkout.
    /// Keeping this machine's own is what stops the next cycle asking git again.
    #[test]
    fn a_pull_keeps_this_machines_answer_about_its_own_folder() {
        let local = ws();
        let mut wire = project_workspace(&local);
        wire.repo = Some("https://github.com/someone-else/fork".into());
        let merged = merge_workspace(&wire, Some(&local));
        assert_eq!(merged.repo, local.repo);
    }

    /// The failure this guards is quiet: a pull blanking a path that works,
    /// leaving a workspace that cannot start a session.
    #[test]
    fn a_pull_never_blanks_a_resolved_path() {
        let local = ws();
        let mut wire = project_workspace(&local);
        wire.name = "renamed elsewhere".into();
        let merged = merge_workspace(&wire, Some(&local));
        assert_eq!(merged.name, "renamed elsewhere", "shared fields do arrive");
        assert_eq!(merged.path, local.path, "local ones do not");
    }

    #[test]
    fn a_folder_board_becomes_a_question_rather_than_vanishing() {
        let mut w = ws();
        w.tracker.as_mut().unwrap().providers =
            vec![TrackerProvider::Fs { root: TrackerRoot::Path { path: "/Users/someone/vault".into() } }];
        let wire = project_workspace(&w);
        assert!(wire.tracker.is_empty(), "the path cannot travel");
        assert!(wire.tracker_needs_path, "but the fact that there was one must");
        assert!(!serde_json::to_string(&wire).unwrap().contains("/Users/"));
    }

    /// A provider written by a newer build round-trips in the local store (#117)
    /// but must not be re-published: this build cannot tell whether it names a
    /// path, an account or a secret.
    #[test]
    fn an_unreadable_provider_is_not_republished() {
        let mut w = ws();
        w.tracker.as_mut().unwrap().providers = vec![TrackerProvider::Unknown(
            serde_json::json!({"type": "jira", "token": "s3cret", "root": "/Users/someone/x"}),
        )];
        let json = serde_json::to_string(&project_workspace(&w)).unwrap();
        assert!(!json.contains("s3cret"), "a secret in a provider we cannot read: {json}");
        assert!(!json.contains("jira"), "{json}");
    }

    #[test]
    fn a_scenario_travels_but_its_schedule_does_not_start_firing() {
        let wire = project_skill(&sk());
        assert!(
            !serde_json::to_string(&wire).unwrap().contains("enabled"),
            "enabled must not be on the wire at all"
        );
        let arrived = merge_skill(&wire, None);
        assert_eq!(arrived.prompt, sk().prompt);
        let s = arrived.schedule.expect("the schedule itself travels");
        assert!(!s.enabled, "off until this machine says otherwise");
        assert_eq!(s.preset, sk().schedule.unwrap().preset, "and arrives intact");
    }

    /// The regression that "arrives disabled" would not have caught: enable it
    /// here, pull again, and it must not switch itself back off.
    #[test]
    fn a_later_pull_does_not_disable_what_this_machine_enabled() {
        let wire = project_skill(&sk());
        let here = merge_skill(&wire, None);
        let mut here = here;
        here.schedule.as_mut().unwrap().enabled = true;

        let again = merge_skill(&wire, Some(&here));
        assert!(
            again.schedule.unwrap().enabled,
            "a pull must not clobber this machine's choice"
        );
    }

    #[test]
    fn two_machines_write_different_files() {
        let root = Path::new("/tmp/root");
        assert_ne!(runs_shard(root, "m-1"), runs_shard(root, "m-2"));
        assert_eq!(workspace_path(root, "ws-1"), root.join("ws-1/workspace.json"));
        assert_eq!(scenario_path(root, "sk-1"), root.join("scenarios/sk-1.json"));
    }

    #[test]
    fn the_journal_is_read_across_every_shard() {
        let root = std::env::temp_dir().join(format!("cd-shards-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (m, lines) in [("m-1", "a\nb\n"), ("m-2", "c\n")] {
            let p = runs_shard(&root, m);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, lines).unwrap();
        }
        // A shard directory with no journal yet, and a blank line in one.
        std::fs::create_dir_all(root.join("runs/m-3")).unwrap();

        assert_eq!(read_run_shards(&root), vec!["a", "b", "c"]);
        assert!(read_run_shards(Path::new("/nonexistent")).is_empty());

        std::fs::remove_dir_all(&root).unwrap();
    }
}
