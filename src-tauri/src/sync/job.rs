//! One cycle of sync, and the state a person can look at afterwards.
//!
//! # Not the scenario scheduler
//!
//! `scheduler.rs` looks like the right home and is not. It carries catch-up
//! semantics — `is_catch_up` exists so a scenario that should have fired at
//! 03:00 while the laptop was shut still fires — and sync wants the opposite. A
//! missed tick is simply the next tick, and a week away should produce one sync
//! on return, not a queue of them. Same shape, separate loop.
//!
//! # Never on the critical path
//!
//! The window opens and sessions restore whether or not the network answers.
//! #35 already settled this for memory generally: it stays off the session
//! launch path, and there is deliberately no `SessionStart` injection. A
//! blocking pull would put a network round trip in front of the window
//! appearing.

use crate::sync::git::{self, Auth, GitError};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Ceiling on one tick's sleep, matching the scenario loop's. Long enough that
/// a quiet deck is quiet, short enough that a finished capture reaches the
/// remote while the person is still around to see it.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(300);

/// What went wrong, in the four shapes that actually happen.
///
/// Each is a different sentence and a different next step, which is why they are
/// separate variants rather than one string: #318 renders them, and a single
/// "sync failed" would have nothing to offer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Fault {
    /// Not a failure, and it clears itself. Recorded so a long quiet spell can
    /// be told from a working one.
    Offline { since: i64 },
    /// Two machines edited the same lines. Named files, and no automatic
    /// resolution: notes are prose, and a merge produces a plausible paragraph
    /// nobody wrote.
    Conflict { files: Vec<String> },
    /// The remote moved and a rebase did not settle it.
    PushRejected { message: String },
    /// The account was revoked or logged out.
    ///
    /// Its own variant because #150 is the existing instance of this being
    /// reported as something else — a revoked token surfacing as "no account
    /// bound", which the user can see is false.
    AuthGone { message: String },
    /// The repository was written by a newer build. Sync stops; the deck keeps
    /// working locally. An older build that wrote anyway would corrupt the store
    /// for both machines.
    FormatNewer { found: u32, supported: u32 },
}

/// What a person sees. Local only — `sync_state.json` sits in the sync root and
/// the deny-by-default ignore keeps it there without anyone naming it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncState {
    pub last_pull: Option<i64>,
    pub last_push: Option<i64>,
    /// Cleared by the first tick that gets through. A fault that outlives its
    /// cause is worse than none, because it teaches people to ignore it.
    pub fault: Option<Fault>,
}

impl SyncState {
    pub fn load(root: &Path) -> SyncState {
        std::fs::read_to_string(root.join("sync_state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, root: &Path) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(root.join("sync_state.json"), s);
        }
    }
}

/// What one cycle did.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub pulled: bool,
    pub pushed: bool,
}

/// Whether a failed pull means "there is nothing on the other end yet".
///
/// Worth telling apart from every other failure: reported as a fault, the first
/// sync of a fresh repository would look broken to the person who just set it
/// up, and the corpus would never reach it.
fn is_empty_remote(e: &GitError) -> bool {
    let GitError::Failed { message, .. } = e else { return false };
    let m = message.to_lowercase();
    m.contains("no such ref was fetched")
        || m.contains("couldn't find remote ref")
}

/// A git failure, read for what it means rather than repeated verbatim.
fn classify(e: &GitError, now: i64) -> Fault {
    let GitError::Failed { message, .. } = e else {
        // No git at all, or a deadline that passed with nothing coming back.
        // Both look the same from here and both clear themselves.
        return Fault::Offline { since: now };
    };
    let text = message.clone();
    let msg = message.to_lowercase();

    // Order matters: an auth failure often also says "could not read from
    // remote repository", which reads as offline if that is checked first.
    if msg.contains("authentication failed")
        || msg.contains("invalid username or password")
        || msg.contains("permission denied")
        || msg.contains("403")
        || msg.contains("could not read username")
    {
        return Fault::AuthGone { message: text };
    }
    if msg.contains("could not resolve host")
        || msg.contains("network is unreachable")
        || msg.contains("connection refused")
        || msg.contains("connection timed out")
        || msg.contains("temporary failure in name resolution")
    {
        return Fault::Offline { since: now };
    }
    Fault::PushRejected { message: text }
}

