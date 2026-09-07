//! Writing the store out as the repository sees it, before each cycle commits.
//!
//! Without this the loop would commit whatever happened to be in the directory —
//! which is the memory the sidecar writes, and none of the configuration. The
//! projection describes the shape; this is what puts it on disk.
//!
//! Writing only. Removal is deliberately *not* done by comparing the repository
//! against the store: from here, a record that arrived in a pull and has not
//! been merged yet looks exactly like one deleted locally. `forget_workspace` is
//! called when somebody actually deletes one.

use crate::model::{Skill, Workspace};
use crate::sync::activation;
use crate::sync::machine::Machine;
use crate::sync::manifest;
use crate::sync::projection::{
    machine_label_path, project_skill, project_workspace, runs_shard, scenario_path,
    workspace_path,
};
use std::path::Path;

/// What the repository should contain, written where sync will find it.
pub fn publish(
    root: &Path,
    workspaces: &[Workspace],
    skills: &[Skill],
    machine: &Machine,
) -> std::io::Result<()> {
    // Rewritten every cycle rather than only at activation: a build that adds a
    // path shape has to take effect on an already-connected machine, and the
    // alternative is a migration nobody would remember to write.
    std::fs::write(root.join(".gitignore"), manifest::gitignore())?;
    std::fs::write(root.join(activation::MARKER), activation::marker_body())?;

    for w in workspaces {
        let wire = project_workspace(w);
        let p = workspace_path(root, &w.id);
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_if_changed(&p, &serde_json::to_string_pretty(&wire)?)?;
    }

    let scen_dir = root.join("scenarios");
    std::fs::create_dir_all(&scen_dir)?;
    for s in skills {
        write_if_changed(
            &scenario_path(root, &s.id),
            &serde_json::to_string_pretty(&project_skill(s))?,
        )?;
    }

    // This machine's journal, in its own shard, beside its own label.
    let shard = runs_shard(root, &machine.id);
    if let Some(dir) = shard.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if let Ok(journal) = std::fs::read_to_string(root.join("runs.jsonl")) {
        write_if_changed(&shard, &journal)?;
    }
    write_if_changed(
        &machine_label_path(root, &machine.id),
        &serde_json::to_string_pretty(machine)?,
    )?;

    Ok(())
}

/// Only touch the file when its contents differ.
///
/// Not an optimisation. `commit_all` asks git whether anything changed, and
/// rewriting identical files does not make git think so — but it does churn
/// mtimes, and the memory index keys its incremental update on mtime and size.
/// A rewrite every five minutes would re-embed the whole corpus every five
/// minutes.
fn write_if_changed(path: &Path, body: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == body {
            return Ok(());
        }
    }
    std::fs::write(path, body)
}

/// Forget one workspace, because somebody deleted it here.
///
/// Deletion is an event, not something to infer. A sweep comparing the
/// repository against the local store cannot tell a workspace deleted here from
/// one that arrived in a pull and has not been merged yet — and it used to
/// delete the second kind, commit that, and push it, so the machine it came
/// from lost its own record on the next pull.
///
/// **Its memory stays.** The notes under that id are the history of work that
/// really happened, and deleting a workspace is not a statement about it. An
/// orphaned corpus is recoverable; a deleted one is not.
pub fn forget_workspace(root: &Path, id: &str) {
    let _ = std::fs::remove_file(workspace_path(root, id));
}

