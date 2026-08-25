#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod model;
mod store;
mod sync;
mod sync_cmd;
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
mod ownership;
mod windows;
use cowork_deck::tasks;

use commands::AppState;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
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

/// Whether the app may go now, and the one place that decides it.
///
/// Returns true when there is nothing running inside any session. When there is,
/// the first attempt is refused and the deck is asked to put the question to the
/// person — the same discipline as the worktree guards in `commands.rs`, which
/// refuse rather than destroy when they cannot prove there is nothing to lose.
///
/// The flag is the escape hatch, and it is why this asks at most once per
/// unanswered question: if the window is wedged and never answers, a second
/// quit gesture goes straight through. An app that cannot be quit would be a
/// worse defect than the one this prevents. A cancelled quit disarms it
/// (`quit_cancelled`), so the next attempt asks again.
fn ready_to_quit(app: &tauri::AppHandle) -> bool {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return true,
    };
    let work = state.pty.live_work();
    if work.is_empty() {
        return true;
    }
    if state.quit_asked.swap(true, Ordering::SeqCst) {
        return true;
    }
    let _ = app.emit("app://quit-blocked", work);
    false
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
        // What carries an `https://` out of the webview and into the person's own
        // browser. Without it a link is inert: this window has no `_blank` target
        // to navigate to, so an anchor's click is dropped and nothing at all
        // happens (#252). The capability grants `open-url` only, scoped to
        // `http`/`https` — `open-path` would let a URL out of a pull request
        // description name a file to run.
        .plugin(tauri_plugin_opener::init())
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
                session_envs: Mutex::new(std::collections::HashMap::new()),
                shells: Mutex::new(std::collections::HashSet::new()),
                quit_asked: AtomicBool::new(false),
                issue_open_counts: Mutex::new(std::collections::HashMap::new()),
                windows_ready: std::sync::Arc::new(windows::WindowReady::default()),
                session_owners: ownership::SessionOwners::default(),
            });

            // Scheduled scenarios: the backend decides *when* and emits
            // `schedule://fire`; the frontend launches the session.
            let sched_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                scheduler::run(sched_handle, dir, scheduler_ready).await;
            });

            // Memory and configuration sync, if it has been switched on. A
            // detached thread and never awaited: the window opens and sessions
            // restore whether or not the network answers, which is the same rule
            // #35 set for memory generally — it stays off the launch path.
            sync_cmd::spawn(handle.clone());

            // Floating "N waiting" status pill: a second, hidden-by-default
            // window shown/hidden via the `pill://count` event (see src/pill.ts).
            // Transparent + always-on-top confirmed working on macOS with
            // macOSPrivateApi + the `macos-private-api` Cargo feature (spike).
            let pill = tauri::WebviewWindowBuilder::new(
                app,
                windows::PILL,
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
            // `Destroyed`, not `CloseRequested`: the latter is preventable and
            // also fires while the runtime tears everything down at quit, so a
            // window that refused to close would be marked gone while it is
            // still listening. A label is reusable — the same workspace pulled
            // out twice — and the second window has its own listeners to attach,
            // so the first one's readiness must not be inherited.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.windows_ready.forget(window.label());
                    // Ownership only. The sessions this window held are **not**
                    // ended — closing a window returns its workspace and never
                    // costs a session, so they become unowned here and wait to
                    // be re-homed (#245). Anything this window still sends is
                    // refused from this moment, which is the point.
                    state.session_owners.release_window(window.label());
                }
                // And tell the other windows, because none of them can see this
                // happen. `Destroyed` rather than `CloseRequested` for the same
                // reason the two clears above use it: the latter is preventable
                // and also fires while the runtime tears everything down at quit,
                // so a window that refused to close would be announced as gone
                // while it is still on screen and still listening.
                let _ = window.app_handle().emit(
                    "window://gone",
                    commands::WindowGonePayload { label: window.label().to_string() },
                );
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The label check is load-bearing and its absence is invisible
                // from the frontend. `AppState` is app-level, so this handler
                // resolves the same PTY manager whichever window sent the event
                // — and the app has a second window, the floating status pill.
                // One `close()` on the pill, a Linux compositor's delete-event,
                // or any future decoration on it would otherwise kill every
                // session in every workspace.
                if window.label() != windows::MAIN {
                    return;
                }
                if !ready_to_quit(window.app_handle()) {
                    api.prevent_close();
                    return;
                }
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
            commands::prepare_workspace,
            commands::quit_confirmed,
            commands::quit_cancelled,
            commands::start_session,
            commands::start_shell_session,
            commands::session_jobs,
            commands::load_terminals,
            commands::save_terminals,
            commands::write_session,
            commands::resize_session,
            commands::close_session,
            commands::window_ready,
            commands::claim_session,
            commands::open_workspace_window,
            commands::load_layout,
            commands::save_layout,
            commands::load_ui_state,
            commands::save_ui_state,
            commands::git_status,
            commands::git_changes,
            commands::worktree_files,
            commands::config_paths,
            commands::session_snapshots,
            commands::scheduler_ready,
            commands::schedule_ack,
            commands::load_schedule_state,
            commands::list_runs,
            commands::delete_skill_history,
            commands::reveal_path,
            sync_cmd::sync_summary,
            sync_cmd::sync_preflight,
            sync_cmd::sync_probe,
            sync_cmd::sync_create,
            sync_cmd::sync_connect,
            sync_cmd::sync_disconnect,
            sync_cmd::sync_now,
            sync_cmd::sync_questions,
            sync_cmd::sync_blocked_kinds,
            sync_cmd::sync_fault,
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
        .build(tauri::generate_context!())
        .expect("error while building cowork-deck")
        // The app-level exit events, which a webview `CloseRequested` is not.
        //
        // macOS Cmd+Q is `terminate:` and arrives here, not as a window close;
        // so does `app.exit`, and so does the updater's relaunch — which goes
        // through `request_restart` and would otherwise orphan the whole process
        // tree and then restore sessions alongside the survivors. Before this,
        // the only cleanup path in the app was one window's close request, so
        // every one of those gestures skipped it silently.
        .run(|app, event| match event {
            // `prevent_exit` is ignored for a restart, by design in Tauri: an
            // update that has already been installed must not be blockable. The
            // teardown below still runs for it.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !ready_to_quit(app) {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.pty.kill_all();
                }
            }
            _ => {}
        });
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