/// One cycle: pull, commit whatever changed, push.
///
/// `now` is passed rather than read so a test can pin it — the same reason
/// `scheduler::decide` takes one.
pub fn sync_once(repo: &Path, auth: &Auth, message: &str, now: i64) -> Result<Progress, Fault> {
    // A stopped rebase is waiting for a person. Carrying on would stack a second
    // failure on top of the one nobody has seen yet.
    if git::rebase_in_progress(repo) {
        return Err(Fault::Conflict { files: conflicted_files(repo) });
    }

    let mut progress = Progress { pulled: false, pushed: false };

    // Commit *before* pulling, and this order is not a preference. `pull
    // --rebase` refuses outright on a dirty tree — "cannot pull with rebase:
    // You have unstaged changes" — and a dirty tree is the normal state of any
    // tick that has something to sync. Committing first also means the rebase
    // replays our work onto theirs, which is the outcome we want anyway.
    let committed = git::commit_all(repo, message).map_err(|e| classify(&e, now))?;

    match git::pull_rebase(repo, auth) {
        Ok(()) => progress.pulled = true,
        // The remote has no commits yet. Not an edge case — it is the first
        // sync on the first machine, every time: a repository created empty has
        // no branch to pull, and git reports that as a merge configuration
        // error rather than as "nothing there".
        Err(e) if is_empty_remote(&e) => {}
        Err(e) => {
            if git::rebase_in_progress(repo) {
                return Err(Fault::Conflict { files: conflicted_files(repo) });
            }
            return Err(classify(&e, now));
        }
    }

    // Nothing of ours to send: an empty push per tick is churn against a remote
    // someone may be watching.
    if !committed && !has_unpushed(repo) {
        return Ok(progress);
    }

    match git::push(repo, auth) {
        Ok(()) => progress.pushed = true,
        Err(first) => {
            // The remote moved between our pull and our push. Rebase and try
            // once more — never force. Failing twice is a real fault.
            if git::pull_rebase(repo, auth).is_err() {
                if git::rebase_in_progress(repo) {
                    return Err(Fault::Conflict { files: conflicted_files(repo) });
                }
                return Err(classify(&first, now));
            }
            git::push(repo, auth).map_err(|e| classify(&e, now))?;
            progress.pushed = true;
        }
    }

    Ok(progress)
}

