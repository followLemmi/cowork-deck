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
//! That is all of `gh_*`, `pr_*`, `issue_*`, `git_status`, `git_changes` and
//! `worktree_files` here, and the whole
//! of `tasks_cmd`, whose file board reads a directory that may be on a network
//! mount. The three deliberate exceptions, which stay on the main thread:
//!
//! - the store and settings commands (`list_workspaces`, `save_*`, `load_layout`,
//!   …) — a small JSON file in the app's own directory, and running them in
//!   arrival order is worth more than the microseconds;
//! - the session commands (`start_session`, `write_session`, `resize_session`,
//!   `close_session`) — **ordering is the feature**: a `write` that overtook its
//!   `start`, or two writes that swapped, is lost or misdirected keyboard input.
//!   They stay here because the blocking work was *moved off* them rather than
//!   because they never had any: `start_session` used to resolve `claude`'s
//!   location and the workspace's `gh` token inline, which is up to ten seconds
//!   of frozen window on a launch. Both are now resolved by
//!   `prepare_workspace`, which carries `(async)`, and `start_session` reads
//!   what it left behind (`session_auth`). A cache miss still resolves inline,
//!   so the freeze is a rare fallback rather than the normal path — and adding
//!   any *new* blocking call to these four puts it straight back;
//!   `quit_confirmed` and `quit_cancelled` sit here for the same ordering
//!   reason, and do no IO at all;
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
    ConfigFile, ConfigPaths, GitChange, GitChanges, GitStatus, SessionEntry, SessionTokens, Skill,
    TokenUsage, UiState, UiStatePatch, Workspace, WorkspaceGithub,
};
use crate::pty::PtyManager;
use crate::store::Store;
use crate::which;
use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

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
    /// Identity environments resolved ahead of a launch, keyed by workspace id.
    /// Filled by `prepare_workspace` off the main thread and read by
    /// `start_session`, which must stay synchronous — see `session_auth` and the
    /// note at the top of this file. Same lifetime and the same "in memory only,
    /// never persisted" rule as `gh_tokens`, whose token these entries carry;
    /// cleared whenever a workspace is saved, since the binding may have changed.
    pub session_envs: Mutex<std::collections::HashMap<String, AuthOutcome>>,
    /// Live shell ids, for the cap in `start_shell_session`. Pruned against the
    /// PTY manager on every open rather than maintained by every close: a set
    /// that had to be kept in step from three call sites is a set that goes
    /// stale, and the manager already knows the truth.
    pub shells: Mutex<std::collections::HashSet<String>>,
    /// Whether the person has already been asked about live work on the way out.
    /// Set when the app refuses to quit and clears it again only when the answer
    /// comes back — so a second quit gesture goes through even if the window
    /// never answers, and the app can never become unquittable. See the exit
    /// handler in `main.rs`.
    pub quit_asked: std::sync::atomic::AtomicBool,
    /// The open-issue count each GitHub workspace's board last saw, for the
    /// sidebar badge. Written by `tasks_list`, read by `tasks_open_counts`, never
    /// a network call. A workspace whose board has not been opened this run is
    /// absent, and `WorkspacesPanel` already draws nothing for that.
    pub issue_open_counts: Mutex<std::collections::HashMap<String, usize>>,
    /// Which windows have attached their listeners, and how to wait for one.
    ///
    /// The same problem `scheduler_ready` above solves for `schedule://fire`,
    /// with more than one thing to wait for: an emit to a webview that holds no
    /// listener for that event is a silent no-op at both ends, so a window that
    /// has not announced itself is not spoken to. See `windows::WindowReady`.
    pub windows_ready: std::sync::Arc<crate::windows::WindowReady>,
    /// Which window may write to which session. Claimed where a session is
    /// spawned, cleared where one closes and where a window is destroyed, and
    /// checked before every write and resize. See `ownership::SessionOwners`
    /// for why the frontend cannot be the layer that decides this.
    pub session_owners: crate::ownership::SessionOwners,
    /// Whether the reported source of usage limits may be asked. Shared with the
    /// Claude provider inside `usage`, so `save_ui_state` can flip it without
    /// rebuilding the registry. See `UiState::usage_reported`.
    pub usage_reported: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// What each connected AI has left, with a TTL cache in front of it. An
    /// `Arc` because `usage_snapshot` hands it to a blocking task: the providers
    /// spawn subprocesses, and none of that may happen on the runtime's own
    /// threads.
    pub usage: std::sync::Arc<crate::usage::registry::Registry>,
}

/// Take one of `AppState`'s locks, poisoned or not.
///
/// A poisoned mutex is one whose holder panicked while holding it. `lock()` then
/// returns `Err` **forever**, so `lock().unwrap()` converts a single panic inside
/// one command into a panic in every later command touching the same lock: the
/// app is dead from the first fault rather than degraded by it. The store lock is
/// the worst of them, because nearly every command takes it — a panic anywhere
/// under `save_workspace` and the deck stops answering, including the commands
/// that would let a person save their work and leave.
///
/// `PoisonError::into_inner` takes the guard anyway, and that is sound for these
/// six specifically. None of them guards an invariant-carrying structure that can
/// be observed mid-update: `Store` is a handle to a directory, re-reading and
/// atomically rewriting whole JSON files (see `store.rs`), and the five caches
/// beside it are maps whose worst reachable state is a stale or missing entry —
/// each one already has a miss path, because each is empty on launch. A torn
/// write is not observable through any of them, so carrying on with the data as
/// it stands is strictly better than refusing to serve it.
///
/// Three styles used to coexist for the store lock alone: `unwrap()` in nineteen
/// places, `map_err(|_| "store lock")` in six, `if let Ok` in four. The same fault
/// was therefore fatal, an error message, or silence depending on which command
/// met it first (#463).
fn taken<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The six locks in `AppState`, each reached by a method that cannot panic.
///
/// The fields stay `pub` because `main.rs` builds the state with a struct
/// literal, so the accessors are a convention rather than a wall — and
/// `no_state_lock_is_unwrapped` below is what makes the convention hold.
impl AppState {
    /// The store: workspaces, skills, layouts, the journal, `ui_state`.
    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> { taken(&self.store) }

