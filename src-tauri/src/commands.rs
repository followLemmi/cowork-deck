//! # `#[tauri::command(async)]` is not decoration — read this before adding one
//!
//! A bare `#[tauri::command]` on a **synchronous** function runs on the thread
//! that received the IPC message, which is the main thread — and on Linux the
//! main thread is the one running the GTK loop that paints the WebView. So a
//! command that spawns `gh` and waits for the network does not merely take a
//! while: it freezes the window for its whole duration. Nothing the frontend does
//! can help, because the frontend cannot repaint. That is what
//! `tauri-macros`' `ExecutionContext::Blocking` (its default) means, and the
//! generated wrapper calls the function inline to prove it.
//!
//! `(async)` on a function that is still `fn` selects the macro's
//! `sync_threadpool` kind: the same synchronous body, run inside a task on the
//! async runtime instead of on the main thread. No signature change, no `.await`,
//! no `Send` gymnastics with `State` — the locks in this file are all taken and
//! released around the blocking calls rather than held across them (see
//! `gh_invocation`), which is what makes concurrent commands safe here.
//!
//! **Every command that spawns a process or touches the network carries it.**
//! That is all of `gh_*`, `pr_*`, `issue_*` and `git_status` here, and the whole
//! of `tasks_cmd`, whose file board reads a directory that may be on a network
//! mount. The three deliberate exceptions, which stay on the main thread:
//!
//! - the store and settings commands (`list_workspaces`, `save_*`, `load_layout`,
//!   …) — a small JSON file in the app's own directory, and running them in
//!   arrival order is worth more than the microseconds;
//! - the session commands (`start_session`, `write_session`, `resize_session`,
//!   `close_session`) — **ordering is the feature**: a `write` that overtook its
//!   `start`, or two writes that swapped, is lost or misdirected keyboard input.
//!   None of them resolves a token (`workspace_token` is reached only from
//!   `gh_invocation`), so none of them is a candidate anyway;
//! - `host_platform` — one `/etc/os-release` read. (`claude_available` used to
//!   sit here as "one `which`", but discovery now probes install dirs and may
//!   run the user's login shell, so it carries `(async)` like everything else
//!   that shells out.)
//!
//! Adding a command that shells out and forgetting `(async)` reintroduces a
//! frozen window, and it will not look like this file's fault from the frontend.

use crate::gh;
use crate::hooks::build_settings_json;
use crate::model::{
    GitStatus, SessionEntry, SessionTokens, Skill, TokenUsage, UiState, UiStatePatch, Workspace,
    WorkspaceGithub,
};
use crate::pty::PtyManager;
use crate::store::Store;
use crate::which;
use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub store: Mutex<Store>,
    pub pty: PtyManager,
    pub listener_port: u16,
    pub reporter_path: String,
    /// Absolute path to the `cowork_task` sidecar, handed to sessions via
    /// COWORK_TASK_BIN.
    pub task_bin_path: String,
    /// Signalled once by the frontend (`scheduler_ready`) after it attaches its
    /// `schedule://fire` listener, so the scheduler's first (catch-up) tick is
    /// not emitted into the void.
    pub scheduler_ready: std::sync::Arc<tokio::sync::Notify>,
    /// Live directory watchers for configured tracker roots. Rebuilt via
    /// `tasks_watch_sync` whenever the workspace set or its config changes.
    pub watchers: std::sync::Arc<cowork_deck::tasks::watch::TaskWatchers>,
    /// In-memory account tokens, keyed by (host, login). See `workspace_token`.
    pub gh_tokens: Mutex<std::collections::HashMap<(String, String), String>>,
    /// Per-workspace repository facts: `owner/name` and the default branch, as
    /// `gh` resolved them from the workspace's folder. Resolved once per
    /// workspace per app run — the same lifetime and the same "in memory only,
    /// never persisted" rule as `gh_tokens` beside it — and cleared whenever a
    /// workspace is saved, since its folder may now be a different repository.
    pub gh_repos: Mutex<std::collections::HashMap<String, cowork_deck::tasks::gh_issues::RepoFacts>>,
    /// The open-issue count each GitHub workspace's board last saw, for the
    /// sidebar badge. Written by `tasks_list`, read by `tasks_open_counts`, never
    /// a network call. A workspace whose board has not been opened this run is
    /// absent, and `WorkspacesPanel` already draws nothing for that.
    pub issue_open_counts: Mutex<std::collections::HashMap<String, usize>>,
}

/// Build the argv (after the program name) for launching an interactive claude
/// session. First launch pins our own session id via `--session-id`; restart/
/// restore resumes that same conversation via `--resume` (no prompt — context
/// already lives in the resumed session).
pub fn build_claude_args(
    settings_json: &str,
    initial_prompt: &Option<String>,
    session_id: &str,
    resume: bool,
) -> Vec<String> {
    let mut args = vec!["--settings".to_string(), settings_json.to_string()];
    if resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
        if let Some(p) = initial_prompt {
            args.push(p.clone());
        }
    }
    args
}

/// Environment a session needs to file its own tickets. When the workspace has
/// no tracker, the tracker vars are omitted entirely rather than set to an
/// empty string — the CLI then fails loudly instead of writing somewhere
/// arbitrary, and the agent has no empty path to misread. `COWORK_TASK_ID` is
/// the exception: it is pushed unconditionally, same as `COWORK_SESSION`,
/// because the hooks that key off it need to know a card is linked even when
/// the workspace's tracker is unreachable.
///
/// The GitHub half is two variables and no folder. `COWORK_ISSUE_REPO` exists
/// for one reason: without it `guard`'s no-card branch goes silent, and that
/// branch is the only thing telling a *plainly started* session that this
/// workspace has a tracker at all — the launch prompt is built on the launch
/// path alone. Losing it would quietly kill the "found a side problem, file a
/// ticket" convention in every GitHub workspace. `COWORK_ISSUE_NUMBER` is the
/// analogue of `COWORK_TASK_ID` and is set only on the launch-from-an-issue path.
pub fn session_env(
    root: Option<&std::path::Path>,
    project: &str,
    task_bin: &str,
    session: &str,
    task_id: Option<&str>,
    issue_repo: Option<&str>,
    issue_number: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = vec![("COWORK_SESSION".to_string(), session.to_string())];
    if let Some(root) = root {
        env.push(("COWORK_TASKS_DIR".to_string(), root.to_string_lossy().to_string()));
        env.push(("COWORK_PROJECT".to_string(), project.to_string()));
        env.push(("COWORK_TASK_BIN".to_string(), task_bin.to_string()));
    }
    // The hooks in hooks.rs find the card through this. Set on resume too:
    // a restored session that lost it would silently stop being reminded.
    if let Some(id) = task_id {
        env.push(("COWORK_TASK_ID".to_string(), id.to_string()));
    }
    if let Some(repo) = issue_repo {
        env.push(("COWORK_ISSUE_REPO".to_string(), repo.to_string()));
    }
    if let Some(n) = issue_number {
        env.push(("COWORK_ISSUE_NUMBER".to_string(), n.to_string()));
    }
    env
}

