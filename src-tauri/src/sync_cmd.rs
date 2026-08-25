//! The sync surface the frontend calls, and the loop nobody calls.
//!
//! Kept out of `commands.rs` for the reason that file's own size argues for:
//! 3582 lines welded to `State<AppState>` can only be tested through a running
//! app, and #276 exists to undo that. Nothing here adds to it.

use crate::commands::AppState;
use crate::sync::activation::{self, Blocked, Preflight, RepoState};
use crate::sync::git::{self, Auth};
use crate::sync::job::{self, Fault, SyncState};
use crate::sync::{machine, manifest};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

/// The sync root is the config directory itself — repository root and memory
/// root, one directory (ADR to follow in #319).
fn root(state: &State<AppState>) -> Result<PathBuf, String> {
    Ok(state.store.lock().map_err(|_| "store lock".to_string())?.dir.clone())
}

/// Sync is on when the directory is a repository with a remote. There is no
/// separate "enabled" flag, deliberately: a flag can disagree with the
/// directory, and then the app is confidently wrong about whether a person's
/// memory is leaving the machine.
fn is_on(root: &std::path::Path) -> bool {
    root.join(".git").exists() && git::remote_url(root).is_some()
}

#[derive(Serialize)]
pub struct SyncSummary {
    pub on: bool,
    pub remote: Option<String>,
    pub state: SyncState,
    pub machine: machine::Machine,
}

#[tauri::command(async)]
pub fn sync_summary(state: State<AppState>) -> Result<SyncSummary, String> {
    let root = root(&state)?;
    Ok(SyncSummary {
        on: is_on(&root),
        remote: git::remote_url(&root),
        state: SyncState::load(&root),
        machine: machine::load_or_create(&root),
    })
}

/// Whether sync can be switched on, and under which accounts.
#[tauri::command(async)]
pub fn sync_preflight() -> Preflight {
    activation::preflight_from(crate::gh::status())
}

/// `gh` under one named account, without touching the active one.
struct AccountGh {
    program: String,
    path_env: Option<String>,
    token: Option<String>,
}

