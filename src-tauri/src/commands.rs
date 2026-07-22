use crate::model::{Settings, Skill, Workspace};
use crate::store::Store;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub store: Mutex<Store>,
    pub external: crate::external::ExternalManager,
    pub listener_port: u16,
    pub reporter_path: String,
}

#[derive(Clone, Serialize)]
struct StatePayload { session: String, state: crate::model::SessionState }

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.store.lock().unwrap().settings()
}
#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    state.store.lock().unwrap().save_settings(&settings).map_err(|e| e.to_string())
}

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

#[tauri::command]
pub fn launch_session(
    state: State<AppState>,
    session: String,
    cwd: String,
    initial_prompt: Option<String>,
) -> Result<(), String> {
    let program = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let settings_file = crate::hooks::write_settings_file(&state.reporter_path, state.listener_port, &session)
        .map_err(|e| e.to_string())?;
    let mut template = state.store.lock().unwrap().settings().terminal_command;
    if template.trim().is_empty() {
        // Empty setting = auto: resolve the system default terminal at launch time.
        template = crate::external::detect_default_terminal();
    }
    let argv = crate::external::build_launch_argv(
        &template, &program, &settings_file.to_string_lossy(), &initial_prompt,
    )?;
    state.external.launch(&session, &argv, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_session(state: State<AppState>, session: String) {
    state.external.kill(&session);
}

/// Called by main during setup to emit state changes coming from the listener.
pub fn emit_state(app: &AppHandle, session: String, state: crate::model::SessionState) {
    let _ = app.emit("session://state", StatePayload { session, state });
}