#[derive(Clone, Serialize)]
struct OutputPayload { session: String, #[serde(rename = "dataB64")] data_b64: String }
#[derive(Clone, Serialize)]
struct StatePayload { session: String, state: crate::model::SessionState }
#[derive(Clone, Serialize)]
struct ExitPayload { session: String, ok: bool }

#[tauri::command]
pub fn list_workspaces(state: State<AppState>) -> Vec<Workspace> {
    state.store.lock().unwrap().workspaces()
}
#[tauri::command]
pub fn save_workspace(state: State<AppState>, ws: Workspace) -> Result<Vec<Workspace>, String> {
    // The binding may have just changed; a stale cached token would keep this
    // workspace talking as the old account. The map holds a handful of entries,
    // so clearing all of it costs nothing and precision buys nothing.
    if let Ok(mut cache) = state.gh_tokens.lock() {
        cache.clear();
    }
    // A re-pointed folder is a different repository, and a re-sourced tracker is
    // a different count. Both caches are keyed by workspace, so both would
    // otherwise keep answering for the workspace this one used to be.
    if let Ok(mut cache) = state.gh_repos.lock() {
        cache.clear();
    }
    if let Ok(mut cache) = state.issue_open_counts.lock() {
        cache.clear();
    }
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    // Seeded the same way the tracker reads them, so a version 1 config's
    // cards are not forgotten by the very save that bumps it to version 2.
    let old = store
        .workspaces()
        .into_iter()
        .map(crate::tasks_cmd::seed_previous_location)
        .find(|w| w.id == ws.id);
    let ws = crate::tasks_cmd::with_previous_location(old.as_ref(), ws);
    store.upsert_workspace(ws).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remove_workspace(state: State<AppState>, id: String) -> Result<Vec<Workspace>, String> {
    state.store.lock().unwrap().delete_workspace(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn list_skills(state: State<AppState>) -> Vec<Skill> {
    state.store.lock().unwrap().skills()
}
#[tauri::command]
pub fn save_skill(state: State<AppState>, sk: Skill) -> Result<Vec<Skill>, String> {
    state.store.lock().unwrap().upsert_skill(sk).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remove_skill(state: State<AppState>, id: String) -> Result<Vec<Skill>, String> {
    state.store.lock().unwrap().delete_skill(&id).map_err(|e| e.to_string())
}

/// Runtime schedule state for the UI. The backend owns this file; without a
/// way to read it the frontend could only guess whether a schedule had ever
/// run, and "last run" had nowhere to come from.
#[derive(Serialize)]
pub struct ScheduleView {
    #[serde(flatten)]
    run: crate::model::ScheduleRun,
    /// Next firing time, computed by the side that actually fires. The
    /// frontend had its own copy of this arithmetic; two implementations of
    /// the same rule drift apart silently, with nothing to compare them by.
    #[serde(rename = "nextRunMs")]
    next_run_ms: Option<i64>,
}

#[tauri::command]
pub fn load_schedule_state(
    state: State<AppState>,
) -> std::collections::HashMap<String, ScheduleView> {
    let store = state.store.lock().unwrap();
    let runs = store.schedule_state();
    let skills = store.skills();
    let now = chrono::Local::now().naive_local();
    runs.into_iter()
        .map(|(id, run)| {
            let next = skills
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| s.schedule.as_ref())
                .filter(|sch| sch.enabled)
                .map(|sch| crate::scheduler::to_epoch_ms(
                    crate::scheduler::next_occurrence(&sch.preset, now),
                ));
            (id, ScheduleView { run, next_run_ms: next })
        })
        .collect()
}

/// Report what a `schedule://fire` actually produced. The loop records only
/// that it made an attempt; this is what lets `lastRun` mean "a session really
/// started" instead of "an event was emitted into the void".
///
/// An ack that no longer matches the pending attempt is dropped silently —
/// see `scheduler::apply_ack`.
#[tauri::command]
pub fn schedule_ack(
    state: State<AppState>,
    skill_id: String,
    occurrence_ms: i64,
    outcome: String,
) -> Result<(), String> {
    let store = state.store.lock().unwrap();
    let mut st = store.schedule_state();
    let Some(updated) = crate::scheduler::apply_ack(st.get(&skill_id), occurrence_ms, &outcome)
    else {
        return Ok(());
    };
    st.insert(skill_id, updated);
    store.save_schedule_state(&st).map_err(|e| e.to_string())
}

/// The frontend calls this once, after its `schedule://fire` listener is
/// attached, to release the scheduler loop's first tick.
#[tauri::command]
pub fn scheduler_ready(state: State<AppState>) {
    state.scheduler_ready.notify_one();
}

#[derive(Debug, Clone, Serialize)]
pub struct HostPlatform {
    /// "macos" | "windows" | "linux"
    pub os: String,
    /// ID дистрибутива из /etc/os-release; None на macOS/Windows.
    pub distro: Option<String>,
}

/// Достаёт `ID=` из /etc/os-release. Кавычки вокруг значения допустимы.
pub fn parse_os_release_id(contents: &str) -> Option<String> {
    contents.lines().find_map(|l| {
        l.strip_prefix("ID=")
            .map(|v| v.trim().trim_matches('"').to_string())
            .filter(|v| !v.is_empty())
    })
}

/// Сообщает факты об ОС. Строку команды установки собирает фронт — так вся
/// матрица платформ покрывается одним набором тестов, а не двумя на разных
/// языках.
#[tauri::command]
pub fn host_platform() -> HostPlatform {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let distro = if os == "linux" {
        std::fs::read_to_string("/etc/os-release").ok().as_deref().and_then(parse_os_release_id)
    } else {
        None
    };
    HostPlatform { os: os.to_string(), distro }
}

#[tauri::command(async)]
pub fn gh_status() -> gh::GhStatus {
    gh::status()
}

#[tauri::command(async)]
pub fn claude_available() -> bool {
    which_claude().is_some()
}

/// Successful discoveries only — a miss stays retryable so installing claude
/// and pressing "try again" works without restarting the app. The expensive
/// probes run at most once per process; `start_session` reads the cache.
static CLAUDE_CACHE: std::sync::OnceLock<which::Resolution> = std::sync::OnceLock::new();

fn which_claude() -> Option<which::Resolution> {
    // Respect an explicit override, else run the shared discovery: PATH,
    // known install dirs, login shell. An npm/nvm-installed claude is a
    // `#!/usr/bin/env node` script, which is why the resolution's captured
    // PATH matters to the session that runs it (see `which::Resolution`).
    if let Ok(p) = std::env::var("COWORK_CLAUDE_PATH") {
        if !p.is_empty() {
            return Some(which::Resolution { program: p, path_env: None });
        }
    }
    if let Some(hit) = CLAUDE_CACHE.get() {
        return Some(hit.clone());
    }
    let names: &[&str] = if cfg!(windows) { &["claude.cmd", "claude"] } else { &["claude"] };
    // Native installer, `claude migrate-installer`, and common npm setups.
    let mut candidates = which::under_home(if cfg!(windows) {
        &[".local/bin/claude.exe", ".bun/bin/claude.exe", ".volta/bin/claude.exe"]
    } else {
        &[".local/bin/claude", ".claude/local/claude", ".npm-global/bin/claude", ".volta/bin/claude", ".bun/bin/claude"]
    });
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\npm\\claude.cmd"));
        }
    } else {
        candidates.push("/opt/homebrew/bin/claude".to_string());
        candidates.push("/usr/local/bin/claude".to_string());
    }
    let found = which::discover(names, &candidates, &which::version_runs)?;
    Some(CLAUDE_CACHE.get_or_init(|| found).clone())
}

/// Что фронт узнаёт про аккаунт стартовавшей сессии. Токена здесь нет и быть
/// не может — только имя аккаунта и, если что-то пошло не так, причина.
#[derive(Debug, Clone, Serialize)]
pub struct SessionAuth {
    pub account: Option<String>,
    pub degraded: Option<String>,
}

pub struct AuthOutcome {
    pub env: Vec<(String, String)>,
    pub auth: SessionAuth,
}

/// Резолвит привязку воркспейса в окружение сессии. Сбой резолва НЕ блокирует
/// старт: сессия поднимается в деградированном режиме (см. `gh::session_env`),
/// а причина уезжает во фронт для бейджа на тайле.
///
/// Принимает уже извлечённый конфиг, а не `State`, специально: `gh::token`
/// блокирует до `timeout`, и держать в это время мьютекс стора нельзя.
pub fn resolve_session_auth(
    cfg: Option<&WorkspaceGithub>,
    noauth_dir: &str,
    timeout: std::time::Duration,
) -> AuthOutcome {
    let cfg = match cfg {
        Some(c) => c,
        None => {
            return AuthOutcome {
                env: Vec::new(),
                auth: SessionAuth { account: None, degraded: None },
            }
        }
    };
    match gh::token(&cfg.host, &cfg.login, timeout) {
        Ok(t) => AuthOutcome {
            env: gh::session_env(cfg, Some(&t), noauth_dir),
            auth: SessionAuth { account: Some(cfg.login.clone()), degraded: None },
        },
        Err(reason) => AuthOutcome {
            env: gh::session_env(cfg, None, noauth_dir),
            auth: SessionAuth { account: Some(cfg.login.clone()), degraded: Some(reason) },
        },
    }
}

/// Каталог-пустышка для деградированных сессий: `gh` с таким `GH_CONFIG_DIR`
/// честно сообщает «не залогинен» вместо работы под чужим активным аккаунтом.
fn noauth_dir(state: &State<AppState>) -> std::path::PathBuf {
    let dir = state.store.lock().unwrap().dir.join("gh-noauth");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Cap on one page of pull requests. Named rather than inlined because the
/// frontend prints "showing N of M" against it: a silently truncated list reads
/// as a complete one.
pub const PR_PAGE_LIMIT: usize = 50;

/// `-R` rather than letting `gh` resolve the repository from `cwd`: this feature
/// creates worktrees whose `origin` is related to but not identical with the
/// workspace's, and a call that resolves from wherever it is standing is a call
/// waiting to answer for the wrong repository (decision 11).
pub fn pr_list_argv(repo: &str, limit: usize) -> Vec<String> {
    vec![
        "pr".into(),
        "list".into(),
        "--state".into(),
        "open".into(),
        "--limit".into(),
        limit.to_string(),
        "--json".into(),
        crate::gh_pr::PR_LIST_FIELDS.into(),
        "-R".into(),
        repo.into(),
    ]
}

/// One pull request's contents. Same `-R` discipline, same reason.
pub fn pr_detail_argv(repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".into(),
        "view".into(),
        number.to_string(),
        "--json".into(),
        crate::gh_pr::PR_DETAIL_FIELDS.into(),
        "-R".into(),
        repo.into(),
    ]
}

/// Cap on how many files of one diff cross IPC, named for the same reason
/// `PR_PAGE_LIMIT` is: the drawer prints "showing N of M" against it, and a
/// silently truncated file list reads as a complete one. A 900-file pull request
/// has to say so rather than quietly stopping at 300.
pub const PR_DIFF_FILE_LIMIT: usize = 300;

/// One page of the files endpoint, and GitHub's own maximum for it. #151's 62
/// files arrive in a single page at this size — the measurement the whole
/// one-call design rests on.
const PR_DIFF_PER_PAGE: usize = 100;

/// One page of a pull request's changed files, with their patches.
///
/// `gh api` has no `-R`; the repository goes in the path instead, which is the
/// same discipline `pr_list_argv` states, spelled the way this endpoint spells
/// it. Explicit `page` rather than `--paginate` because the cap has to be ours:
/// `--paginate` would fetch all 900 files of a 900-file pull request, patches
/// included, before anything here got a chance to stop.
pub fn pr_files_argv(repo: &str, number: u64, per_page: usize, page: usize) -> Vec<String> {
    vec!["api".into(), format!("repos/{repo}/pulls/{number}/files?per_page={per_page}&page={page}")]
}

/// One file of a diff, on a page of its own, with no cap of ours applied.
///
/// **A page of one is the whole mechanism**, and it is measured rather than clever.
/// GitHub zeroes a file's counts and drops its patch when the *response* hits a
/// budget, so the fix for a file it declined to describe is to ask for a response
/// small enough that it cannot. On #151 `tests/tasks.test.ts` is index 60: in the
/// 62-file response it reads 0/0/0 with no patch, and at `per_page=1&page=61` it
/// comes back 163/3 with a 193-line patch.
///
/// The same call answers the other refusal for free. A file over `PR_DIFF_LINE_CAP`
/// was dropped by us and not by GitHub, so re-asking for it alone and parsing it
/// uncapped is exactly "show anyway" — one mechanism serving both states, which is
/// why no `uncapped_path` exemption was added to `pr_diff`. A path would not have
/// worked as the key anyway: 2 of 549 measured responses name the same path twice.
///
/// It does **not** answer `TooLargeUpstream`, and that is measured too — #151's
/// 5290-change plan has no patch at `per_page=1` either. The view offers no button
/// there, because the bytes never existed to be fetched.
#[tauri::command(async)]
pub fn pr_file_patch(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    file_index: usize,
) -> Result<crate::gh_pr::DiffFile, String> {
    let repo = repo_facts_for(&state, &workspace_id)?.repo;
    // The index in the accumulated list *is* the one-based page number of a
    // one-per-page request. That equivalence is why the drawer keys files by index
    // and never by path.
    let argv = pr_files_argv(&repo, number, 1, file_index + 1);
    let json = run_gh_for_workspace(&state, &workspace_id, &argv)?;
    crate::gh_pr::parse_pr_files_capped(&json, usize::MAX)?
        .files
        .pop()
        .ok_or_else(|| format!("the pull request has no file at position {}", file_index + 1))
}

/// How many files GitHub says the pull request touches.
///
/// Exactly the shape and the reasoning of `issue_totals_argv`: a page shorter
/// than the cap *is* the total, so this second call happens only when the pages
/// ran out at `PR_DIFF_FILE_LIMIT` — which on a repository of ordinary pull
/// requests is never. GraphQL rather than `pr view --json changedFiles` because
/// the whole point is to move one integer, not a detail payload.
const CHANGED_FILES_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { changedFiles }
  }
}";

pub fn pr_changed_files_argv(repo: &str, number: u64) -> Vec<String> {
    let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
    vec![
        "api".into(),
        "graphql".into(),
        "-F".into(),
        format!("owner={owner}"),
        "-F".into(),
        format!("name={name}"),
        "-F".into(),
        format!("number={number}"),
        "-f".into(),
        format!("query={CHANGED_FILES_QUERY}"),
    ]
}

/// Resolve the workspace's account token, caching it in memory.
///
/// The account feature deliberately keeps tokens out of the app: one is
/// resolved at session start and lives only in the child's memory. Polling is
/// why this cache exists — resolving on every tick would run `gh auth token`
/// every few seconds, and a locked keyring is exactly the case the timeout was
/// added for. So the cache is narrow: in memory only, keyed by host and login,
/// never logged, never persisted, dropped when a binding changes.
fn workspace_token(state: &State<AppState>, cfg: &WorkspaceGithub) -> Option<String> {
    let key = (cfg.host.clone(), cfg.login.clone());
    if let Some(t) = state.gh_tokens.lock().ok()?.get(&key) {
        return Some(t.clone());
    }
    let t = gh::token(&cfg.host, &cfg.login, std::time::Duration::from_secs(5)).ok()?;
    if let Ok(mut cache) = state.gh_tokens.lock() {
        cache.insert(key, t.clone());
    }
    Some(t)
}

/// Everything a `gh` call in a workspace needs before it can be spawned.
///
/// A struct rather than the three-element tuple this started as: the tuple's
/// type trips `clippy::type_complexity`, and the ceiling this plan works under
/// allows neither a new warning nor an `allow` to hide one.
struct GhInvocation {
    /// The `gh` program itself.
    path: String,
    /// The workspace folder the call runs in — `gh` resolves the repository from
    /// it, so it is not incidental.
    cwd: String,
    /// What decides which account the call speaks as.
    env: Vec<(String, String)>,
}