    /// Account tokens, in memory only. See `workspace_token`.
    pub fn gh_tokens(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<(String, String), String>> {
        taken(&self.gh_tokens)
    }

    /// Per-workspace repository facts, as `gh` resolved them.
    pub fn gh_repos(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, cowork_deck::tasks::gh_issues::RepoFacts>> {
        taken(&self.gh_repos)
    }

    /// Identity environments resolved ahead of a launch. See `session_auth`.
    pub fn session_envs(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, AuthOutcome>> {
        taken(&self.session_envs)
    }

    /// Live shell ids, for the cap in `start_shell_session`.
    pub fn shells(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        taken(&self.shells)
    }

    /// The open-issue count each GitHub workspace's board last saw.
    pub fn issue_open_counts(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, usize>> {
        taken(&self.issue_open_counts)
    }
}

/// Build the argv (after the program name) for launching an interactive claude
/// session. First launch pins our own session id via `--session-id`; restart/
/// restore resumes a conversation via `--resume` (no prompt — context already
/// lives in the resumed session).
///
/// `resume` names the conversation rather than merely asking for one, and that
/// is deliberate: it used to be a `bool`, and the id it resumed was
/// `session_id` — the id the deck launched with, which stops naming the
/// conversation the person is in the moment they type `/clear` (#199). A caller
/// that has to state the id cannot reintroduce that by omission. See
/// [`resume_target`] for where the id comes from.
pub fn build_claude_args(
    settings_json: &str,
    initial_prompt: &Option<String>,
    session_id: &str,
    resume: Option<&str>,
    memory: &[String],
) -> Vec<String> {
    let mut args = vec!["--settings".to_string(), settings_json.to_string()];
    // Before the branch, so memory reaches **both** launch paths. Added inside
    // one of them, a session that survived a restart would quietly lose its
    // memory — and a restored tile is exactly the long-running session most
    // likely to want it.
    //
    // Position also matters for a second, sharper reason. `--mcp-config` is
    // **variadic** — `<configs...>` — so it keeps consuming arguments until one
    // starts with a dash. Measured: `claude --mcp-config '<json>' mcp list` fails
    // with "MCP config file not found: mcp" and "…: list", having swallowed both.
    // On a first launch the initial prompt is a *positional* argument, so memory
    // placed after `--session-id <id>` would have `--mcp-config` eat the prompt.
    // Here it is followed by `--session-id` or `--resume`, both flags, so the
    // variadic stops where it should. `no_positional_follows_the_mcp_config`
    // pins that.
    args.extend_from_slice(memory);
    if let Some(conversation) = resume {
        args.push("--resume".to_string());
        args.push(conversation.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
        if let Some(p) = initial_prompt {
            args.push(p.clone());
        }
    }
    args
}

/// Which conversation a restart or a restore should resume, for a tile the deck
/// knows as `session`.
///
/// Three sources, in this order, and each one covers a case the next cannot:
///
/// 1. [`crate::resume_ids`] — what a hook reported during **this** app run. The
///    freshest answer, and the only one that is right for a `/clear` followed by
///    a ⟳ before the frontend's next poll tick has persisted anything.
/// 2. `resume_id` on the layout entry — the only copy that survives a restart,
///    and so the answer on the auto-restore path, where the map above is empty
///    for the whole of a restored tile's life until its first hook arrives.
/// 3. The launch id itself, which is what a session that has never been cleared
///    means, and what every layout written before the field existed says.
///
/// Resolved here rather than passed in from the frontend, and that is the point:
/// a caller that forgot to pass it would resume the pre-`/clear` conversation
/// with **nothing failing** — the launch id still names a real, resumable
/// conversation. That is #199 exactly, and it is not a mistake a second caller
/// should be able to make. The same reasoning put transcript recording inside
/// the listener rather than behind a callback.
///
/// The id is not checked against the transcripts on disk. A `--resume` naming a
/// conversation that has been deleted fails visibly — the tile goes to `error`
/// and offers ⟳ — whereas quietly falling back to the launch id is the silent
/// wrong answer this whole issue is about.
///
/// The layout is read best-effort all the same, and that is a decision rather
/// than an oversight. `layout()` reads an unparseable `sessions.json` as an
/// empty one, so a file damaged *while the app runs* would send a cleared tile
/// back to its launch id without a word — the failure above, by another route.
/// Refusing instead would mean no session restarts at all while the file is
/// damaged, uncleared ones included, and those are the great majority and would
/// all have been right. A tile that loses one `/clear` is the smaller harm than
/// a deck that will not restart anything, so this reads what it can get.
fn resume_target(store: &Store, session: &str) -> String {
    if let Some(current) = crate::resume_ids::get(session) {
        return current;
    }
    // Takes the store rather than the mutex, and the caller passes
    // `&state.store()` — so the guard is a temporary, dropped at the end of that
    // statement rather than held into the launch. See the note at the top of
    // this file about what `start_session` may and may not do. It used to take
    // the mutex and `lock().ok()`, which meant a poisoned lock fell back to the
    // launch id silently: after a `/clear` that is the conversation the person
    // just left, resumed on purpose (#463).
    //
    // Every window's entries, not this window's: a session that was handed to
    // another deck is owned by that one, and the id it should resume is a fact
    // about the conversation rather than about who is showing it.
    store
        .layout()
        .into_iter()
        .find(|e| e.session_id == session)
        .and_then(|e| e.resume_id)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| session.to_string())
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
struct StatePayload { session: String, state: crate::model::SessionState }

/// What `session://exit` carries.
///
/// `ok` alone was the whole payload, and it made three different things look
/// identical: a command that failed, a process the app hung up at shutdown, and
/// a `wait()` the app could not read. The frontend now gets the fact rather than
/// a verdict — see `pty::Exit`.
#[derive(Clone, Serialize)]
struct ExitPayload {
    session: String,
    ok: bool,
    code: Option<i32>,
    signal: Option<String>,
    unknown: bool,
}

impl ExitPayload {
    fn new(session: String, exit: &crate::pty::Exit) -> ExitPayload {
        ExitPayload {
            session,
            ok: exit.ok(),
            code: exit.code,
            signal: exit.signal.clone(),
            unknown: exit.unknown,
        }
    }
}

/// The tile's two-state summary of an outcome that now has more than two.
///
/// A signalled process is `Ended`, not `Error`: it did not fail, it was stopped —
/// by this app at shutdown, by the person, or by the system. Reading "error" on
/// a tile the app itself hung up is the exact confusion this payload exists to
/// end. A failed `wait()` is `Error`, because not knowing is not success.
fn state_of(exit: &crate::pty::Exit) -> crate::model::SessionState {
    if exit.ok() || exit.signalled() {
        crate::model::SessionState::Ended
    } else {
        crate::model::SessionState::Error
    }
}

/// The same judgement for the run journal, which records one of two outcomes.
fn run_status_of(exit: &crate::pty::Exit) -> crate::runs::RunStatus {
    if exit.ok() || exit.signalled() {
        crate::runs::RunStatus::Ended
    } else {
        crate::runs::RunStatus::Error
    }
}

/// The workspace list, refusing rather than answering "none" for a file it
/// cannot read.
///
/// It answered `Vec` until #369, on `read_vec`'s best-effort terms: an
/// unparseable `workspaces.json` read as an empty list, which cost a stale
/// sidebar and nothing else. It costs more now. A window pinned to a workspace
/// closes itself when this call stops listing it, so an empty answer is a
/// decision to hand the window's sessions back and go — and a fault has to be
/// unable to make that decision. `try_workspaces` carries the difference; the
/// frontend's `listWorkspaces` rejects, and every reader of it already has to
/// survive an invoke that fails.
#[tauri::command]
pub fn list_workspaces(state: State<AppState>) -> Result<Vec<Workspace>, String> {
    state.store().try_workspaces().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn save_workspace(state: State<AppState>, ws: Workspace) -> Result<Vec<Workspace>, String> {
    // The binding may have just changed; a stale cached token would keep this
    // workspace talking as the old account. The map holds a handful of entries,
    // so clearing all of it costs nothing and precision buys nothing.
    state.gh_tokens().clear();
    // The resolved environment is the same binding one step further on: a
    // workspace that now points at another account would otherwise keep handing
    // new sessions the old account's token. This is the invalidation point the
    // fork-time resolution never had.
    state.session_envs().clear();
    // A re-pointed folder is a different repository, and a re-sourced tracker is
    // a different count. Both caches are keyed by workspace, so both would
    // otherwise keep answering for the workspace this one used to be.
    state.gh_repos().clear();
    state.issue_open_counts().clear();
    let store = state.store();
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
    let (left, dir) = {
        let store = state.store();
        (store.delete_workspace(&id).map_err(|e| e.to_string())?, store.dir.clone())
    };
    // Deletion is an event, and this is the moment it happens. Sync cannot work
    // it out later by comparing the repository against the store: a record that
    // arrived in a pull and has not been merged yet is indistinguishable from
    // one deleted here, and guessing wrong deletes another machine's workspace.
    // Its memory is deliberately left where it is.
    crate::sync::publish::forget_workspace(&dir, &id);
    Ok(left)
}
#[tauri::command]
pub fn list_skills(state: State<AppState>) -> Vec<Skill> {
    state.store().skills()
}
#[tauri::command]
pub fn save_skill(state: State<AppState>, sk: Skill) -> Result<Vec<Skill>, String> {
    state.store().upsert_skill(sk).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn remove_skill(state: State<AppState>, id: String) -> Result<Vec<Skill>, String> {
    let (left, dir) = {
        let store = state.store();
        (store.delete_skill(&id).map_err(|e| e.to_string())?, store.dir.clone())
    };
    crate::sync::publish::forget_scenario(&dir, &id);
    Ok(left)
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
    let store = state.store();
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
    // The workspace the fire resolved to, when it resolved to one. A
    // `skipped-overlap` happened somewhere, and the history screen is
    // workspace-scoped; `no-workspace` has none by definition and says so.
    workspace_id: Option<String>,
) -> Result<(), String> {
    // The gate here is `schedule_state.json`, which stays what it always was — a
    // gate, not a log: it is read and written every tick and must remember
    // attempts that launched nothing, and deriving "did we already fire" by
    // scanning the journal would be both slower and semantically wrong.
    {
        let store = state.store();
        let mut st = store.schedule_state();
        let Some(updated) = crate::scheduler::apply_ack(st.get(&skill_id), occurrence_ms, &outcome)
        else {
            return Ok(());
        };
        st.insert(skill_id.clone(), updated);
        store.save_schedule_state(&st).map_err(|e| e.to_string())?;
    }
    // A fire that launched nothing gets a record of its own — but only once the
    // ack has been accepted. An ack `apply_ack` drops as stale or replayed is not
    // an event that happened twice, and a journal that disagreed with the gate
    // would report the same failed occurrence again on every retry.
    if outcome != "launched" {
        crate::run_journal::failed_to_launch(&skill_id, workspace_id.as_deref(), &outcome);
    }
    Ok(())
}

/// The run journal, newest first, optionally narrowed.
///
/// Both filters are applied here rather than in the frontend so that the screen
/// and the sidebar's state dot ask the same question of the same code. Records
/// with **no** `workspaceId` pass every workspace filter: an unpinned scenario
/// whose scheduled fire never resolved a folder belongs to no workspace, and
/// hiding it everywhere would hide precisely the failure worth seeing — the same
/// rule the deck already applies to orphaned tiles.
#[tauri::command(async)]
pub fn list_runs(
    state: State<AppState>,
    workspace_id: Option<String>,
    skill_id: Option<String>,
) -> Vec<crate::runs::RunRecord> {
    let runs = { state.store().runs() };
    crate::runs::scoped(runs, workspace_id.as_deref(), skill_id.as_deref())
}

/// Erase one scenario's history, within the workspace scope the screen was
/// showing. The only erasure there is — see `Store::delete_skill_history`, which
/// also refuses while one of those runs is still open.
#[tauri::command(async)]
pub fn delete_skill_history(
    state: State<AppState>,
    skill_id: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let store = state.store();
    store
        .delete_skill_history(&skill_id, workspace_id.as_deref())
        .map_err(|e| e.to_string())
}

/// The argv that shows `path` in the platform's file manager, selected.
///
/// **Reveal only.** Not `open <path>`, which would hand a `.jsonl` to whatever
/// is registered for it — the point is to show somebody where the file is, not
/// to launch something with it. Linux has no standard "select this file", so it
/// gets the containing folder, which is the honest approximation rather than a
/// silently different action.
///
/// Argv, never a shell string: the path comes off a record and may hold spaces,
/// quotes or a newline, and there is no interpreter here for any of them to
/// mean anything to.
///
/// Windows is the exception that proves it. Explorer parses its own command
/// line rather than taking the argv the OS handed it, and it does not recognise
/// `/select` once Rust's quoting rules have wrapped the switch and the path
/// together — which is what happens the moment the path holds a space, as
/// `C:\Users\John Smith\…` does. The form it accepts is `/select,"<path>"`, so
/// the quotes are placed here and the argument goes through `raw_arg` in
/// `reveal_path`, unquoted again by nobody. A Windows path cannot itself contain
/// a `"`, so there is nothing inside for the quoting to get wrong.
pub fn reveal_argv(path: &std::path::Path) -> (String, Vec<String>) {
    let p = path.to_string_lossy().to_string();
    if cfg!(target_os = "macos") {
        ("open".into(), vec!["-R".into(), p])
    } else if cfg!(windows) {
        ("explorer".into(), vec![format!("/select,\"{p}\"")])
    } else {
        let dir = path.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or(p);
        ("xdg-open".into(), vec![dir])
    }
}

/// Show a run's transcript in the file manager.
///
/// Claude Code owns those files' lifetime and they legitimately disappear, so a
/// missing one is an ordinary answer rather than a fault — and it is refused
/// here as well as being disabled in the UI, because the file can go between
/// the render and the click.
///
/// The helper is waited on, on a thread of its own. `Child`'s `Drop` does not
/// reap, and this screen invites one press per row: fifty reveals would
/// otherwise mean fifty `<defunct>` children holding PID slots for as long as
/// the app runs. Waiting on a thread rather than inline because `open`,
/// `explorer` and `xdg-open` all return immediately in the ordinary case and
/// this must not become the one that does not. Their stdio is discarded too —
/// `xdg-open`'s diagnostics belong nowhere near the app's own output.
#[tauri::command(async)]
pub fn reveal_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    // Checked before the file test, so a path outside every root reports the
    // refusal rather than reporting on a file's existence — a "no longer there"
    // for a path that was never openable would answer a question nobody asked.
    // The three roots are a workspace and its worktrees, this app's own config
    // directory, and Claude Code's project directory; see `reachable`.
    if !revealable_roots(&state).contains(&path) {
        return Err("That file is not one this app has anything to do with.".into());
    }
    reveal_file(&path)
}

fn reveal_file(path: &str) -> Result<(), String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_file() {
        return Err("The transcript is no longer there.".into());
    }
    let (program, args) = reveal_argv(&p);
    let mut cmd = std::process::Command::new(&program);
    // See `reveal_argv`: Explorer re-parses its own command line, so its one
    // argument is already quoted and must reach it untouched.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for a in &args {
            cmd.raw_arg(a);
        }
    }
    #[cfg(not(windows))]
    cmd.args(&args);
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not open the file manager ({program}): {e}"))?;
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
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
    /// Whether this platform lets the app say where a window goes.
    ///
    /// False on Wayland, where `set_position` returns `Ok` and silently does
    /// nothing. The tear-out gesture is built on putting the new window under
    /// the cursor, so it is not offered where that cannot work — the plain
    /// trigger does the same job and reads as the way to do it, rather than as
    /// the fallback beside a gesture that looks broken.
    #[serde(rename = "placesWindows")]
    pub places_windows: bool,
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
    // Whether this platform lets an app say where a window goes.
    //
    // `set_position` compiles and returns `Ok` on Wayland and silently does
    // nothing: the compositor owns placement. The tear-out gesture is built on
    // putting the new window under the cursor, so on Wayland it cannot work at
    // all — and a gesture that half-works is worse than one that is not offered,
    // because the plain trigger is right there and reads as broken beside it.
    //
    // Named for the capability rather than the display server, because that is
    // what the caller needs to know and it stays true if another platform ever
    // makes the same choice.
    let places_windows = !(os == "linux"
        && std::env::var("XDG_SESSION_TYPE")
            .map(|t| t.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false));
    HostPlatform { os: os.to_string(), distro, places_windows }
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

pub(crate) fn which_claude() -> Option<which::Resolution> {
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

#[derive(Debug, Clone)]
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

/// The empty directory a degraded session's `gh` is pointed at, so that it says
/// "you are not logged in" instead of quietly working as whichever account
/// happens to be globally active.
///
/// **Read-only, and that is the feature.** "You are not logged in" is precisely
/// the message that makes a person run `gh auth login`, and with `GH_CONFIG_DIR`
/// pointing here that login would write a real `hosts.yml` into a directory
/// every degraded session of every workspace shares — from then on, all of them
/// silently authenticate as that account. That inverts the invariant the whole
/// per-workspace binding rests on (see the head of `gh.rs`: the app never
/// changes global `gh` state). Unwritable, the login fails loudly and nothing
/// becomes app-wide by accident.
///
/// The permission is re-applied on every call rather than only at creation: an
/// installation that already has the directory from an older build gets it
/// fixed, and a failed login cannot leave it writable behind itself.
fn noauth_dir(state: &State<AppState>) -> std::path::PathBuf {
    let dir = state.store().dir.join("gh-noauth");
    let _ = std::fs::create_dir_all(&dir);
    harden_noauth_dir(&dir);
    dir
}

/// `r-x` for the owner and nothing for anyone else: `gh` must be able to look
/// and find nothing, and must not be able to write.
#[cfg(unix)]
fn harden_noauth_dir(dir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500));
}

/// Windows has no equivalent one-liner — denying writes means an ACL edit
/// through the API. The degraded session there keeps the older, weaker promise:
/// `GIT_TERMINAL_PROMPT=0` still stops git soliciting a credential, and a
/// `gh auth login` still has to be typed deliberately.
#[cfg(not(unix))]
fn harden_noauth_dir(_dir: &std::path::Path) {}

/// The workspace's identity environment, taken from the cache that
/// `prepare_workspace` fills off the main thread.
///
/// A miss still resolves here, synchronously, because a session that starts
/// with the wrong identity is worse than a session that starts slowly — the
/// cache is a de-risking, not a contract. What it costs when it misses is what
/// this used to cost every time: up to five seconds on the thread that paints
/// the window.
///
/// Successful resolutions only. A degraded outcome — a locked keyring, a `gh`
/// that timed out — stays out of the cache, so unlocking the keyring does not
/// require restarting the app. Same rule as `which_gh`'s discovery cache, for
/// the same reason.
fn session_auth(
    state: &State<AppState>,
    workspace_id: Option<&str>,
    github: Option<&WorkspaceGithub>,
) -> AuthOutcome {
    if let Some(id) = workspace_id {
        let hit = state.session_envs().get(id).cloned();
        if let Some(outcome) = hit {
            return outcome;
        }
    }
    let dir = noauth_dir(state);
    let outcome =
        resolve_session_auth(github, &dir.to_string_lossy(), std::time::Duration::from_secs(5));
    if let (Some(id), None) = (workspace_id, outcome.auth.degraded.as_ref()) {
        state.session_envs().insert(id.to_string(), outcome.clone());
    }
    outcome
}

/// Resolve everything a session launch would otherwise block on, off the thread
/// that paints the window, and remember it.
///
/// Called when a workspace becomes the active one and before each launch, so
/// that `start_session` — which stays synchronous because ordering with
/// `write_session` is the feature — finds its environment already resolved
/// instead of shelling out to `gh` and to the login shell while the window is
/// frozen. Everything that can block is warmed here: the account binding,
/// `claude`'s own discovery, which probes install directories and may run the
/// login shell, and the login shell's PATH, which the session needs whatever
/// that discovery found.
///
/// Returns what the binding resolved to, so a caller that wants to show the
/// account badge before the session exists can.
#[tauri::command(async)]
pub fn prepare_workspace(state: State<AppState>, workspace_id: String) -> SessionAuth {
    // Warms `CLAUDE_CACHE`; the result is read again, from the cache, by the
    // launch itself.
    let _ = which_claude();
    // And the session's PATH, which the launch now asks for on every route
    // rather than only after a login-shell discovery — so without this the
    // first launch pays up to five seconds for a login shell on a path
    // somebody is watching.
    let _ = which::login_path();
    let github = {
        let store = state.store();
        store.workspaces().into_iter().find(|w| w.id == workspace_id).and_then(|w| w.github)
    };
    session_auth(&state, Some(&workspace_id), github.as_ref()).auth
}

/// The sentence a workspace with no folder on this machine gets.
///
/// A marker the frontend can match on, the way `unavailableFrom` matches the
/// `gh` states, plus prose for anywhere that only shows the text.
pub fn no_local_path(workspace_id: Option<&str>) -> String {
    let _ = workspace_id;
    "no-local-path: this workspace has no folder on this machine yet. \
     Point it at one before starting a session here."
        .to_string()
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
    if let Some(t) = state.gh_tokens().get(&key) {
        return Some(t.clone());
    }
    let t = gh::token(&cfg.host, &cfg.login, std::time::Duration::from_secs(5)).ok()?;
    state.gh_tokens().insert(key, t.clone());
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
        let store = state.store();
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
    if let Some(f) = state.gh_repos().get(workspace_id).cloned() {
        return Ok(f);
    }
    let json = run_gh_for_workspace(
        state,
        workspace_id,
        &cowork_deck::tasks::gh_issues::repo_facts_argv(),
    )?;
    let facts = cowork_deck::tasks::gh_issues::parse_repo_facts(&json)?;
    state.gh_repos().insert(workspace_id.to_string(), facts.clone());
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
        let store = state.store();
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
    };
    // Empty is not the same as absent, and both are refused: a workspace that
    // arrived over sync exists as a record while naming no folder here, and
    // every caller of this — worktrees, git status, `gh` resolving from a
    // directory — would otherwise run somewhere unspecified.
    match found {
        Some(p) if !p.trim().is_empty() => Ok(p),
        Some(_) => Err(no_local_path(Some(workspace_id))),
        None => Err("no such workspace".to_string()),
    }
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

/// Everything the frontend supplies to launch a `claude` session.
///
/// A struct rather than fourteen parameters, which is what this was (#463). The
/// arity was not the whole objection: at that width a caller passing `cols` where
/// `rows` belongs, or a `bool` into the wrong one of two, compiles — and both
/// pairs are adjacent here. Named fields on one side and named properties on the
/// other remove the class.
///
/// The four things NOT in here are the ones the frontend does not send: the
/// `AppHandle`, the window, the state, and the output channel. `sink` in
/// particular has to stay a parameter of its own — Tauri gives a `Channel` its
/// identity from the payload, and burying it in a struct is not a shape it
/// deserialises.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub session: String,
    pub cwd: String,
    pub workspace_id: Option<String>,
    pub initial_prompt: Option<String>,
    /// Set when the session is launched from (or restored with) a tracker card —
    /// see `session_env`.
    pub task_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub resume: bool,
    /// Set when this launch comes from a scenario, by any route. Absent for a
    /// card, an issue, a pull request or a bare "+ session" — the journal answers
    /// "what did my scenarios do", not "what did I run yesterday".
    pub scenario: Option<crate::run_journal::ScenarioLaunch>,
    /// Deliberately replacing a process that is still live under this id — the
    /// restart button, and nothing else. Left false, a launch into an id that is
    /// already running is refused rather than silently killing what is there; see
    /// `PtyManager::spawn`.
    pub replace: bool,
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
    req: LaunchRequest,
    // Where this session's pty output goes.
    //
    // A per-session `Channel` rather than a broadcast `app.emit`, and the
    // difference is not tidiness. `emit` builds a JS source string with the
    // payload embedded as a JSON literal and runs it through
    // `WKWebView.evaluateJavaScript` — which meant every chunk of terminal
    // output was base64'd (+33%), pasted into JavaScript source, parsed by the
    // JS parser, `atob`'d, and walked a byte at a time by a `Uint8Array.from`
    // callback, all on the one thread that also has to deliver keystrokes.
    //
    // A channel carrying `Response::new(bytes)` sends `InvokeResponseBody::Raw`,
    // which Tauri hands over the custom protocol as binary once a message
    // clears 1KB (`tauri::ipc::channel::MAX_RAW_DIRECT_EXECUTE_THRESHOLD`) —
    // no base64, no JS parse of the payload, no per-byte callback. Ordering is
    // preserved by the index the JS `Channel` reorders on, so the byte stream
    // stays intact across a glyph split by a batch boundary.
    sink: Channel<Response>,
) -> Result<SessionAuth, String> {
    let LaunchRequest {
        session,
        cwd,
        workspace_id,
        initial_prompt,
        task_id,
        cols,
        rows,
        resume,
        scenario,
        replace,
    } = req;
    // A workspace that arrived over sync has no folder on this machine until
    // somebody says where it is (#316). Everything downstream — the pty's
    // working directory, worktrees, `gh` resolving a repository from where it
    // stands — assumes this names a directory that exists. Refused here with a
    // sentence, because the alternative is a shell in an unspecified directory
    // and a failure three layers further in.
    if cwd.trim().is_empty() {
        return Err(no_local_path(workspace_id.as_deref()));
    }
    let resolved = which_claude().ok_or_else(|| "claude-not-found".to_string())?;
    let program = resolved.program;
    let settings = build_settings_json(
        &state.reporter_path,
        state.listener_port,
        &session,
        &state.task_bin_path,
        workspace_id.as_deref(),
    );
    // Off the store lock and off any network: `session_args` stats one file and
    // formats a JSON string. #35's rule that memory stays off the session launch
    // path is about the *index* and the model, neither of which is touched here.
    let memory = crate::memory::session_args(workspace_id.as_deref());
    // The conversation, not merely the fact that there is one to resume: after a
    // `/clear` the launch id names the conversation the person left, and
    // resuming it succeeds — see `resume_target` (#199).
    let resuming = resume.then(|| resume_target(&state.store(), &session));
    let args = build_claude_args(
        &settings, &initial_prompt, &session, resuming.as_deref(), &memory,
    );

    // Замок стора берётся и отпускается ДО резолва токена: gh::token блокирует
    // до пяти секунд, и удерживать общий мьютекс всё это время означало бы
    // подвесить любую другую операцию со стором.
    let ws = match workspace_id.as_deref() {
        Some(id) => {
            let store = state.store();
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

    // The GitHub account's environment goes on top of the tracker's: the two
    // key sets do not overlap, and the session gets both.
    let outcome =
        session_auth(&state, workspace_id.as_deref(), ws.and_then(|w| w.github).as_ref());
    env.extend(outcome.env.clone());

    // Hand the session the login shell's PATH. Not only for a claude that is
    // really an `env node` script — which dies instantly under the app's
    // launchd-minimal environment — but for everything claude then spawns:
    // stdio MCP servers (`npx ...`, `#!/usr/bin/env node` shims), hooks, the
    // Bash tool. All of them resolve through PATH, and under launchd's
    // `/usr/bin:/bin:/usr/sbin:/sbin` none of them is found (#332).
    //
    // The resolution's own PATH wins where there is one, so a claude found
    // *through* the login shell keeps the exact environment it was validated
    // under. `login_path` covers every other route, which is all the routes
    // that captured nothing: a natively installed claude (a self-contained
    // binary, so it passes `--version` under launchd's PATH and never reaches
    // the login-shell stage) and `COWORK_CLAUDE_PATH`. That last one is a
    // deliberate change — the override names a binary, not an environment.
    if let Some(path_env) = resolved.path_env.or_else(which::login_path) {
        env.push(("PATH".to_string(), path_env));
    }

    // Read on the way past, not instead of: the terminal gets every byte, and
    // this is a copy taken from the same batch. It is here rather than in the
    // frontend because the PTY is the only place these bytes are still whole —
    // xterm has consumed them by the time anything in `src/` could look.
    //
    // Only on a `claude` session, and deliberately not on a shell or command
    // tile: "limit reached" from a build script is not this account's budget, and
    // a parser that refuses to guess is worth more than the coverage.
    let sess_watch = session.clone();
    let app_watch = app.clone();
    let on_output = move |bytes: Vec<u8>| {
        let now = chrono::Utc::now().timestamp_millis();
        if crate::usage::observed::note_output(&sess_watch, &bytes, now) {
            // Something the cache cannot know has just happened. The frontend
            // answers this by re-reading with `force`, which is why nothing here
            // needs a route to `AppState`.
            let _ = app_watch.emit("usage://changed", ());
        }
        let _ = sink.send(Response::new(bytes));
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |exit: crate::pty::Exit| {
        // The record closes here rather than on the frontend's say-so: a
        // scheduled run's tile may have no window to report from, and the
        // process dying is the fact the journal is about.
        crate::run_journal::close(&sess_exit, run_status_of(&exit));
        let _ = app_exit.emit(
            "session://state",
            StatePayload { session: sess_exit.clone(), state: state_of(&exit) },
        );
        let _ = app_exit.emit("session://exit", ExitPayload::new(sess_exit.clone(), &exit));
    };

    // Before the spawn, because `pty.spawn` starts the waiter thread that calls
    // `on_exit` before it returns: a process that dies on the spot — a rejected
    // `--resume`, a shim that refuses — would otherwise fire `on_exit` while the
    // record did not yet exist, and nothing would ever close it. A launch that
    // never happened is closed below instead of going unrecorded, which is the
    // more useful of the two silences: "the schedule fired and died instantly" is
    // exactly what somebody opens a history to find out.
    if let Some(launch) = &scenario {
        crate::run_journal::open(
            &session, launch, &cwd, workspace_id.as_deref(), initial_prompt.as_deref(),
        );
    }
    if let Err(e) = state.pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &env, replace, on_output, on_exit)
    {
        let e = e.to_string();
        crate::run_journal::failed_to_start(&session, &e);
        return Err(e);
    }
    // After the spawn, so a session that failed to start leaves no owner behind
    // for a later id collision to inherit. The window that started a session
    // owns it until it hands it on.
    state.session_owners.claim(&session, window.label());
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
    window: tauri::WebviewWindow,
    state: State<AppState>,
    session: String,
    cwd: String,
    command: String,
    cols: u16,
    rows: u16,
    // Same binary path as `start_session`'s — see the note there.
    sink: Channel<Response>,
) -> Result<(), String> {
    let (program, args) = if cfg!(windows) {
        ("cmd".to_string(), vec!["/C".to_string(), command])
    } else {
        ("sh".to_string(), vec!["-lc".to_string(), command])
    };

    let on_output = move |bytes: Vec<u8>| {
        let _ = sink.send(Response::new(bytes));
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |exit: crate::pty::Exit| {
        let _ = app_exit.emit(
            "session://state",
            StatePayload { session: sess_exit.clone(), state: state_of(&exit) },
        );
        let _ = app_exit.emit("session://exit", ExitPayload::new(sess_exit.clone(), &exit));
    };

    // Never a replacement: a command tile's id is minted for it and used once,
    // and this command offers no restart. An id that is somehow already live is
    // a double-launch, which is exactly what the refusal is for.
    state
        .pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &[], false, on_output, on_exit)
        .map_err(|e| e.to_string())?;
    state.session_owners.claim(&session, window.label());
    Ok(())
}

/// How many shells may be open at once.
///
/// Not a guess about how many a person wants — eight tabs is already more than a
/// tab strip reads well at — but a backstop. Every other spawn in this app is
/// one gesture, one process; the drawer is the first surface where "open a
/// terminal" is cheap enough to hold down by accident, and a shell is the most
/// expensive child the app has.
const MAX_SHELLS: usize = 8;

/// What the drawer needs to write its banner line.
///
/// The branch is deliberately absent: reading it means running `git`, and this
/// command is on the thread that paints the window. The drawer already has
/// `git_status`, which carries `(async)`, so it asks for the branch itself and
/// composes the line. Everything here is already in memory.
#[derive(Serialize)]
pub struct ShellStart {
    /// The account this shell's `gh` will act as, and why not when it cannot.
    pub auth: SessionAuth,
    /// The git identity the shell carries in its environment, as
    /// `Name <email>` — or `None` when the workspace injects none and the
    /// shell inherits whatever `~/.gitconfig` says.
    ///
    /// This exists because a person cannot otherwise *check* it: `GIT_AUTHOR_*`
    /// in the environment outranks the config, and `git config user.email`
    /// reports the config — so the honest answer is only available from the side
    /// that set it.
    pub identity: Option<String>,
    /// The program the shell actually is, for the tab's name.
    pub program: String,
}

/// The person's own shell, as an interactive terminal would start it.
///
/// `$SHELL` rather than a fixed program: this is the shell they configured, and
/// an app that silently gave them bash when they use fish would be lying about
/// what it opened. A login shell on macOS, plain elsewhere, which is what
/// Terminal.app and gnome-terminal respectively do — and on macOS it is load-
/// bearing rather than cosmetic, because an .app launched from the Dock
/// inherits launchd's minimal `PATH` and a non-login shell would keep it.
fn user_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let ps = "powershell.exe".to_string();
        (std::env::var("COMSPEC").unwrap_or(ps), Vec::new())
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" }
                    .to_string()
            });
        let args = if cfg!(target_os = "macos") { vec!["-l".to_string()] } else { Vec::new() };
        (shell, args)
    }
}

