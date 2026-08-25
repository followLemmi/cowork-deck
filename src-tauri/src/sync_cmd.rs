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