/// Resolve that invocation. Factored out of the two runners below so the account
/// resolution exists once and they can only differ in how they spawn.
fn gh_invocation(
    state: &State<AppState>,
    workspace_id: &str,
) -> Result<GhInvocation, String> {
    // The store lock is taken and released before the token is resolved:
    // `gh::token` blocks for up to five seconds, and holding the shared mutex
    // that long would stall every other operation on the store.
    let ws = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id)
    }
    .ok_or_else(|| "no such workspace".to_string())?;
    let cfg = ws.github.clone().ok_or_else(|| "no-account".to_string())?;
    let resolved = gh::which_gh().ok_or_else(|| "gh-not-found".to_string())?;
    let token = workspace_token(state, &cfg);

    let dir = noauth_dir(state);
    let mut env = gh::session_env(&cfg, token.as_deref(), &dir.to_string_lossy());
    // A gh resolved through the login shell was validated under that shell's
    // PATH; every spawn of it must carry the same one.
    if let Some(path_env) = &resolved.path_env {
        env.push(("PATH".to_string(), path_env.clone()));
    }

    Ok(GhInvocation { path: resolved.program, cwd: ws.path.clone(), env })
}

/// `gh`'s own exit code for "authentication required" — the one status worth
/// interpreting rather than merely reporting.
const GH_EXIT_AUTH: i32 = 4;

/// The message a failed `gh` leaves behind, out of its exit status and its stderr.
///
/// **Never empty, and that is why it exists.** `gh` killed by a signal, or a
/// future `gh` that reports to stdout, leaves stderr blank; the bare
/// `Err(redacted stderr)` this replaces then reached the board as
/// `TaskError::Remote("")`, rendered as an error paragraph containing no words at
/// all above a list the user had no way to tell was stale. Nothing downstream can
/// rescue that, because there is no phrase to match — so the exit status, the one
/// fact that always exists, is the fallback.
///
/// Exit 4 is `gh`'s "authentication required", and `no-account` is appended so
/// `unavailableFrom` (`src/issues.ts:124`) resolves it to a screen that says what
/// to do about it. The nearest of the three states rather than an exact one: it
/// covers a workspace with no account bound, and this is a bound account whose
/// credentials `gh` will not accept — but "Bind an account" is the right action
/// for both, and the alternative is an unrecognised error.
///
/// **stderr is kept verbatim and the marker is appended, never substituted:**
/// `unavailableFrom` matches with `includes`, which survives an added prefix or
/// suffix but not a replaced body. The marker is bare for the same reason — it is
/// a contract with that table, and prose around it invites a rewording that
/// breaks the match.
///
/// Redaction happens here rather than at the two call sites, because this is the
/// only place a failed `gh` becomes a message and therefore the only place that
/// could forget.
fn gh_failure(code: Option<i32>, stderr: &str) -> String {
    let said = gh::redact(stderr.trim());
    let mut msg = match (said.is_empty(), code) {
        (false, _) => said,
        (true, Some(c)) => format!("gh exited with code {c} and wrote no error"),
        // No code at all: killed by a signal, so there is not even a number.
        (true, None) => "gh was killed before it could write an error".to_string(),
    };
    if code == Some(GH_EXIT_AUTH) {
        msg.push_str(" (no-account)");
    }
    msg
}

