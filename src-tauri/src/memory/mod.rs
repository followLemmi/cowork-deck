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
