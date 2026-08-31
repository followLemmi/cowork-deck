//! The deck's own memory: what past sessions did and decided, written down
//! where a later session — or a later machine — can find it.
//!
//! Phase 2 of #35 was the write path, and it is the half the feature stands on:
//! search over an empty corpus is a working search that returns nothing. Under
//! ADR-0004 the markdown *is* the memory and the index is a cache built over it
//! afterwards, which is why the write path was finished and tested with no model
//! on the machine at all — and why every module here except [`sidecar`] still
//! needs none.
//!
//! - [`corpus`] — where a note goes and what it looks like when it gets there.
//! - [`queue`] — the durable queue that makes capture a promise.
//! - [`transcript`] — reading a session's log, per CLI, because the deck runs
//!   sessions on four of them and their logs have nothing in common.
//! - [`rooms`] — the diary rooms a lesson can be routed to, and what happens to
//!   one that is retired.
//! - [`capture`] — one `claude -p` per closed session, billed to the person.
//! - [`sidecar`] — talking to `cowork_memory`, which is what reads the corpus
//!   back.
//!
//! The root is the app's config directory, which is also the store's directory
//! and the sync repository root (ADR-0006). Neither module resolves it: both are
//! handed one, so every test runs against a temporary directory and nothing
//! there can write into a real corpus by accident. The process-wide wiring below
//! is where the real directory is named, once.

pub mod capture;
pub mod corpus;
pub mod queue;
pub mod rooms;
pub mod sidecar;
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
/// Through `for_prompt`, which is where a description is made one line and
/// bounded before it reaches a model request. Empty stays a working state: the
/// prompt then asks for no lessons at all, and `capture::run` drops any that
/// arrive anyway.
fn prompt_rooms() -> Vec<rooms::Room> {
    match dir().get() {
        Some(d) => rooms::Rooms::new(d.clone()).for_prompt(),
        None => Vec::new(),
    }
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
    let rooms = prompt_rooms();

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
            // A note on disk that the index has not seen is a note no search
            // finds. Here rather than at the end of every capture, so a drain of
            // six jobs embeds once.
            if r.wrote > 0 {
                spawn_reindex();
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

fn rooms_store() -> Result<rooms::Rooms, String> {
    dir()
        .get()
        .map(|d| rooms::Rooms::new(d.clone()))
        .ok_or_else(|| "memory is not wired up".to_string())
}

/// Every configured diary room.
///
/// Through `list`, which is what seeds the defaults on a corpus that has never
/// had any — so opening the surface for the first time shows a usable set rather
/// than an empty page with an Add button.
#[tauri::command]
pub fn memory_rooms() -> Vec<rooms::Room> {
    rooms_store().map(|r| r.list()).unwrap_or_default()
}

/// Declare a room, or change its description. Returns the name it was stored
/// under, which is the slug of what was asked for.
#[tauri::command]
pub fn memory_save_room(name: String, description: String) -> Result<String, String> {
    rooms_store()?.save(&name, &description).map_err(|e| e.to_string())
}

/// Stop routing lessons to a room. **Its lessons stay on disk** — see
/// [`rooms::Rooms::retire`] for why that is not negotiable.
#[tauri::command]
pub fn memory_retire_room(name: String) -> Result<bool, String> {
    rooms_store()?.retire(&name).map_err(|e| e.to_string())
}

/// Rename a room, moving its lessons with it. Refuses to merge into an existing
/// one.
#[tauri::command]
pub fn memory_rename_room(from: String, to: String) -> Result<String, String> {
    rooms_store()?.rename(&from, &to).map_err(|e| e.to_string())
}

/// Forget the remembered answer, so the next close asks again.
#[tauri::command]
pub fn memory_forget_capture_answer() -> Result<(), String> {
    let Some(dir) = dir().get() else { return Err("memory is not wired up".to_string()) };
    crate::store::Store::new(dir.clone())
        .clear_capture_on_close()
        .map_err(|e| e.to_string())
}

/// The sidecar over this corpus, or `None` before [`init`].
pub fn indexer() -> Option<sidecar::Sidecar> {
    dir().get().map(|d| sidecar::Sidecar::new(d.clone()))
}

/// The index and the model.
///
/// The call that decides what the interface may offer, because it needs neither
/// — see [`sidecar`]. A search returning nothing cannot tell "no matches" from
/// "never indexed" from "no model", and this is what tells them apart.
#[tauri::command]
pub fn memory_status() -> Result<sidecar::Status, String> {
    indexer().ok_or_else(|| "memory is not wired up".to_string())?.status()
}

/// Search the corpus.
///
/// `workspace_id` scopes it: a workspace sees its own notes plus the global
/// diaries, which is what makes a lesson from another project reachable from
/// this one. Absent, it searches everything.
#[tauri::command]
pub fn memory_search(
    query: String,
    workspace_id: Option<String>,
    top: Option<usize>,
) -> Result<Vec<sidecar::Hit>, String> {
    let scope = match workspace_id.filter(|w| !w.trim().is_empty()) {
        Some(id) => sidecar::Scope::Workspace(id),
        None => sidecar::Scope::Everything,
    };
    indexer()
        .ok_or_else(|| "memory is not wired up".to_string())?
        .search(&query, &scope, top.unwrap_or(10))
}

/// Bring the index up to date, on a thread of its own.
///
/// Never awaited by a caller and never on a launch path: a cold index embeds
/// every note there is, which on a corpus somebody has been filling for months
/// is minutes of CPU. #35 is explicit that memory stays off the session launch
/// path, and this is the call that would break that promise if it were
/// synchronous.
pub fn spawn_reindex() -> bool {
    use std::sync::atomic::Ordering;
    let Some(s) = indexer() else { return false };
    if !s.is_staged() {
        // Ordinary on a build that did not stage it, and not worth a warning on
        // every start — `memory_status` says so where somebody is looking.
        return false;
    }
    // Its own guard, and for a sharper reason than the drain's: two reindexes
    // would each embed the same notes, on the CPU, at the same time. The two
    // things that start one — a startup pass and a drain that wrote a note — can
    // easily coincide on a machine that was shut with work queued.
    if reindexing().compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return false;
    }
    std::thread::spawn(move || {
        let out = s.update();
        reindexing().store(false, Ordering::SeqCst);
        match out {
        Ok(ix) if ix.changed > 0 => {
            eprintln!(
                "memory: reindexed {} file(s); {} files, {} chunks",
                ix.changed, ix.files, ix.chunks,
            );
            announce();
        }
        Ok(_) => {}
        // Warned rather than surfaced: the ordinary cause is a model that has
        // not been downloaded, which is a sentence the interface owes somebody
        // where they asked (#374) rather than a notification at startup.
        Err(e) => eprintln!("memory: could not reindex ({e})"),
        }
    });
    true
}

fn reindexing() -> &'static std::sync::atomic::AtomicBool {
    static REINDEXING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &REINDEXING
}

