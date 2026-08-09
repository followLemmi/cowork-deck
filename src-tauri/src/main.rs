#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod store;
mod gh;
mod gh_pr;
mod hooks;
mod listener;
mod pty;
mod commands;
mod run_journal;
mod runs;
mod scheduler;
mod tasks_cmd;
mod transcripts;
mod which;
use cowork_deck::tasks;

use commands::AppState;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

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

fn task_bin_name() -> &'static str {
    if cfg!(windows) { "cowork_task.exe" } else { "cowork_task" }
}

fn task_bin_path() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    resolve_reporter_path(&dir, task_bin_name(), |p| p.exists())
        .to_string_lossy()
        .to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Geometry survives a restart; visibility does not. The plugin's restore
        // runs `show()` *and* `set_focus()` on every window it manages, and it
        // does so for a window with no saved entry too — so the pill, hidden by
        // default and up only while a session waits, arrived blank and holding
        // the keyboard at every launch. Whether the pill is up is the deck's
        // answer to give (`pill://count`, see src/pill.ts); the plugin is here to
        // remember where the person dragged it to.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Config dir for the store.
            let dir = app.path().app_config_dir().expect("app config dir");
            let store = store::Store::new(dir.clone());

            // Before the listener, and long before the frontend can launch
            // anything: a hook or a PTY exit arriving with the journal unwired
            // would be a run nobody recorded. `sweep_and_compact` then closes
            // whatever a crash left open — nothing has a live PTY behind it at
            // this point, so every record still `running` is one of those.
            run_journal::init(dir.clone(), handle.clone());
            run_journal::sweep_and_compact();

            // Start the status listener on the tokio runtime Tauri provides.
            let handle_for_cb = handle.clone();
            let port = tauri::async_runtime::block_on(async move {
                listener::start_listener(move |session, state| {
                    commands::emit_state(&handle_for_cb, session, state);
                })
                .await
                .expect("listener bind")
            });

            let scheduler_ready = std::sync::Arc::new(tokio::sync::Notify::new());
            app.manage(AppState {
                store: Mutex::new(store),
                pty: pty::PtyManager::new(),
                listener_port: port,
                reporter_path: reporter_path(),
                task_bin_path: task_bin_path(),
                scheduler_ready: scheduler_ready.clone(),
                watchers: std::sync::Arc::new(tasks::watch::TaskWatchers::new()),
                gh_tokens: Mutex::new(std::collections::HashMap::new()),
                gh_repos: Mutex::new(std::collections::HashMap::new()),
                issue_open_counts: Mutex::new(std::collections::HashMap::new()),
            });

            // Scheduled scenarios: the backend decides *when* and emits
            // `schedule://fire`; the frontend launches the session.
            let sched_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                scheduler::run(sched_handle, dir, scheduler_ready).await;
            });

            // Floating "N waiting" status pill: a second, hidden-by-default
            // window shown/hidden via the `pill://count` event (see src/pill.ts).
            // Transparent + always-on-top confirmed working on macOS with
            // macOSPrivateApi + the `macos-private-api` Cargo feature (spike).
            let pill = tauri::WebviewWindowBuilder::new(
                app,
                "pill",
                tauri::WebviewUrl::App("pill.html".into()),
            )
            .inner_size(200.0, 48.0)
            .position(40.0, 40.0)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .transparent(true)
            .visible(false)
            // A status indicator must never take the keyboard. `show()` reaches
            // `makeKeyAndOrderFront:`, and a focusable window duly becomes the
            // *key* window — so every re-show stole the keyboard from the
            // session the person was typing into, mid-question. `focusable(false)`
            // makes `canBecomeKeyWindow` answer false: the pill still orders
            // front, which is all it ever wanted.
            //
            // The pair matters: a window that cannot become key would otherwise
            // swallow the first click into it, and the pill's only interaction
            // *is* that first click (focus the next waiting session, plus the
            // drag region). `accept_first_mouse` delivers it to the webview.
            //
            // Both calls are cross-platform in Tauri, but only the first has an
            // effect off macOS: on Linux `focusable(false)` becomes
            // `gtk_window_set_accept_focus(false)` and `accept_first_mouse` is a
            // no-op, so whether the click still reaches the webview there is
            // down to the compositor and has not been tried on a Linux machine.
            .focusable(false)
            .accept_first_mouse(true)
            .build();
            // Without the pill there is no waiting indicator at all, and every
            // `pill://count` afterwards goes nowhere — worth a line to diagnose
            // it by rather than a silently discarded `Result`.
            if let Err(e) = pill {
                eprintln!("error: failed to create the status pill window ({e})");
            }

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
            commands::load_layout,
            commands::save_layout,
            commands::load_ui_state,
            commands::save_ui_state,
            commands::git_status,
            commands::session_snapshots,
            commands::scheduler_ready,
            commands::schedule_ack,
            commands::load_schedule_state,
            commands::list_runs,
            commands::delete_skill_history,
            commands::reveal_path,
            commands::start_command_session,
            commands::gh_status,
            commands::pr_list,
            commands::pr_detail,
            commands::pr_diff,
            commands::pr_file_patch,
            commands::pr_merge_options,
            commands::pr_merge,
            commands::pr_close,
            commands::pr_reopen,
            commands::pr_worktree_path,
            commands::pr_worktree_add,
            commands::pr_worktree_remove,
            commands::host_platform,
            commands::issue_totals,
            commands::issue_worktree_add,
            commands::issue_worktree_path,
            commands::issue_worktree_remove,
            tasks_cmd::tasks_list,
            tasks_cmd::tasks_create,
            tasks_cmd::tasks_resolve,
            tasks_cmd::tasks_update,
            tasks_cmd::tasks_capabilities,
            tasks_cmd::tasks_open_counts,
            tasks_cmd::tasks_watch_sync,
            tasks_cmd::tasks_migration_status,
            tasks_cmd::tasks_migrate,
            tasks_cmd::tasks_migration_dismiss,
            tasks_cmd::tracker_root_preview,
            tasks_cmd::tracker_open_count,
            tasks_cmd::board_config_save,
            tasks_cmd::board_step_rewrite,
            tasks_cmd::board_step_usage,
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

    #[test]
    fn task_bin_resolves_next_to_the_exe_like_the_reporter() {
        let dir = Path::new("/app");
        let got = resolve_reporter_path(dir, task_bin_name(), |p| p == Path::new("/app/cowork_task"));
        assert_eq!(got, Path::new("/app/cowork_task"));
    }
}