/// The last segment of a shell's path — `zsh`, not `/bin/zsh` — for a tab label.
fn shell_name(program: &str) -> String {
    program
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(program)
        .trim_end_matches(".exe")
        .to_string()
}

/// Open an interactive shell on a pty.
///
/// Synchronous and ordered like the other session commands, and it can afford to
/// be: the account binding is already resolved (`prepare_workspace`), and
/// nothing here shells out. The three guards are the ones an ordinary shell
/// needs and `claude` never did — a person opens these, closes them, and opens
/// them again, which is exactly the traffic that finds a race.
#[tauri::command]
pub fn start_shell_session(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
    session: String,
    cwd: String,
    workspace_id: Option<String>,
    cols: u16,
    rows: u16,
    // Same binary path as `start_session`'s — see the note there.
    sink: Channel<Response>,
) -> Result<ShellStart, String> {
    // Ids the manager no longer holds are closed tabs; they must not count
    // toward the cap, and pruning here means no bookkeeping anywhere else.
    {
        let mut shells = state.shells();
        shells.retain(|id| state.pty.is_live(id));
        if !shells.contains(&session) && shells.len() >= MAX_SHELLS {
            return Err(format!("terminal-limit:{MAX_SHELLS}"));
        }
    }

    let ws = match workspace_id.as_deref() {
        Some(id) => {
            let store = state.store();
            store.workspaces().into_iter().find(|w| w.id == id)
        }
        None => None,
    };
    let github = ws.and_then(|w| w.github);
    let outcome = session_auth(&state, workspace_id.as_deref(), github.as_ref());
    let identity = git_identity(&outcome.env);

    let (program, args) = user_shell();

    let on_output = move |bytes: Vec<u8>| {
        let _ = sink.send(Response::new(bytes));
    };

    let app_exit = app.clone();
    let sess_exit = session.clone();
    let on_exit = move |exit: crate::pty::Exit| {
        let _ = app_exit.emit(
            "session://state",
            StatePayload { session: sess_exit.clone(), state: state_of(&exit) },
        );
        let _ = app_exit.emit("session://exit", ExitPayload::new(sess_exit.clone(), &exit));
    };

    // Never a replacement. A person who presses the same key twice, or a restore
    // that raced a manual open, must not silently kill a shell that is running
    // something — refusing is the whole point of the guard.
    state
        .pty
        .spawn(&session, &program, &args, &cwd, cols, rows, &outcome.env, false, on_output, on_exit)
        .map_err(|e| e.to_string())?;

    state.session_owners.claim(&session, window.label());
    state.shells().insert(session);
    Ok(ShellStart { auth: outcome.auth, identity, program: shell_name(&program) })
}