/// The files a stopped rebase is waiting on, named so #318 can show them.
fn conflicted_files(repo: &Path) -> Vec<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["diff", "--name-only", "--diff-filter=U"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Whether this branch is ahead of its upstream.
fn has_unpushed(repo: &Path) -> bool {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-list", "--count", "@{u}..HEAD"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().unwrap_or(0) > 0
        }
        // No upstream yet, or git could not say. Pushing is the safe guess: a
        // push with nothing to send is a no-op, while skipping one that had
        // something to send loses it until the next tick.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        origin: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Fixture {
            let root = std::env::temp_dir().join(format!("cd-job-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            let origin = root.join("origin.git");
            assert!(std::process::Command::new("git")
                .args(["init", "--bare", "--quiet", "-b", "main"])
                .arg(&origin)
                .output()
                .unwrap()
                .status
                .success());
            Fixture { root, origin }
        }

        fn checkout(&self, name: &str) -> PathBuf {
            let dir = self.root.join(name);
            git::clone(&format!("file://{}", self.origin.display()), &dir, &Auth::default())
                .expect("clone");
            for (k, v) in [("user.email", "t@example.com"), ("user.name", "T")] {
                assert!(std::process::Command::new("git")
                    .arg("-C").arg(&dir).args(["config", k, v])
                    .output().unwrap().status.success());
            }
            dir
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn a_changed_corpus_reaches_the_remote_and_the_other_machine() {
        let f = Fixture::new("basic");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "ws-1/Facts.md", "- a fact\n");
        let p = sync_once(&a, &Auth::default(), "sync", 1).unwrap();
        assert!(p.pushed, "a dirty tree is committed and pushed");

        let p = sync_once(&b, &Auth::default(), "sync", 2).unwrap();
        assert!(p.pulled);
        assert!(b.join("ws-1/Facts.md").exists());
    }

    /// The first sync on the first machine, which is not an edge case: a
    /// repository created empty has no branch to pull, and a pull that reports
    /// that as a fault would make a fresh setup look broken.
    #[test]
    fn the_very_first_sync_against_an_empty_repository_works() {
        let f = Fixture::new("firstever");
        let a = f.checkout("a");
        write(&a, "ws-1/Facts.md", "the first fact\n");

        let p = sync_once(&a, &Auth::default(), "first", 1).unwrap();
        assert!(!p.pulled, "there was nothing to pull");
        assert!(p.pushed, "but the corpus must still reach the remote");

        let b = f.checkout("b");
        assert!(b.join("ws-1/Facts.md").exists(), "and a second machine gets it");
    }

    #[test]
    fn an_unchanged_corpus_produces_nothing() {
        let f = Fixture::new("quiet");
        let a = f.checkout("a");
        write(&a, "ws-1/Facts.md", "x\n");
        sync_once(&a, &Auth::default(), "sync", 1).unwrap();

        let before = commit_count(&a);
        let p = sync_once(&a, &Auth::default(), "sync", 2).unwrap();
        assert!(!p.pushed, "an empty push per tick is churn against a watched remote");
        assert_eq!(commit_count(&a), before, "and no empty commit either");
    }

    /// The ordinary two-machine race: both committed since the last pull.
    #[test]
    fn a_remote_that_moved_is_rebased_onto_rather_than_forced_over() {
        let f = Fixture::new("race");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "seed.md", "seed\n");
        sync_once(&a, &Auth::default(), "seed", 1).unwrap();
        sync_once(&b, &Auth::default(), "pull", 2).unwrap();

        write(&a, "from-a.md", "a\n");
        sync_once(&a, &Auth::default(), "a", 3).unwrap();

        // b has not pulled since, and now has its own commit.
        write(&b, "from-b.md", "b\n");
        let p = sync_once(&b, &Auth::default(), "b", 4).unwrap();
        assert!(p.pushed, "the retry after a rebase must succeed");

        sync_once(&a, &Auth::default(), "settle", 5).unwrap();
        assert!(a.join("from-b.md").exists(), "and nothing was overwritten");
        assert!(a.join("from-a.md").exists());
    }

    #[test]
    fn two_machines_editing_one_line_stop_and_name_the_file() {
        let f = Fixture::new("conflict");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "ws-1/Facts.md", "one\n");
        sync_once(&a, &Auth::default(), "seed", 1).unwrap();
        sync_once(&b, &Auth::default(), "pull", 2).unwrap();

        write(&a, "ws-1/Facts.md", "from a\n");
        sync_once(&a, &Auth::default(), "a", 3).unwrap();

        write(&b, "ws-1/Facts.md", "from b\n");
        let fault = sync_once(&b, &Auth::default(), "b", 4).unwrap_err();
        match &fault {
            Fault::Conflict { files } => {
                assert!(files.iter().any(|x| x == "ws-1/Facts.md"), "{files:?}")
            }
            other => panic!("expected a named conflict, got {other:?}"),
        }

        // And the next tick must not pile a second failure on the first.
        assert_eq!(sync_once(&b, &Auth::default(), "b", 5).unwrap_err(), fault);
    }

    #[test]
    fn an_unreachable_remote_is_offline_rather_than_a_failure_to_shout_about() {
        let f = Fixture::new("offline");
        let a = f.checkout("a");
        assert!(std::process::Command::new("git")
            .arg("-C").arg(&a)
            .args(["remote", "set-url", "origin", "https://nonexistent.invalid/x.git"])
            .output().unwrap().status.success());

        write(&a, "ws-1/Facts.md", "x\n");
        let fault = sync_once(&a, &Auth::default(), "sync", 7).unwrap_err();
        assert!(
            matches!(fault, Fault::Offline { since: 7 }),
            "an unreachable host is not a fault to alarm anyone with: {fault:?}"
        );
    }

    /// #150 is the existing instance of this going wrong: a revoked token
    /// reported as "no account bound", which the user can see is false.
    #[test]
    fn a_rejected_credential_is_told_apart_from_being_offline() {
        for message in [
            "fatal: Authentication failed for 'https://github.com/me/mem.git/'",
            "remote: Permission denied to user",
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ] {
            let e = GitError::Failed { step: "push", message: message.into() };
            assert!(
                matches!(classify(&e, 0), Fault::AuthGone { .. }),
                "{message} must not read as offline"
            );
        }
        let unreachable = "fatal: unable to access: Could not resolve host: github.com";
        let e = GitError::Failed { step: "push", message: unreachable.into() };
        assert!(matches!(classify(&e, 9), Fault::Offline { since: 9 }), "{unreachable}");
        assert!(matches!(classify(&GitError::NotFound, 3), Fault::Offline { since: 3 }));
        assert!(matches!(
            classify(&GitError::Timeout { step: "push" }, 4),
            Fault::Offline { since: 4 }
        ));
    }

    #[test]
    fn the_state_file_round_trips_and_survives_a_damaged_one() {
        let f = Fixture::new("state");
        let s = SyncState {
            last_pull: Some(10),
            last_push: Some(11),
            fault: Some(Fault::Conflict { files: vec!["ws-1/Facts.md".into()] }),
        };
        s.save(&f.root);
        assert_eq!(SyncState::load(&f.root), s);

        fs::write(f.root.join("sync_state.json"), "{ not json").unwrap();
        assert_eq!(SyncState::load(&f.root), SyncState::default(), "a damaged state is not fatal");
    }

    /// It lives in the sync root, so the deny-by-default ignore is what keeps it
    /// off the wire — without anyone having to remember to exclude it.
    #[test]
    fn the_state_file_is_not_on_the_allowlist() {
        assert!(!crate::sync::manifest::ALLOWED.contains(&"sync_state.json"));
    }

    fn commit_count(repo: &Path) -> u64 {
        let o = std::process::Command::new("git")
            .arg("-C").arg(repo).args(["rev-list", "--count", "HEAD"])
            .output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0)
    }
}