/// The one place a finished `gh` becomes a `Result`, shared by both runners.
///
/// **The exit code is read before stdout is**, and the order is load-bearing: a
/// missing scope is exit 1 with nothing on stdout, so a parse-first runner would
/// report a scope failure as unreadable JSON.
fn gh_output(out: std::process::Output) -> Result<String, String> {
    if !out.status.success() {
        return Err(gh_failure(out.status.code(), &String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Run `gh` in the workspace's folder, under the workspace's account.
///
/// Every path out of here is redacted: `gh` is capable of echoing a token back
/// in an error, and this and `gh_output` are the only places that decide what the
/// frontend sees.
pub(crate) fn run_gh_for_workspace(
    state: &State<AppState>,
    workspace_id: &str,
    args: &[String],
) -> Result<String, String> {
    let GhInvocation { path, cwd, env } = gh_invocation(state, workspace_id)?;

    let out = std::process::Command::new(&path)
        .args(args)
        .current_dir(&cwd)
        .envs(env)
        .output()
        .map_err(|e| gh::redact(&e.to_string()))?;
    gh_output(out)
}

/// `run_gh_for_workspace` with a body on stdin.
///
/// `Command::output()` sets stdin to null, so the existing runner cannot feed
/// one — and `gh issue create` prompts interactively for a missing body, which
/// in a child process is a hang waiting for the one case that reaches it. Same
/// account resolution, same `cwd`, and — since both end on `gh_output` — the same
/// redaction and the same check-the-exit-code-before-parsing rule by construction
/// rather than by agreement; the only difference is the pipe.
pub(crate) fn run_gh_with_stdin(
    state: &State<AppState>,
    workspace_id: &str,
    args: &[String],
    stdin_body: &str,
) -> Result<String, String> {
    let GhInvocation { path, cwd, env } = gh_invocation(state, workspace_id)?;

    let mut child = std::process::Command::new(&path)
        .args(args)
        .current_dir(&cwd)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| gh::redact(&e.to_string()))?;
    // Best effort, and deliberately not fatal: gh may have exited already (an
    // argument error, no credentials), and a BrokenPipe here would report that
    // as a write failure instead of letting the real message through.
    if let Some(mut sink) = child.stdin.take() {
        use std::io::Write;
        let _ = sink.write_all(stdin_body.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| gh::redact(&e.to_string()))?;
    gh_output(out)
}

/// Split `gh api --include` output into the remaining GraphQL budget and the
/// body. The budget is the proactive rate-limit signal of decision 9: the
/// refusal's own text is unverified, so nothing matches on it.
fn split_gh_response(out: &str) -> (Option<u64>, &str) {
    let (head, body) = match out.split_once("\r\n\r\n") {
        Some(p) => p,
        None => match out.split_once("\n\n") {
            Some(p) => p,
            // No header block: the call was made without `--include`, or gh
            // changed. The body is all of it, and there is no signal — which is
            // `None`, never `0`: zero means exhausted and would raise the
            // banner on every tick.
            None => return (None, out),
        },
    };
    let remaining = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("x-ratelimit-remaining").then(|| v.trim().parse().ok())?
    });
    (remaining, body)
}

pub fn issue_totals_argv_with_headers(repo: &str) -> Vec<String> {
    let mut argv = cowork_deck::tasks::gh_issues::issue_totals_argv(repo);
    argv.push("--include".into());
    argv
}

/// `owner/name` and the default branch for a workspace, resolved once and
/// cached. Not parsed out of `git remote get-url`: that is free but has to
/// handle both SSH and HTTPS forms, and `gh`'s own answer is authoritative about
/// which remote `gh` would have picked.
pub(crate) fn repo_facts_for(
    state: &State<AppState>,
    workspace_id: &str,
) -> Result<cowork_deck::tasks::gh_issues::RepoFacts, String> {
    if let Some(f) = state.gh_repos.lock().ok().and_then(|c| c.get(workspace_id).cloned()) {
        return Ok(f);
    }
    let json = run_gh_for_workspace(
        state,
        workspace_id,
        &cowork_deck::tasks::gh_issues::repo_facts_argv(),
    )?;
    let facts = cowork_deck::tasks::gh_issues::parse_repo_facts(&json)?;
    if let Ok(mut cache) = state.gh_repos.lock() {
        cache.insert(workspace_id.to_string(), facts.clone());
    }
    Ok(facts)
}

/// How many issues the repository has, in both states. One GraphQL point, and
/// the frontend only calls it when the open page came back full — a shorter page
/// *is* the total.
#[tauri::command(async)]
pub fn issue_totals(
    state: State<AppState>,
    workspace_id: String,
) -> Result<IssueTotalsView, String> {
    let facts = repo_facts_for(&state, &workspace_id)?;
    let out =
        run_gh_for_workspace(&state, &workspace_id, &issue_totals_argv_with_headers(&facts.repo))?;
    let (remaining, body) = split_gh_response(&out);
    let t = cowork_deck::tasks::gh_issues::parse_issue_totals(body)?;
    Ok(IssueTotalsView { open: t.open, closed: t.closed, rate_remaining: remaining })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTotalsView {
    pub open: u64,
    pub closed: u64,
    /// GraphQL points left this hour, from the response headers. `None` when the
    /// headers said nothing — never `0`, which means exhausted.
    pub rate_remaining: Option<u64>,
}

#[tauri::command(async)]
pub fn pr_list(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Vec<crate::gh_pr::PullRequest>, String> {
    // One cached lookup on the first refresh of an app run, none thereafter.
    let repo = repo_facts_for(&state, &workspace_id)?.repo;
    let json = run_gh_for_workspace(&state, &workspace_id, &pr_list_argv(&repo, PR_PAGE_LIMIT))?;
    crate::gh_pr::parse_pull_requests(&json)
}

/// What one pull request holds, for a row somebody opened.
///
/// Not part of the poll: the view fetches this once per expansion and keeps the
/// answer, so a description does not travel every 15 s alongside the rows.
#[tauri::command(async)]
pub fn pr_detail(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
) -> Result<crate::gh_pr::PrDetail, String> {
    let repo = repo_facts_for(&state, &workspace_id)?.repo;
    let json = run_gh_for_workspace(&state, &workspace_id, &pr_detail_argv(&repo, number))?;
    crate::gh_pr::parse_pr_detail(&json)
}

/// The whole diff of one pull request, in one call.
///
/// **`gh pr diff` cannot serve this.** GitHub caps that endpoint at 20,000 lines
/// and answers HTTP 406 above it; this repository's own PR #151 is 19,854 patch
/// lines *after* GitHub has already dropped its largest file, so the path fails
/// on precisely the pull request the drawer exists for, and it fails at the
/// moment of use. The files endpoint has no such cap and pages instead.
///
/// Stateless, exactly like `pr_detail`: fetch, parse, return, keep nothing. All
/// 62 files of #151 arrive in one response, so serving one file per call would
/// be 62 IPC round trips slicing a single fetch, each taking the `AppState`
/// mutex — and it would need an eviction policy, a lifetime tied to the head
/// commit, and a cache-miss error case existing only because of the
/// optimisation. What makes handing over the lot affordable is
/// `gh_pr::PR_DIFF_LINE_CAP`, applied before any of this is serialised.
#[tauri::command(async)]
pub fn pr_diff(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
) -> Result<crate::gh_pr::PrDiff, String> {
    let repo = repo_facts_for(&state, &workspace_id)?.repo;
    let mut files: Vec<crate::gh_pr::DiffFile> = Vec::new();
    let mut fetched: u64 = 0;
    let mut page = 1;
    // A page shorter than the one asked for *is* the end of the list — the rule
    // `issue_totals_argv` states, and what makes the count below free in every
    // ordinary case.
    let mut full_page = true;
    // Read off page one and kept, rather than overwritten per page. Later pages
    // are served by separate requests and a push between them would give two
    // different commits; the first is the one the bulk of what we return came
    // from, and the head moving mid-fetch is what the staleness bar is for.
    let mut head_ref_oid = String::new();
    while full_page && files.len() < PR_DIFF_FILE_LIMIT {
        let argv = pr_files_argv(&repo, number, PR_DIFF_PER_PAGE, page);
        let json = run_gh_for_workspace(&state, &workspace_id, &argv)?;
        let got = crate::gh_pr::parse_pr_files(&json)?;
        if head_ref_oid.is_empty() {
            head_ref_oid = got.head_ref_oid;
        }
        full_page = got.total_files as usize == PR_DIFF_PER_PAGE;
        fetched += got.total_files;
        files.extend(got.files);
        page += 1;
    }
    files.truncate(PR_DIFF_FILE_LIMIT);

    // Still full at the cap, so `fetched` is a floor and not a total. Asking
    // GitHub for the real number is one small request on a path an ordinary pull
    // request never reaches — and its failure is not this command's failure: a
    // diff in hand beats throwing 300 files away over a count, so the floor
    // stands in. It can only understate, which reads as "showing 300 of 300".
    let total_files = if full_page {
        run_gh_for_workspace(&state, &workspace_id, &pr_changed_files_argv(&repo, number))
            .ok()
            .and_then(|json| crate::gh_pr::parse_pr_changed_files(&json).ok())
            .unwrap_or(fetched)
    } else {
        fetched
    };
    Ok(crate::gh_pr::PrDiff { head_ref_oid, files, total_files })
}

#[tauri::command(async)]
pub fn pr_merge_options(
    state: State<AppState>,
    workspace_id: String,
) -> Result<crate::gh_pr::MergeOptions, String> {
    let args: Vec<String> = vec![
        "repo".into(),
        "view".into(),
        "--json".into(),
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,\
viewerDefaultMergeMethod,deleteBranchOnMerge"
            .into(),
    ];
    let json = run_gh_for_workspace(&state, &workspace_id, &args)?;
    crate::gh_pr::parse_merge_options(&json)
}

fn merge_strategy_flag(strategy: &str) -> Option<&'static str> {
    match strategy {
        "merge" => Some("--merge"),
        "squash" => Some("--squash"),
        "rebase" => Some("--rebase"),
        _ => None,
    }
}

pub fn pr_merge_argv(
    number: u64,
    strategy: &str,
    head_oid: &str,
    delete_branch: bool,
) -> Vec<String> {
    let mut argv: Vec<String> = vec!["pr".into(), "merge".into(), number.to_string()];
    if let Some(flag) = merge_strategy_flag(strategy) {
        argv.push(flag.into());
    }
    // Pins the merge to the commit the person actually read. gh fails if the
    // head has moved, which is the outcome we want.
    argv.push("--match-head-commit".into());
    argv.push(head_oid.into());
    if delete_branch {
        argv.push("--delete-branch".into());
    }
    argv
}

#[tauri::command(async)]
pub fn pr_merge(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    strategy: String,
    head_oid: String,
    delete_branch: bool,
) -> Result<(), String> {
    if merge_strategy_flag(&strategy).is_none() {
        return Err(format!("unknown merge strategy: {strategy}"));
    }
    run_gh_for_workspace(
        &state,
        &workspace_id,
        &pr_merge_argv(number, &strategy, &head_oid, delete_branch),
    )
    .map(|_| ())
}

#[tauri::command(async)]
pub fn pr_close(state: State<AppState>, workspace_id: String, number: u64) -> Result<(), String> {
    let args: Vec<String> = vec!["pr".into(), "close".into(), number.to_string()];
    run_gh_for_workspace(&state, &workspace_id, &args).map(|_| ())
}

#[tauri::command(async)]
pub fn pr_reopen(state: State<AppState>, workspace_id: String, number: u64) -> Result<(), String> {
    let args: Vec<String> = vec!["pr".into(), "reopen".into(), number.to_string()];
    run_gh_for_workspace(&state, &workspace_id, &args).map(|_| ())
}

/// Whether a worktree holds no uncommitted work.
///
/// An error is not "clean": if `git status` cannot answer, the only safe
/// reading is that we do not know, and we do not delete what we cannot inspect.
fn worktree_is_clean(path: &std::path::Path) -> Result<bool, String> {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// The path of the workspace a command names, or an error if there is no such
/// workspace. The store lock is taken and released here and nowhere else, so no
/// git process ever runs while it is held.
fn workspace_path(state: &State<AppState>, workspace_id: &str) -> Result<String, String> {
    let found = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
    };
    found.ok_or_else(|| "no such workspace".to_string())
}

/// Where this pull request's worktree would live, and whether it is there.
/// Read-only: the cleanup offer needs the path before it can name it.
#[tauri::command(async)]
pub fn pr_worktree_path(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    branch: String,
) -> Result<Option<String>, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    Ok(path.exists().then(|| path.to_string_lossy().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdded {
    pub path: String,
    /// True when this is the directory an issue was already being worked in.
    /// The tile's prompt says so: the same commits under two names would
    /// otherwise read as two pieces of work.
    pub reused: bool,
}

/// The worktree `pr_worktree_add` may reuse for a pull request on `branch`, out
/// of `git worktree list --porcelain`.
///
/// `worktree_on_branch` answers a narrower question — which worktree is on this
/// branch — and its first candidate is the workspace's **own working copy**,
/// because that is the first block git prints. For the ordinary pull request,
/// pushed from the workspace with its branch still checked out there, that block
/// is the one that matches; handing it back opens a session in the workspace
/// root beside every other live session there, which is the precise harm this
/// command refuses `gh pr checkout` to avoid.
///
/// So reuse is limited to the two sibling directories this app creates worktrees
/// in, which is also what makes it meaningful: the case reuse exists for is the
/// worktree our own issue flow made on the issue's branch. A directory somebody
/// created by hand is on the right branch and nothing else, and `reused: true`
/// would tell the tile it is the same piece of work.
fn reusable_worktree(
    porcelain: &str,
    branch: &str,
    ws_path: &str,
    number: u64,
) -> Option<std::path::PathBuf> {
    let found = crate::gh_pr::worktree_on_branch(porcelain, branch)?;
    if found == std::path::Path::new(ws_path) {
        return None;
    }
    // Built by the two functions that create them, so those names keep one
    // source; only the parent is read, and `number` and `branch` reach no
    // further than the leaf both of them discard.
    let ours = [
        crate::gh_pr::worktree_path(ws_path, number, branch),
        cowork_deck::tasks::gh_issues::issue_worktree_path(ws_path, number, branch),
    ];
    ours.iter()
        .any(|d| d.parent().is_some() && d.parent() == found.parent())
        .then_some(found)
}

#[tauri::command(async)]
pub fn pr_worktree_add(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    branch: String,
    cross_repository: bool,
) -> Result<WorktreeAdded, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;

    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    // Already there from an earlier launch: hand it back rather than failing.
    // The session that opens in it will see whatever state it was left in.
    if path.exists() {
        return Ok(WorktreeAdded { path: path.to_string_lossy().to_string(), reused: false });
    }

    // The ordinary path through the issues board produces a worktree on the
    // issue's own branch before the pull request exists. Reuse it rather than
    // fetching the same commits into a second directory under a second name.
    // Never for a fork: the head is not a local branch there, and our own issue
    // flow cannot have produced the first worktree anyway.
    if !cross_repository {
        let out = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&ws_path)
            .output();
        // Best effort: a failure here means "no reuse", never "no worktree". One
        // extra git invocation per launch is the cost of the choice.
        if let Ok(out) = out {
            if out.status.success() {
                let listed = String::from_utf8_lossy(&out.stdout);
                if let Some(found) = reusable_worktree(&listed, &branch, &ws_path, number) {
                    return Ok(WorktreeAdded {
                        path: found.to_string_lossy().to_string(),
                        reused: true,
                    });
                }
            }
        }
    }
    std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;

    // Fetch the head into a local branch first, then attach a worktree to it.
    // `gh pr checkout` is not used: it would move the branch inside the
    // workspace's own working copy, under every live session there.
    let local = format!("pr-{number}");
    let refspec = format!("pull/{number}/head:{local}");
    let fetch: Vec<String> = vec!["fetch".into(), "origin".into(), refspec, "--force".into()];
    let out = std::process::Command::new("git")
        .args(&fetch)
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let out = std::process::Command::new("git")
        .args(["worktree", "add", &path.to_string_lossy(), &local])
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(WorktreeAdded { path: path.to_string_lossy().to_string(), reused: false })
}

#[tauri::command(async)]
pub fn pr_worktree_remove(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    branch: String,
) -> Result<(), String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = crate::gh_pr::worktree_path(&ws_path, number, &branch);
    if !path.exists() {
        return Ok(());
    }
    match worktree_is_clean(&path) {
        Ok(true) => {}
        Ok(false) => {
            return Err(format!(
                "{} has uncommitted changes — nothing was removed",
                path.to_string_lossy()
            ))
        }
        Err(e) => {
            return Err(format!(
                "cannot tell whether {} is clean, so it was left alone: {e}",
                path.to_string_lossy()
            ))
        }
    }
    let out = std::process::Command::new("git")
        .args(["worktree", "remove", &path.to_string_lossy()])
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// `git worktree add` for an issue branch. `base` is `Some` when the branch has
/// to be created and `None` when it already exists.
fn worktree_add_argv(path: &str, branch: &str, base: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = vec!["worktree".into(), "add".into()];
    match base {
        Some(default) => {
            argv.push("-b".into());
            argv.push(branch.into());
            argv.push(path.into());
            argv.push(format!("origin/{default}"));
        }
        None => {
            argv.push(path.into());
            argv.push(branch.into());
        }
    }
    argv
}

fn branch_exists(ws_path: &str, branch: &str) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .current_dir(ws_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A worktree on a new branch off the repository's default branch, and the path
/// to it. Beside the workspace, never inside it — see
/// `gh_issues::issue_worktree_path` and BUG-026.
#[tauri::command(async)]
pub fn issue_worktree_add(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    title: String,
) -> Result<String, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = cowork_deck::tasks::gh_issues::issue_worktree_path(&ws_path, number, &title);
    // Already there from an earlier launch: hand it back rather than failing, as
    // `pr_worktree_add` does. The session that opens in it sees whatever state it
    // was left in.
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;

    let branch = cowork_deck::tasks::gh_issues::issue_branch(number, &title);
    let base = if branch_exists(&ws_path, &branch) {
        None
    } else {
        let facts = repo_facts_for(&state, &workspace_id)?;
        if facts.default_branch.is_empty() {
            return Err("this repository has no default branch to base an issue branch on".into());
        }
        // Fetched first, so a branch is not cut from a stale `origin/main`. The
        // failure is surfaced rather than swallowed: the same choice
        // `pr_worktree_add` makes about its own fetch.
        let out = std::process::Command::new("git")
            .args(["fetch", "origin", &facts.default_branch])
            .current_dir(&ws_path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Some(facts.default_branch)
    };

    let argv = worktree_add_argv(&path.to_string_lossy(), &branch, base.as_deref());
    let out = std::process::Command::new("git")
        .args(&argv)
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

/// Where this issue's worktree would live, and whether it is there. Read-only:
/// the cleanup offer needs the path before it can name it. Same shape as
/// `pr_worktree_path`, keyed by `(number, title)` rather than `(number, branch)`.
#[tauri::command(async)]
pub fn issue_worktree_path(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    title: String,
) -> Result<Option<String>, String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = cowork_deck::tasks::gh_issues::issue_worktree_path(&ws_path, number, &title);
    Ok(path.exists().then(|| path.to_string_lossy().to_string()))
}

/// Remove an issue's worktree, keeping all three of `pr_worktree_remove`'s
/// guards: never remove what is not there, refuse while it is dirty, and refuse
/// when cleanliness cannot be determined at all.
#[tauri::command(async)]
pub fn issue_worktree_remove(
    state: State<AppState>,
    workspace_id: String,
    number: u64,
    title: String,
) -> Result<(), String> {
    let ws_path = workspace_path(&state, &workspace_id)?;
    let path = cowork_deck::tasks::gh_issues::issue_worktree_path(&ws_path, number, &title);
    if !path.exists() {
        return Ok(());
    }
    match worktree_is_clean(&path) {
        Ok(true) => {}
        Ok(false) => {
            return Err(format!(
                "{} has uncommitted changes — nothing was removed",
                path.to_string_lossy()
            ))
        }
        Err(e) => {
            return Err(format!(
                "cannot tell whether {} is clean, so it was left alone: {e}",
                path.to_string_lossy()
            ))
        }
    }
    let out = std::process::Command::new("git")
        .args(["worktree", "remove", &path.to_string_lossy()])
        .current_dir(&ws_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<AppState>,
    session: String,
    cwd: String,
    workspace_id: Option<String>,
    initial_prompt: Option<String>,
    // Set when the session is launched from (or restored with) a tracker
    // card — see `session_env`.
    task_id: Option<String>,
    cols: u16,
    rows: u16,
    resume: bool,
) -> Result<SessionAuth, String> {
    let resolved = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let program = resolved.program;
    let settings = build_settings_json(&state.reporter_path, state.listener_port, &session, &state.task_bin_path);
    let args = build_claude_args(&settings, &initial_prompt, &session, resume);

    // Замок стора берётся и отпускается ДО резолва токена: gh::token блокирует
    // до пяти секунд, и удерживать общий мьютекс всё это время означало бы
    // подвесить любую другую операцию со стором.
    let ws = match workspace_id.as_deref() {
        Some(id) => {
            let store = state.store.lock().map_err(|_| "store lock".to_string())?;
            store.workspaces().into_iter().find(|w| w.id == id)
        }
        None => None,
    };

    // Tracker environment, resolved from the workspace's configuration. Three
    // outcomes: a folder, a repository, or nothing at all.
    let (root, project, issue_repo) = match &ws {
        Some(ws) => match crate::tasks_cmd::tracker_kind(ws) {
            Some(crate::tasks_cmd::TrackerKind::Fs { root, creation }) => {
                // A project-kind root may not exist yet on a freshly configured
                // workspace — create it now so the CLI the session is about to
                // get has somewhere to write. Best-effort, as before.
                let _ = crate::tasks_cmd::ensure_root_if_ours(&root, &creation);
                (Some(root), ws.name.clone(), None)
            }
            // The repository is resolved the same way `pr_list` resolves it, and
            // cached: a session launch must not spend a point rediscovering what
            // the board already asked. A failure here is not fatal — the session
            // starts without the tracker line rather than not at all.
            Some(crate::tasks_cmd::TrackerKind::GitHub) => (
                None,
                ws.name.clone(),
                repo_facts_for(&state, &ws.id).ok().map(|f| f.repo),
            ),
            None => (None, ws.name.clone(), None),
        },
        None => (None, String::new(), None),
    };
    let mut env = session_env(
        root.as_deref(), &project, &state.task_bin_path, &session, task_id.as_deref(),
        issue_repo.as_deref(),
        // For a GitHub workspace a card id *is* the issue number, so no new
        // parameter is threaded through this already 10-argument command.
        issue_repo.as_ref().and(task_id.as_deref()),
    );

    // Окружение GitHub-аккаунта кладётся поверх трекерного: наборы ключей не
    // пересекаются, сессия получает оба.
    let dir = noauth_dir(&state);
    let outcome = resolve_session_auth(
        ws.and_then(|w| w.github).as_ref(),
        &dir.to_string_lossy(),
        std::time::Duration::from_secs(5),
    );
    env.extend(outcome.env);

    // If discovery went through the login shell, hand the session that shell's
    // PATH: a claude that is really an `env node` script dies instantly under
    // the app's launchd-minimal environment otherwise.
    if let Some(path_env) = resolved.path_env {
        env.push(("PATH".to_string(), path_env));
    }

    let app_out = app.clone();
    let sess_out = session.clone();
    let on_output = move |bytes: Vec<u8>| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = app_out.emit("session://output", OutputPayload { session: sess_out.clone(), data_b64: b64 });
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |ok: bool| {
        let state = if ok { crate::model::SessionState::Ended } else { crate::model::SessionState::Error };
        let _ = app_exit.emit("session://state", StatePayload { session: sess_exit.clone(), state });
        let _ = app_exit.emit("session://exit", ExitPayload { session: sess_exit.clone(), ok });
    };

    state.pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &env, on_output, on_exit)
        .map_err(|e| e.to_string())?;
    Ok(outcome.auth)
}

/// Запускает произвольную команду в PTY-тайле.
///
/// Команду пишет пользователь и видит её целиком до запуска (форма установки
/// gh), поэтому приложение не выполняет ничего привилегированного вслепую.
/// Хуки Claude Code сюда не подставляются: это обычный терминал, а не сессия
/// агента, и её состояние ведётся только по факту выхода процесса.
#[tauri::command]
pub fn start_command_session(
    app: AppHandle,
    state: State<AppState>,
    session: String,
    cwd: String,
    command: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (program, args) = if cfg!(windows) {
        ("cmd".to_string(), vec!["/C".to_string(), command])
    } else {
        ("sh".to_string(), vec!["-lc".to_string(), command])
    };

    let app_out = app.clone();
    let sess_out = session.clone();
    let on_output = move |bytes: Vec<u8>| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let _ = app_out.emit("session://output", OutputPayload { session: sess_out.clone(), data_b64: b64 });
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |ok: bool| {
        let st = if ok { crate::model::SessionState::Ended } else { crate::model::SessionState::Error };
        let _ = app_exit.emit("session://state", StatePayload { session: sess_exit.clone(), state: st });
        let _ = app_exit.emit("session://exit", ExitPayload { session: sess_exit.clone(), ok });
    };

    state
        .pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &[], on_output, on_exit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_session(state: State<AppState>, session: String, data: String) -> Result<(), String> {
    state.pty.write(&session, data.as_bytes()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn resize_session(state: State<AppState>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    state.pty.resize(&session, cols, rows).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn close_session(state: State<AppState>, session: String) {
    state.pty.kill(&session);
}

#[tauri::command]
pub fn load_layout(state: State<AppState>) -> Vec<SessionEntry> {
    state.store.lock().unwrap().layout()
}

#[tauri::command]
pub fn save_layout(state: State<AppState>, sessions: Vec<SessionEntry>) -> Result<(), String> {
    state.store.lock().unwrap().save_layout(&sessions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_ui_state(state: State<AppState>) -> UiState {
    state.store.lock().unwrap().ui_state()
}

#[tauri::command]
pub fn save_ui_state(state: State<AppState>, ui: UiStatePatch) -> Result<(), String> {
    state.store.lock().unwrap().save_ui_state(&ui).map_err(|e| e.to_string())
}

/// Called by main during setup to emit state changes coming from the listener.
pub fn emit_state(app: &AppHandle, session: String, state: crate::model::SessionState) {
    let _ = app.emit("session://state", StatePayload { session, state });
}

#[tauri::command(async)]
pub fn git_status(cwd: String) -> GitStatus {
    use std::process::Command;
    let branch = Command::new("git")
        .arg("-C").arg(&cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let dirty = branch.is_some()
        && Command::new("git")
            .arg("-C").arg(&cwd)
            .args(["status", "--porcelain"])
            .output().ok()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);
    GitStatus { branch, dirty }
}

/// Fold `message.usage.*` into `acc`, **once per API request**. Tolerant of
/// non-JSON lines and lines without usage (user messages, meta).
///
/// Usage belongs to a request, not to a line. A transcript writes one line per
/// content block of an assistant turn — a `thinking` block, a `text` block, one
/// per `tool_use` — and every one of them repeats the identical usage object:
///
/// ```text
/// id=msg_011Cdp96Yq… out=384 blocks=["thinking"]
/// id=msg_011Cdp96Yq… out=384 blocks=["text"]
/// id=msg_011Cdp96Yq… out=384 blocks=["tool_use"]
/// ```
///
/// Folding per line billed those 384 tokens three times. The inflation is not a
/// constant — it tracks how many tool calls a turn makes, so it grew precisely
/// on the sessions where the number mattered.
///
/// `seen` is threaded through by the caller so that a session's own transcript
/// and its subagents deduplicate against one shared set of ids.
///
/// Note `usage.iterations[]`, a newer field carrying per-iteration counts: today
/// it holds a single element mirroring the top level, which is the aggregate.
/// Adding it to the fields below would reintroduce this same bug under another
/// name.
pub fn fold_usage_lines(
    content: &str,
    seen: &mut std::collections::HashSet<String>,
    acc: &mut TokenUsage,
) {
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let usage = &v["message"]["usage"];
        if !usage.is_object() {
            continue;
        }
        // Every usage-bearing line carries `message.id`, and it maps one-to-one
        // onto `requestId` across every transcript on hand. A line without one
        // is a shape we have not seen, so count it rather than silently drop it.
        if let Some(id) = v["message"]["id"].as_str() {
            if !seen.insert(id.to_string()) {
                continue;
            }
        }
        acc.input += usage["input_tokens"].as_u64().unwrap_or(0);
        acc.output += usage["output_tokens"].as_u64().unwrap_or(0);
        acc.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        acc.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    }
}

/// Tokens resident in the context window: the prompt of the last request **plus
/// the response it produced**. This is the figure Claude Code prints for the
/// session, and it reproduces exactly — verified against a terminal reading
/// 83 682 for a last request of `input=2, cache_creation=124,
/// cache_read=82 021, output=1 535`.
///
/// The `output` term is the one that is easy to leave out: the window holds both
/// what was sent and what came back.
///
/// The reading goes stale between a final response and the next request — while
/// the user types, the real window grows and the transcript does not move. That
/// costs nothing against the terminal, which is stale in the same way from the
/// same source.
pub fn last_context(content: &str) -> Option<u64> {
    let mut ctx = None;
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let u = &v["message"]["usage"];
        if !u.is_object() {
            continue;
        }
        // Duplicate lines repeat one request's usage verbatim, so the last one
        // wins either way and needs no deduplication here.
        ctx = Some(
            u["input_tokens"].as_u64().unwrap_or(0)
                + u["cache_creation_input_tokens"].as_u64().unwrap_or(0)
                + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                + u["output_tokens"].as_u64().unwrap_or(0),
        );
    }
    ctx
}

/// Locate the transcript file `<session_id>.jsonl` under any project dir.
///
/// Scanning every project dir rather than deriving one from the workspace path
/// is load-bearing: a transcript moves. Entering a git worktree changes the
/// session's cwd, and Claude Code relocates the whole file to the project dir of
/// the new path.
fn find_transcript(session_id: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = std::path::PathBuf::from(home).join(".claude/projects");
    let target = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(&base).ok()? {
        let dir = match entry { Ok(e) => e.path(), Err(_) => continue };
        let f = dir.join(&target);
        if f.is_file() {
            return Some(f);
        }
    }
    None
}

/// Subagent transcripts, which sit in a directory named after the session rather
/// than in the session's own file:
///
/// ```text
/// ~/.claude/projects/<slug>/
/// ├── 55dde7d8-….jsonl
/// └── 55dde7d8-…/subagents/
///     └── agent-aeafe71a469403fc0.jsonl
/// ```
///
/// Missing these hid up to two thirds of a session's spend — in one measured
/// case a single subagent outspent the entire main chain.
///
/// Do not go looking for `isSidechain` instead: it is present on every line of a
/// current transcript and false on all of them. Subagents were moved out to
/// their own files and that marker now finds nothing.
fn subagent_transcripts(transcript: &std::path::Path) -> Vec<std::path::PathBuf> {
    let dir = match (transcript.parent(), transcript.file_stem()) {
        (Some(parent), Some(stem)) => parent.join(stem).join("subagents"),
        _ => return Vec::new(),
    };
    // A session that delegated nothing has no such directory, which is ordinary
    // rather than an error.
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    out.sort();
    out
}

/// `None` means the reading is unavailable — no transcript, or one that would
/// not open. That is not the same as a session which has spent nothing, and
/// reporting four zeroes for a file we never opened made a lost transcript look
/// like an idle session. Transcripts do go missing under a running app: they are
/// rotated, and entering a worktree moves them.
///
/// A session that is present but has yet to make a request reports
/// `context: None` with a zero `spend` — genuinely zero, and distinguishable.
#[tauri::command(async)]
pub fn session_tokens(session_id: String) -> Option<SessionTokens> {
    let path = find_transcript(&session_id)?;
    let main = std::fs::read_to_string(&path).ok()?;
    let mut seen = std::collections::HashSet::new();
    let mut spend = TokenUsage::default();
    fold_usage_lines(&main, &mut seen, &mut spend);
    let mut subagents = 0;
    for sub in subagent_transcripts(&path) {
        // One unreadable subagent understates the bill; it should not discard
        // the main chain's figure along with it.
        if let Ok(content) = std::fs::read_to_string(&sub) {
            fold_usage_lines(&content, &mut seen, &mut spend);
            subagents += 1;
        }
    }
    Some(SessionTokens { context: last_context(&main), spend, subagents })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_env_carries_tracker_paths_when_configured() {
        let root = std::path::PathBuf::from("/home/u/vault/Tasks");
        let env = session_env(Some(&root), "cowork-deck", "/opt/cowork_task", "sess-9", None, None, None);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("COWORK_TASKS_DIR"), Some("/home/u/vault/Tasks"));
        assert_eq!(get("COWORK_PROJECT"), Some("cowork-deck"));
        assert_eq!(get("COWORK_TASK_BIN"), Some("/opt/cowork_task"));
        assert_eq!(get("COWORK_SESSION"), Some("sess-9"));
    }

    #[test]
    fn session_env_omits_tracker_vars_when_not_configured() {
        // Otherwise the agent would see an empty path and start guessing.
        let env = session_env(None, "cowork-deck", "/opt/cowork_task", "sess-9", None, None, None);
        assert!(env.iter().all(|(n, _)| n != "COWORK_TASKS_DIR"));
        assert!(env.iter().all(|(n, _)| n != "COWORK_TASK_BIN"));
    }

    #[test]
    fn a_session_launched_from_a_card_carries_its_id() {
        let root = std::path::PathBuf::from("/home/u/vault/Tasks");
        let env = session_env(
            Some(&root), "cowork-deck", "/opt/cowork_task", "sess-9", Some("01K1CARD"), None, None,
        );
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("COWORK_TASK_ID"), Some("01K1CARD"));
    }

    #[test]
    fn a_session_launched_without_a_card_carries_no_card_id() {
        // The guard reads its absence as "nothing to demand" and allows.
        let root = std::path::PathBuf::from("/home/u/vault/Tasks");
        let env = session_env(Some(&root), "cowork-deck", "/opt/cowork_task", "sess-9", None, None, None);
        assert!(env.iter().all(|(n, _)| n != "COWORK_TASK_ID"));
    }

    fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// A failed `gh` always says something.
    ///
    /// The empty case needs no unusual conditions — `gh` killed by a signal, or a
    /// future `gh` that reports to stdout — and it used to return `Err("")`,
    /// which the board turns into `TaskError::Remote("")`, "GitHub: ", and an
    /// error paragraph containing no words at all above a list nothing said was
    /// stale. Nothing downstream can rescue it, because there is no phrase to
    /// match; the exit status is the one fact that always exists.
    #[test]
    fn a_failed_gh_always_says_something() {
        for (code, stderr) in [
            (Some(1), ""),
            (Some(4), ""),
            (Some(128), ""),
            // Whitespace only: `trim` empties it, which is the same hole.
            (Some(1), " \n "),
            // No code at all — killed by a signal, and the case that has no
            // number to fall back on either.
            (None, ""),
            (None, "\n"),
        ] {
            let msg = gh_failure(code, stderr);
            assert!(!msg.trim().is_empty(), "{code:?} with {stderr:?} said nothing");
            // And it says what happened, not merely *something*: the code is the
            // only fact left, so it has to be in there when there is one.
            if let Some(c) = code {
                assert!(msg.contains(&c.to_string()), "{msg}");
            }
        }
    }

    /// stderr survives verbatim, because that is what the frontend matches on:
    /// `unavailableFrom` (`src/issues.ts:124`) uses `includes`, which survives an
    /// added prefix or suffix but not a replaced body.
    #[test]
    fn stderr_is_kept_verbatim_so_the_frontends_markers_still_match() {
        for said in [
            "gh: no git remotes found",
            "fatal: not a git repository (or any of the parent directories): .git",
            "none of the git remotes configured for this repository point to a known GitHub host",
            "API rate limit exceeded for user ID 1234",
        ] {
            assert!(gh_failure(Some(1), said).contains(said), "{said}");
        }
    }

    /// Exit 4 is `gh`'s own "authentication required", and it is the signal
    /// `src/issues.ts` wanted and could not have while the status was dropped
    /// here. The marker is appended, never substituted, so a stderr that names
    /// something the table also knows is still readable.
    #[test]
    fn exit_four_is_reported_as_the_no_account_state() {
        let msg = gh_failure(Some(4), "gh: To get started with GitHub CLI, please run: gh auth login");
        assert!(msg.contains("no-account"), "{msg}");
        assert!(msg.contains("gh auth login"), "the cause is still in it: {msg}");
        // And only exit 4: every other status stays an ordinary error, which
        // keeps the last good list on screen beside it.
        for code in [Some(1), Some(2), Some(3), Some(128), None] {
            let msg = gh_failure(code, "something else went wrong");
            assert!(!msg.contains("no-account"), "{code:?} claimed an auth failure: {msg}");
        }
    }

    /// The constraint the whole function exists inside: nothing from `gh` leaves
    /// the backend unredacted, and there is exactly one place that can forget.
    #[test]
    fn a_token_echoed_back_by_gh_is_redacted_on_every_branch() {
        assert!(!gh_failure(Some(1), "bad credentials: gho_secretvalue").contains("gho_secret"));
        assert!(!gh_failure(Some(4), "token ghp_secretvalue rejected").contains("ghp_secret"));
    }

    /// The leak test, written as an assertion about what is *missing*, because
    /// that is the failure mode. With no `COWORK_TASK_BIN` the agent has no path
    /// to the sidecar; with no `COWORK_TASKS_DIR` every subcommand fails loudly
    /// at `run()`'s env check for anyone who finds it anyway.
    #[test]
    fn a_github_session_is_told_nothing_about_files_or_the_sidecar() {
        let env = session_env(
            None, "cowork-deck", "/opt/cowork_task", "sess-1", None,
            Some("followLemmi/cowork-deck"), None,
        );
        for k in ["COWORK_TASKS_DIR", "COWORK_PROJECT", "COWORK_TASK_BIN"] {
            assert!(value(&env, k).is_none(), "{k} must not be set for a github workspace");
        }
        assert_eq!(value(&env, "COWORK_ISSUE_REPO"), Some("followLemmi/cowork-deck"));
        assert!(value(&env, "COWORK_ISSUE_NUMBER").is_none(), "no issue on a plain launch");
        // And no value anywhere names a folder of ours.
        assert!(
            !env.iter().any(|(_, v)| v.contains("cowork-deck-tasks") || v.contains("board.json")),
            "{env:?}",
        );
    }

    /// The analogue of `COWORK_TASK_ID`, set only on the launch-from-an-issue
    /// path — which is the same path, since for a GitHub workspace a card id *is*
    /// the issue number.
    #[test]
    fn an_issue_launch_names_the_issue() {
        let env = session_env(
            None, "cowork-deck", "/opt/cowork_task", "sess-1", Some("42"),
            Some("followLemmi/cowork-deck"), Some("42"),
        );
        assert_eq!(value(&env, "COWORK_ISSUE_NUMBER"), Some("42"));
        // Still pushed, for the reason its own comment gives: the hooks that key
        // off it need to know a card is linked. Inert here — `guard` dispatches
        // on COWORK_ISSUE_REPO before it ever reads this — and consistent, which
        // is what the assertion pins.
        assert_eq!(value(&env, "COWORK_TASK_ID"), Some("42"));
    }

    /// The file workspace's environment is unchanged, in both directions: this
    /// is the test that would fail if the new branch were reached by mistake.
    #[test]
    fn a_file_session_is_told_nothing_about_github() {
        let env = session_env(
            Some(std::path::Path::new("/home/u/vault/cowork-deck-tasks/deck")),
            "deck", "/opt/cowork_task", "sess-1", Some("01ABC"), None, None,
        );
        assert_eq!(value(&env, "COWORK_TASKS_DIR"), Some("/home/u/vault/cowork-deck-tasks/deck"));
        assert_eq!(value(&env, "COWORK_PROJECT"), Some("deck"));
        assert_eq!(value(&env, "COWORK_TASK_BIN"), Some("/opt/cowork_task"));
        for k in ["COWORK_ISSUE_REPO", "COWORK_ISSUE_NUMBER"] {
            assert!(value(&env, k).is_none(), "{k} must not be set for a file workspace");
        }
    }

    /// Neither set of arguments gets both. A contradictory environment is the
    /// state that should never occur, and this pins the half of that which
    /// `session_env` decides: given a root and no repository, or a repository and
    /// no root, the two variable groups do not leak into each other. Whether a
    /// real caller can ever pass both is not visible from here — the arguments
    /// are seven hand-written values, not a workspace.
    #[test]
    fn the_two_tracker_environments_are_never_both_present() {
        let file = session_env(
            Some(std::path::Path::new("/r")), "deck", "/b", "s", None, None, None,
        );
        let gh = session_env(None, "deck", "/b", "s", None, Some("o/n"), None);
        assert!(value(&file, "COWORK_ISSUE_REPO").is_none());
        assert!(value(&gh, "COWORK_TASKS_DIR").is_none());
    }

    /// The workspace: `/home/u/projects/cowork-deck`, its two sibling worktree
    /// directories `…-issue/` and `…-pr/`. The first block is the workspace's own
    /// working copy, because that is where `git worktree list --porcelain` puts
    /// it, and `feature/x` is checked out there — a developer pushed the branch
    /// from the workspace and opened a pull request, which is the ordinary case.
    const WS: &str = "/home/u/projects/cowork-deck";
    const REUSE_PORCELAIN: &str = "worktree /home/u/projects/cowork-deck\n\
HEAD aaaa\n\
branch refs/heads/feature/x\n\
\n\
worktree /home/u/projects/cowork-deck-issue/42-sidebar\n\
HEAD bbbb\n\
branch refs/heads/issue-42-sidebar\n\
\n\
worktree /home/u/projects/cowork-deck-pr/9-old\n\
HEAD cccc\n\
branch refs/heads/pr-9\n\
\n\
worktree /home/u/scratch/wip\n\
HEAD dddd\n\
branch refs/heads/feature/y\n";

    /// Clicking ▶ on that pull request must not open a session in the workspace
    /// root, alongside every other live session there. That is the precise harm
    /// `pr_worktree_add` refuses `gh pr checkout` to avoid, and reuse walked
    /// straight into it.
    #[test]
    fn the_workspaces_own_working_copy_is_never_reused() {
        // The pure function is right, and stays right: that worktree really is
        // on the branch. The judgement belongs to the caller.
        assert_eq!(
            crate::gh_pr::worktree_on_branch(REUSE_PORCELAIN, "feature/x"),
            Some(WS.into()),
        );
        assert_eq!(reusable_worktree(REUSE_PORCELAIN, "feature/x", WS, 11), None);
    }

    /// Reuse exists for one situation: the worktree our own issue flow made on
    /// the issue's branch. A directory somebody created by hand is on the right
    /// branch and nothing else — the tile would call it "reused" and describe
    /// work it knows nothing about.
    #[test]
    fn only_a_worktree_this_app_created_is_reused() {
        assert_eq!(
            reusable_worktree(REUSE_PORCELAIN, "issue-42-sidebar", WS, 11),
            Some("/home/u/projects/cowork-deck-issue/42-sidebar".into()),
        );
        assert_eq!(
            reusable_worktree(REUSE_PORCELAIN, "pr-9", WS, 11),
            Some("/home/u/projects/cowork-deck-pr/9-old".into()),
        );
        assert_eq!(
            reusable_worktree(REUSE_PORCELAIN, "feature/y", WS, 11),
            None,
            "/home/u/scratch/wip is on the branch and is not ours",
        );
    }

    #[test]
    fn a_branch_with_no_worktree_at_all_is_not_reused() {
        assert_eq!(reusable_worktree(REUSE_PORCELAIN, "feature/none", WS, 11), None);
    }

    /// `reusable_worktree` compares parent directories and throws the leaves
    /// away, which is what lets it build its two candidates from the functions
    /// that create those directories instead of spelling `-pr` and `-issue` a
    /// third time. It is sound only while the leaf is the only part the
    /// title-or-branch argument decides. Nest either builder one level deeper and
    /// the comparison silently changes meaning — reuse stops working, or starts
    /// matching a directory it should not — with nothing to fail. These two fail.
    ///
    /// `assert_ne` on the whole path is half the invariant: the parents must
    /// agree *because* the argument reaches no further than the leaf, not because
    /// the builder ignores it.
    #[test]
    fn a_pull_request_worktrees_parent_does_not_depend_on_the_branch() {
        let one = crate::gh_pr::worktree_path(WS, 11, "one");
        let other = crate::gh_pr::worktree_path(WS, 11, "another");
        assert_eq!(one.parent().expect("a parent"), other.parent().expect("a parent"));
        assert_ne!(one, other, "the branch still reaches the leaf");
    }

    #[test]
    fn an_issue_worktrees_parent_does_not_depend_on_the_title() {
        use cowork_deck::tasks::gh_issues::issue_worktree_path;
        let one = issue_worktree_path(WS, 11, "one");
        let other = issue_worktree_path(WS, 11, "another");
        assert_eq!(one.parent().expect("a parent"), other.parent().expect("a parent"));
        assert_ne!(one, other, "the title still reaches the leaf");
    }

    /// A turn as a transcript actually writes it: one line per content block,
    /// each repeating the same `message.usage`. The old fixture had two lines
    /// with no `message.id` and no repeats — a shape that does not occur — which
    /// is why it went on passing while every figure in the app was 2-3x high.
    /// `fold_usage_lines` over a single transcript. Production reads a session's
    /// own file and its subagents into one accumulator, so this shape exists only
    /// to let the tests below state one transcript's total.
    fn sum_usage_lines(content: &str) -> TokenUsage {
        let mut acc = TokenUsage::default();
        fold_usage_lines(content, &mut std::collections::HashSet::new(), &mut acc);
        acc
    }

    fn turn(id: &str, input: u64, output: u64, cc: u64, cr: u64, blocks: &[&str]) -> String {
        blocks
            .iter()
            .map(|b| {
                format!(
                    r#"{{"type":"assistant","message":{{"id":"{id}","content":[{{"type":"{b}"}}],"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_creation_input_tokens":{cc},"cache_read_input_tokens":{cr}}}}}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn sum_usage_lines_counts_a_turn_once_however_many_blocks_it_wrote() {
        let content = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#.to_string(),
            turn("msg_a", 10, 5, 100, 200, &["thinking", "text", "tool_use", "tool_use"]),
            "not json at all".to_string(),
            turn("msg_b", 3, 7, 0, 50, &["thinking", "tool_use"]),
        ]
        .join("\n");

        let u = sum_usage_lines(&content);
        assert_eq!(u.input, 13, "two requests, not six lines");
        assert_eq!(u.output, 12);
        assert_eq!(u.cache_creation, 100);
        assert_eq!(u.cache_read, 250);
    }

    #[test]
    fn a_line_without_a_message_id_is_counted_rather_than_dropped() {
        let content = concat!(
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#, "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":3,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#, "\n",
        );
        let u = sum_usage_lines(content);
        assert_eq!(u.input, 13, "an unfamiliar shape is not silently discarded");
        assert_eq!(u.output, 12);
    }

    #[test]
    fn one_shared_seen_set_dedupes_across_transcripts() {
        // Subagents fold into the same accumulator as the main chain. Were an id
        // to appear in both, it must still be billed once.
        let mut seen = std::collections::HashSet::new();
        let mut acc = TokenUsage::default();
        fold_usage_lines(&turn("msg_a", 1, 2, 3, 4, &["text"]), &mut seen, &mut acc);
        fold_usage_lines(&turn("msg_a", 1, 2, 3, 4, &["text"]), &mut seen, &mut acc);
        fold_usage_lines(&turn("msg_b", 1, 2, 3, 4, &["text"]), &mut seen, &mut acc);
        assert_eq!(acc.output, 4, "two distinct requests");
    }

    #[test]
    fn sum_usage_lines_empty_is_zero() {
        assert_eq!(sum_usage_lines(""), TokenUsage::default());
    }

    /// The exact arithmetic behind a terminal reading of 83 682, from the last
    /// request of a real session. The `output` term is the one a reimplementation
    /// tends to drop.
    #[test]
    fn last_context_is_the_prompt_sent_plus_the_response_returned() {
        let content = [
            turn("msg_earlier", 1, 998, 691, 80_333, &["thinking", "text"]),
            turn("msg_last", 2, 1535, 124, 82_021, &["thinking", "tool_use", "tool_use"]),
        ]
        .join("\n");
        assert_eq!(last_context(&content), Some(83_682));
    }

    /// The layout the app has to walk: a session's own file, and its subagents
    /// in a directory named after it rather than beside it.
    #[test]
    fn subagent_transcripts_are_found_in_the_directory_named_after_the_session() {
        let root = tempfile::tempdir().unwrap();
        let slug = root.path().join("-Users-someone-project");
        let subs = slug.join("55dde7d8").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let transcript = slug.join("55dde7d8.jsonl");
        std::fs::write(&transcript, "").unwrap();
        std::fs::write(subs.join("agent-bbb.jsonl"), "").unwrap();
        std::fs::write(subs.join("agent-aaa.jsonl"), "").unwrap();
        // Not a transcript; the app should not try to parse it.
        std::fs::write(subs.join("notes.txt"), "").unwrap();

        let found = subagent_transcripts(&transcript);
        let names: Vec<String> =
            found.iter().map(|p| p.file_name().unwrap().to_string_lossy().into()).collect();
        assert_eq!(names, ["agent-aaa.jsonl", "agent-bbb.jsonl"], "sorted, .jsonl only");
    }

    #[test]
    fn a_session_that_delegated_nothing_has_no_subagents_directory_and_that_is_fine() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("55dde7d8.jsonl");
        std::fs::write(&transcript, "").unwrap();
        assert!(subagent_transcripts(&transcript).is_empty());
    }

    #[test]
    fn last_context_is_absent_before_the_first_request() {
        assert_eq!(last_context(""), None);
        assert_eq!(
            last_context(r#"{"type":"user","message":{"role":"user","content":"hi"}}"#),
            None,
            "a session that has yet to ask anything has no window to report",
        );
    }

    #[test]
    fn builds_claude_args_first_launch_with_session_id_and_prompt() {
        let args = build_claude_args("{\"hooks\":{}}", &Some("collect email report".into()), "sess-1", false);
        assert_eq!(args, vec![
            "--settings".to_string(), "{\"hooks\":{}}".to_string(),
            "--session-id".to_string(), "sess-1".to_string(),
            "collect email report".to_string(),
        ]);
    }

    #[test]
    fn builds_claude_args_first_launch_without_prompt() {
        let args = build_claude_args("{}", &None, "sess-1", false);
        assert_eq!(args, vec![
            "--settings".to_string(), "{}".to_string(),
            "--session-id".to_string(), "sess-1".to_string(),
        ]);
    }

    #[test]
    fn builds_claude_args_resume_uses_resume_flag_and_ignores_prompt() {
        let args = build_claude_args("{}", &Some("ignored".into()), "sess-1", true);
        assert_eq!(args, vec![
            "--settings".to_string(), "{}".to_string(),
            "--resume".to_string(), "sess-1".to_string(),
        ]);
    }

    #[test]
    fn git_status_reports_branch_and_dirty() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("cowork-git-{}-{:?}", std::process::id(), std::time::SystemTime::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();
        let run = |args: &[&str]| { Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap(); };
        run(&["init"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "init"]);

        let clean = git_status(cwd.to_string());
        assert!(clean.branch.is_some(), "committed repo must report a branch");
        assert!(!clean.dirty, "just-committed repo is clean");

        std::fs::write(dir.join("b.txt"), "new").unwrap(); // untracked → dirty
        let dirty = git_status(cwd.to_string());
        assert!(dirty.dirty, "untracked file makes it dirty");

        let non_repo = git_status(std::env::temp_dir().to_str().unwrap().to_string());
        // temp_dir itself is not a repo (usually); branch None. Tolerate either but dirty must be false when branch is None.
        if non_repo.branch.is_none() { assert!(!non_repo.dirty); }
    }

    #[test]
    fn linux_distro_id_is_taken_from_os_release() {
        let sample = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n";
        assert_eq!(parse_os_release_id(sample).as_deref(), Some("ubuntu"));
        assert_eq!(parse_os_release_id("ID=fedora\n").as_deref(), Some("fedora"));
        assert_eq!(parse_os_release_id("ID=\"opensuse-tumbleweed\"\n").as_deref(), Some("opensuse-tumbleweed"));
        assert_eq!(parse_os_release_id("NAME=\"Weird\"\n"), None);
        assert_eq!(parse_os_release_id(""), None);
        // ID_LIKE не должен побеждать: strip_prefix("ID=") его не матчит.
        assert_eq!(parse_os_release_id("ID_LIKE=debian\nID=pop\n").as_deref(), Some("pop"));
    }

    /// The argv is what decides which account and which repository answer, so
    /// it is worth pinning even though the call itself needs the network.
    #[test]
    fn pr_list_argv_asks_for_open_prs_with_every_field() {
        let argv = pr_list_argv("o/n", 50);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "list");
        assert!(argv.contains(&"--state".to_string()));
        assert!(argv.contains(&"open".to_string()));
        assert!(argv.contains(&"--limit".to_string()));
        assert!(argv.contains(&"50".to_string()));
        let json_at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[json_at + 1], crate::gh_pr::PR_LIST_FIELDS);
    }

    /// Explicit rather than resolved from `cwd`. This feature creates worktrees
    /// whose `origin` is related to but not identical with the workspace's, so a
    /// command that resolves its repository from wherever it happens to be
    /// standing is a command waiting to act on the wrong one.
    #[test]
    fn the_pr_list_call_names_its_repository() {
        let argv = pr_list_argv("o/n", PR_PAGE_LIMIT);
        let at = argv.iter().position(|a| a == "-R").expect("-R");
        assert_eq!(argv[at + 1], "o/n");
    }

    /// `view <n>`, not `list -S <n>`: `-S` is a relevance-ranked full-text search
    /// capped at `gh`'s own default, so on a busy repository the pull request
    /// asked for is simply not in the answer — the same mistake an early draft of
    /// `GhIssueProvider::resolve` made and records.
    #[test]
    fn the_pr_detail_call_names_its_number_its_fields_and_its_repository() {
        let argv = pr_detail_argv("o/n", 7);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "view");
        assert_eq!(argv[2], "7");
        let json_at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[json_at + 1], crate::gh_pr::PR_DETAIL_FIELDS);
        let repo_at = argv.iter().position(|a| a == "-R").expect("-R");
        assert_eq!(argv[repo_at + 1], "o/n");
        assert!(!argv.contains(&"-S".to_string()), "-S is a search, not a lookup");
    }

    /// The files endpoint, its page and its size all on the URL. `gh api` takes
    /// no `-R`, so the repository being in the path is the same "never resolve
    /// from `cwd`" discipline the other two argv builders state.
    #[test]
    fn the_diff_call_names_its_repository_its_number_and_its_page() {
        let argv = pr_files_argv("o/n", 151, PR_DIFF_PER_PAGE, 2);
        assert_eq!(argv[0], "api");
        assert_eq!(argv[1], "repos/o/n/pulls/151/files?per_page=100&page=2");
    }

    /// `--paginate` would fetch every file of a 900-file pull request, patches
    /// and all, before `PR_DIFF_FILE_LIMIT` got a chance to stop it. The cap is
    /// only a cap if the paging is ours.
    #[test]
    fn the_diff_call_pages_itself_rather_than_letting_gh_do_it() {
        let argv = pr_files_argv("o/n", 151, PR_DIFF_PER_PAGE, 1);
        assert!(!argv.iter().any(|a| a == "--paginate"), "paging must stay under our cap");
        assert!(PR_DIFF_FILE_LIMIT.is_multiple_of(PR_DIFF_PER_PAGE), "the cap must land on a page");
    }

    /// The count query is only reached when the file pages ran out at the cap,
    /// so it must ask for the count and nothing else — a `files` field here
    /// would refetch the payload the cap exists to bound.
    #[test]
    fn the_changed_files_query_moves_one_integer_and_names_its_pull_request() {
        let argv = pr_changed_files_argv("o/n", 151);
        assert_eq!(argv[0], "api");
        assert_eq!(argv[1], "graphql");
        assert!(argv.contains(&"owner=o".to_string()));
        assert!(argv.contains(&"name=n".to_string()));
        assert!(argv.contains(&"number=151".to_string()));
        let q = argv.last().expect("query");
        assert!(q.contains("changedFiles"));
        assert!(!q.contains("files(") && !q.contains("patch"), "the payload stays out of it");
    }

    /// --match-head-commit is the whole safety story of this button: without it
    /// the merge takes whatever is at the head now, not what was on screen.
    #[test]
    fn merge_argv_pins_the_head_commit() {
        let argv = pr_merge_argv(7, "squash", "abc123", false);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "merge");
        assert_eq!(argv[2], "7");
        assert!(argv.contains(&"--squash".to_string()));
        let at = argv.iter().position(|a| a == "--match-head-commit").expect("pin");
        assert_eq!(argv[at + 1], "abc123");
        assert!(!argv.contains(&"--delete-branch".to_string()));
    }

    #[test]
    fn merge_argv_maps_every_strategy_and_can_delete_the_branch() {
        assert!(pr_merge_argv(1, "merge", "a", true).contains(&"--merge".to_string()));
        assert!(pr_merge_argv(1, "rebase", "a", true).contains(&"--rebase".to_string()));
        assert!(pr_merge_argv(1, "merge", "a", true).contains(&"--delete-branch".to_string()));
    }

    /// An unknown strategy must not silently become a merge commit.
    #[test]
    fn an_unknown_strategy_is_rejected() {
        assert!(merge_strategy_flag("cherry-pick").is_none());
    }

    #[test]
    fn no_binding_means_no_env_and_no_badge() {
        let outcome = resolve_session_auth(None, "/tmp/noauth", std::time::Duration::from_secs(5));
        assert!(outcome.env.is_empty());
        assert_eq!(outcome.auth.account, None);
        assert_eq!(outcome.auth.degraded, None);
    }

    #[test]
    fn binding_to_an_unknown_account_degrades_but_keeps_identity() {
        let cfg = WorkspaceGithub {
            host: "github.com".into(),
            login: "definitely-not-a-real-account-xyz".into(),
            git_name: Some("Evgeny".into()),
            git_email: None,
            ssh_key: None,
        };
        let outcome =
            resolve_session_auth(Some(&cfg), "/tmp/noauth", std::time::Duration::from_secs(5));
        assert_eq!(outcome.auth.account.as_deref(), Some("definitely-not-a-real-account-xyz"));
        assert!(outcome.auth.degraded.is_some(), "должна быть причина деградации");
        let keys: Vec<&str> = outcome.env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"GH_CONFIG_DIR"), "деградация обязана увести gh в пустой конфиг");
        assert!(keys.contains(&"GIT_AUTHOR_NAME"), "идентичность известна и без токена");
        assert!(!keys.contains(&"GH_TOKEN"), "без токена GH_TOKEN выставлять нельзя");
    }

    #[test]
    fn a_dirty_worktree_is_never_removed() {
        let dir = std::env::temp_dir().join(format!("cowork-wt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // Not a git repository at all: `git status` fails, which must read as
        // "refuse", never as "clean, go ahead and delete".
        let verdict = worktree_is_clean(&dir);
        // Removed before the assertion so a failure cannot leak the directory.
        let _ = std::fs::remove_dir_all(&dir);
        assert!(verdict.is_err());
    }

    /// `gh api --include` prints the response headers, a blank line, then the
    /// body. The remaining budget is read from the headers and the body is
    /// handed on untouched — a parser that fed the whole thing to serde would
    /// report a perfectly good response as unreadable JSON.
    #[test]
    fn headers_and_body_are_split_and_the_budget_is_read() {
        let out = "HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n\
                   X-Ratelimit-Remaining: 4873\r\n\r\n{\"data\":{}}";
        let (remaining, body) = split_gh_response(out);
        assert_eq!(remaining, Some(4873));
        assert_eq!(body.trim(), "{\"data\":{}}");
    }

    /// Header names are case-insensitive on the wire and gh does not normalise
    /// them; a match on one exact spelling would read as "no signal" forever.
    #[test]
    fn the_budget_header_is_matched_case_insensitively() {
        let (remaining, _) = split_gh_response("x-ratelimit-remaining: 12\n\n{}");
        assert_eq!(remaining, Some(12));
    }

    /// No headers at all — an older gh, or a call made without `--include`. The
    /// body must survive and the signal must simply be absent, never zero: zero
    /// means "exhausted" and would raise the banner on every tick.
    #[test]
    fn a_response_without_headers_keeps_its_body_and_reports_no_budget() {
        let (remaining, body) = split_gh_response("{\"data\":{}}");
        assert_eq!(remaining, None);
        assert_eq!(body, "{\"data\":{}}");
    }

    /// The base is the repository's default branch, never the workspace's
    /// current HEAD: the person may be sitting on a feature branch, and an issue
    /// branch based on it would silently inherit unrelated work.
    #[test]
    fn a_new_issue_worktree_branches_off_the_remote_default() {
        let argv = worktree_add_argv("/tmp/x-issue/42-t", "issue-42-t", Some("main"));
        assert_eq!(&argv[0..2], &["worktree".to_string(), "add".to_string()]);
        let at = argv.iter().position(|a| a == "-b").expect("-b");
        assert_eq!(argv[at + 1], "issue-42-t");
        assert_eq!(argv.last().unwrap(), "origin/main");
    }

    /// If the branch exists but the directory does not — a manual `rm -rf` — a
    /// worktree is attached to the existing branch rather than created, or the
    /// second launch dies where the first succeeded.
    #[test]
    fn an_existing_branch_is_attached_rather_than_recreated() {
        let argv = worktree_add_argv("/tmp/x-issue/42-t", "issue-42-t", None);
        assert!(!argv.iter().any(|a| a == "-b"), "an existing branch is not created again");
        assert_eq!(argv.last().unwrap(), "issue-42-t");
    }

    #[test]
    fn the_totals_call_asks_for_headers() {
        let argv = issue_totals_argv_with_headers("o/n");
        assert!(argv.iter().any(|a| a == "--include"), "the budget comes from the headers");
        assert!(argv.iter().any(|a| a.starts_with("query=")));
    }

    /// Which commands are allowed to run on the thread that paints the window.
    ///
    /// Not a style list — a list of things fast enough that arrival order is worth
    /// more than the microseconds, plus the four session commands where arrival
    /// order *is* the feature. The reasoning is at the top of this file.
    /// `session_tokens` used to sit here as "one file read". It now opens a
    /// session's transcript *and* every subagent transcript beside it — fifty of
    /// them on a delegation-heavy session — so it carries `(async)` like
    /// everything else that does real I/O.
    const MAIN_THREAD_COMMANDS: [&str; 13] = [
        "list_workspaces",
        "save_workspace",
        "remove_workspace",
        "list_skills",
        "save_skill",
        "remove_skill",
        "load_schedule_state",
        "schedule_ack",
        "scheduler_ready",
        "load_layout",
        "save_layout",
        "load_ui_state",
        "save_ui_state",
    ];
    /// The same, for the four that must not be reordered — kept apart from the list
    /// above because these are the ones where moving a command off the main thread
    /// would be a *correctness* bug rather than merely unnecessary.
    const ORDERED_COMMANDS: [&str; 6] = [
        "start_session",
        "start_command_session",
        "write_session",
        "resize_session",
        "close_session",
        "host_platform",
    ];

    /// A synchronous `#[tauri::command]` runs on the main thread, and on Linux that
    /// is the thread painting the WebView — so one that shells out freezes the
    /// window for as long as it takes. Every such command carries `(async)`; this is
    /// what makes "every" true rather than aspirational, because the failure is
    /// invisible in a unit test and looks like a frontend problem in the app.
    ///
    /// Written as an allow-list rather than a scan for `Command::new`: the blocking
    /// call is usually three helpers deep, and a check that followed it there would
    /// pass the moment somebody added a fourth. Adding a command now forces a
    /// decision — carry the attribute, or say here why it need not.
    #[test]
    fn every_command_that_can_block_runs_off_the_main_thread() {
        let files = [
            include_str!("commands.rs"),
            include_str!("tasks_cmd.rs"),
        ];
        let mut on_main = Vec::new();
        for src in files {
            for (i, line) in src.lines().enumerate() {
                if line.trim() != "#[tauri::command]" {
                    continue;
                }
                // The declaration is the next line; `pub fn name(`.
                let next = src.lines().nth(i + 1).unwrap_or("");
                let name = next
                    .trim()
                    .strip_prefix("pub fn ")
                    .and_then(|r| r.split('(').next())
                    .unwrap_or(next.trim());
                on_main.push(name.to_string());
            }
        }
        let allowed: Vec<&str> =
            MAIN_THREAD_COMMANDS.iter().chain(ORDERED_COMMANDS.iter()).copied().collect();
        let unexpected: Vec<&String> =
            on_main.iter().filter(|n| !allowed.contains(&n.as_str())).collect();
        assert!(
            unexpected.is_empty(),
            "these commands are synchronous, so they run on the thread that paints the \
             window: {unexpected:?}. Either add `(async)` — see the note at the top of \
             commands.rs — or add the name to MAIN_THREAD_COMMANDS with a reason.",
        );
        // The other direction: an allow-list nothing matches has stopped guarding
        // anything, which is how a rename turns this test green and useless.
        for name in allowed {
            assert!(
                on_main.iter().any(|n| n == name),
                "{name} is on the main-thread allow-list but is no longer a synchronous \
                 command — was it renamed, removed, or given `(async)`?",
            );
        }
    }
}
