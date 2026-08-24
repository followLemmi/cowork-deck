//! Which machine this is — enough to keep two of them out of each other's way,
//! and no more than that.
//!
//! It exists for one reason: the run journal is append-only, and two machines
//! appending to one `runs.jsonl` conflict on every sync. Sharding it needs a
//! name per machine, so a name per machine is what this is.
//!
//! `machine.json` is not on the allowlist and never travels. What travels is the
//! id, and only as a directory name under `runs/`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Machine {
    /// Stable for the life of this installation, and a directory name in the
    /// repository.
    ///
    /// Random rather than derived from the hostname, and stability is the
    /// reason: machines get renamed, and an id that followed the hostname would
    /// split this machine's journal in two at the moment it happened.
    pub id: String,
    /// A name for this machine, for a person reading a list of them.
    ///
    /// `machine.json` at the sync root does not travel. The projection publishes
    /// the label separately, inside the journal shard it names
    /// (`projection::machine_label_path`), because a history screen that can
    /// only say "another machine" is no use to someone with three.
    pub label: String,
}

/// 128 bits of hex, mixed from three sources that fail independently.
///
/// Not `uuid`, and not for the sake of being clever: this is the only identifier
/// the backend generates — every other id in the app comes from the frontend's
/// `crypto.randomUUID()` — and a dependency for one value is a poor trade.
///
/// The bar is also genuinely low. This has to be distinct across the handful of
/// machines one person owns. It is not a secret, it guards nothing, and it never
/// has to be unique across the world.
///
/// `RandomState` carries the real entropy: its key is seeded from the OS once
/// per process. Two ids minted in one process would otherwise share that seed
/// and differ only by its internal counter, so the clock and the pid go in
/// alongside it — three sources, and an id that is wrong only if all three are.
fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;

    let mut out = String::with_capacity(32);
    for half in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(nanos);
        h.write_u64(pid);
        h.write_u64(half);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// This machine's identity, created on first call and stable afterwards.
///
/// A corrupt or unreadable file is replaced rather than reported. The cost of
/// getting this wrong is one orphaned journal shard in a directory nobody reads
/// by hand; the cost of refusing to start is the whole feature. That trade is
/// the opposite of the one `try_read_vec` makes in `store.rs`, and deliberately:
/// there, a bad read that gets overwritten loses a person's workspaces.
pub fn load_or_create(dir: &Path) -> Machine {
    let path = dir.join("machine.json");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(m) = serde_json::from_str::<Machine>(&s) {
            if !m.id.is_empty() {
                return m;
            }
        }
    }
    let m = Machine { id: random_id(), label: default_label() };
    let _ = std::fs::create_dir_all(dir);
    if let Ok(json) = serde_json::to_string_pretty(&m) {
        let _ = std::fs::write(&path, json);
    }
    m
}

/// The host's name, asked for exactly once in the life of an installation.
/// Empty or missing is not a failure — the label is a convenience, and a
/// person can see which machine they are sitting at.
fn default_label() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this machine".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cd-machine-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn created_once_and_stable_afterwards() {
        let d = tmp("stable");
        let first = load_or_create(&d);
        assert_eq!(first.id.len(), 32, "128 bits of hex: {}", first.id);
        assert!(!first.label.is_empty());

        let second = load_or_create(&d);
        assert_eq!(first, second, "a second call must not mint a new machine");

        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn two_machines_do_not_collide() {
        let (a, b) = (tmp("a"), tmp("b"));
        assert_ne!(load_or_create(&a).id, load_or_create(&b).id);
        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }

    /// Unlike the workspace store, a damaged file here is replaced rather than
    /// refused: the worst case is one orphaned journal shard, and refusing
    /// would take the feature down with it.
    #[test]
    fn a_damaged_file_is_replaced_rather_than_fatal() {
        let d = tmp("corrupt");
        fs::write(d.join("machine.json"), "{ not json").unwrap();
        let m = load_or_create(&d);
        assert_eq!(m.id.len(), 32);
        assert_eq!(load_or_create(&d), m, "and the replacement then sticks");
        fs::remove_dir_all(&d).unwrap();
    }

    /// This file sits in the sync root, so the allowlist is what keeps it home.
    ///
    /// Narrow on purpose: `runs/*/machine.json` — the label beside a journal
    /// shard — *does* travel, and an assertion that no pattern mentions the name
    /// would forbid the wrong one. The proof that both land on the right side is
    /// the git-backed test in `manifest`, which has one of each.
    #[test]
    fn the_root_machine_file_is_not_on_the_allowlist() {
        assert!(
            !crate::sync::manifest::ALLOWED.contains(&"machine.json"),
            "the root machine.json must never travel: it is this installation's \
             own identity, and publishing it would give two machines one id"
        );
    }
}
