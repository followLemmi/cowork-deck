//! Clone, pull, commit and push, under the account the person picked, with the
//! token never touching the disk.
//!
//! ADR-0002 settles that the app process is the one holding credentials, so
//! these run here rather than in a sidecar.
//!
//! # Where the token goes, and where it must not
//!
//! The obvious way to authenticate a push is to put the token in the remote
//! URL: `https://x-access-token:TOKEN@github.com/…`. It works, and it writes a
//! live credential in clear text into `.git/config` — inside the very directory
//! this epic exists to copy between machines. The allowlist does not save us:
//! `.git/` is never tracked, but the file is still sitting on that disk.
//!
//! So the token is passed in the environment and read by a credential helper
//! that git runs for the length of one command. Nothing is written, and nothing
//! outlives the process.
//!
//! The helper is preceded by an *empty* `credential.helper=`, which is not
//! decoration: it clears whatever the machine has configured globally. Without
//! it, `osxkeychain` — or any other helper — answers first, and the push
//! authenticates as whichever account that keychain happens to hold. That would
//! invert the invariant the whole per-workspace binding rests on (`gh.rs`: the
//! app never changes, and never leans on, global `gh` state).

use std::path::Path;
use std::time::Duration;

/// The environment variable the credential helper reads. Named so that seeing it
/// in a process listing says what it is.
const TOKEN_ENV: &str = "COWORK_SYNC_TOKEN";

/// Long enough for a first clone of a corpus over a slow link, short enough that
/// a wedged process is not permanent. Sync never blocks the window opening
/// (#317), so this is a background wait, not a person's.
pub const NETWORK_DEADLINE: Duration = Duration::from_secs(600);
/// Local plumbing: staging, committing, asking whether anything changed.
pub const LOCAL_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub enum GitError {
    /// No usable `git`.
    NotFound,
    /// The deadline passed and the child was killed.
    Timeout { step: &'static str },
    /// git ran and said no.
    Failed { step: &'static str, message: String },
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotFound => write!(f, "git was not found"),
            GitError::Timeout { step } => write!(f, "git {step} did not finish in time"),
            GitError::Failed { step, message } => write!(f, "git {step} failed: {message}"),
        }
    }
}

/// What decides which account a call speaks as. `None` is a local-only
/// operation, and also the offline path: nothing here needs a token to commit.
#[derive(Default, Clone)]
pub struct Auth {
    pub token: Option<String>,
}

/// The `-c` pair that installs the helper, and the one that disables everything
/// the machine had configured before it.
///
/// The `$` is deliberately not expanded here: the helper is a shell snippet git
/// runs later, and it reads the variable then. Building the string with the
/// token in it would put the credential in argv, where every process listing on
/// the machine can read it.
fn credential_args() -> [String; 4] {
    [
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        format!(
            "credential.helper=!f() {{ echo username=x-access-token; echo \"password=${TOKEN_ENV}\"; }}; f"
        ),
    ]
}

