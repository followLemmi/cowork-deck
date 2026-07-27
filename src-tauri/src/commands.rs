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
    /// Signalled once by the frontend (`scheduler_ready`) after it attaches its
    /// `schedule://fire` listener, so the scheduler's first (catch-up) tick is
    /// not emitted into the void.
    pub scheduler_ready: std::sync::Arc<tokio::sync::Notify>,
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
    state.store.lock().unwrap().upsert_workspace(ws).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<AppState>,
    session: String,
    cwd: String,
    initial_prompt: Option<String>,
    cols: u16,
    rows: u16,
    workspace_id: Option<String>,
    resume: bool,
) -> Result<SessionAuth, String> {
    let program = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let settings = build_settings_json(&state.reporter_path, state.listener_port, &session);
    let args = build_claude_args(&settings, &initial_prompt, &session, resume);

    // Замок стора берётся и отпускается ДО резолва токена: gh::token блокирует
    // до пяти секунд, и удерживать общий мьютекс всё это время означало бы
    // подвесить любую другую операцию со стором.
    let cfg = workspace_id.as_ref().and_then(|id| {
        let store = state.store.lock().unwrap();
        store.workspaces().into_iter().find(|w| &w.id == id).and_then(|w| w.github)
    });
    let dir = noauth_dir(&state);
    let outcome =
        resolve_session_auth(cfg.as_ref(), &dir.to_string_lossy(), std::time::Duration::from_secs(5));

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
        .spawn(&session, &program, &args, &cwd, &outcome.env, cols, rows, on_output, on_exit)
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
        .spawn(&session, &program, &args, &cwd, &[], cols, rows, on_output, on_exit)
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
}