/// One note, read back out of the corpus.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Note {
    /// Where it is, so it can be revealed in a file manager.
    pub path: String,
    pub markdown: String,
}

/// Read one note by its path relative to the corpus root.
///
/// **Relative, and checked.** A search hit's `file` comes back from the sidecar,
/// which read it off the filesystem, so in practice it is already ours — but this
/// is a command, and a command that took an absolute path would be a command any
/// window could ask to read any file. The path is joined to the root and the
/// result has to still be inside it, which is the same reasoning `corpus::segment`
/// applies on the way in.
///
/// `main.rs` refuses `open-path` in the opener plugin for a related reason — "a
/// URL out of a pull request description" naming a file to run — so a note is
/// read and rendered in the app rather than handed to whatever the system would
/// launch.
#[tauri::command]
pub fn memory_read_note(file: String) -> Result<Note, String> {
    let Some(root) = dir().get() else { return Err("memory is not wired up".to_string()) };
    let real = note_under(root, &file)?;
    let bytes =
        std::fs::read(&real).map_err(|e| format!("could not read that note ({})", e.kind()))?;
    Ok(Note {
        path: real.to_string_lossy().into_owned(),
        // Lossily, for the reason `transcript::read` gives about transcripts: a
        // note that is not quite text is better read imperfectly than refused.
        markdown: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Resolve a note's relative path inside the corpus, or refuse.
///
/// Split out from the command because it is the only defensive logic in this
/// module and the only part of it worth a test: the command around it is a file
/// read.
fn note_under(root: &std::path::Path, file: &str) -> Result<PathBuf, String> {
    if !file.ends_with(".md") {
        return Err("that is not a note".to_string());
    }
    // `canonicalize` resolves `..` and every symlink on the way, so containment
    // is checked against where the path actually lands rather than how it is
    // spelled. A prefix check on the joined string would pass
    // `ws-1/../../.ssh/id_rsa.md` and follow a symlink out without noticing.
    let real = root.join(file).canonicalize().map_err(|_| "that note is not there".to_string())?;
    let real_root = root.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&real_root) {
        return Err("that note is not in the corpus".to_string());
    }
    if !real.is_file() {
        return Err("that note is not there".to_string());
    }
    Ok(real)
}

/// What a download is doing, or how it ended.
///
/// One event shape for both, because a surface has to render "fetching", "done"
/// and "it failed" in the same place and a second event would let those disagree.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelDownload {
    /// `fetching`, `verifying`, `ready` or `failed`.
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub got: u64,
    pub total: u64,
    /// Why it failed, in a sentence somebody could act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn downloading() -> &'static std::sync::atomic::AtomicBool {
    static DOWNLOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &DOWNLOADING
}

fn emit_model(ev: ModelDownload) {
    if let Some(handle) = app().get() {
        let _ = handle.emit("memory://model", ev);
    }
}

/// Fetch the embedding model, reporting progress on `memory://model`.
///
/// Returns whether a download was started; `false` when one already is. The work
/// is on a thread of its own — 479 MB is not something to hold a command open
/// for — and an interrupted one resumes rather than restarting (ADR-0005), so
/// quitting mid-download costs nothing but time.
///
/// **It ends by running `update`, and that is not tidiness.** The probe that
/// decides whether the downloaded bytes are a working model lives inside
/// `OnnxEmbedder::load`, so nothing before the first real use can say. ADR-0005
/// is explicit about why it matters: a truncated or damaged ONNX file may still
/// load and still produce vectors, every search then returns plausible-looking
/// nonsense, and nothing reports a fault. Verifying here is what turns that into
/// a sentence at the moment somebody is looking.
#[tauri::command]
pub fn memory_download_model() -> bool {
    use std::sync::atomic::Ordering;
    let Some(s) = indexer() else { return false };
    if !s.is_staged() {
        emit_model(ModelDownload {
            phase: "failed".into(),
            file: None,
            got: 0,
            total: 0,
            error: Some(format!("the memory sidecar is not installed at {}", s.program().display())),
        });
        return false;
    }
    if downloading().compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return false;
    }

    std::thread::spawn(move || {
        let mut last = ModelDownload {
            phase: "fetching".into(),
            file: None,
            got: 0,
            total: 0,
            error: None,
        };
        let fetched = s.download_model(&mut |p| {
            last = ModelDownload {
                phase: "fetching".into(),
                file: Some(p.file.clone()),
                got: p.got,
                total: p.total,
                error: None,
            };
            emit_model(last.clone());
        });

        let out = match fetched {
            Err(e) => Err(e),
            Ok(()) => {
                // The probe, by way of the only thing that runs it.
                emit_model(ModelDownload {
                    phase: "verifying".into(),
                    file: None,
                    got: last.got,
                    total: last.total,
                    error: None,
                });
                s.update().map(|_| ())
            }
        };
        downloading().store(false, Ordering::SeqCst);

        match out {
            Ok(()) => {
                emit_model(ModelDownload {
                    phase: "ready".into(),
                    file: None,
                    got: last.total,
                    total: last.total,
                    error: None,
                });
                announce();
            }
            Err(e) => {
                eprintln!("memory: the model is not usable ({e})");
                emit_model(ModelDownload {
                    phase: "failed".into(),
                    file: last.file.clone(),
                    got: last.got,
                    total: last.total,
                    error: Some(e),
                });
            }
        }
    });
    true
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

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "cd-note-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ws-1/Sessions/2026-08")).unwrap();
        std::fs::write(root.join("ws-1/Sessions/2026-08/31-a-note.md"), "# a note\n").unwrap();
        root
    }

    #[test]
    fn a_note_inside_the_corpus_resolves() {
        let root = corpus("ok");
        let p = note_under(&root, "ws-1/Sessions/2026-08/31-a-note.md").unwrap();
        assert!(p.ends_with("31-a-note.md"));
    }

    /// The check this function exists for. A prefix test on the joined string
    /// would pass every one of these.
    #[test]
    fn a_path_that_climbs_out_of_the_corpus_is_refused() {
        let root = corpus("escape");
        // Something real to reach for, one directory above the corpus.
        let outside = root.parent().unwrap().join("cd-note-outside.md");
        std::fs::write(&outside, "not yours\n").unwrap();

        let e = note_under(&root, "../cd-note-outside.md")
            .expect_err("a note above the corpus is not a note in it");
        assert!(e.contains("not in the corpus"), "{e}");

        let e = note_under(&root, "ws-1/../../cd-note-outside.md")
            .expect_err("nor is one reached the long way round");
        assert!(e.contains("not in the corpus"), "{e}");
        let _ = std::fs::remove_file(&outside);
    }

    /// `canonicalize` is what makes this refusal work: the path is inside the
    /// corpus and the file it names is not.
    #[test]
    #[cfg(unix)]
    fn a_symlink_pointing_out_of_the_corpus_is_refused() {
        let root = corpus("symlink");
        let outside = root.parent().unwrap().join("cd-note-secret.md");
        std::fs::write(&outside, "not yours\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("ws-1/link.md")).unwrap();

        let e = note_under(&root, "ws-1/link.md")
            .expect_err("a link out of the corpus leads out of the corpus");
        assert!(e.contains("not in the corpus"), "{e}");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn only_markdown_is_a_note() {
        let root = corpus("ext");
        std::fs::write(root.join("ws-1/workspace.json"), "{}").unwrap();
        let e = note_under(&root, "ws-1/workspace.json").expect_err("a record is not a note");
        assert!(e.contains("not a note"), "{e}");
        // The store's own files sit in this directory, which is why the
        // extension is checked rather than assumed from the layout.
        std::fs::write(root.join("accounts.json"), "{}").unwrap();
        assert!(note_under(&root, "accounts.json").is_err());
    }

    #[test]
    fn a_note_that_is_not_there_says_so_rather_than_which() {
        let root = corpus("missing");
        let e = note_under(&root, "ws-1/Sessions/2026-08/nothing.md").unwrap_err();
        assert!(e.contains("not there"), "{e}");
    }

    #[test]
    fn a_directory_is_not_a_note() {
        let root = corpus("dir");
        std::fs::create_dir_all(root.join("ws-1/odd.md")).unwrap();
        assert!(note_under(&root, "ws-1/odd.md").is_err());
    }
}