impl activation::Gh for AccountGh {
    fn run(&self, account: &crate::gh::GhAccount, args: &[&str]) -> Result<String, String> {
        let mut cmd = std::process::Command::new(&self.program);
        cmd.args(args);
        if let Some(t) = &self.token {
            cmd.env("GH_TOKEN", t);
        }
        if account.host != "github.com" {
            cmd.env("GH_HOST", &account.host);
        }
        if let Some(p) = &self.path_env {
            cmd.env("PATH", p);
        }
        let out = crate::which::output_with_deadline(cmd, std::time::Duration::from_secs(30))
            .ok_or_else(|| "gh did not answer in time".to_string())?;
        if !out.status.success() {
            return Err(crate::gh::redact(String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

fn account_gh(host: &str, login: &str) -> Result<AccountGh, String> {
    let resolved = crate::gh::which_gh().ok_or_else(|| "gh-not-found".to_string())?;
    let token = crate::gh::token(host, login, std::time::Duration::from_secs(5)).ok();
    Ok(AccountGh { program: resolved.program, path_env: resolved.path_env, token })
}

fn account(host: &str, login: &str) -> crate::gh::GhAccount {
    crate::gh::GhAccount {
        host: host.to_string(),
        login: login.to_string(),
        active: false,
        scopes: Vec::new(),
        state: "success".into(),
    }
}

/// What is on the other end of a repository name, before adopting it.
#[tauri::command(async)]
pub fn sync_probe(host: String, login: String, repo: String) -> Result<RepoState, String> {
    let gh = account_gh(&host, &login)?;
    Ok(activation::probe(&gh, &account(&host, &login), &repo))
}

/// Create a private repository and adopt it.
#[tauri::command(async)]
pub fn sync_create(
    state: State<AppState>,
    host: String,
    login: String,
    name: String,
) -> Result<String, String> {
    let gh = account_gh(&host, &login)?;
    let url = activation::create(&gh, &account(&host, &login), &name)?;
    adopt_repository(&root(&state)?, &url)?;
    Ok(url)
}

/// Adopt a repository that already exists, refusing anything that is not ours.
#[tauri::command(async)]
pub fn sync_connect(
    state: State<AppState>,
    host: String,
    login: String,
    repo: String,
    url: String,
) -> Result<(), String> {
    let gh = account_gh(&host, &login)?;
    match activation::probe(&gh, &account(&host, &login), &repo) {
        RepoState::Empty | RepoState::Ours { .. } => adopt_repository(&root(&state)?, &url),
        RepoState::OursNewer { format } => Err(format!(
            "that repository was written by a newer version of the app (format {format}); \
             update before connecting to it"
        )),
        RepoState::Foreign => Err(
            "that repository already has content that is not this app's. Connecting would \
             commit your memory into it."
                .into(),
        ),
        RepoState::Missing => Err("no such repository, or this account cannot see it".into()),
        RepoState::Unknown { why } => Err(format!("could not check that repository: {why}")),
    }
}

/// Make the config directory a repository pointed at `url`, and write the two
/// files that define what leaves it.
fn adopt_repository(root: &std::path::Path, url: &str) -> Result<(), String> {
    // The ignore first, and before any `git add` can happen. A repository that
    // exists for even one commit without it publishes the whole config
    // directory, and a later commit removing them does not unpublish anything.
    std::fs::write(root.join(".gitignore"), manifest::gitignore())
        .map_err(|e| format!("could not write .gitignore: {e}"))?;
    std::fs::write(root.join(activation::MARKER), activation::marker_body())
        .map_err(|e| format!("could not write the marker: {e}"))?;
    git::init_with_remote(root, url).map_err(|e| e.to_string())
}

/// Stop syncing, and say plainly what that does and does not do.
#[tauri::command(async)]
pub fn sync_disconnect(state: State<AppState>) -> Result<(), String> {
    let root = root(&state)?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["remote", "remove", "origin"])
        .output()
        .map_err(|e| e.to_string())?;
    // Already gone is success: this is the button someone presses when they
    // want it off, and telling them it was already off is not an error.
    let _ = out;
    SyncState::default().save(&root);
    Ok(())
}

/// One cycle, on demand. The same call the loop makes.
#[tauri::command(async)]
pub fn sync_now(state: State<AppState>) -> Result<SyncState, String> {
    let root = root(&state)?;
    let (workspaces, skills) = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        (store.workspaces(), store.skills())
    };
    Ok(run_once(&root, &workspaces, &skills))
}

/// A cycle plus the bookkeeping a person sees.
pub fn run_once(
    root: &std::path::Path,
    workspaces: &[crate::model::Workspace],
    skills: &[crate::model::Skill],
) -> SyncState {
    let mut st = SyncState::load(root);
    if !is_on(root) {
        return st;
    }

    // Write the store out before asking git what changed. Without this the
    // cycle commits the memory the sidecar wrote and none of the configuration,
    // which is half a feature that looks like a whole one.
    let m = machine::load_or_create(root);
    // `gh` is not asked here: resolving a repository per workspace means a
    // subprocess each, on a five-minute timer, for a value that only matters to
    // a machine that has never seen the project. #316's adoption path resolves
    // it when it is actually needed.
    let no_repo = |_: &crate::model::Workspace| None;
    if let Err(e) = crate::sync::publish::publish(root, workspaces, skills, &m, &no_repo) {
        eprintln!("warning: could not write the sync projection ({e})");
    }

    let now = chrono::Utc::now().timestamp();
    let auth = Auth { token: token_for(root) };
    let message = format!("deck sync {}", chrono::Utc::now().format("%Y-%m-%d %H:%M"));

    match job::sync_once(root, &auth, &message, now) {
        Ok(p) => {
            if p.pulled {
                st.last_pull = Some(now);
                // What arrived is on disk; this is what makes it exist for the
                // app. Without it a pulled workspace is a file nobody reads —
                // and the next `publish` used to delete it for being unfamiliar.
                adopt_into_store(root, workspaces, skills);
            }
            if p.pushed {
                st.last_push = Some(now);
            }
            // Cleared by the first tick that gets through: a fault that outlives
            // its cause teaches people to ignore the indicator.
            st.fault = None;
        }
        Err(f) => st.fault = Some(f),
    }
    st.save(root);
    st
}

/// Merge what a pull brought into the local store.
///
/// Records only. The questions a pull raises — where is this project on this
/// machine, are these two the same one — are asked lazily by the surface, and
/// answering them here would mean deciding for the person.
///
/// A workspace already here keeps everything local: its path, its ssh key, the
/// tracker history that describes cards on this disk. A scenario already here
/// keeps whether its schedule is switched on.
fn adopt_into_store(
    root: &std::path::Path,
    workspaces: &[crate::model::Workspace],
    skills: &[crate::model::Skill],
) {
    let no_repo = |_: &crate::model::Workspace| None;
    let adopted = crate::sync::adopt::adopt(root, workspaces, skills, &no_repo);

    for path in &adopted.unreadable {
        // Named rather than skipped: a record that quietly fails to arrive is
        // indistinguishable from one that was never synced.
        eprintln!("warning: sync could not read {path}");
    }

    // Nothing arrived at all — an empty repository, or a pull that changed only
    // memory. Writing an empty list over a populated store would be the worst
    // possible reading of that.
    if adopted.workspaces.is_empty() && adopted.skills.is_empty() {
        return;
    }

    if let Err(e) = write_merged(root, &adopted) {
        eprintln!("warning: sync could not save what it pulled ({e})");
    }
}

fn write_merged(
    root: &std::path::Path,
    adopted: &crate::sync::adopt::Adopted,
) -> std::io::Result<()> {
    // A `Store` of its own rather than the app's, and only because taking the
    // shared lock here would hold it across a write while the caller already
    // released it. Same directory, same files.
    let store = crate::store::Store::new(root.to_path_buf());
    if !adopted.workspaces.is_empty() {
        store.save_workspaces(&adopted.workspaces)?;
    }
    if !adopted.skills.is_empty() {
        store.save_skills(&adopted.skills)?;
    }
    Ok(())
}

/// The token for whichever account owns the remote.
///
/// Resolved per cycle rather than cached: a revoked account has to start
/// failing, and a five-second read every five minutes is not worth a cache that
/// can be stale in the direction of "still authorised".
fn token_for(root: &std::path::Path) -> Option<String> {
    let url = git::remote_url(root)?;
    let host = url
        .split("://")
        .nth(1)?
        .split('/')
        .next()?
        .to_string();
    let status = crate::gh::status();
    let acct = status.accounts.iter().find(|a| a.host == host)?;
    crate::gh::token(&acct.host, &acct.login, std::time::Duration::from_secs(5)).ok()
}

/// The loop. Never on the window's critical path: it starts detached, and the
/// deck opens whether or not the network answers.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Ok(dir) = app.path().app_config_dir() else { return };
        loop {
            // The store lock is taken and released around the read, never held
            // across the git calls: those take up to ten minutes, and holding
            // the shared mutex that long would stall the whole app.
            let read = app.try_state::<AppState>().and_then(|st| {
                st.store.lock().ok().map(|s| (s.workspaces(), s.skills()))
            });
            if let Some((workspaces, skills)) = read {
                let st = run_once(&dir, &workspaces, &skills);
                let _ = app.emit("sync://state", &st);
            }
            std::thread::sleep(job::TICK);
        }
    });
}

