//! The deck's own memory: what past sessions did and decided, written down
//! where a later session — or a later machine — can find it.
//!
//! Phase 2 of #35 is the write path, and it is the half the feature stands on.
//! Search over an empty corpus is a working search that returns nothing, so
//! nothing here indexes, embeds or spawns the `cowork_memory` sidecar; under
//! ADR-0004 the markdown *is* the memory and the index is a cache built over it
//! afterwards, which is why the write path can be finished and tested with no
//! model on the machine at all.
//!
//! - [`corpus`] — where a note goes and what it looks like when it gets there.
//! - [`queue`] — the durable queue that makes capture a promise.
//! - [`transcript`] — reading a session's log, per CLI, because the deck runs
//!   sessions on four of them and their logs have nothing in common.
//! - [`capture`] — one `claude -p` per closed session, billed to the person.
//!
//! The root is the app's config directory, which is also the store's directory
//! and the sync repository root (ADR-0006). Neither module resolves it: both are
//! handed one, so every test runs against a temporary directory and nothing
//! there can write into a real corpus by accident. The process-wide wiring below
//! is where the real directory is named, once.

pub mod capture;
pub mod corpus;
pub mod queue;
pub mod transcript;

use queue::Queue;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// The config directory, set once from `main`'s setup.
///
/// A process-wide `OnceLock` rather than a field on `AppState`, for the reason
/// [`crate::run_journal`] gives about its own: the wiring happens in setup,
/// before `AppState` exists, and the queue has to be reachable from a close
/// handler that has no `State` to borrow.
fn dir() -> &'static OnceLock<PathBuf> {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    &DIR
}

fn app() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

/// The wrapup queue, or `None` before [`init`].
pub fn wrapup_queue() -> Option<Queue> {
    dir().get().map(|d| Queue::new(d.clone()))
}

/// Wire memory to the app's directory and window. Called once, from `main`'s
/// setup, before the frontend can close anything.
pub fn init(app_dir: PathBuf, handle: AppHandle) {
    let _ = dir().set(app_dir);
    let _ = app().set(handle);
}

/// Startup: clear every `running` claim a dead process left behind, and prune.
///
/// Called straight after [`init`] and before the frontend is up, which is what
/// makes the reasoning in [`Queue::recover`] sound — nothing has a job in flight
/// at this point, so every `running` job on disk is one the app died inside.
///
/// Warns rather than fails. A queue that could not be recovered is a summary or
/// two that will not be written, and it is not a reason to refuse to start the
/// app somebody opened to get their sessions back.
pub fn recover_wrapup_queue() {
    let Some(q) = wrapup_queue() else { return };
    match q.recover() {
        Ok(out) => {
            if out.requeued > 0 || out.failed > 0 {
                eprintln!(
                    "wrapup queue: {} job(s) queued again after an unclean stop, {} given up on",
                    out.requeued, out.failed,
                );
                announce();
            }
            if out.pruned > 0 {
                eprintln!("wrapup queue: pruned {} finished job(s)", out.pruned);
            }
        }
        Err(e) => eprintln!("warning: could not recover the wrapup queue ({e})"),
    }
}

/// The diary rooms a capture may route a lesson to.
///
/// Empty until #367, which owns where the list comes from and how it is edited.
/// Empty is a working state rather than a stub: the prompt then asks for no
/// lessons at all, and `capture::run` drops any that arrive anyway — a room
/// nobody configured is a directory nobody reads.
fn rooms() -> Vec<capture::Room> {
    Vec::new()
}

/// Whether a drain is already running.
///
/// The queue's own `next` stops one job being taken twice, but two *drains*
/// would each take a different job and spawn `claude` side by side. This is what
/// keeps "one at a time" true across the two things that start a drain: the
/// startup pass, and a close (#366).
fn draining() -> &'static std::sync::atomic::AtomicBool {
    static DRAINING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &DRAINING
}

/// Run whatever is on the queue, on a thread of its own.
///
/// Detached and never awaited, following `sync_cmd::spawn`: #35 is explicit that
/// memory stays off the session launch path, and a summary is worth exactly none
/// of the delay it would cost a window to open. Returns whether a drain was
/// started — `false` when one already is.
pub fn spawn_drain() -> bool {
    use std::sync::atomic::Ordering;
    if draining()
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    std::thread::spawn(|| {
        drain_now();
        draining().store(false, Ordering::SeqCst);
    });
    true
}

/// One drain pass, on the calling thread.
fn drain_now() {
    let Some(q) = wrapup_queue() else { return };
    let Some(dir) = dir().get() else { return };
    let corpus = corpus::Corpus::new(dir.clone());
    let rooms = rooms();

    let report = q.drain(|job| {
        capture::run(job, &corpus, &rooms).map(|c| {
            if let Some(cost) = c.cost {
                // The one line in the app that says what memory cost. Worth
                // saying out loud while there is no panel to show it (#35's
                // phase 3), because the person is paying for it.
                eprintln!(
                    "memory: captured {} — {} in, {} out{}",
                    job.session_name.as_deref().unwrap_or(&job.session_id),
                    cost.input_tokens,
                    cost.output_tokens,
                    cost.usd.map(|u| format!(", ${u:.4}")).unwrap_or_default(),
                );
            }
            (c.note, c.cost)
        })
    });
    match report {
        Ok(r) => {
            if r.wrote > 0 || r.failed > 0 || r.requeued > 0 {
                announce();
            }
            if r.failed > 0 {
                eprintln!("memory: gave up on {} capture job(s)", r.failed);
            }
        }
        Err(e) => eprintln!("warning: the wrapup queue could not be drained ({e})"),
    }
}