/// `Name <email>` out of a resolved session environment, when it carries both.
///
/// Reads the environment rather than the workspace configuration on purpose: the
/// environment is what the shell will actually be given, and if the two ever
/// disagree the banner must say what is true rather than what was intended.
fn git_identity(env: &[(String, String)]) -> Option<String> {
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    match (get("GIT_AUTHOR_NAME"), get("GIT_AUTHOR_EMAIL")) {
        (Some(n), Some(e)) => Some(format!("{n} <{e}>")),
        (Some(n), None) => Some(n.to_string()),
        (None, Some(e)) => Some(e.to_string()),
        (None, None) => None,
    }
}

/// How many jobs a session is running right now.
///
/// What the close confirmation asks. A shell has no hooks and therefore no state
/// of its own to read — the tile chip says `idle` whether the shell is at a
/// prompt or halfway through a release build — so the only honest answer comes
/// from the process table.
#[tauri::command(async)]
pub fn session_jobs(state: State<AppState>, session: String) -> usize {
    state.pty.jobs(&session)
}

#[tauri::command]
pub fn load_terminals(state: State<AppState>) -> crate::model::TerminalLayout {
    state.store().terminals()
}

#[tauri::command]
pub fn save_terminals(
    state: State<AppState>,
    layout: crate::model::TerminalLayout,
) -> Result<(), String> {
    state.store().save_terminals(&layout).map_err(|e| e.to_string())
}

/// Input for a session, from the window that owns it.
///
/// `window` comes from the runtime, so there is no token to pass and no call
/// site to change — `src/broadcast.ts` included. The refusals are named rather
/// than described: `not-owner` tells a window it is stale and should dispose,
/// `no-session` says the session is gone, which for a keystroke arriving just
/// after a close is ordinary. Both used to be `Ok(())`, which is exactly why a
/// stale window could never detect itself.
#[tauri::command]
pub fn write_session(
    window: tauri::WebviewWindow, state: State<AppState>, session: String, data: String,
) -> Result<(), String> {
    state.session_owners.check(&session, window.label()).map_err(|r| r.as_str().to_string())?;
    state.pty.write(&session, data.as_bytes()).map_err(session_io_error)
}
/// A new geometry for a session, from the window that owns it.
///
/// The ownership check is what keeps a resize that was in flight across the IPC
/// boundary when ownership changed from reaching the child: without it the
/// process gets a SIGWINCH for a geometry no visible window has, and an Ink
/// application repaints at the wrong width.
#[tauri::command]
pub fn resize_session(
    window: tauri::WebviewWindow, state: State<AppState>, session: String, cols: u16, rows: u16,
) -> Result<(), String> {
    state.session_owners.check(&session, window.label()).map_err(|r| r.as_str().to_string())?;
    state.pty.resize(&session, cols, rows).map_err(session_io_error)
}

/// What `window://gone` carries: the window that has just been destroyed.
///
/// The main window keeps a picture of what every other window holds, and draws a
/// detached workspace's row and its sessions from it. Nothing told it when a
/// window went away, so that picture outlived the window: the row stayed marked
/// as being elsewhere, could not be selected, and clicking it emitted into a
/// label nothing answers to — a workspace that had been brought back was
/// unreachable until the app restarted.
#[derive(Clone, Serialize)]
pub struct WindowGonePayload {
    pub label: String,
}

/// What `session://owner` carries: a session and the window that now holds it.
#[derive(Clone, Serialize)]
pub struct OwnerPayload {
    pub session: String,
    pub owner: String,
}

/// Take a running session over, output and all.
///
/// The receiving half of a workspace moving between windows. The order is the
/// whole design and it is not negotiable: **the receiving window becomes
/// authoritative before the source gives anything up.** By the time this
/// returns, the new window owns the session, its output arrives there, and every
/// write from the old window is refused (#240) — so the source can dispose
/// whenever it notices, and losing that race costs nothing.
///
/// It spawns nothing. `start_session` with `resume: true` would run
/// `claude --resume` against a PTY that is still alive, which is a second agent
/// on one conversation — the defect this whole epic starts from.
///
/// `sink` is a fresh output channel belonging to the calling window;
/// `PtyManager::retarget` swaps it in under the same lock the reader takes, so a
/// batch goes wholly to one window or wholly to the other. One already in flight
/// lands in the source, which is why the caller reconciles what it buffered
/// against the scrollback it was handed rather than assuming a clean cut.
#[tauri::command(async)]
pub async fn claim_session(
    app: AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>,
    session: String, sink: Channel<Response>,
) -> Result<(), String> {
    // Refuse an id nothing is running under, rather than recording an owner for
    // a session that does not exist and leaving the caller to build a panel for
    // it.
    state.pty.retarget(&session, move |bytes: Vec<u8>| {
        let _ = sink.send(Response::new(bytes));
    }).map_err(session_io_error)?;

    // After the retarget: if that failed there is nothing to own.
    state.session_owners.claim(&session, window.label());

    // Global rather than aimed at the source, because the source is whoever used
    // to own it and this is the message telling them so. A window compares the
    // owner against its own label; the one that matches has just asked for this
    // and ignores it.
    let _ = app.emit(
        "session://owner",
        OwnerPayload { session, owner: window.label().to_string() },
    );
    Ok(())
}

/// Name the one io error the frontend has to recognise, and pass every other
/// through as it reads.
///
/// A session the manager no longer holds is `NotFound`, and that is a race
/// between a keystroke and a close rather than a fault. Anything else reached
/// the PTY and failed there, which is worth its own words.
fn session_io_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        crate::ownership::NO_SESSION.to_string()
    } else {
        e.to_string()
    }
}
#[tauri::command]
pub fn close_session(
    state: State<AppState>,
    session: String,
    capture: Option<CaptureOnClose>,
) {
    // First of all, and it is a parameter of this command rather than a call the
    // frontend makes beforehand for exactly that reason. The note needs the
    // transcript path, `transcripts::forget` below takes it away, and an ordering
    // that lives inside one function cannot be got wrong by a caller — the same
    // reasoning as the `run_journal::close` line under it, one step earlier.
    if let Some(c) = capture {
        crate::memory::enqueue_on_close(&session, &c.workspace_id, c.cli_kind, c.session_name);
    }
    // Before the kill, so the result is read off the transcript this session was
    // still reporting. `run_journal::close` takes the record out of its own map,
    // so the PTY's `on_exit` arriving a moment later finds nothing to close and
    // cannot overwrite `ended` with an exit code nobody asked for.
    crate::run_journal::close(&session, crate::runs::RunStatus::Ended);
    state.pty.kill(&session);
    state.session_owners.release(&session);
    crate::transcripts::forget(&session);
    // And which conversation it was in, for the same reason: the id belongs to a
    // tile that is gone, and the next session to be given this id is a different
    // conversation entirely.
    crate::resume_ids::forget(&session);
    // The trailing output buffer, for the same reason the transcript goes: a
    // tile that is gone should not contribute a half-drawn banner to whatever
    // reuses its id.
    crate::usage::observed::forget(&session);
}

/// A closing session's note, when the person has agreed to one.
///
/// `Option<CaptureOnClose>` on `close_session` rather than a flag, because the
/// three fields are meaningless apart: a consent with no workspace has nowhere
/// to file the note, and one with no CLI cannot say which reader understands the
/// log. Absent means "close it and write nothing", which is what every close
/// before #366 meant.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CaptureOnClose {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "cliKind", default)]
    pub cli_kind: Option<String>,
    /// What the tile was called, so a failed job can name something a person
    /// recognises rather than an id.
    #[serde(rename = "sessionName", default)]
    pub session_name: Option<String>,
}

/// Quit, having been told to go ahead.
///
/// The counterpart to the refusal in `main.rs`: the app asked about the live
/// work it was about to destroy, the person said yes, and this is the yes. It
/// goes through `AppHandle::exit`, so the teardown still happens in the one
/// place that does it — `RunEvent::Exit` — rather than being duplicated here.
#[tauri::command]
pub fn quit_confirmed(app: AppHandle, state: State<AppState>) {
    state.quit_asked.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// The person said no. Disarming the flag is what makes the *next* quit ask
/// again instead of going straight through.
#[tauri::command]
pub fn quit_cancelled(state: State<AppState>) {
    state.quit_asked.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// A window saying that it has attached its listeners.
///
/// The label comes from the runtime rather than a parameter, for the reason
/// `load_layout` below takes a `WebviewWindow`: a window that could name another
/// would be able to unblock a hand-off that has not happened.
///
/// Synchronous, and cheap enough to stay that way: one lock, one insert into a
/// set of at most a handful of labels, and a wake of whoever is waiting. Making
/// it async would also make it race the window it is announcing.
#[tauri::command]
pub fn window_ready(window: tauri::WebviewWindow, state: State<AppState>) {
    state.windows_ready.mark(window.label());
}

/// How long a new window has to say it is listening before the attempt is
/// called a failure.
///
/// Generous, because what is being waited for is a webview booting on a machine
/// that may be busy compiling; short enough that a page which will never boot is
/// reported rather than left spinning. The cost of being wrong in either
/// direction is one dialog, not a lost session.
const WINDOW_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Open the window pinned to `workspace_id`, or raise it if it is already up.
///
/// Built here rather than in the webview. `core:webview:default` does not include
/// `allow-create-webview-window`, and granting window-spawning to a webview that
/// renders untrusted agent output buys less than it costs — the label scheme and
/// the window cap belong on this side anyway. `WebviewUrl::App` is same-origin,
/// exactly as the main window is, so the CSP is not a factor.
///
/// Returns only once the new window has announced itself, so a caller holding the
/// label may address it at once. A window that never announces itself is closed
/// and the failure reported: an inert window that renders and answers nothing is
/// the exact outcome the handshake exists to prevent, and leaving one on screen
/// would hide the cause rather than show it.
#[tauri::command(async)]
pub async fn open_workspace_window(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    // `at` is where to put it, in physical screen coordinates, and `drag` hands
    // the window straight to the OS's own move so the person keeps dragging what
    // is now an ordinary window. Both are set by the tear-out gesture and absent
    // for the plain trigger, which lets the window state plugin restore the
    // window wherever it was last left. `drag` is only meaningful with `at`.
    at: Option<(f64, f64)>,
    drag: Option<bool>,
) -> Result<String, String> {
    let label = crate::windows::workspace_label(&workspace_id);

    // The id arrives from the webview and is about to become a window label —
    // the thing every capability match, every emit target and every ownership
    // check is keyed on. One that does not survive the round trip would mint a
    // label naming a different workspace, or none at all; an empty id mints the
    // bare prefix, which parses back to nothing.
    if crate::windows::workspace_id_of(&label) != Some(workspace_id.as_str()) {
        return Err("that is not a workspace id a window can be opened for".to_string());
    }

    // Already open: raise it. Tauri refuses a second window with the same label,
    // and a person who asks twice means "show me that one".
    //
    // Before the store is consulted, deliberately. Raising needs no title and no
    // record — the window is on screen, whatever the store now says — and this
    // is the path that recovers the case nothing else can, a window that died
    // without announcing it. Refusing to raise something visible on the strength
    // of a file read would trade that recovery for nothing.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(label);
    }

    // The workspace has to still be there, and this is the only place that can
    // say so before a window exists. A window's label is minted from the id and
    // is then immutable, so a window opened for an id the store does not have is
    // pinned to nothing for as long as it lives: its sessions collect under
    // "Other" and it has no workspace row, which means no way to start a session
    // in it (#369).
    //
    // Reachable from an ordinary click. A window's copy of the list can be older
    // than the store — a pull that folded or deleted a record leaves the main
    // window drawing a row for it — and pressing that row lands here. Refusing
    // is what turns a silently broken window into a sentence, and the caller
    // re-reads its list when it hears this.
    let title = {
        // Scoped: the guard must not be held across the await below.
        let store = state.store();
        store.workspaces().into_iter().find(|w| w.id == workspace_id).map(|w| w.name)
    }
    .ok_or_else(|| "that workspace is no longer in the store".to_string())?;

    // A label is reusable — the same workspace pulled out, returned, and pulled
    // out again — and the readiness of the window that has gone is not this
    // one's. Cleared here as well as on `Destroyed` because only one of the two
    // is guaranteed to have run by now.
    state.windows_ready.forget(&label);

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("workspace.html".into()),
    )
    .title(title)
    .inner_size(1100.0, 760.0)
    // Hidden, then shown once the geometry is settled. The window-state plugin
    // restores size and position after the window exists, so a visible window
    // appears at the default position and visibly jumps to the remembered one.
    // The plugin's own `show()` is not in play: `StateFlags::VISIBLE` is cleared
    // in `main.rs`, which is what keeps it from focus-stealing.
    .visible(false)
    .build()
    .map_err(|e| format!("could not create the window for this workspace: {e}"))?;

    fit_to_display(&window);
    if let Some((x, y)) = at {
        // Offset so the cursor lands near the top-left of the new window rather
        // than at its centre: what the person is dragging should appear under
        // their hand, the way a torn-off tab does.
        let _ = window.set_position(tauri::PhysicalPosition::new(x - 60.0, y - 12.0));
        // After the placement, or the clamp would measure against the display the
        // window was built on rather than the one it was dropped on.
        fit_to_display(&window);
    }
    window
        .show()
        .map_err(|e| format!("the window for this workspace could not be shown: {e}"))?;
    if drag.unwrap_or(false) {
        // The OS takes over from here: the compositor's own move, so the window
        // follows the cursor natively and snapping and edge behaviour are the
        // platform's. Best effort — a window that did not pick up the drag is
        // still open, in the right place, holding the workspace.
        let _ = window.start_dragging();
    }

    if !state.windows_ready.wait_for(&label, WINDOW_READY_TIMEOUT).await {
        let _ = window.close();
        return Err("the window for this workspace did not finish loading".to_string());
    }
    Ok(label)
}

