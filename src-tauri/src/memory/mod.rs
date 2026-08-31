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
//!
//! The root is the app's config directory, which is also the store's directory
//! and the sync repository root (ADR-0006). Neither module resolves it: both are
//! handed one, so every test runs against a temporary directory and nothing
//! there can write into a real corpus by accident. The process-wide wiring below
//! is where the real directory is named, once.

// Capture (#365) is what will call into `corpus`, and the surfaces (#366, #367)
// are what will read the queue. Until then the build prints a dead-code warning
// for every item in both modules, which is a wall of noise that hides the next
// real warning. **Remove this line with #365**, at which point everything here
// has a caller and the warnings would be true.
#![allow(dead_code)]

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
