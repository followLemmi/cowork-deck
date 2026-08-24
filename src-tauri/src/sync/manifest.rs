//! What leaves this machine when sync is switched on, and what does not.
//!
//! The list is data in one place rather than string literals at the call sites,
//! because the question "does this travel?" gets asked from the projection, from
//! the ignore file and from the test, and three answers that can drift apart is
//! exactly one answer too many.
//!
//! # The ignore is written inside out, and that is the point
//!
//! The sync root is the app's config directory, which already holds things that
//! must never be published — and #206 is about to add a `0600` secret file to it
//! as the fallback for hosts with no keyring.
//!
//! Written as a list of exclusions, this file would be correct today and wrong
//! the first time somebody adds a store file: the default for anything new would
//! be *tracked*. Written as `*` plus explicit re-inclusions, the default is
//! untracked, and adding something to the corpus is a line in a diff a reviewer
//! can see.
//!
//! `gh-noauth/` is the sharpest illustration of why this matters. It is a
//! directory deliberately hardened to `0500` (`commands.rs`, `harden_noauth_dir`)
//! so that a `gh auth login` inside a degraded session fails loudly instead of
//! becoming app-wide state (#233). Git records one permission bit. Round-trip
//! that directory through a clone and it arrives writable — inverting the very
//! invariant it exists to hold, on a machine nobody was watching.

/// Path shapes that travel, as gitignore patterns relative to the sync root.
///
/// Every entry names one kind of thing, and the layout is what makes the
/// patterns safe to be this loose: memory lives under the workspace id at the
/// top level, so `*/Facts.md` is "any workspace's facts".
///
/// Memory *has* to stay at the top level, incidentally — the sidecar's
/// `detect_scope` reads the first path segment as the scope, so nesting notes
/// under a `workspaces/` prefix would give every workspace the same scope and
/// collapse per-project search (ADR-0004).
pub const ALLOWED: &[&str] = &[
    // The ignore file itself. A clone that arrives without it has no boundary
    // at all, and the first commit from that machine publishes everything.
    ".gitignore",
    // The workspace record, beside the memory it describes. Not `.md`, so the
    // sidecar's walk skips it while sitting in the same directory.
    "*/workspace.json",
    "*/Facts.md",
    "*/Sessions/**/*.md",
    // Global, cross-project, and the reason a lesson learned in one repository
    // reaches the next one.
    "Diaries/*/*.md",
    "scenarios/*.json",
    // Sharded per machine: the journal is append-only, and two machines
    // appending to one file conflict on every single sync.
    "runs/*/*.jsonl",
    // The label beside the shard it names. Without it the repository holds two
    // opaque ids and cannot say which one is the laptop — see
    // `projection::machine_label_path` for what that costs and what it does not.
    "runs/*/machine.json",
];

/// Directories that exist inside the root and are never worth walking: a
/// disposable cache and a 470 MB model. `*` already excludes their contents;
/// naming them re-excludes the directories themselves so git does not descend,
/// and so a reader looking for them finds an answer instead of an inference.
const NEVER: &[&str] = &[".index/", ".model/"];

/// The deny-by-default ignore file, generated from [`ALLOWED`].
///
/// `!*/` is not decoration. Git will not re-include a file whose parent
/// directory is excluded, and `*` excludes directories too — so without it
/// every pattern below matches nothing at all.
pub fn gitignore() -> String {
    let mut s = String::new();
    s.push_str("# Generated from src-tauri/src/sync/manifest.rs. Do not edit by hand.\n");
    s.push_str("#\n");
    s.push_str("# Deny by default, then re-include. Anything added to this directory\n");
    s.push_str("# later is untracked until somebody says otherwise, in a diff.\n");
    s.push_str("*\n\n");
    s.push_str("# Git cannot re-include a file whose parent directory is excluded.\n");
    s.push_str("!*/\n\n");
    for p in ALLOWED {
        s.push('!');
        s.push_str(p);
        s.push('\n');
    }
    s.push_str("\n# Disposable, and large. Re-excluded so git does not walk them.\n");
    for p in NEVER {
        s.push_str(p);
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }

    /// The guarantee, and the reason it is asserted against real git rather than
    /// against a reimplementation of gitignore's rules: what ships is decided by
    /// git, so git is what has to agree.
    ///
    /// Equality, not containment. A subset assertion passes when something new
    /// starts being tracked, which is the exact failure this exists to catch.
    #[test]
    fn exactly_the_allowlist_is_tracked_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("cd-sync-manifest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // One of everything that travels.
        let expected: BTreeSet<String> = [
            ".gitignore",
            "ws-1/workspace.json",
            "ws-1/Facts.md",
            "ws-1/Sessions/2026-08/24-topic.md",
            "Diaries/reviewer/2026-08.md",
            "scenarios/sk-1.json",
            "runs/m-1/runs.jsonl",
            "runs/m-1/machine.json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        for p in &expected {
            if p != ".gitignore" {
                write(&root, p);
            }
        }

        // And one of everything that must not. Every entry here is a real file
        // the app writes into this directory today, plus the secret fallback
        // #206 will add.
        for p in [
            "sessions.json",
            "terminals.json",
            "ui_state.json",
            "schedule_state.json",
            "workspaces.json",
            "skills.json",
            "runs.jsonl",
            "accounts.json",
            "secrets.json",
            // At the root it is this machine's private identity and must not
            // travel; inside a shard it is that shard's label and must. Two
            // files, one name, opposite answers — worth asserting both.
            "machine.json",
            "gh-noauth/hosts.yml",
            ".index/meta.json",
            ".index/emb.bin",
            ".model/model.onnx",
            "ws-1/Sessions/2026-08/notes.txt",
            "ws-1/scratch.md",
        ] {
            write(&root, p);
        }

        fs::write(root.join(".gitignore"), gitignore()).unwrap();

        git(&root, &["init", "-q"]);
        git(&root, &["add", "-A"]);
        let tracked: BTreeSet<String> = git(&root, &["ls-files"])
            .lines()
            .map(|s| s.to_string())
            .collect();

        assert_eq!(
            tracked, expected,
            "tracked set must equal the allowlist exactly\n  unexpected: {:?}\n  missing:   {:?}",
            tracked.difference(&expected).collect::<Vec<_>>(),
            expected.difference(&tracked).collect::<Vec<_>>()
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