/// Cut a restored size down to the display the window actually landed on.
///
/// The window-state plugin applies a remembered position only when a monitor
/// intersects it, but applies a remembered **size** unconditionally — so a window
/// last sized on a 4K display reopens 3840px wide on a laptop, most of it and its
/// close button past the edge of the screen.
///
/// Best effort throughout: every step here can fail on a machine whose display
/// configuration is changing underneath it, and none of those failures is worth
/// refusing to open a window over. A window of the wrong size is recoverable by
/// dragging it; one that did not open is not.
fn fit_to_display(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else { return };
    let Ok(size) = window.outer_size() else { return };
    let area = monitor.work_area().size;
    let (w, h) = crate::windows::clamp_to_work_area(
        (size.width, size.height),
        (area.width, area.height),
    );
    if (w, h) != (size.width, size.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    }
}

/// The tiles this window should restore, and nobody else's.
///
/// `window` is supplied by the runtime rather than passed by the caller, so a
/// webview cannot ask for another window's tiles by naming a label — the same
/// reason it stamps the owner on the way out. `invoke("load_layout")` in
/// `src/ipc.ts` is unchanged and stays that way.
#[tauri::command]
pub fn load_layout(window: tauri::WebviewWindow, state: State<AppState>) -> Vec<SessionEntry> {
    state.store().layout_for(window.label())
}

/// Write this window's tiles into `sessions.json` without disturbing another
/// window's. See `Store::save_layout` for what the merge holds and why a
/// failed read refuses rather than truncating.
///
/// The conversation each session is in is taken from [`crate::resume_ids`] and
/// not from the caller, wherever this app run has learned one. The frontend does
/// send it — it reads it off the poll tick and keeps it on the tile — but the
/// backend is the one that knows, and two saves in the same tick used to be able
/// to lose it: `persistLayout` serialises the tiles it can see at the moment it
/// is called, so a save fired for tile A carried tile B's fork as still absent,
/// and if that save landed last the id was gone from the file with nothing left
/// to notice — the in-memory copy already matched, so nothing would write it
/// again (#199). Taking it from the map instead makes every save carry the
/// freshest answer, whatever order they arrive in.
///
/// What the caller sent still stands where the map has nothing: a restored tile
/// carries its fork from the layout for the whole of its life until its first
/// hook arrives, and that copy is the only one there is.
#[tauri::command]
pub fn save_layout(
    window: tauri::WebviewWindow, state: State<AppState>, mut sessions: Vec<SessionEntry>,
) -> Result<(), String> {
    for entry in sessions.iter_mut() {
        if let Some(current) = crate::resume_ids::get(&entry.session_id) {
            entry.resume_id = Some(current);
        }
    }
    let store = state.store();
    store.save_layout(window.label(), &sessions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_ui_state(state: State<AppState>) -> UiState {
    state.store().ui_state()
}

#[tauri::command]
pub fn save_ui_state(state: State<AppState>, ui: UiStatePatch) -> Result<(), String> {
    // Applied to the live flag as well as written to the file, and in that order
    // of importance: the registry holds this `Arc` and the providers read it on
    // every fetch, so a person turning the reported source off has it off before
    // the next poll rather than after the next launch.
    if let Some(on) = ui.usage_reported {
        state.usage_reported.store(on, std::sync::atomic::Ordering::Relaxed);
        state.usage.invalidate("claude");
    }
    state.store().save_ui_state(&ui).map_err(|e| e.to_string())
}

/// How long the whole snapshot may take.
///
/// Generous, and it can be: this is never on the paint tick. The registry's TTL
/// keeps it to once every five minutes per provider, and the frontend draws the
/// block from the previous answer while this one is in flight. The number is set
/// by the slowest thing inside it — a whole `claude` process, measured at about
/// four seconds — with room for a machine under load.
const USAGE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(20);

/// What every connected AI has left, and where each number came from.
///
/// `force` is "read again", and the moment a limit banner goes past on a PTY:
/// the two cases where a cached "you are fine" is a lie.
///
/// A blocking body behind `command(async)`, which is how `config_paths` next
/// door does it: every provider in here may start a process and read files, and
/// Tauri runs an `(async)`-marked synchronous command on its thread pool. An
/// `async fn` would put that work on the runtime's own threads and every other
/// command behind it.
#[tauri::command(async)]
pub fn usage_snapshot(state: State<AppState>, force: bool) -> Vec<crate::usage::model::AiUsage> {
    let now = chrono::Utc::now().timestamp_millis();
    state.usage.snapshot(now, force, USAGE_DEADLINE)
}

/// Forget the refusals this app watched happen, for one provider.
///
/// The escape hatch the observed source needs: a parser can be wrong, and an app
/// insisting the budget is spent while sessions are plainly running would be
/// worse than one that never said so. Reached from the dialog, and it clears the
/// cache too so the next read is not the same stale answer.
#[tauri::command(async)]
pub fn usage_clear_observed(state: State<AppState>, provider: String) {
    crate::usage::observed::clear(&provider);
    state.usage.invalidate(&provider);
}

/// Called by main during setup to emit state changes coming from the listener.
///
/// `Ended` closes the session's journal record; `Done` deliberately does not.
/// The agent finishing a turn and parking at the prompt leaves a tile the person
/// can keep typing into, and the last thing it said is read at close time off
/// the same transcript either way — see `run_journal::close`.
pub fn emit_state(app: &AppHandle, session: String, state: crate::model::SessionState) {
    if state == crate::model::SessionState::Ended {
        crate::run_journal::close(&session, crate::runs::RunStatus::Ended);
    }
    let _ = app.emit("session://state", StatePayload { session, state });
}

/// The directories a path from the frontend may name, derived from the store.
///
/// `worktrees` for the three `git -C` commands, whose argument is always a
/// session's working directory; `revealable` for `reveal_path`, which is also
/// asked about a note in the config directory and a transcript under Claude
/// Code's own. See `reachable` for why this is derived rather than recorded, and
/// for what it does and does not narrow.
fn git_roots(state: &AppState) -> crate::reachable::Roots {
    let store = state.store();
    let workspaces = store.workspaces();
    crate::reachable::Roots::worktrees(workspaces.iter().map(|w| w.path.as_str()))
}

fn revealable_roots(state: &AppState) -> crate::reachable::Roots {
    let store = state.store();
    let workspaces = store.workspaces();
    crate::reachable::Roots::revealable(
        workspaces.iter().map(|w| w.path.as_str()),
        &store.dir,
    )
}

#[tauri::command(async)]
pub fn git_status(state: State<'_, AppState>, cwd: String) -> GitStatus {
    // A path outside every workspace answers the way an unreadable one does —
    // the frontend already draws nothing for a branchless status, and a refusal
    // it had to render would be a message about a path nobody typed.
    if !git_roots(&state).contains(&cwd) {
        return GitStatus { branch: None, dirty: false };
    }
    git_status_in(&cwd)
}

/// `git_status` with the reachability check already made.
///
/// Split out so the tests can reach it: the check needs `State<AppState>`, which
/// a unit test cannot build, and a body only reachable through a Tauri command is
/// a body with no tests. The same split is below for the other three.
fn git_status_in(cwd: &str) -> GitStatus {
    use std::process::Command;
    let branch = Command::new("git")
        .arg("-C").arg(cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let dirty = branch.is_some()
        && Command::new("git")
            .arg("-C").arg(cwd)
            .args(["status", "--porcelain"])
            .output().ok()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);
    GitStatus { branch, dirty }
}

/// Every file this app writes for itself, by name, in the directory it writes them
/// to.
///
/// Named rather than listed off the disk with `read_dir`, and that is the whole
/// design: `read_dir` answers "what is there", and the question a person opening
/// Settings has is "what does this app keep about me" — which includes the file
/// that does not exist yet because they have never saved a scenario. A directory
/// listing would quietly leave that one out.
const CONFIG_FILES: [&str; 8] = [
    "workspaces.json",
    "skills.json",
    "sessions.json",
    "terminals.json",
    "ui_state.json",
    "schedule_state.json",
    "runs.jsonl",
    "usage_state.json",
];

/// Split from the command so it can be tested against a real directory: the rule
/// with something to get wrong is "a missing file is reported, not dropped".
fn config_files(dir: &std::path::Path) -> Vec<ConfigFile> {
    CONFIG_FILES
        .iter()
        .map(|name| ConfigFile {
            name: (*name).to_string(),
            exists: dir.join(name).exists(),
        })
        .collect()
}

#[tauri::command(async)]
pub fn config_paths(state: State<AppState>) -> ConfigPaths {
    // The lock is taken and released around the reads rather than held across
    // them, which is the rule the note at the top of this file states.
    let dir = { state.store().dir.clone() };
    ConfigPaths {
        dir: dir.to_string_lossy().to_string(),
        files: config_files(&dir),
    }
}

/// The files in a session's own checkout, as git sees them.
///
/// `git ls-files` rather than a directory walk, and that is the whole design: the
/// question a worktree raises is "what is MINE here", and `--exclude-standard`
/// answers it with the repository's own ignore rules instead of a list of ignore
/// patterns we would have to keep in step with them. `node_modules` and `target`
/// are absent because the repository says they are, not because this code knows
/// their names.
///
/// Tracked and untracked-but-not-ignored, which is the same pair a person sees in
/// `git status`. Paths are relative to `cwd` and separated by `\n`; a path with a
/// newline in it comes back quoted by git and is left that way rather than
/// silently splitting into two files that do not exist.
#[tauri::command(async)]
pub fn worktree_files(state: State<'_, AppState>, cwd: String) -> Vec<String> {
    if !git_roots(&state).contains(&cwd) {
        return Vec::new();
    }
    worktree_files_in(&cwd)
}

fn worktree_files_in(cwd: &str) -> Vec<String> {
    use std::process::Command;
    let out = Command::new("git")
        .arg("-C").arg(cwd)
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let mut files: Vec<String> = out.lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
    files.sort();
    files.dedup();
    files
}

/// What this checkout has changed, file by file, with the branch it is on.
///
/// Two reads folded into one answer, because they are two halves of one question
/// and a caller asking twice would paint half of it: `--porcelain` says WHICH
/// files and how, `--numstat` says how much. A file appears once, with zeroes when
/// git has nothing to diff it against.
#[tauri::command(async)]
pub fn git_changes(state: State<'_, AppState>, cwd: String) -> GitChanges {
    if !git_roots(&state).contains(&cwd) {
        return GitChanges { branch: None, files: Vec::new() };
    }
    git_changes_in(&cwd)
}

fn git_changes_in(cwd: &str) -> GitChanges {
    use std::process::Command;
    let git = |args: &[&str]| {
        Command::new("git")
            .arg("-C").arg(cwd)
            .args(args)
            .output().ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    };
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();
    GitChanges {
        branch: Some(branch).filter(|b| !b.is_empty() && b != "HEAD"),
        files: merge_changes(&git(&["status", "--porcelain"]), &git(&["diff", "--numstat", "HEAD"])),
    }
}

/// Fold `git status --porcelain` and `git diff --numstat HEAD` into one list.
///
/// Split out from the command because it is the part with rules in it, and rules
/// are what tests can hold: the mark is the WORKTREE's letter when there is one
/// and the index's otherwise (a file staged and then edited again is `M` either
/// way, but one staged and untouched since reads `M` only in the index column); a
/// rename's path is the destination, since that is the file that exists now; and a
/// binary file's `-` in numstat is a zero rather than a parse failure.
fn merge_changes(porcelain: &str, numstat: &str) -> Vec<GitChange> {
    let mut sizes: std::collections::HashMap<&str, (u32, u32)> = std::collections::HashMap::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let added = parts.next().unwrap_or("-");
        let removed = parts.next().unwrap_or("-");
        let Some(path) = parts.next() else { continue };
        sizes.insert(
            path,
            (added.parse().unwrap_or(0), removed.parse().unwrap_or(0)),
        );
    }
    let mut files = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 { continue }
        let (status, rest) = line.split_at(2);
        let index = status.as_bytes()[0] as char;
        let work = status.as_bytes()[1] as char;
        let mark = if work != ' ' { work } else { index };
        // `R  old -> new`: the destination is the file that exists now, and the one
        // a person clicking the row wants opened.
        let path = rest.trim_start();
        let path = path.rsplit(" -> ").next().unwrap_or(path);
        let (added, removed) = sizes.get(path).copied().unwrap_or((0, 0));
        files.push(GitChange {
            mark: mark.to_string(),
            path: path.to_string(),
            added,
            removed,
        });
    }
    files
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

/// How many tool calls this buffer holds, deduplicated by `tool_use.id` across
/// every buffer a session's read touches.
///
/// The number on the activity button, and the reason it rides here rather than
/// in a second command: the poll already reads and JSON-parses every line of
/// every open session's transcript, and walking the `content[]` of the assistant
/// lines it has already parsed is cheap beside that parse. The **breakdown** does
/// not ride the poll — `session_activity` is called when the panel opens.
///
/// Deliberately not shaped like `fold_usage_lines` next door, which dedupes by
/// `message.id` because a transcript writes one line per content block and every
/// one repeats the identical usage object. The repetition is in the usage, not
/// in the blocks: 1673 `tool_use` blocks across 27 measured files carried 1673
/// distinct ids. `seen` is threaded through anyway, so a session's own
/// transcript and its subagents deduplicate against one shared set.
pub fn fold_tool_calls(
    content: &str,
    seen: &mut std::collections::HashSet<String>,
) -> u32 {
    let mut calls = 0;
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Measured: `message.content` is a string on some lines. Skip those the
        // way the usage fold skips a line without usage.
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            if b["type"].as_str() != Some("tool_use") {
                continue;
            }
            match b["id"].as_str() {
                Some(id) => {
                    if seen.insert(id.to_string()) {
                        calls += 1;
                    }
                }
                // A block with no id is a shape we have not seen, so count it
                // rather than silently drop it — the rule the usage fold follows
                // for a line without `message.id`.
                None => calls += 1,
            }
        }
    }
    calls
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

/// The three names a transcript can carry, newest of each kind.
///
/// `custom` is what a person typed inside Claude Code, `ai` is what Claude Code
/// generated, `prompt` is the opening prompt echoed back. All three are already
/// sanitised; a field that sanitises to nothing is `None`, never `Some("")`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptTitle {
    /// `custom-title` / `customTitle` — renamed inside Claude Code.
    pub custom: Option<String>,
    /// `ai-title` / `aiTitle`.
    pub ai: Option<String>,
    /// `last-prompt` / `lastPrompt` — a primary path, not a corner: measured
    /// across 96 transcripts, 23% never get a title of either other kind.
    pub prompt: Option<String>,
}