/// Tell the frontend the queue moved, following the `runs://changed`
/// precedent — deliberately not a polling timer.
pub fn announce() {
    if let Some(handle) = app().get() {
        let _ = handle.emit("memory://changed", ());
    }
}

/// Whether closing this session could produce a note, and why not when it could
/// not.
///
/// Asked *before* the question is put to anybody, because consent to spend money
/// on something that cannot work is worse than no offer at all. Two things have
/// to be true and neither is knowable from the frontend: this build must have a
/// reader for the CLI that wrote the log (#371, #372), and the app must know
/// where that log is.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureOffer {
    pub available: bool,
    /// Why not, in a sentence a person could be shown. `None` when it is
    /// available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The offer for one session.
///
/// The "nothing to summarise" half of #366 is deliberately **not** decided here.
/// Reading a transcript to find out whether it holds a conversation would put a
/// file read of up to a few megabytes on the path of closing a tile, and it would
/// buy nothing: `capture::run` checks it again before the model call, so a
/// session that turns out to be empty costs a queue entry and no tokens. What
/// this rules out is what would otherwise cost a *question* — a CLI whose log
/// cannot be read at all, and a session the app never saw a log for.
#[tauri::command]
pub fn memory_capture_offer(session: String, cli_kind: Option<String>) -> CaptureOffer {
    let cli = crate::activity::model::CliKind::parse(cli_kind.as_deref().unwrap_or_default());
    if transcript::digester_for(cli).is_none() {
        return CaptureOffer {
            available: false,
            reason: Some(format!(
                "Notes are not available for {} sessions in this build.",
                cli.as_str(),
            )),
        };
    }
    if crate::transcripts::get(&session).is_none() {
        return CaptureOffer {
            available: false,
            // The ordinary case by far: a tile that never got as far as running
            // anything reported no transcript, so there is nothing to read.
            reason: Some("This session has not written a transcript yet.".to_string()),
        };
    }
    CaptureOffer { available: true, reason: None }
}

/// Put a closing session's note on the queue.
///
/// Called from `close_session` rather than from the frontend, and that is the
/// guarantee rather than a convenience: the enqueue has to happen before
/// `transcripts::forget`, and an ordering that lives inside one function cannot
/// be got wrong by a caller.
///
/// Returns whether anything was queued. `false` is ordinary — a session with no
/// transcript on record — and never a reason to fail a close.
pub fn enqueue_on_close(
    session: &str,
    workspace_id: &str,
    cli_kind: Option<String>,
    session_name: Option<String>,
) -> bool {
    let Some(q) = wrapup_queue() else { return false };
    // The second of the two guards `decideCapture` documents. A remembered "yes"
    // arrives here without having consulted `memory_capture_offer`, so a session
    // whose CLI this build cannot read would otherwise be queued and then fail —
    // on every close of such a tile, forever, for somebody who agreed to notes
    // once and about something else.
    let cli = crate::activity::model::CliKind::parse(cli_kind.as_deref().unwrap_or_default());
    if transcript::digester_for(cli).is_none() {
        return false;
    }
    let Some(path) = crate::transcripts::get(session) else { return false };

    let req = queue::EnqueueRequest {
        session_id: session.to_string(),
        workspace_id: workspace_id.to_string(),
        cli_kind,
        transcript_path: path,
        session_name,
    };
    match q.enqueue(&req) {
        Ok(_) => {
            announce();
            // What turns a queued job into a note. On its own thread, so a close
            // never waits on a model.
            spawn_drain();
            true
        }
        Err(e) => {
            // Warned, never propagated. The person asked for a tile to go away; a
            // queue that could not be written is a summary that will not exist,
            // and that is not a reason to keep the tile on screen.
            eprintln!("warning: could not queue a note for a closing session ({e})");
            false
        }
    }
}

/// Forget the remembered answer, so the next close asks again.
#[tauri::command]
pub fn memory_forget_capture_answer() -> Result<(), String> {
    let Some(dir) = dir().get() else { return Err("memory is not wired up".to_string()) };
    crate::store::Store::new(dir.clone())
        .clear_capture_on_close()
        .map_err(|e| e.to_string())
}

/// Every wrapup job, oldest first.
///
/// Read-only, and the frontend has nothing that writes the queue: a job is put
/// on it by the close path in Rust (#366) and taken off it by the runner (#365).
/// A window that could enqueue would be a window that could enqueue a job for a
/// session another window owns.
#[tauri::command]
pub fn memory_jobs() -> Vec<queue::WrapupJob> {
    wrapup_queue().map(|q| q.jobs()).unwrap_or_default()
}