/// Forget one scenario. Unlike a workspace it leaves nothing behind worth
/// keeping, so the file is the whole of it.
pub fn forget_scenario(root: &Path, id: &str) {
    let _ = std::fs::remove_file(scenario_path(root, id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Workspace;
    use std::fs;
    use std::path::PathBuf;

    fn root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cd-publish-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn ws(id: &str) -> Workspace {
        Workspace {
            id: id.into(),
            name: id.into(),
            path: format!("/here/{id}"),
            color: "#8ab4f8".into(),
            github: None,
            tracker: None,
            repo: None,
        }
    }

    fn machine() -> Machine {
        Machine { id: "m-1".into(), label: "laptop".into() }
    }

    #[test]
    fn the_store_lands_where_sync_will_commit_it() {
        let r = root("basic");
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine()).unwrap();

        assert!(r.join("ws-1/workspace.json").is_file());
        assert!(r.join("ws-2/workspace.json").is_file());
        assert!(r.join(".gitignore").is_file(), "the boundary travels with the repository");
        assert!(r.join(".cowork-sync.json").is_file(), "and so does what identifies it");
        assert!(r.join("runs/m-1/machine.json").is_file(), "the label beside its shard");

        let written = fs::read_to_string(r.join("ws-1/workspace.json")).unwrap();
        assert!(!written.contains("/here/"), "no local path may reach it: {written}");
    }

    /// Not an optimisation. The memory index keys incremental update on mtime
    /// and size, so rewriting identical files every five minutes would re-embed
    /// the entire corpus every five minutes.
    #[test]
    fn an_unchanged_record_is_not_rewritten() {
        let r = root("mtime");
        publish(&r, &[ws("ws-1")], &[], &machine()).unwrap();
        let p = r.join("ws-1/workspace.json");
        let first = fs::metadata(&p).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        publish(&r, &[ws("ws-1")], &[], &machine()).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().modified().unwrap(),
            first,
            "an identical record must not be touched"
        );

        let mut changed = ws("ws-1");
        changed.name = "renamed".into();
        std::thread::sleep(std::time::Duration::from_millis(20));
        publish(&r, &[changed], &[], &machine()).unwrap();
        assert_ne!(
            fs::metadata(&p).unwrap().modified().unwrap(),
            first,
            "but a changed one must be"
        );
    }

    /// Otherwise the next machine to pull resurrects it, and deleting it again
    /// becomes a fight rather than an action.
    #[test]
    fn a_workspace_deleted_here_stops_being_published() {
        let r = root("prune");
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine()).unwrap();

        forget_workspace(&r, "ws-2");

        assert!(r.join("ws-1/workspace.json").is_file());
        assert!(!r.join("ws-2/workspace.json").exists(), "its record goes");
    }

    /// The notes under that id are the history of work that really happened.
    /// Deleting a workspace is not a statement about it.
    #[test]
    fn but_its_memory_is_left_alone() {
        let r = root("keepmem");
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine()).unwrap();
        fs::write(r.join("ws-2/Facts.md"), "- something that happened\n").unwrap();
        fs::create_dir_all(r.join("ws-2/Sessions/2026-08")).unwrap();
        fs::write(r.join("ws-2/Sessions/2026-08/24-topic.md"), "# a session\n").unwrap();

        forget_workspace(&r, "ws-2");

        assert!(!r.join("ws-2/workspace.json").exists());
        assert!(r.join("ws-2/Facts.md").is_file(), "an orphaned corpus is recoverable");
        assert!(r.join("ws-2/Sessions/2026-08/24-topic.md").is_file());
    }

    #[test]
    fn forgetting_something_that_was_never_there_is_not_an_error() {
        let r = root("forgetnone");
        forget_workspace(&r, "never-existed");
        forget_scenario(&r, "never-existed");
    }

    /// The failure this file had, and the reason pruning left it.
    ///
    /// A record that arrived in a pull but has not been merged into the local
    /// store yet is indistinguishable, from here, from one deleted locally. A
    /// sweep that infers deletion from absence therefore deletes the other
    /// machine's workspace, commits that, pushes it — and the machine it came
    /// from loses its own record on the next pull.
    #[test]
    fn a_record_pulled_but_not_yet_adopted_survives() {
        let r = root("pulled");
        // As a pull would have left it: on disk, not in this machine's store.
        fs::create_dir_all(r.join("ws-from-a")).unwrap();
        fs::write(r.join("ws-from-a/workspace.json"), "{\"id\":\"ws-from-a\"}").unwrap();

        publish(&r, &[ws("ws-1")], &[], &machine()).unwrap();

        assert!(
            r.join("ws-from-a/workspace.json").is_file(),
            "another machine's record must not be deleted for being unfamiliar"
        );
    }

    #[test]
    fn a_scenario_pulled_but_not_yet_adopted_survives() {
        let r = root("pulledscen");
        fs::create_dir_all(r.join("scenarios")).unwrap();
        fs::write(r.join("scenarios/sk-from-a.json"), "{\"id\":\"sk-from-a\"}").unwrap();

        publish(&r, &[], &[], &machine()).unwrap();

        assert!(r.join("scenarios/sk-from-a.json").is_file());
    }

    #[test]
    fn the_journal_goes_into_this_machines_shard_and_no_one_elses() {
        let r = root("shard");
        fs::write(r.join("runs.jsonl"), "{\"a\":1}\n").unwrap();
        // Another machine's shard, as a pull would have left it.
        fs::create_dir_all(r.join("runs/m-2")).unwrap();
        fs::write(r.join("runs/m-2/runs.jsonl"), "{\"b\":2}\n").unwrap();

        publish(&r, &[], &[], &machine()).unwrap();

        assert_eq!(fs::read_to_string(r.join("runs/m-1/runs.jsonl")).unwrap(), "{\"a\":1}\n");
        assert_eq!(
            fs::read_to_string(r.join("runs/m-2/runs.jsonl")).unwrap(),
            "{\"b\":2}\n",
            "another machine's shard is not ours to write"
        );
    }

    #[test]
    fn the_directories_publish_does_not_own_are_left_alone() {
        let r = root("leave");
        fs::create_dir_all(r.join("Diaries/reviewer")).unwrap();
        fs::write(r.join("Diaries/reviewer/2026-08.md"), "# lessons\n").unwrap();

        publish(&r, &[ws("ws-1")], &[], &machine()).unwrap();
        assert!(r.join("Diaries/reviewer/2026-08.md").is_file(), "global diaries are not workspaces");
    }
}