/// Which of the three a displayed title came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleSource {
    Custom,
    Ai,
    Prompt,
}

impl TranscriptTitle {
    /// The name to show, and where it came from: `custom` → `ai` → `prompt`.
    ///
    /// `custom` outranks `ai` because Claude Code stops emitting `ai-title` once a
    /// conversation is renamed inside it — for 13 of 96 measured transcripts
    /// `customTitle` is the only name on disk. The two never appear in one file, so
    /// the ordering is insurance, and it is the direction that respects a
    /// deliberate human rename.
    ///
    /// One place, so the "never an empty string" guarantee is testable once.
    pub fn resolved(&self) -> Option<(String, TitleSource)> {
        let (t, src) = match (&self.custom, &self.ai, &self.prompt) {
            (Some(t), _, _) => (t, TitleSource::Custom),
            (_, Some(t), _) => (t, TitleSource::Ai),
            (_, _, Some(t)) => (t, TitleSource::Prompt),
            _ => return None,
        };
        Some((t.clone(), src))
    }
}

/// Longest name we keep. The same string reaches `sessions.json`, a desktop
/// notification body and a confirmation sentence, so it is capped once here.
const TITLE_CAP: usize = 120;

/// Strip control characters, collapse whitespace runs, trim, and cap at
/// [`TITLE_CAP`] **characters**.
///
/// Chars, never bytes: 80% of real titles are Cyrillic and a byte cap splits a
/// character. A whitespace control character (a newline inside `lastPrompt`, say)
/// becomes a space rather than vanishing, so two words do not merge into one.
fn sanitise_title(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut kept = 0usize;
    let mut space = false;
    for ch in raw.chars() {
        if kept == TITLE_CAP {
            break;
        }
        if ch.is_whitespace() {
            // A leading run is dropped rather than remembered, which is the trim.
            space = kept > 0;
            continue;
        }
        if ch.is_control() {
            continue;
        }
        if space {
            out.push(' ');
            kept += 1;
            space = false;
            if kept == TITLE_CAP {
                break;
            }
        }
        out.push(ch);
        kept += 1;
    }
    // A separator can only be written before a character, so there is no trailing
    // one to trim — except when the cap fell exactly on it.
    let out = out.trim_end();
    if out.is_empty() { None } else { Some(out.to_string()) }
}