/// What a person still has to answer after a pull.
#[tauri::command(async)]
pub fn sync_questions(state: State<AppState>) -> Result<Vec<crate::sync::adopt::Question>, String> {
    let root = root(&state)?;
    let (workspaces, skills) = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        (store.workspaces(), store.skills())
    };
    let no_repo = |_: &crate::model::Workspace| None;
    Ok(crate::sync::adopt::adopt(&root, &workspaces, &skills, &no_repo).questions)
}

/// Named so the frontend's three blocking states and these agree by
/// construction rather than by anyone remembering to keep them in step.
#[tauri::command(async)]
pub fn sync_blocked_kinds() -> Vec<Blocked> {
    vec![Blocked::NoGh, Blocked::NoAccount]
}

/// The fault currently standing, if any.
#[tauri::command(async)]
pub fn sync_fault(state: State<AppState>) -> Result<Option<Fault>, String> {
    Ok(SyncState::load(&root(&state)?).fault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Workspace;
    use crate::sync::git;
    use std::fs;
    use std::path::{Path, PathBuf};

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

    struct TwoMachines {
        root: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    /// Two config directories and one bare repository between them: the shape
    /// the manual check has to use two computers for, as far as it can be taken
    /// without them.
    fn two_machines(tag: &str) -> TwoMachines {
        let root = std::env::temp_dir().join(format!("cd-two-{tag}-{}", std::process::id()));
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

        let url = format!("file://{}", origin.display());
        let mut dirs = Vec::new();
        for name in ["a", "b"] {
            let d = root.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(".gitignore"), crate::sync::manifest::gitignore()).unwrap();
            git::init_with_remote(&d, &url).unwrap();
            for (k, v) in [("user.email", "t@example.com"), ("user.name", "T")] {
                assert!(std::process::Command::new("git")
                    .arg("-C").arg(&d).args(["config", k, v])
                    .output().unwrap().status.success());
            }
            dirs.push(d);
        }
        TwoMachines { root, a: dirs[0].clone(), b: dirs[1].clone() }
    }

    impl Drop for TwoMachines {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn stored(dir: &Path) -> Vec<Workspace> {
        crate::store::Store::new(dir.to_path_buf()).workspaces()
    }

    /// The upgrade path, end to end: a person who already has workspaces
    /// switches sync on, and a second machine gets them.
    #[test]
    fn a_workspace_reaches_the_other_machine_and_lands_in_its_store() {
        let t = two_machines("adopt");
        let mine = vec![ws("ws-1", "cowork-deck", "/here/deck")];
        crate::store::Store::new(t.a.clone()).save_workspaces(&mine).unwrap();

        assert_eq!(run_once(&t.a, &mine, &[]).fault, None, "switching sync on must just work");
        assert_eq!(run_once(&t.b, &[], &[]).fault, None);

        let there = stored(&t.b);
        assert_eq!(there.len(), 1, "the record has to exist for the app, not only on disk");
        assert_eq!(there[0].id, "ws-1");
        assert_eq!(there[0].name, "cowork-deck");
        assert!(there[0].path.is_empty(), "and it names no folder on this machine");
    }

    /// The defect this test was written for. B pulls A's record, and B's own
    /// next cycle used to delete it for being unfamiliar, push that deletion,
    /// and take A's workspace with it.
    #[test]
    fn the_other_machines_record_survives_this_machines_next_cycle() {
        let t = two_machines("survive");
        let mine = vec![ws("ws-1", "deck", "/here/deck")];
        crate::store::Store::new(t.a.clone()).save_workspaces(&mine).unwrap();
        run_once(&t.a, &mine, &[]);

        // B adopts it, then runs again with its own view of the world.
        run_once(&t.b, &[], &[]);
        let after_first = stored(&t.b);
        run_once(&t.b, &after_first, &[]);

        assert!(t.b.join("ws-1/workspace.json").is_file(), "B kept it");

        // And A does not lose it when B's cycle reaches the remote.
        run_once(&t.a, &mine, &[]);
        assert!(t.a.join("ws-1/workspace.json").is_file(), "A kept it too");
        assert_eq!(stored(&t.a).len(), 1);
    }

    /// A path resolved here must survive every future pull. Blanking it would
    /// break a working workspace on a timer.
    #[test]
    fn adopting_never_blanks_a_path_this_machine_has_answered() {
        let t = two_machines("keeppath");
        let mine = vec![ws("ws-1", "deck", "/on/a/deck")];
        crate::store::Store::new(t.a.clone()).save_workspaces(&mine).unwrap();
        run_once(&t.a, &mine, &[]);

        run_once(&t.b, &[], &[]);
        // The person points it at a folder here.
        let mut theirs = stored(&t.b);
        theirs[0].path = "/on/b/deck".into();
        crate::store::Store::new(t.b.clone()).save_workspaces(&theirs).unwrap();

        run_once(&t.b, &theirs, &[]);
        assert_eq!(stored(&t.b)[0].path, "/on/b/deck", "a pull must not undo the answer");
    }

    #[test]
    fn a_workspace_deleted_here_is_withdrawn_rather_than_left_to_be_guessed() {
        let t = two_machines("delete");
        let mine = vec![ws("ws-1", "deck", "/here/deck"), ws("ws-2", "site", "/here/site")];
        crate::store::Store::new(t.a.clone()).save_workspaces(&mine).unwrap();
        run_once(&t.a, &mine, &[]);

        crate::sync::publish::forget_workspace(&t.a, "ws-2");
        let left: Vec<Workspace> = mine.iter().filter(|w| w.id != "ws-2").cloned().collect();
        run_once(&t.a, &left, &[]);

        run_once(&t.b, &[], &[]);
        assert!(!t.b.join("ws-2/workspace.json").exists(), "the deletion travels");
        assert_eq!(stored(&t.b).len(), 1);
    }

    #[test]
    fn a_cycle_with_sync_switched_off_does_nothing_at_all() {
        let dir = std::env::temp_dir().join(format!("cd-off-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let st = run_once(&dir, &[ws("ws-1", "deck", "/here")], &[]);
        assert_eq!(st, SyncState::default());
        assert!(!dir.join("ws-1").exists(), "nothing is written before sync is on");
        let _ = fs::remove_dir_all(&dir);
    }
}