/// Whether `git` can be spawned at all, asked once.
///
/// Without this a missing git is indistinguishable from a hung one:
/// `output_with_deadline` collapses a spawn failure into the same `None` a
/// deadline produces, and "you appear to be offline" is the wrong thing to tell
/// someone who needs to install git.
fn git_present() -> bool {
    static PRESENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *PRESENT.get_or_init(|| {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

fn run(
    repo: &Path,
    step: &'static str,
    args: &[&str],
    auth: &Auth,
    deadline: Duration,
) -> Result<String, GitError> {
    if !git_present() {
        return Err(GitError::NotFound);
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo);
    if auth.token.is_some() {
        cmd.args(credential_args());
    }
    cmd.args(args);

    if let Some(t) = &auth.token {
        cmd.env(TOKEN_ENV, t);
    }
    // git must never stop and ask. Without this a missing credential becomes a
    // prompt on a stdin nobody is attached to, and the deadline is the only
    // thing that ends it.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Progress goes to stderr only when stderr is a terminal, and here it is a
    // pipe — which matters, because `output_with_deadline` reads both pipes only
    // after the child exits. A chatty clone could otherwise fill the buffer,
    // stall itself, and be reaped as if it had hung.
    cmd.env("GIT_PROGRESS_DELAY", "31536000");

    let out = crate::which::output_with_deadline(cmd, deadline)
        .ok_or(GitError::Timeout { step })?;
    if !out.status.success() {
        return Err(GitError::Failed {
            step,
            message: crate::gh::redact(String::from_utf8_lossy(&out.stderr).trim()),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether the working tree has anything to commit.
pub fn is_dirty(repo: &Path) -> Result<bool, GitError> {
    let out = run(repo, "status", &["status", "--porcelain"], &Auth::default(), LOCAL_DEADLINE)?;
    Ok(!out.is_empty())
}

/// Stage everything and commit. `Ok(false)` when there was nothing to do — an
/// empty commit per tick would be pure churn in a history someone may read.
pub fn commit_all(repo: &Path, message: &str) -> Result<bool, GitError> {
    if !is_dirty(repo)? {
        return Ok(false);
    }
    run(repo, "add", &["add", "-A"], &Auth::default(), LOCAL_DEADLINE)?;
    run(
        repo,
        "commit",
        &["commit", "-m", message],
        &Auth::default(),
        LOCAL_DEADLINE,
    )?;
    Ok(true)
}

/// Whether this branch has an upstream to pull from and push to.
///
/// A clone has one from the start; a directory turned into a repository by
/// `init_with_remote` does not, and that is the first machine's path — the one
/// where somebody switches sync on for the first time. Without asking, `pull`
/// and `push` both fail with "there is no tracking information for the current
/// branch", which reads as a fault and is really a setup step nobody did.
pub fn has_upstream(repo: &Path) -> bool {
    run(
        repo,
        "upstream",
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        &Auth::default(),
        LOCAL_DEADLINE,
    )
    .is_ok()
}

/// Give this branch an upstream when the remote already has one to offer.
///
/// This is how the *second* machine adopts an existing repository. It cannot
/// clone: its config directory is already full of its own workspaces and
/// memory, so cloning over it would mean moving all of that out of the way
/// first. What it does instead is fetch, and bind the local branch to the remote
/// one if there is a remote one.
///
/// `Ok(false)` means the remote has nothing on this branch — the first machine's
/// case, where the first push is what creates it.
pub fn ensure_upstream(repo: &Path, auth: &Auth) -> Result<bool, GitError> {
    if has_upstream(repo) {
        return Ok(true);
    }
    run(repo, "fetch", &["fetch", "--quiet", "origin"], auth, NETWORK_DEADLINE)?;

    // `branch --show-current`, not `rev-parse HEAD`: a clone of an empty
    // repository has an unborn branch, and `rev-parse` calls that an ambiguous
    // argument. Unborn is exactly the state the first sync is in.
    let branch = run(
        repo,
        "branch",
        &["branch", "--show-current"],
        &Auth::default(),
        LOCAL_DEADLINE,
    )?;
    if branch.is_empty() {
        // Detached head. Nothing to bind, and nothing sensible to guess.
        return Ok(false);
    }
    let remote_ref = format!("origin/{branch}");
    if run(
        repo,
        "branch",
        &["rev-parse", "--verify", "--quiet", &remote_ref],
        &Auth::default(),
        LOCAL_DEADLINE,
    )
    .is_err()
    {
        return Ok(false);
    }

    // An unborn branch cannot be given an upstream — git answers "no commit on
    // branch yet" — and unborn is exactly what a machine joining an existing
    // repository has. Naming the remote and the branch pulls without needing
    // one, and leaves a commit for the binding below to attach to.
    let unborn = run(
        repo,
        "head",
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        &Auth::default(),
        LOCAL_DEADLINE,
    )
    .is_err();
    if unborn {
        run(
            repo,
            "pull",
            &["pull", "--rebase", "--quiet", "origin", &branch],
            auth,
            NETWORK_DEADLINE,
        )?;
    }

    run(
        repo,
        "branch",
        &["branch", &format!("--set-upstream-to={remote_ref}"), &branch],
        &Auth::default(),
        LOCAL_DEADLINE,
    )?;
    Ok(true)
}

/// Rebase onto the remote. Rebase rather than merge, so the history stays a line
/// a person can read rather than a lattice of merges between two of their own
/// machines.
pub fn pull_rebase(repo: &Path, auth: &Auth) -> Result<(), GitError> {
    run(repo, "pull", &["pull", "--rebase", "--quiet"], auth, NETWORK_DEADLINE)?;
    Ok(())
}

/// Push. There is no force anywhere in this module, and that is deliberate: when
/// a disk dies the remote is the only copy of the memory. A rejected push means
/// rebase and try again, or surface a conflict (#318) — never overwrite.
///
/// The first push from a directory that was never cloned also sets the upstream,
/// so every push after it is an ordinary one.
pub fn push(repo: &Path, auth: &Auth) -> Result<(), GitError> {
    if has_upstream(repo) {
        run(repo, "push", &["push", "--quiet"], auth, NETWORK_DEADLINE)?;
    } else {
        run(
            repo,
            "push",
            &["push", "--quiet", "--set-upstream", "origin", "HEAD"],
            auth,
            NETWORK_DEADLINE,
        )?;
    }
    Ok(())
}

/// A command that is not yet inside a repository: `clone`, and `init` on a
/// directory that has content but no `.git` yet.
fn run_outside(
    cwd: &Path,
    step: &'static str,
    args: &[&str],
    auth: &Auth,
    deadline: Duration,
) -> Result<String, GitError> {
    if !git_present() {
        return Err(GitError::NotFound);
    }
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(cwd);
    if auth.token.is_some() {
        cmd.args(credential_args());
    }
    cmd.args(args);
    if let Some(t) = &auth.token {
        cmd.env(TOKEN_ENV, t);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_PROGRESS_DELAY", "31536000");

    let out = crate::which::output_with_deadline(cmd, deadline)
        .ok_or(GitError::Timeout { step })?;
    if !out.status.success() {
        return Err(GitError::Failed {
            step,
            message: crate::gh::redact(String::from_utf8_lossy(&out.stderr).trim()),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Clone into `dest`, which must not exist yet.
///
/// Used by the tests here, and by "clone it" when a pulled workspace has no
/// folder on this machine — the offer #316's surface makes.
#[allow(dead_code)]
pub fn clone(url: &str, dest: &Path, auth: &Auth) -> Result<(), GitError> {
    let parent = dest.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| GitError::Failed {
        step: "clone",
        message: e.to_string(),
    })?;
    run_outside(
        parent,
        "clone",
        &["clone", "--quiet", url, &dest.to_string_lossy()],
        auth,
        NETWORK_DEADLINE,
    )?;
    Ok(())
}

/// Turn a directory that already has content into a repository pointed at
/// `url`.
///
/// This, not `clone`, is what activation on the first machine does: the config
/// directory is already full of the person's workspaces and memory, and cloning
/// over it would mean moving all of that somewhere first.
pub fn init_with_remote(repo: &Path, url: &str) -> Result<(), GitError> {
    let auth = Auth::default();
    run_outside(repo, "init", &["init", "--quiet"], &auth, LOCAL_DEADLINE)?;
    // `set-url` first, then `add`: the second run of this must not fail merely
    // because the remote is already there, and neither ordering alone is
    // idempotent on its own.
    if run(repo, "remote", &["remote", "set-url", "origin", url], &auth, LOCAL_DEADLINE).is_err() {
        run(repo, "remote", &["remote", "add", "origin", url], &auth, LOCAL_DEADLINE)?;
    }
    Ok(())
}

/// The remote this repository points at, if any.
///
/// `origin` first, `upstream` next, and then the sole remote when there is
/// exactly one — because "the remote is called `origin`" is a convention, not a
/// rule, and a clone that calls it `github` is still the same project on every
/// machine that has it. A workspace whose remote had an unconventional name used
/// to resolve to "this folder has no remote", which is the one answer that
/// cannot be told apart from a folder that really has none.
///
/// Two or more unconventionally named remotes resolve to nothing. Picking one
/// would be guessing which of several is the project's identity, and a wrong
/// guess makes two machines disagree — worse than admitting there is no answer.
pub fn remote_url(repo: &Path) -> Option<String> {
    for name in ["origin", "upstream"] {
        if let Some(url) = get_url(repo, name) {
            return Some(url);
        }
    }
    let mut names = remotes(repo);
    match names.len() {
        1 => get_url(repo, &names.pop()?),
        _ => None,
    }
}

/// One remote's fetch URL, or nothing when there is no remote by that name.
fn get_url(repo: &Path, name: &str) -> Option<String> {
    run(repo, "remote", &["remote", "get-url", name], &Auth::default(), LOCAL_DEADLINE)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Every remote this repository has, by name.
fn remotes(repo: &Path) -> Vec<String> {
    run(repo, "remote", &["remote"], &Auth::default(), LOCAL_DEADLINE)
        .map(|out| out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// True when a rebase stopped on a conflict and is waiting for someone.
pub fn rebase_in_progress(repo: &Path) -> bool {
    let git_dir = repo.join(".git");
    git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A bare repository on disk, served over `file://`.
    ///
    /// Real git, real refs, real rebases — everything except a network and a
    /// credential. The parts a `file://` remote cannot exercise are the two the
    /// module is most careful about, so they are asserted directly instead: that
    /// no token reaches `.git/config`, and that no code path passes `--force`.
    struct Fixture {
        root: PathBuf,
        origin: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Fixture {
            let root = std::env::temp_dir().join(format!("cd-git-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            let origin = root.join("origin.git");
            let out = std::process::Command::new("git")
                .args(["init", "--bare", "--quiet", "-b", "main"])
                .arg(&origin)
                .output()
                .expect("git init --bare");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            Fixture { root, origin }
        }

        fn url(&self) -> String {
            format!("file://{}", self.origin.display())
        }

        /// A working copy with an identity, so commits do not depend on whatever
        /// the machine running the tests has configured globally.
        fn checkout(&self, name: &str) -> PathBuf {
            let dir = self.root.join(name);
            clone(&self.url(), &dir, &Auth::default()).expect("clone");
            for (k, v) in [("user.email", "t@example.com"), ("user.name", "T")] {
                let out = std::process::Command::new("git")
                    .arg("-C").arg(&dir).args(["config", k, v])
                    .output().unwrap();
                assert!(out.status.success());
            }
            dir
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn add_remote(dir: &Path, name: &str, url: &str) {
        run(dir, "remote", &["remote", "add", name, url], &Auth::default(), LOCAL_DEADLINE)
            .expect("git remote add");
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn commit_and_push_then_pull_it_back_on_the_other_machine() {
        let f = Fixture::new("roundtrip");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "ws-1/Facts.md", "- 2026-08-24 [active] a fact\n");
        assert!(commit_all(&a, "first").unwrap(), "a dirty tree commits");
        push(&a, &Auth::default()).unwrap();

        pull_rebase(&b, &Auth::default()).unwrap();
        assert_eq!(
            fs::read_to_string(b.join("ws-1/Facts.md")).unwrap(),
            "- 2026-08-24 [active] a fact\n"
        );
    }

    #[test]
    fn an_unchanged_tree_produces_no_commit() {
        let f = Fixture::new("nochurn");
        let a = f.checkout("a");
        write(&a, "ws-1/Facts.md", "x\n");
        assert!(commit_all(&a, "first").unwrap());
        assert!(!is_dirty(&a).unwrap());
        assert!(
            !commit_all(&a, "second").unwrap(),
            "an empty commit every tick is churn in a history someone may read"
        );
    }

    /// The failure this module is built around: a credential in a file that
    /// lives inside the directory the epic copies between machines.
    #[test]
    fn the_token_never_reaches_the_repository_on_disk() {
        let f = Fixture::new("notoken");
        let a = f.checkout("a");
        let auth = Auth { token: Some("ghp_notarealtoken_abcdef123456".into()) };

        write(&a, "ws-1/Facts.md", "x\n");
        commit_all(&a, "first").unwrap();
        push(&a, &auth).unwrap();

        let config = fs::read_to_string(a.join(".git/config")).unwrap();
        assert!(!config.contains("ghp_"), ".git/config holds a credential: {config}");
        assert!(!config.contains("x-access-token"), "{config}");

        // Nor anywhere else under .git — a helper that cached it would be just
        // as bad as a remote URL that embedded it.
        let mut found = Vec::new();
        fn walk(d: &Path, needle: &str, found: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(d) else { return };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, needle, found);
                } else if let Ok(s) = fs::read_to_string(&p) {
                    if s.contains(needle) {
                        found.push(p.display().to_string());
                    }
                }
            }
        }
        walk(&a.join(".git"), "ghp_notarealtoken", &mut found);
        assert!(found.is_empty(), "the token is on disk in: {found:?}");
    }

    /// A rejected push is a signal to rebase, never to overwrite: when a disk
    /// dies the remote is the only copy of the memory.
    #[test]
    fn a_diverged_remote_rejects_the_push_rather_than_being_overwritten() {
        let f = Fixture::new("diverge");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "seed.md", "seed\n");
        commit_all(&a, "seed").unwrap();
        push(&a, &Auth::default()).unwrap();
        pull_rebase(&b, &Auth::default()).unwrap();

        write(&a, "from-a.md", "a\n");
        commit_all(&a, "a").unwrap();
        push(&a, &Auth::default()).unwrap();

        write(&b, "from-b.md", "b\n");
        commit_all(&b, "b").unwrap();
        let err = push(&b, &Auth::default()).expect_err("the remote moved");
        assert!(matches!(err, GitError::Failed { step: "push", .. }), "{err}");

        // And the way out is rebase, not force.
        pull_rebase(&b, &Auth::default()).unwrap();
        push(&b, &Auth::default()).unwrap();
        pull_rebase(&a, &Auth::default()).unwrap();
        assert!(a.join("from-b.md").exists() && a.join("from-a.md").exists());
    }

    #[test]
    fn a_conflicting_rebase_stops_and_says_so() {
        let f = Fixture::new("conflict");
        let a = f.checkout("a");
        let b = f.checkout("b");

        write(&a, "ws-1/Facts.md", "one\n");
        commit_all(&a, "seed").unwrap();
        push(&a, &Auth::default()).unwrap();
        pull_rebase(&b, &Auth::default()).unwrap();

        write(&a, "ws-1/Facts.md", "from a\n");
        commit_all(&a, "a").unwrap();
        push(&a, &Auth::default()).unwrap();

        write(&b, "ws-1/Facts.md", "from b\n");
        commit_all(&b, "b").unwrap();

        assert!(pull_rebase(&b, &Auth::default()).is_err(), "the same line, twice");
        assert!(
            rebase_in_progress(&b),
            "a stopped rebase must be detectable — #318 shows it, and the tick \
             loop must not carry on as though nothing happened"
        );
    }

    /// The first machine does not clone: its config directory is already full of
    /// the person's workspaces and memory.
    #[test]
    fn a_directory_with_content_becomes_a_repository_in_place() {
        let f = Fixture::new("init");
        let dir = f.root.join("existing");
        fs::create_dir_all(&dir).unwrap();
        write(&dir, "ws-1/Facts.md", "already here\n");

        init_with_remote(&dir, &f.url()).unwrap();
        assert_eq!(remote_url(&dir).as_deref(), Some(f.url().as_str()));
        assert!(dir.join("ws-1/Facts.md").exists(), "nothing was moved out of the way");

        // And running it twice is not an error.
        init_with_remote(&dir, &f.url()).unwrap();
        assert_eq!(remote_url(&dir).as_deref(), Some(f.url().as_str()));
    }

    /// A clone whose remote is not called `origin` is still the same project on
    /// every machine that has it — which is the whole of what sync compares
    /// (#348, #359).
    #[test]
    fn a_remote_by_any_other_name_is_still_this_project() {
        let f = Fixture::new("othername");
        let dir = f.root.join("named-github");
        fs::create_dir_all(&dir).unwrap();
        run_outside(&dir, "init", &["init", "--quiet"], &Auth::default(), LOCAL_DEADLINE).unwrap();
        add_remote(&dir, "github", "git@github.com:o/r.git");

        assert_eq!(
            remote_url(&dir).as_deref(),
            Some("git@github.com:o/r.git"),
            "the sole remote is the answer, whatever it is called"
        );
    }

    /// Convention still wins where it is present: a fork has both, and `origin`
    /// is the one the other machine will also have.
    #[test]
    fn origin_wins_over_every_other_remote_and_upstream_over_the_rest() {
        let f = Fixture::new("precedence");

        let both = f.root.join("both");
        fs::create_dir_all(&both).unwrap();
        run_outside(&both, "init", &["init", "--quiet"], &Auth::default(), LOCAL_DEADLINE).unwrap();
        add_remote(&both, "github", "git@github.com:o/mirror.git");
        add_remote(&both, "upstream", "git@github.com:o/upstream.git");
        add_remote(&both, "origin", "git@github.com:o/fork.git");
        assert_eq!(remote_url(&both).as_deref(), Some("git@github.com:o/fork.git"));

        let no_origin = f.root.join("no-origin");
        fs::create_dir_all(&no_origin).unwrap();
        run_outside(&no_origin, "init", &["init", "--quiet"], &Auth::default(), LOCAL_DEADLINE)
            .unwrap();
        add_remote(&no_origin, "github", "git@github.com:o/mirror.git");
        add_remote(&no_origin, "upstream", "git@github.com:o/upstream.git");
        assert_eq!(
            remote_url(&no_origin).as_deref(),
            Some("git@github.com:o/upstream.git"),
            "second convention before guesswork"
        );
    }

    /// Guessing which of several remotes is the project's identity is how two
    /// machines come to disagree about it, and disagreeing is worse than not
    /// knowing.
    #[test]
    fn two_unconventional_remotes_are_no_answer_at_all() {
        let f = Fixture::new("ambiguous");
        let dir = f.root.join("two");
        fs::create_dir_all(&dir).unwrap();
        run_outside(&dir, "init", &["init", "--quiet"], &Auth::default(), LOCAL_DEADLINE).unwrap();
        add_remote(&dir, "github", "git@github.com:o/r.git");
        add_remote(&dir, "gitlab", "git@gitlab.com:o/r.git");
        assert!(remote_url(&dir).is_none());
    }

    #[test]
    fn a_missing_remote_is_none_rather_than_an_error() {
        let f = Fixture::new("noremote");
        let dir = f.root.join("bare");
        fs::create_dir_all(&dir).unwrap();
        run_outside(&dir, "init", &["init", "--quiet"], &Auth::default(), LOCAL_DEADLINE).unwrap();
        assert!(remote_url(&dir).is_none());
    }

    /// Asserted by reading the source, because there is no runtime moment at
    /// which "we did not force" can be observed. The remote is the only copy of
    /// the memory when a disk dies.
    #[test]
    fn no_code_path_forces_a_push() {
        let src = include_str!("git.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["--force", "-f\"", "+refs/", "--mirror"] {
            assert!(
                !code.contains(forbidden),
                "{forbidden} appears in the non-test source"
            );
        }
    }
}
