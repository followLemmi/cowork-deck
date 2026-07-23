#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod store;
mod hooks;
mod listener;
mod pty;
mod commands;

use commands::AppState;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

fn reporter_name() -> &'static str {
    if cfg!(windows) { "cowork_report.exe" } else { "cowork_report" }
}

/// Resolve the reporter binary path by probing an ordered list of candidate
/// locations, returning the first that exists. Order: next to the current exe
/// (bundled sidecar / release build), then the sibling `release` dir (so
/// `tauri dev`, whose exe lives in `target/debug`, still finds a staged
/// reporter). Falls back to the exe-adjacent path so bundled behavior is
/// unchanged when nothing is found.
fn resolve_reporter_path(exe_dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let candidates = [
        exe_dir.join(name),
        exe_dir.join("..").join("release").join(name),
    ];
    for c in &candidates {
        if exists(c) {
            return c.clone();
        }
    }
    candidates[0].clone()
}

fn reporter_path() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    resolve_reporter_path(&dir, reporter_name(), |p| p.exists())
        .to_string_lossy()
        .to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Config dir for the store.
            let dir = app.path().app_config_dir().expect("app config dir");
            let store = store::Store::new(dir);

            // Start the status listener on the tokio runtime Tauri provides.
            let handle_for_cb = handle.clone();
            let port = tauri::async_runtime::block_on(async move {
                listener::start_listener(move |session, state| {
                    commands::emit_state(&handle_for_cb, session, state);
                })
                .await
                .expect("listener bind")
            });

            app.manage(AppState {
                store: Mutex::new(store),
                pty: pty::PtyManager::new(),
                listener_port: port,
                reporter_path: reporter_path(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.pty.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::save_workspace,
            commands::remove_workspace,
            commands::list_skills,
            commands::save_skill,
            commands::remove_skill,
            commands::claude_available,
            commands::start_session,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cowork-deck");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn prefers_reporter_next_to_exe() {
        let dir = Path::new("/app");
        let got = resolve_reporter_path(dir, "cowork_report", |p| {
            p == Path::new("/app/cowork_report")
        });
        assert_eq!(got, Path::new("/app/cowork_report"));
    }

    #[test]
    fn falls_back_to_release_sibling_in_dev() {
        let dir = Path::new("/proj/target/debug");
        let release = dir.join("..").join("release").join("cowork_report");
        let got = resolve_reporter_path(dir, "cowork_report", |p| p == release);
        assert_eq!(got, release);
    }

    #[test]
    fn defaults_to_exe_dir_when_none_exist() {
        let dir = Path::new("/app");
        let got = resolve_reporter_path(dir, "cowork_report", |_| false);
        assert_eq!(got, Path::new("/app/cowork_report"));
    }
}
