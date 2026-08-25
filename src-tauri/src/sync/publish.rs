//! Writing the store out as the repository sees it, before each cycle commits.
//!
//! Without this the loop would commit whatever happened to be in the directory —
//! which is the memory the sidecar writes, and none of the configuration. The
//! projection describes the shape; this is what puts it on disk.
//!
//! Files are removed as well as written. A workspace deleted here has to
//! disappear from the repository too, or the next machine to pull would resurrect
//! it, and deleting it again would be a fight rather than an action.

use crate::model::{Skill, Workspace};
use crate::sync::activation;
use crate::sync::machine::Machine;
use crate::sync::manifest;
use crate::sync::projection::{
    machine_label_path, project_skill, project_workspace, runs_shard, scenario_path,
    workspace_path,
};
use std::collections::BTreeSet;
use std::path::Path;

/// What the repository should contain, written where sync will find it.
///
/// `repo_of` answers what repository a workspace's folder is, which only the
/// caller can know — it means asking `gh`, and this is worth testing without one.
pub fn publish(
    root: &Path,
    workspaces: &[Workspace],
    skills: &[Skill],
    machine: &Machine,
    repo_of: &dyn Fn(&Workspace) -> Option<String>,
) -> std::io::Result<()> {
    // Rewritten every cycle rather than only at activation: a build that adds a
    // path shape has to take effect on an already-connected machine, and the
    // alternative is a migration nobody would remember to write.
    std::fs::write(root.join(".gitignore"), manifest::gitignore())?;
    std::fs::write(root.join(activation::MARKER), activation::marker_body())?;

    let mut keep_workspaces = BTreeSet::new();
    for w in workspaces {
        let wire = project_workspace(w, repo_of(w).as_deref());
        let p = workspace_path(root, &w.id);
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_if_changed(&p, &serde_json::to_string_pretty(&wire)?)?;
        keep_workspaces.insert(w.id.clone());
    }

    let mut keep_scenarios = BTreeSet::new();
    let scen_dir = root.join("scenarios");
    std::fs::create_dir_all(&scen_dir)?;
    for s in skills {
        write_if_changed(
            &scenario_path(root, &s.id),
            &serde_json::to_string_pretty(&project_skill(s))?,
        )?;
        keep_scenarios.insert(format!("{}.json", s.id));
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

    prune_workspaces(root, &keep_workspaces);
    prune_scenarios(&scen_dir, &keep_scenarios);
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

/// A workspace removed locally loses its `workspace.json`, and nothing else.
///
/// **Its memory stays.** The notes under that id are the history of work that
/// really happened, and deleting a workspace is not a statement about it. An
/// orphaned corpus is recoverable; a deleted one is not.
fn prune_workspaces(root: &Path, keep: &BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') || name == "scenarios" || name == "runs" || name == "Diaries" {
            continue;
        }
        if !keep.contains(name) {
            let _ = std::fs::remove_file(p.join("workspace.json"));
        }
    }
}

/// A deleted scenario, unlike a workspace, leaves nothing behind worth keeping.
fn prune_scenarios(dir: &Path, keep: &BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if p.is_file() && name.ends_with(".json") && !keep.contains(name) {
            let _ = std::fs::remove_file(p);
        }
    }
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
        }
    }

    fn machine() -> Machine {
        Machine { id: "m-1".into(), label: "laptop".into() }
    }

    fn no_repo(_: &Workspace) -> Option<String> {
        None
    }

    #[test]
    fn the_store_lands_where_sync_will_commit_it() {
        let r = root("basic");
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine(), &no_repo).unwrap();

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
        publish(&r, &[ws("ws-1")], &[], &machine(), &no_repo).unwrap();
        let p = r.join("ws-1/workspace.json");
        let first = fs::metadata(&p).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));
        publish(&r, &[ws("ws-1")], &[], &machine(), &no_repo).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().modified().unwrap(),
            first,
            "an identical record must not be touched"
        );

        let mut changed = ws("ws-1");
        changed.name = "renamed".into();
        std::thread::sleep(std::time::Duration::from_millis(20));
        publish(&r, &[changed], &[], &machine(), &no_repo).unwrap();
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
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine(), &no_repo).unwrap();
        publish(&r, &[ws("ws-1")], &[], &machine(), &no_repo).unwrap();

        assert!(r.join("ws-1/workspace.json").is_file());
        assert!(!r.join("ws-2/workspace.json").exists(), "its record goes");
    }

    /// The notes under that id are the history of work that really happened.
    /// Deleting a workspace is not a statement about it.
    #[test]
    fn but_its_memory_is_left_alone() {
        let r = root("keepmem");
        publish(&r, &[ws("ws-1"), ws("ws-2")], &[], &machine(), &no_repo).unwrap();
        fs::write(r.join("ws-2/Facts.md"), "- something that happened\n").unwrap();
        fs::create_dir_all(r.join("ws-2/Sessions/2026-08")).unwrap();
        fs::write(r.join("ws-2/Sessions/2026-08/24-topic.md"), "# a session\n").unwrap();

        publish(&r, &[ws("ws-1")], &[], &machine(), &no_repo).unwrap();

        assert!(!r.join("ws-2/workspace.json").exists());
        assert!(r.join("ws-2/Facts.md").is_file(), "an orphaned corpus is recoverable");
        assert!(r.join("ws-2/Sessions/2026-08/24-topic.md").is_file());
    }

    #[test]
    fn the_journal_goes_into_this_machines_shard_and_no_one_elses() {
        let r = root("shard");
        fs::write(r.join("runs.jsonl"), "{\"a\":1}\n").unwrap();
        // Another machine's shard, as a pull would have left it.
        fs::create_dir_all(r.join("runs/m-2")).unwrap();
        fs::write(r.join("runs/m-2/runs.jsonl"), "{\"b\":2}\n").unwrap();

        publish(&r, &[], &[], &machine(), &no_repo).unwrap();

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

        publish(&r, &[ws("ws-1")], &[], &machine(), &no_repo).unwrap();
        assert!(r.join("Diaries/reviewer/2026-08.md").is_file(), "global diaries are not workspaces");
    }
}
