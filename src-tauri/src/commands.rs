use crate::gh;
use crate::hooks::build_settings_json;
use crate::model::{GitStatus, SessionEntry, Skill, TokenUsage, UiState, Workspace, WorkspaceGithub};
use crate::pty::PtyManager;
use crate::store::Store;
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

#[tauri::command]
pub fn gh_status() -> gh::GhStatus {
    gh::status()
}

#[tauri::command]
pub fn claude_available() -> bool {
    which_claude().is_some()
}

fn which_claude() -> Option<String> {
    // Respect an explicit override, else rely on PATH resolution by the OS.
    if let Ok(p) = std::env::var("COWORK_CLAUDE_PATH") {
        if !p.is_empty() { return Some(p); }
    }
    let candidate = if cfg!(windows) { "claude.cmd" } else { "claude" };
    // Probe by attempting a version call.
    match std::process::Command::new(candidate).arg("--version").output() {
        Ok(o) if o.status.success() => Some(candidate.to_string()),
        _ => {
            // Fallback to bare "claude" on Windows too.
            match std::process::Command::new("claude").arg("--version").output() {
                Ok(o) if o.status.success() => Some("claude".to_string()),
                _ => None,
            }
        }
    }
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

pub fn pr_list_argv(limit: usize) -> Vec<String> {
    vec![
        "pr".into(),
        "list".into(),
        "--state".into(),
        "open".into(),
        "--limit".into(),
        limit.to_string(),
        "--json".into(),
        crate::gh_pr::PR_LIST_FIELDS.into(),
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
    let path = gh::which_gh().ok_or_else(|| "gh-not-found".to_string())?;
    let token = workspace_token(state, &cfg);

    let dir = noauth_dir(state);
    let env = gh::session_env(&cfg, token.as_deref(), &dir.to_string_lossy());

    Ok(GhInvocation { path, cwd: ws.path.clone(), env })
}

/// Run `gh` in the workspace's folder, under the workspace's account.
///
/// Every path out of here is redacted: `gh` is capable of echoing a token back
/// in an error, and this is the only place that decides what the frontend sees.
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
    if !out.status.success() {
        return Err(gh::redact(String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `run_gh_for_workspace` with a body on stdin.
///
/// `Command::output()` sets stdin to null, so the existing runner cannot feed
/// one — and `gh issue create` prompts interactively for a missing body, which
/// in a child process is a hang waiting for the one case that reaches it. Same
/// account resolution, same `cwd`, same redaction, same
/// check-the-exit-code-before-parsing rule; the only difference is the pipe.
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
    if !out.status.success() {
        return Err(gh::redact(String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
#[tauri::command]
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

#[tauri::command]
pub fn pr_list(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Vec<crate::gh_pr::PullRequest>, String> {
    let json = run_gh_for_workspace(&state, &workspace_id, &pr_list_argv(PR_PAGE_LIMIT))?;
    crate::gh_pr::parse_pull_requests(&json)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn pr_close(state: State<AppState>, workspace_id: String, number: u64) -> Result<(), String> {
    let args: Vec<String> = vec!["pr".into(), "close".into(), number.to_string()];
    run_gh_for_workspace(&state, &workspace_id, &args).map(|_| ())
}

#[tauri::command]
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
#[tauri::command]
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

#[tauri::command]
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
                if let Some(found) = crate::gh_pr::worktree_on_branch(&listed, &branch) {
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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
    let program = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
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
pub fn save_ui_state(state: State<AppState>, ui: UiState) -> Result<(), String> {
    state.store.lock().unwrap().save_ui_state(&ui).map_err(|e| e.to_string())
}

/// Called by main during setup to emit state changes coming from the listener.
pub fn emit_state(app: &AppHandle, session: String, state: crate::model::SessionState) {
    let _ = app.emit("session://state", StatePayload { session, state });
}

#[tauri::command]
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

/// Sum `message.usage.*` token counts across all JSONL lines. Tolerant of
/// non-JSON lines and lines without usage (user messages, meta).
pub fn sum_usage_lines(content: &str) -> TokenUsage {
    let mut u = TokenUsage::default();
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let usage = &v["message"]["usage"];
        if usage.is_object() {
            u.input += usage["input_tokens"].as_u64().unwrap_or(0);
            u.output += usage["output_tokens"].as_u64().unwrap_or(0);
            u.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            u.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        }
    }
    u
}

/// Locate the transcript file `<session_id>.jsonl` under any project dir.
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

#[tauri::command]
pub fn session_tokens(session_id: String) -> TokenUsage {
    match find_transcript(&session_id) {
        Some(path) => std::fs::read_to_string(path)
            .map(|c| sum_usage_lines(&c))
            .unwrap_or_default(),
        None => TokenUsage::default(),
    }
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

    /// Neither workspace kind gets both. A contradictory environment is the state
    /// that should never occur, and the two branches are exclusive by
    /// construction — `root` is `None` exactly when the tracker is GitHub.
    #[test]
    fn the_two_tracker_environments_are_never_both_present() {
        let file = session_env(
            Some(std::path::Path::new("/r")), "deck", "/b", "s", None, None, None,
        );
        let gh = session_env(None, "deck", "/b", "s", None, Some("o/n"), None);
        assert!(value(&file, "COWORK_ISSUE_REPO").is_none());
        assert!(value(&gh, "COWORK_TASKS_DIR").is_none());
    }

    #[test]
    fn sum_usage_lines_adds_assistant_usage_only() {
        let content = concat!(
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#, "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}"#, "\n",
            "not json at all", "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":3,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":50}}}"#, "\n",
        );
        let u = sum_usage_lines(content);
        assert_eq!(u.input, 13);
        assert_eq!(u.output, 12);
        assert_eq!(u.cache_creation, 100);
        assert_eq!(u.cache_read, 250);
    }

    #[test]
    fn sum_usage_lines_empty_is_zero() {
        assert_eq!(sum_usage_lines(""), TokenUsage::default());
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
        let argv = pr_list_argv(50);
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "list");
        assert!(argv.contains(&"--state".to_string()));
        assert!(argv.contains(&"open".to_string()));
        assert!(argv.contains(&"--limit".to_string()));
        assert!(argv.contains(&"50".to_string()));
        let json_at = argv.iter().position(|a| a == "--json").expect("--json");
        assert_eq!(argv[json_at + 1], crate::gh_pr::PR_LIST_FIELDS);
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
}