/// The newest title line of each kind, scanning **backwards**.
///
/// Backwards because each line is re-appended constantly — median 27 occurrences
/// per transcript, max 267 — so a parser taking the first hit reads a stale name;
/// and because `str::Lines` is a `DoubleEndedIterator`, so with a cheap `contains`
/// prefilter the walk stops at the first hit and costs 0.00 ms in the common case.
///
/// Not a tail read: one line in the corpus is 1,227,203 bytes, so a fixed window
/// off the end can contain no newline at all.
///
/// Tolerant of what a file read mid-flush contains — non-JSON lines, a truncated
/// last line, a title field of the wrong type.
pub fn last_title_lines(content: &str) -> TranscriptTitle {
    let mut t = TranscriptTitle::default();
    for line in content.lines().rev() {
        if t.custom.is_some() && t.ai.is_some() && t.prompt.is_some() {
            break;
        }
        if !(line.contains("Title") || line.contains("lastPrompt")) {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for (slot, field) in [
            (&mut t.custom, "customTitle"),
            (&mut t.ai, "aiTitle"),
            (&mut t.prompt, "lastPrompt"),
        ] {
            if slot.is_none() {
                *slot = v[field].as_str().and_then(sanitise_title);
            }
        }
    }
    t
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
pub(crate) fn subagent_transcripts(transcript: &std::path::Path) -> Vec<std::path::PathBuf> {
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

/// What one transcript and its subagents cost, off a buffer already in hand.
///
/// Subagents included, because leaving them out understated a session's spend by
/// up to two thirds — in one measured case a single subagent outspent the entire
/// main chain (#189). One unreadable subagent understates the bill rather than
/// discarding the main chain's figure with it, exactly as `snapshot_from_main`
/// treats the same case.
pub(crate) fn transcript_spend(main: &str, path: &std::path::Path) -> TokenUsage {
    let mut seen = std::collections::HashSet::new();
    let mut spend = TokenUsage::default();
    fold_usage_lines(main, &mut seen, &mut spend);
    for sub in subagent_transcripts(path) {
        if let Ok(content) = std::fs::read_to_string(&sub) {
            fold_usage_lines(&content, &mut seen, &mut spend);
        }
    }
    spend
}

/// Everything one poll tick wants to know about one session.
///
/// `SessionTokens` is wrapped rather than extended: it is the token reading and
/// nothing else, and hanging a name off it would make a measurement carry a
/// label. `tokens: None` keeps its own meaning — the reading is *unavailable*,
/// which is not the same as a session that has spent nothing, and it is why a
/// lost transcript hides the badge instead of drawing four zeroes.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionSnapshot {
    pub tokens: Option<SessionTokens>,
    /// Never `Some("")` — see `sanitise_title`. The `null` is the contract.
    pub title: Option<String>,
    #[serde(rename = "titleSource")]
    pub title_source: Option<TitleSource>,
    /// Tool calls in this session's whole conversation, subagents included — the
    /// number the activity button carries, so the panel is worth opening before
    /// it is opened.
    ///
    /// `Option` for the reason `tokens` is: `None` is "there is nothing to read",
    /// and `Some(0)` is "the log is here and this session has made no calls".
    /// Those are two different sentences and one number cannot carry both — the
    /// distinction this whole feature is drawn around.
    pub calls: Option<u32>,
    /// The conversation this session is in now, when a hook has reported one
    /// other than the id the deck launched it with — i.e. after a `/clear`.
    ///
    /// Read off `crate::resume_ids` rather than out of the transcript, and it
    /// rides this batch because the tick is what the frontend already has: the
    /// deck persists it into its layout entry, which is the only copy that
    /// survives a restart and so the only thing auto-restore can resume by
    /// (#199). `None` is a session still in its launch conversation.
    #[serde(rename = "resumeId")]
    pub resume_id: Option<String>,
}

/// One read, one pass, both results — for every requested session at once.
///
/// Batched rather than per-session because the title and the token counts come
/// from the same bytes: a titles-only command beside `session_tokens` would take
/// the tick from N invokes to N+1 and parse every transcript twice.
///
/// **Every requested id gets an entry**, including ids with no transcript, whose
/// entry carries `tokens: null` and no title. `tsconfig.json` has `strict: true`
/// but not `noUncheckedIndexedAccess`, so a dropped key is typed as present on
/// the TS side and becomes a runtime `undefined` with no compile error at the
/// call site. A missing transcript is not an error.
#[tauri::command(async)]
pub async fn session_snapshots(
    session_ids: Vec<String>,
) -> std::collections::HashMap<String, SessionSnapshot> {
    // spawn_blocking per session, then join: the worst case is roughly max-of-N
    // rather than sum-of-N, and the reads are file I/O on a runtime that already
    // carries `rt-multi-thread`.
    let jobs: Vec<_> = session_ids
        .into_iter()
        .map(|id| {
            tokio::task::spawn_blocking(move || {
                let mut snap = read_session_snapshot(&id);
                // Set here rather than inside `read_session_snapshot`, which
                // returns an empty snapshot the moment there is no transcript to
                // read — and a session that was cleared thirty seconds ago is
                // exactly one whose new transcript may not be on disk yet.
                snap.resume_id = crate::resume_ids::get(&id);
                (id, snap)
            })
        })
        .collect();
    let mut out = std::collections::HashMap::new();
    for job in jobs {
        if let Ok((id, snap)) = job.await {
            out.insert(id, snap);
        }
    }
    out
}

/// The blocking half of [`session_snapshots`]: locate the transcript, read it
/// once, and take every answer off that one buffer. A transcript that is missing
/// or unreadable is an empty snapshot — no reading, no title.
fn read_session_snapshot(session_id: &str) -> SessionSnapshot {
    let path = match current_transcript(session_id) {
        Some(p) => p,
        None => return SessionSnapshot::default(),
    };
    let main = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return SessionSnapshot::default(),
    };
    snapshot_from_main(&main, &subagent_transcripts(&path))
}

/// Which file to read for a deck session: what Claude Code last reported through
/// a hook, else the launch id's own filename.
///
/// The reported path is what makes `/clear` survivable — clearing mints a new
/// session id and a new transcript, so the launch id stops naming the
/// conversation the person is in. The filename scan stays as the fallback, and
/// is still the answer for the whole of a restored tile's life until its first
/// hook arrives.
///
/// The reported path is checked rather than trusted: it is a path from another
/// program, and a transcript can be deleted between the hook and the tick.
pub(crate) fn current_transcript(session_id: &str) -> Option<std::path::PathBuf> {
    if let Some(reported) = crate::transcripts::get(session_id) {
        let path = std::path::PathBuf::from(reported);
        if path.is_file() {
            return Some(path);
        }
    }
    find_transcript(session_id)
}

/// Every answer off the main transcript's one buffer, plus whatever the
/// subagents spent. `seen` is threaded across all of them so one shared set of
/// request ids deduplicates the lot.
fn snapshot_from_main(main: &str, subagents: &[std::path::PathBuf]) -> SessionSnapshot {
    let (title, title_source) = match last_title_lines(main).resolved() {
        Some((t, src)) => (Some(t), Some(src)),
        None => (None, None),
    };
    let mut seen = std::collections::HashSet::new();
    let mut spend = TokenUsage::default();
    // Two sets, because the two folds deduplicate on different ids — see the
    // note on `fold_tool_calls`.
    let mut seen_calls = std::collections::HashSet::new();
    fold_usage_lines(main, &mut seen, &mut spend);
    let mut calls = fold_tool_calls(main, &mut seen_calls);
    let mut counted = 0;
    for sub in subagents {
        // One unreadable subagent understates the bill; it should not discard
        // the main chain's figure along with it.
        if let Ok(content) = std::fs::read_to_string(sub) {
            fold_usage_lines(&content, &mut seen, &mut spend);
            calls += fold_tool_calls(&content, &mut seen_calls);
            counted += 1;
        }
    }
    SessionSnapshot {
        tokens: Some(SessionTokens { context: last_context(main), spend, subagents: counted }),
        title,
        title_source,
        calls: Some(calls),
        // Not a fact about the transcript, and this function only reads one.
        // `session_snapshots` fills it from `resume_ids` after this returns —
        // which is also what gets it onto the snapshot of a session whose new
        // transcript is not on disk yet.
        resume_id: None,
    }
}

#[cfg(test)]
mod config_path_tests {
    use super::{config_files, CONFIG_FILES};

    /// A file that has never been written is reported as absent rather than left
    /// out of the list. The list is what this app keeps ABOUT you, and a person
    /// looking for a file they have not created yet needs to be told it is not
    /// there — not shown a shorter list.
    #[test]
    fn reports_a_missing_file_rather_than_dropping_it() {
        let dir = std::env::temp_dir().join(format!("cowork-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ui_state.json"), "{}").unwrap();

        let files = config_files(&dir);
        assert_eq!(files.len(), CONFIG_FILES.len());
        assert!(files.iter().find(|f| f.name == "ui_state.json").unwrap().exists);
        assert!(!files.iter().find(|f| f.name == "skills.json").unwrap().exists);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Every name is a plain JSON or JSONL file, which is the promise the window
    /// makes when it lists them: a person can read, diff and back one up without
    /// this app's help.
    #[test]
    fn every_file_is_plain_text() {
        for name in CONFIG_FILES {
            assert!(
                name.ends_with(".json") || name.ends_with(".jsonl"),
                "{name} is neither JSON nor JSONL",
            );
        }
    }
}

#[cfg(test)]
mod change_tests {
    use super::merge_changes;

    /// The mark is the worktree's letter when there is one. A file staged and then
    /// edited again reads `MM`, and what a person is looking at is the second M.
    #[test]
    fn takes_the_worktree_letter_when_there_is_one() {
        let files = merge_changes("MM src/app.ts\n", "4\t2\tsrc/app.ts\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].mark, "M");
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!((files[0].added, files[0].removed), (4, 2));
    }

    /// And the index's when the worktree column is blank — a file staged and not
    /// touched since is a change, and one this would otherwise mark with a space.
    #[test]
    fn falls_back_to_the_index_letter() {
        let files = merge_changes("A  tests/new.test.ts\n", "12\t0\ttests/new.test.ts\n");
        assert_eq!(files[0].mark, "A");
        assert_eq!(files[0].added, 12);
    }

    /// An untracked file has no counts, and 0/0 is the honest answer: `git diff`
    /// has nothing to compare it against, so its length is a number git never
    /// states. It is still a change, and it is still listed.
    #[test]
    fn lists_an_untracked_file_with_no_counts() {
        let files = merge_changes("?? notes.md\n", "");
        assert_eq!(files[0].mark, "?");
        assert_eq!(files[0].path, "notes.md");
        assert_eq!((files[0].added, files[0].removed), (0, 0));
    }

    /// A rename's path is the destination: that is the file that exists now, and
    /// the one a row leads to.
    #[test]
    fn a_rename_reports_where_the_file_went() {
        let files = merge_changes("R  src/old.ts -> src/new.ts\n", "0\t0\tsrc/new.ts\n");
        assert_eq!(files[0].mark, "R");
        assert_eq!(files[0].path, "src/new.ts");
    }

    /// numstat writes `-` for a binary file. Not a parse failure — a zero, beside
    /// the mark that says it changed.
    #[test]
    fn a_binary_file_counts_as_zero_rather_than_failing() {
        let files = merge_changes(" M docs/images/deck.png\n", "-\t-\tdocs/images/deck.png\n");
        assert_eq!(files[0].mark, "M");
        assert_eq!((files[0].added, files[0].removed), (0, 0));
    }

    /// A clean checkout is an empty list, not an error and not a fabricated row.
    #[test]
    fn a_clean_checkout_has_no_files() {
        assert!(merge_changes("", "").is_empty());
    }

    /// numstat carries a path that porcelain does not — a staged deletion whose
    /// entry has already been committed away, say — and the list follows
    /// porcelain: it is the one that says what the working tree looks like now.
    #[test]
    fn numstat_alone_does_not_invent_a_row() {
        assert!(merge_changes("", "3\t1\tsrc/ghost.ts\n").is_empty());
    }
}

#[cfg(test)]
mod path_guard_tests {
    use super::no_local_path;

    /// The marker is what the frontend matches on, the way `unavailableFrom`
    /// matches the `gh` states — so it is bare and stays at the front, and the
    /// prose after it can be reworded without breaking the match.
    #[test]
    fn the_sentence_carries_a_marker_and_says_what_to_do() {
        let m = no_local_path(Some("ws-1"));
        assert!(m.starts_with("no-local-path:"), "{m}");
        assert!(m.to_lowercase().contains("point it at one"), "{m}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reveal, never "open with". `open <path>` would hand a `.jsonl` to
    /// whatever is registered for it; the point is to show somebody where the
    /// file is. Argv rather than a shell string, so a path holding a space, a
    /// quote or a newline is one argument and means nothing to any interpreter.
    #[test]
    fn revealing_selects_the_file_rather_than_opening_it() {
        let path = std::path::Path::new("/home/u/.claude/projects/-p/a b'c.jsonl");
        let (program, args) = reveal_argv(path);
        if cfg!(target_os = "macos") {
            assert_eq!(program, "open");
            assert_eq!(args[0], "-R");
            assert_eq!(args[1], "/home/u/.claude/projects/-p/a b'c.jsonl");
        } else if cfg!(windows) {
            assert_eq!(program, "explorer");
            // The path is quoted and the switch is not: Explorer re-parses its
            // own command line and stops recognising `/select` once Rust's
            // quoting has wrapped the two together, which is what happens the
            // moment the path holds a space. `reveal_path` passes this through
            // `raw_arg` so nothing quotes it a second time.
            assert_eq!(args.len(), 1, "{args:?}");
            assert!(args[0].starts_with("/select,\""), "{args:?}");
            assert!(args[0].ends_with('"'), "{args:?}");
        } else {
            // No standard "select this file" on Linux, so the containing folder
            // is the honest approximation rather than a silently different
            // action on some other file.
            assert_eq!(program, "xdg-open");
            assert_eq!(args[0], "/home/u/.claude/projects/-p");
        }
    }

    /// Claude Code owns those files and they legitimately disappear. The UI
    /// disables the control where it can tell in advance; this covers the file
    /// going between the render and the click.
    #[test]
    fn revealing_a_file_that_is_gone_refuses_rather_than_spawning_anything() {
        let err = reveal_file("/nowhere/at/all/missing.jsonl")
            .expect_err("a missing transcript must not reach the file manager");
        assert!(err.contains("no longer there"), "{err}");
    }

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

    /// A title line is re-appended constantly — median 27 occurrences per
    /// transcript, max 267 — so taking the first hit reads a stale name.
    #[test]
    fn last_title_lines_takes_the_newest_ai_title() {
        let content = concat!(
            r#"{"type":"ai-title","aiTitle":"first name"}"#, "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":1}}}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"second name"}"#, "\n",
        );
        assert_eq!(last_title_lines(content).ai.as_deref(), Some("second name"));
    }

    #[test]
    fn a_custom_title_outranks_an_ai_title() {
        let content = concat!(
            r#"{"type":"custom-title","customTitle":"what the person called it"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"what the model called it"}"#, "\n",
        );
        let t = last_title_lines(content);
        assert_eq!(t.custom.as_deref(), Some("what the person called it"));
        assert_eq!(t.ai.as_deref(), Some("what the model called it"));
        assert_eq!(
            t.resolved(),
            Some(("what the person called it".to_string(), TitleSource::Custom)),
            "a deliberate human rename wins, even though the two never coexist in practice",
        );
    }

    #[test]
    fn the_last_prompt_is_only_a_fallback() {
        let prompt_only = r#"{"type":"last-prompt","lastPrompt":"собери отчёт"}"#;
        assert_eq!(
            last_title_lines(prompt_only).resolved(),
            Some(("собери отчёт".to_string(), TitleSource::Prompt)),
            "23% of sessions never get a title of another kind — this is a primary path",
        );
        let with_ai = format!("{prompt_only}\n{}\n", r#"{"type":"ai-title","aiTitle":"a name"}"#);
        assert_eq!(
            last_title_lines(&with_ai).resolved(),
            Some(("a name".to_string(), TitleSource::Ai)),
        );
    }

    #[test]
    fn a_transcript_with_no_title_lines_yields_nothing() {
        let content = concat!(
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#, "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10}}}"#, "\n",
        );
        assert_eq!(last_title_lines(content), TranscriptTitle::default());
        assert_eq!(last_title_lines(content).resolved(), None);
    }

    #[test]
    fn a_title_that_sanitises_to_nothing_is_none_not_empty() {
        let content = concat!(
            r#"{"type":"ai-title","aiTitle":"   "}"#, "\n",
            r#"{"type":"custom-title","customTitle":""}"#, "\n",
        );
        let t = last_title_lines(content);
        assert_eq!(t.ai, None, "whitespace only is absent, not an empty name");
        assert_eq!(t.custom, None);
        assert_eq!(t.resolved(), None);
    }

    #[test]
    fn non_json_lines_are_skipped() {
        let content = concat!(
            r#"{"type":"ai-title","aiTitle":"a name"}"#, "\n",
            "not json at all, but it does mention aiTitle", "\n",
        );
        assert_eq!(last_title_lines(content).ai.as_deref(), Some("a name"));
    }

    /// The file is read while Claude Code is writing it, so the last line can be
    /// half a line.
    #[test]
    fn a_truncated_last_line_does_not_hide_the_previous_title() {
        let content = concat!(
            r#"{"type":"ai-title","aiTitle":"a name"}"#, "\n",
            r#"{"type":"ai-title","aiTi"#,
        );
        assert_eq!(last_title_lines(content).ai.as_deref(), Some("a name"));
    }

    #[test]
    fn an_oversized_title_is_capped_on_a_char_boundary() {
        let long: String = "я".repeat(300);
        let content = format!(r#"{{"type":"ai-title","aiTitle":"{long}"}}"#);
        let name = last_title_lines(&content).ai.expect("a name");
        assert_eq!(name.chars().count(), 120, "chars, never bytes");
        assert!(name.len() > 120, "the cap is not a byte cap — Cyrillic is two bytes a char");
        assert!(std::str::from_utf8(name.as_bytes()).is_ok(), "still valid UTF-8");
    }

    #[test]
    fn control_characters_and_newlines_are_stripped_from_a_title() {
        // A `lastPrompt` carries whatever the person typed, newlines included; a
        // BEL can reach a title through terminal output pasted into a prompt.
        let content = r#"{"type":"last-prompt","lastPrompt":"first line\nsecond\tline\u0007"}"#;
        let name = last_title_lines(content).prompt.expect("a name");
        assert_eq!(name, "first line second line", "one line, whitespace runs collapsed");
        assert!(!name.chars().any(char::is_control), "no control character survives");
    }

    /// A single fixture, both facts. A future split back into two reads — one for
    /// the tokens, one for the title — fails here.
    #[test]
    fn usage_and_title_come_from_one_pass_over_one_buffer() {
        let content = [
            turn("msg_one", 10, 5, 0, 0, &["text"]),
            r#"{"type":"ai-title","aiTitle":"Отчёт по продажам"}"#.to_string(),
        ]
        .join("\n");
        let snap = snapshot_from_main(&content, &[]);
        let tokens = snap.tokens.expect("a reading");
        assert_eq!(tokens.spend.input, 10);
        assert_eq!(tokens.spend.output, 5);
        assert_eq!(snap.title.as_deref(), Some("Отчёт по продажам"));
        assert_eq!(snap.title_source, Some(TitleSource::Ai));
    }

    /// `tsconfig.json` has `strict: true` but not `noUncheckedIndexedAccess`, so a
    /// dropped key is typed as present on the TS side and becomes a runtime
    /// `undefined` with no compile error at the call site.
    #[tokio::test]
    async fn every_requested_session_gets_an_entry() {
        let ids: Vec<String> = ["no-such-a", "no-such-b", "no-such-c"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = session_snapshots(ids.clone()).await;
        assert_eq!(out.len(), 3);
        for id in &ids {
            assert!(out.contains_key(id), "{id} was dropped from the batch");
        }
    }

    /// The whole point of the reported path: after `/clear` the launch id names
    /// a file that will never grow again, and the tile has to follow the
    /// conversation the person is actually in.
    #[test]
    fn a_reported_transcript_wins_over_the_launch_id_filename() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let cleared = dir.path().join("after-clear.jsonl");
        std::fs::write(
            &cleared,
            [
                turn("msg_after_clear", 7, 0, 0, 0, &["text"]),
                r#"{"type":"ai-title","aiTitle":"The topic after clearing"}"#.to_string(),
            ]
            .join("\n"),
        )
        .expect("write");

        let session = "sess-cleared-fixture";
        crate::transcripts::record(session, cleared.to_str().expect("utf-8 path"));
        assert_eq!(current_transcript(session).as_deref(), Some(cleared.as_path()));

        let snap = read_session_snapshot(session);
        assert_eq!(snap.title.as_deref(), Some("The topic after clearing"));
        assert_eq!(snap.tokens.expect("a reading").spend.input, 7);
        crate::transcripts::forget(session);
    }

    /// A path from another program, and a transcript can be deleted between the
    /// hook and the tick — so it is checked, not trusted.
    #[test]
    fn a_reported_path_that_no_longer_exists_falls_back_to_the_scan() {
        let session = "sess-vanished-fixture";
        crate::transcripts::record(session, "/nowhere/at/all/gone.jsonl");
        // No transcript under HOME for this id either, so the fallback finds
        // nothing — the point is that it does not read the dead path.
        assert_eq!(current_transcript(session), None);
        assert_eq!(read_session_snapshot(session).title, None);
        crate::transcripts::forget(session);
    }

    #[test]
    fn a_session_nobody_reported_still_resolves_by_its_launch_id() {
        // A restored tile, before its first hook: the filename scan is the only
        // answer there is, and it must still be reached.
        assert_eq!(current_transcript("sess-never-reported-fixture"), None);
    }

    #[tokio::test]
    async fn a_missing_transcript_is_not_an_error() {
        let out = session_snapshots(vec!["no-transcript-anywhere".to_string()]).await;
        let snap = out.get("no-transcript-anywhere").expect("an entry");
        // An entry, and an empty one: `tokens: None` says the reading is
        // unavailable, which a tile draws as no badge rather than as four zeroes.
        assert!(snap.tokens.is_none(), "unavailable, not zero");
        assert_eq!(snap.title, None);
        assert_eq!(snap.title_source, None);
    }

    #[test]
    fn a_title_field_of_the_wrong_type_is_ignored() {
        let content = concat!(
            r#"{"type":"ai-title","aiTitle":"a name"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":{"text":"an object"}}"#, "\n",
            r#"{"type":"custom-title","customTitle":42}"#, "\n",
        );
        let t = last_title_lines(content);
        assert_eq!(t.ai.as_deref(), Some("a name"), "the wrong type is skipped, not fatal");
        assert_eq!(t.custom, None);
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
    /// A tool call is counted once per id, and a line the fold does not
    /// understand costs nothing.
    #[test]
    fn tool_calls_are_counted_once_per_id_across_a_sessions_buffers() {
        let mut seen = std::collections::HashSet::new();
        let main = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Read"}]}}"#, "\n",
            r#"{"type":"user","message":{"content":"a sentence, not an array"}}"#, "\n",
            "not json at all", "\n",
        );
        assert_eq!(fold_tool_calls(main, &mut seen), 2);

        // A subagent's own calls add to the same total against the same set.
        let sub = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Grep"}]}}"#, "\n",
        );
        assert_eq!(fold_tool_calls(sub, &mut seen), 1);
    }

    /// `None` is not zero. A snapshot with no transcript says nothing about
    /// calls; one off an empty transcript says there have been none.
    #[test]
    fn no_transcript_leaves_the_call_count_unsaid_rather_than_at_zero() {
        assert_eq!(SessionSnapshot::default().calls, None);
        assert_eq!(snapshot_from_main("", &[]).calls, Some(0));
    }

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
        let args = build_claude_args("{\"hooks\":{}}", &Some("collect email report".into()), "sess-1", None, &[]);
        assert_eq!(args, vec![
            "--settings".to_string(), "{\"hooks\":{}}".to_string(),
            "--session-id".to_string(), "sess-1".to_string(),
            "collect email report".to_string(),
        ]);
    }

    #[test]
    fn builds_claude_args_first_launch_without_prompt() {
        let args = build_claude_args("{}", &None, "sess-1", None, &[]);
        assert_eq!(args, vec![
            "--settings".to_string(), "{}".to_string(),
            "--session-id".to_string(), "sess-1".to_string(),
        ]);
    }

    /// The failure this ordering exists to prevent: memory added inside one
    /// branch means a session that survived a restart quietly loses it, and a
    /// restored tile is the long-running session most likely to want it.
    #[test]
    fn memory_reaches_both_launch_paths() {
        let memory = vec![
            "--mcp-config".to_string(),
            "{\"mcpServers\":{}}".to_string(),
            "--append-system-prompt".to_string(),
            "consult it".to_string(),
        ];
        for resume in [None, Some("sess-1")] {
            let args = build_claude_args("{}", &Some("p".into()), "sess-1", resume, &memory);
            assert!(args.iter().any(|a| a == "--mcp-config"), "resume={resume:?}: {args:?}");
            assert!(
                args.iter().any(|a| a == "--append-system-prompt"),
                "resume={resume:?}: {args:?}",
            );
        }
    }

    /// The hazard the placement exists to avoid, asserted rather than reasoned
    /// about. `--mcp-config` takes `<configs...>` and keeps consuming arguments
    /// until one starts with a dash — measured against the real CLI, which read
    /// `mcp` and `list` as two more config paths and failed. The initial prompt is
    /// positional, so a `--mcp-config` immediately in front of it would lose the
    /// prompt into the flag.
    #[test]
    fn no_positional_follows_the_mcp_config() {
        let memory = vec![
            "--mcp-config".to_string(),
            "{\"mcpServers\":{}}".to_string(),
            "--append-system-prompt".to_string(),
            "consult it".to_string(),
        ];
        for resume in [None, Some("sess-1")] {
            let args =
                build_claude_args("{}", &Some("a prompt".into()), "sess-1", resume, &memory);
            let at = args.iter().position(|a| a == "--mcp-config").expect("the flag");
            // One value, then something that stops the variadic.
            let after = args.get(at + 2).map(String::as_str);
            assert!(
                after.is_none_or(|a| a.starts_with('-')),
                "resume={resume:?}: {after:?} would be eaten by --mcp-config in {args:?}",
            );
        }
    }

    /// A build with no sidecar staged adds nothing, so the launch is exactly what
    /// it was before memory existed — no empty flag, no `--mcp-config {}`.
    #[test]
    fn no_memory_to_offer_adds_no_arguments() {
        let with = build_claude_args("{}", &None, "sess-1", None, &[]);
        assert_eq!(with, vec!["--settings", "{}", "--session-id", "sess-1"]);
    }

    /// `--settings` stays first. It carries the hooks, and the reporter's own
    /// tests read that position.
    #[test]
    fn the_settings_stay_where_they_were() {
        let args = build_claude_args("{\"hooks\":{}}", &None, "s", None, &["--x".to_string()]);
        assert_eq!(args[0], "--settings");
        assert_eq!(args[1], "{\"hooks\":{}}");
    }

    /// The prompt is the last argument on a first launch — it is positional, and
    /// a flag appended after it would be read as part of it.
    #[test]
    fn the_prompt_stays_last_with_memory_in_front_of_it() {
        let args = build_claude_args(
            "{}",
            &Some("collect the report".into()),
            "s",
            None,
            &["--mcp-config".to_string(), "{}".to_string()],
        );
        assert_eq!(args.last().unwrap(), "collect the report");
    }

    #[test]
    fn builds_claude_args_resume_uses_resume_flag_and_ignores_prompt() {
        let args = build_claude_args("{}", &Some("ignored".into()), "sess-1", Some("sess-1"), &[]);
        assert_eq!(args, vec![
            "--settings".to_string(), "{}".to_string(),
            "--resume".to_string(), "sess-1".to_string(),
        ]);
    }

    /// #199, at the one line that decides it. A cleared session's tile is still
    /// `sess-1` — its pty key, its `COWORK_SESSION`, the key its hooks are
    /// attributed by — but the conversation it is in is a different id, and that
    /// is what `--resume` must name. The old signature took a `bool` and could
    /// only ever resume `session_id`, which succeeds and brings back the
    /// conversation the person cleared away.
    #[test]
    fn a_cleared_session_resumes_the_conversation_it_is_in_not_its_launch_id() {
        let args = build_claude_args("{}", &None, "sess-1", Some("after-the-clear"), &[]);
        assert_eq!(args, vec![
            "--settings".to_string(), "{}".to_string(),
            "--resume".to_string(), "after-the-clear".to_string(),
        ]);
        assert!(!args.iter().any(|a| a == "sess-1"), "the launch id is not resumed: {args:?}");
        // And it is still not pinned: `--session-id` belongs to a first launch.
        assert!(!args.iter().any(|a| a == "--session-id"), "{args:?}");
    }

    fn store_in_a_temp_dir() -> Mutex<Store> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cowork-resume-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Mutex::new(Store::new(dir))
    }

    fn entry(session: &str, resume_id: Option<&str>) -> SessionEntry {
        SessionEntry {
            session_id: session.to_string(),
            cwd: "/tmp".to_string(),
            name: "session".to_string(),
            workspace_id: None,
            task_id: None,
            scheduled_skill_id: None,
            user_name: None,
            name_kind: None,
            skill_id: None,
            run_id: None,
            owner: None,
            cli_kind: None,
            resume_id: resume_id.map(str::to_string),
        }
    }

    /// A session that has never been cleared resumes itself, which is every
    /// session before #199 and the great majority after it.
    #[test]
    fn resume_target_falls_back_to_the_launch_id() {
        let store = store_in_a_temp_dir();
        assert_eq!(resume_target(&store.lock().unwrap(), "t-plain"), "t-plain");
        // Including one whose layout entry exists and says nothing.
        store.lock().unwrap().save_layout("main", &[entry("t-stored-none", None)]).unwrap();
        assert_eq!(resume_target(&store.lock().unwrap(), "t-stored-none"), "t-stored-none");
    }

    /// The auto-restore path: the app has been closed and reopened, so nothing
    /// is in memory and the layout entry is the only copy of the fact left.
    #[test]
    fn resume_target_reads_the_layout_when_nothing_is_in_memory() {
        let store = store_in_a_temp_dir();
        store
            .lock()
            .unwrap()
            .save_layout("main", &[entry("t-restored", Some("conversation-2"))])
            .unwrap();
        assert_eq!(resume_target(&store.lock().unwrap(), "t-restored"), "conversation-2");
    }

    /// A `/clear` followed by a ⟳ before the poll tick has persisted anything —
    /// what a hook reported during this app run outranks the file, which may be
    /// one conversation behind.
    #[test]
    fn resume_target_prefers_what_a_hook_reported_over_the_layout() {
        let store = store_in_a_temp_dir();
        store
            .lock()
            .unwrap()
            .save_layout("main", &[entry("t-live", Some("conversation-2"))])
            .unwrap();
        crate::resume_ids::record("t-live", "conversation-3");
        assert_eq!(resume_target(&store.lock().unwrap(), "t-live"), "conversation-3");
        crate::resume_ids::forget("t-live");
    }

    /// A blank field is the launch id, not a `--resume ""`. Nothing this app
    /// writes produces one, and a hand-edited or half-written `sessions.json`
    /// should cost a tile its `/clear` rather than its launch.
    #[test]
    fn resume_target_ignores_a_blank_stored_id() {
        let store = store_in_a_temp_dir();
        store
            .lock()
            .unwrap()
            .save_layout("main", &[entry("t-blank", Some("   "))])
            .unwrap();
        assert_eq!(resume_target(&store.lock().unwrap(), "t-blank"), "t-blank");
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

        let clean = git_status_in(cwd);
        assert!(clean.branch.is_some(), "committed repo must report a branch");
        assert!(!clean.dirty, "just-committed repo is clean");

        std::fs::write(dir.join("b.txt"), "new").unwrap(); // untracked → dirty
        let dirty = git_status_in(cwd);
        assert!(dirty.dirty, "untracked file makes it dirty");

        let non_repo = git_status_in(std::env::temp_dir().to_str().unwrap());
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

    /// A tab is labelled with the shell, not with the path to it.
    #[test]
    fn a_shell_is_named_by_what_it_is_called() {
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("/opt/homebrew/bin/fish"), "fish");
        assert_eq!(shell_name("bash"), "bash");
        assert_eq!(shell_name(r"C:\Windows\System32\cmd.exe"), "cmd");
        // Nothing useful to shorten: better the whole string than an empty tab.
        assert_eq!(shell_name("/"), "/");
    }

    /// The banner's whole reason for existing: `GIT_AUTHOR_*` in the environment
    /// outranks `.git/config`, so `git config user.email` reports the value that
    /// does **not** win. The only side that can answer honestly is the one that
    /// set the variable, which is why this reads the environment rather than the
    /// workspace's configuration.
    #[test]
    fn the_banner_names_the_identity_the_shell_will_actually_commit_as() {
        let env = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        assert_eq!(
            git_identity(&env(&[
                ("GIT_AUTHOR_NAME", "Evgeny"),
                ("GIT_AUTHOR_EMAIL", "e@example.com"),
            ])),
            Some("Evgeny <e@example.com>".to_string()),
        );
        // Half a binding is still worth naming.
        assert_eq!(git_identity(&env(&[("GIT_AUTHOR_NAME", "Evgeny")])), Some("Evgeny".into()));
        assert_eq!(git_identity(&env(&[("GIT_AUTHOR_EMAIL", "e@x")])), Some("e@x".into()));
        // Nothing injected: the shell inherits `~/.gitconfig`, and claiming an
        // identity the app did not set would be the same lie in reverse.
        assert_eq!(git_identity(&env(&[("GH_TOKEN", "gho_x")])), None);
    }

    /// A shell the person did not configure is still a shell, and a dead tab
    /// would be worse than the wrong prompt.
    #[test]
    fn there_is_always_a_shell_to_open() {
        let (program, _args) = user_shell();
        assert!(!program.trim().is_empty());
    }

    /// The reason the exit payload had to grow: with one boolean, a session the
    /// app hung up at shutdown reported itself as an error, indistinguishable
    /// from a command that failed. It was stopped, not broken — and a tile that
    /// says "error" about the app's own teardown is a bug report waiting to be
    /// filed against nothing.
    #[test]
    fn a_stopped_session_is_ended_and_a_failed_one_is_an_error() {
        let signalled = crate::pty::Exit {
            code: None,
            signal: Some("Hangup".into()),
            unknown: false,
        };
        assert_eq!(state_of(&signalled), crate::model::SessionState::Ended);
        assert_eq!(run_status_of(&signalled), crate::runs::RunStatus::Ended);

        let failed = crate::pty::Exit { code: Some(1), signal: None, unknown: false };
        assert_eq!(state_of(&failed), crate::model::SessionState::Error);
        assert_eq!(run_status_of(&failed), crate::runs::RunStatus::Error);

        let clean = crate::pty::Exit { code: Some(0), signal: None, unknown: false };
        assert_eq!(state_of(&clean), crate::model::SessionState::Ended);

        // Not knowing is not success. It was `false` before, which happened to
        // be right for the wrong reason — the same `false` as `exit 1`.
        let unknown = crate::pty::Exit { code: None, signal: None, unknown: true };
        assert_eq!(state_of(&unknown), crate::model::SessionState::Error);
    }

    /// "You are not logged in" is exactly the message that makes a person run
    /// `gh auth login`, and this is the directory that login would write into —
    /// one directory shared by every degraded session of every workspace. A
    /// writable one turns the app's own honest degradation into app-wide global
    /// state, which is the inverse of the invariant the whole per-workspace
    /// binding rests on.
    #[cfg(unix)]
    #[test]
    fn a_login_cannot_write_into_the_shared_no_auth_directory() {
        use std::os::unix::fs::PermissionsExt;
        // Permission bits do not apply to root, so there is nothing to assert
        // in a container that runs as it.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: running as root, where the mode bits do not bind");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("gh-noauth");
        std::fs::create_dir_all(&dir).unwrap();
        harden_noauth_dir(&dir);

        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o500,
            "the no-auth directory must be readable and not writable",
        );
        assert!(
            std::fs::write(dir.join("hosts.yml"), "github.com:\n").is_err(),
            "a `gh auth login` could write credentials into the shared directory",
        );
        // Handed back so the temporary directory can be cleaned up.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
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
    /// `session_tokens` used to sit here as "one file read". Its successor
    /// `session_snapshots` opens a transcript *and* every subagent transcript
    /// beside it — fifty of them on a delegation-heavy session — for every open
    /// session at once, so it carries `(async)` like everything else that does
    /// real I/O.
    const MAIN_THREAD_COMMANDS: [&str; 16] = [
        // One lock, one insert, one wake. It also must not be async: a window
        // announcing itself cannot be allowed to race the window it announces.
        "window_ready",
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
        "load_terminals",
        "save_terminals",
        "load_ui_state",
        "save_ui_state",
    ];
    /// The same, for the four that must not be reordered — kept apart from the list
    /// above because these are the ones where moving a command off the main thread
    /// would be a *correctness* bug rather than merely unnecessary.
    const ORDERED_COMMANDS: [&str; 9] = [
        "start_session",
        "start_command_session",
        "write_session",
        "resize_session",
        "close_session",
        // Two flag writes and an `exit`. On the main thread because the answer
        // to "may I quit" must not overtake the question.
        "start_shell_session",
        "quit_confirmed",
        "quit_cancelled",
        "host_platform",
    ];

    /// Every `AppState` lock is taken through its accessor, and none of them
    /// panics on a poisoned mutex.
    ///
    /// Scanned rather than trusted, because the failure is invisible until it
    /// happens and total when it does: a poisoned mutex returns `Err` forever, so
    /// one `lock().unwrap()` on the store turns a single panic into a dead app —
    /// every later command that touches the store panics too, including the ones
    /// that would let a person save and leave. Nineteen of them were there when
    /// the audit found this (#463).
    ///
    /// A scan for the field name is the right shape here, unlike the allow-list
    /// above: the fault is one expression, spelled the same way every time, and a
    /// new command reaching for `state.store.lock()` is exactly what this must
    /// catch. `taken()` itself is the one place that may call `lock()`, and it is
    /// matched by its own definition rather than by a field.
    #[test]
    fn no_state_lock_is_unwrapped() {
        const LOCKS: [&str; 6] =
            ["store", "gh_tokens", "gh_repos", "session_envs", "shells", "issue_open_counts"];
        let files = [
            ("commands.rs", include_str!("commands.rs")),
            ("tasks_cmd.rs", include_str!("tasks_cmd.rs")),
            ("sync_cmd.rs", include_str!("sync_cmd.rs")),
            ("activity/mod.rs", include_str!("activity/mod.rs")),
        ];
        let mut found = Vec::new();
        for (name, src) in files {
            for (i, line) in src.lines().enumerate() {
                // This test's own source names the pattern it forbids.
                if line.trim_start().starts_with("//") || line.contains("LOCKS") {
                    continue;
                }
                for field in LOCKS {
                    if line.contains(&format!(".{field}.lock()")) {
                        found.push(format!("{name}:{} — {}", i + 1, line.trim()));
                    }
                }
            }
        }
        assert!(
            found.is_empty(),
            "these take an AppState lock directly instead of through its accessor, so a \
             poisoned mutex is fatal rather than survivable: {found:#?}. Use \
             `state.store()` and its five siblings — see `taken()`.",
        );
    }

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
