//! Writing the scenario run journal. The shape of what is written lives in
//! [`crate::runs`]; this is where the calls come from.
//!
//! # Why the backend owns the writing
//!
//! Schedules fire with the window closed, hook events arrive in Rust
//! (`listener.rs`), and PTY death is observed in Rust (`commands.rs`). A
//! frontend-owned journal would lose exactly the unattended runs that
//! scheduling exists for. The frontend gets a read command and an event; it
//! never writes.
//!
//! # Process-global, like `transcripts`
//!
//! The state below is a process-wide map rather than a field on `AppState`, for
//! the reason `transcripts.rs` already gives: the listener is started before
//! `AppState` exists, so its callback has nothing to write into. The store is
//! rebuilt from the app directory per call, exactly as `scheduler::run` does it.

use crate::runs::{
    last_assistant_text, ResultSource, RunClosed, RunEvent, RunStarted, RunStatus, RunTrigger,
    RUN_JOURNAL_VERSION,
};
use crate::store::Store;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// What a launch says about the scenario behind it.
///
/// One optional argument on `start_session` rather than four, because they are
/// meaningless apart: a trigger without a scenario says nothing, and params
/// without a run have nowhere to go.
#[derive(Debug, Clone, Deserialize)]
pub struct ScenarioLaunch {
    /// Minted by the same code that mints the session id, and for the same
    /// reason: the tile has to persist it into `SessionEntry.runId` the moment
    /// it exists, so that a restart can chain to it. **Only this module ever
    /// writes a journal line** — an id is an identifier, not a record.
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "skillId")]
    pub skill_id: String,
    pub trigger: RunTrigger,
    /// The placeholder values this run was launched with, so it can be run
    /// again with them visible.
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// The run this one resumes. The frontend always names it when there is one
    /// — auto-restore reads it out of `SessionEntry.runId`, and a ⟳ names the
    /// record its tile is leaving, because that button is only offered on a
    /// session that has already ended and whose record is therefore already
    /// closed here.
    #[serde(rename = "continuesRunId", default)]
    pub continues_run_id: Option<String>,
}

fn dir() -> &'static OnceLock<PathBuf> {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    &DIR
}

fn app() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

/// The record a live session is currently in.
#[derive(Debug, Clone)]
struct OpenRun {
    run_id: String,
    /// Carried alongside so that closing a run does not have to re-read the
    /// whole journal merely to say which scenario changed.
    skill_id: String,
}

/// session id -> the journal record that session is currently in.
///
/// Also the guard that keeps a run from being closed twice: `Ended` arrives
/// both from the reporter's hook and from the PTY exiting, and whichever comes
/// first takes the entry away.
fn open_runs() -> &'static Mutex<HashMap<String, OpenRun>> {
    static OPEN: OnceLock<Mutex<HashMap<String, OpenRun>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// session id -> the transcript path last written to the journal for it.
///
/// Separate from `transcripts::get`, which is the *current* path for every
/// session in the app. This one answers the narrower question the journal asks:
/// has the path changed since we last wrote it down — which is what a `/clear`
/// looks like from here.
fn journalled_paths() -> &'static Mutex<HashMap<String, String>> {
    static PATHS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Wire the journal to the app's directory and window. Called once, from
/// `main`'s setup, before the frontend can launch anything.
pub fn init(app_dir: PathBuf, handle: AppHandle) {
    let _ = dir().set(app_dir);
    let _ = app().set(handle);
}

fn store() -> Option<Store> {
    dir().get().map(|d| Store::new(d.clone()))
}

/// A **true epoch** in millis, which is the whole of the storage format for
/// every `at` in this file. Not `naive_local().and_utc()`: that is the version-1
/// bug `ScheduleRun` had to grow a version field to escape.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whether new records may be opened.
///
/// Read from `ui_state.json` per call rather than cached: a cache would be one
/// more thing that can disagree with the file, and the reads happen a handful of
/// times per run — at launch, at a `/clear`, and at close.
pub fn recording() -> bool {
    store().map(|s| s.ui_state().record_scenario_runs).unwrap_or(false)
}

fn append(ev: RunEvent) {
    let Some(store) = store() else { return };
    if let Err(e) = store.append_run_event(&ev) {
        // Worth a line rather than a discarded `Result`: a journal that stopped
        // recording looks from the outside exactly like a scenario that stopped
        // running.
        eprintln!("warning: could not write to the run journal ({e})");
    }
}

/// Tell the frontend something moved. Emitted on open and on close, following
/// the `tasks://changed` precedent — deliberately not a polling timer.
fn announce(skill_id: &str) {
    if let Some(handle) = app().get() {
        let _ = handle.emit("runs://changed", ChangedPayload { skill_id: skill_id.to_string() });
    }
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    #[serde(rename = "skillId")]
    skill_id: String,
}

/// The branch a run started on, best effort.
///
/// The same `rev-parse` `git_status` runs, and kept to that one call: this is on
/// the session launch path, which stays on the main thread by design (see the
/// module docs of `commands.rs`), so the second call that decides `dirty` is not
/// worth the milliseconds for a field nobody filters on.
fn branch_of(cwd: &str) -> Option<String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
}

/// Open a record for a session that is about to start.
///
/// Called from `start_session` whenever the launch carries a scenario — which
/// covers manual clicks, ⏰, scheduled fires and restores alike, because the
/// question people bring to a history is "when did this scenario last run", not
/// "who pressed it".
pub fn open(
    session: &str,
    launch: &ScenarioLaunch,
    cwd: &str,
    workspace_id: Option<&str>,
    prompt: Option<&str>,
) {
    if !recording() {
        return;
    }
    // A relaunch under a session id that is still open. The caller normally
    // names its predecessor, but this is the case where it cannot be wrong:
    // whatever is open under this id ends here, because one PTY is one record.
    let predecessor = take_open(session);
    if let Some(prev) = &predecessor {
        close_record(
            &prev.run_id, &prev.skill_id, RunStatus::Ended, None,
            crate::transcripts::get(session),
        );
    }
    let continues = predecessor
        .map(|p| p.run_id)
        .or_else(|| launch.continues_run_id.clone());

    let Some(store) = store() else { return };
    let skill = store.skills().into_iter().find(|s| s.id == launch.skill_id);
    // A resume carries no prompt of its own — nothing was sent, the
    // conversation was picked up — so the chain's own text is inherited. The
    // predecessor is also the last place a name survives once the scenario
    // itself has been deleted.
    let previous = continues.as_deref().and_then(|id| store.run(id));
    let (name, icon) = match (&skill, &previous) {
        (Some(sk), _) => (sk.name.clone(), sk.icon.clone()),
        (None, Some(prev)) => (prev.name.clone(), prev.icon.clone()),
        // Nothing left to name it by. The id is a poor label and an honest one;
        // inventing a friendlier string would put a fiction in the record.
        (None, None) => (launch.skill_id.clone(), String::new()),
    };
    let prompt = prompt
        .map(str::to_string)
        .or_else(|| previous.as_ref().and_then(|p| p.prompt.clone()));
    let params = if launch.params.is_empty() {
        previous.as_ref().map(|p| p.params.clone()).unwrap_or_default()
    } else {
        launch.params.clone()
    };

    append(RunEvent::Started(RunStarted {
        version: RUN_JOURNAL_VERSION,
        run_id: launch.run_id.clone(),
        at: now_ms(),
        trigger: launch.trigger,
        skill_id: launch.skill_id.clone(),
        name,
        icon,
        workspace_id: workspace_id.map(str::to_string),
        cwd: cwd.to_string(),
        branch: branch_of(cwd),
        session_id: Some(session.to_string()),
        params,
        prompt,
        continues_run_id: continues,
        // Every session the deck launches is `claude` today — `start_session`
        // resolves nothing else — and recording it is what lets a history read
        // back later say what ran a run rather than only that something did.
        cli_kind: Some(crate::activity::model::CliKind::Claude.as_str().to_string()),
    }));
    if let Ok(mut m) = open_runs().lock() {
        m.insert(session.to_string(), OpenRun {
            run_id: launch.run_id.clone(),
            skill_id: launch.skill_id.clone(),
        });
    }
    // A restart starts a new file as far as the journal is concerned.
    if let Ok(mut m) = journalled_paths().lock() {
        m.remove(session);
    }
    announce(&launch.skill_id);
}

/// A hook reported where this session's transcript is.
///
/// Written on the first one and again whenever it changes — the same "forward,
/// never back" rule `transcripts::record` follows. A change of path **is** a
/// `/clear`, and saying so is what stops the UI presenting the tail of a
/// conversation as the whole of it.
pub fn note_transcript(session: &str, path: &str) {
    if path.is_empty() {
        return;
    }
    let Some(run_id) = current_run(session) else { return };
    let cleared = match journalled_paths().lock() {
        Ok(mut m) => match m.get(session) {
            Some(known) if known == path => return,
            known => {
                let cleared = known.is_some();
                m.insert(session.to_string(), path.to_string());
                cleared
            }
        },
        Err(_) => return,
    };
    append(RunEvent::Transcript(crate::runs::RunTranscript {
        version: RUN_JOURNAL_VERSION,
        run_id,
        at: now_ms(),
        path: path.to_string(),
        cleared,
    }));
}

/// The PTY never started, so close the record the launch had just opened.
///
/// The record is opened before the spawn (see `start_session`) because the
/// waiter thread that reports the exit is running before `spawn` returns.
/// Closing it here with the spawn error in `reason` is what keeps a failed
/// launch from reading as `running` until the next startup relabels it
/// `interrupted` — a launch that failed instantly and a run cut short by a
/// crash are different facts.
pub fn failed_to_start(session: &str, reason: &str) {
    let Some((open, _)) = take_for_close(session) else { return };
    // No transcript to read: nothing ever ran to write one, and the read this
    // skips is the one `close` has to hand to a thread.
    close_record(&open.run_id, &open.skill_id, RunStatus::Error, Some(reason.to_string()), None);
}

/// Close the record this session is in, if it is in one.
///
/// `Done` deliberately never reaches here: the agent finished a turn and parked
/// at the prompt, and the person can keep typing in that tile. What it would
/// have written — the last known result — is read at close time anyway, off the
/// same transcript, so a record closed by a crash three turns later still
/// carries the last thing the agent said.
/// The cheap half of a close: claim the record and let go of the session.
///
/// Separated because this is the part with an ordering requirement —
/// `close_session` runs it before killing the PTY so that the exit arriving a
/// moment later finds nothing to close — while the read below has none.
fn take_for_close(session: &str) -> Option<(OpenRun, Option<String>)> {
    let open = take_open(session)?;
    let transcript = crate::transcripts::get(session);
    if let Ok(mut m) = journalled_paths().lock() {
        m.remove(session);
    }
    Some((open, transcript))
}

pub fn close(session: &str, status: RunStatus) {
    let Some((open, transcript)) = take_for_close(session) else { return };
    // The read is the expensive half: `close_record` reads the whole transcript
    // and, through `transcript_spend`, every subagent transcript beside it —
    // megabytes for a long session. `close_session` is one of the commands that
    // stays on the main thread by design (see this crate's `commands` module
    // docs, where ordering is the reason), and on Linux that thread paints the
    // window, so the read would be a freeze between the click and the tile
    // going. Landing the line a moment later costs nothing: `fold_events` keys
    // by run id, so no other event depends on this one arriving first.
    std::thread::spawn(move || {
        close_record(&open.run_id, &open.skill_id, status, None, transcript);
    });
}

/// The record a live session belongs to.
fn current_run(session: &str) -> Option<String> {
    Some(open_runs().lock().ok()?.get(session)?.run_id.clone())
}

fn take_open(session: &str) -> Option<OpenRun> {
    open_runs().lock().ok()?.remove(session)
}

/// A scheduled occurrence fired and nothing started.
///
/// Started and closed in one go, with no `sessionId`, because there was never a
/// session. "The schedule silently did nothing" is precisely what people open a
/// history to find out, so the reason travels with the record.
pub fn failed_to_launch(skill_id: &str, workspace_id: Option<&str>, reason: &str) {
    if !recording() {
        return;
    }
    let Some(store) = store() else { return };
    let skill = store.skills().into_iter().find(|s| s.id == skill_id);
    let (name, icon) = match &skill {
        Some(sk) => (sk.name.clone(), sk.icon.clone()),
        None => (skill_id.to_string(), String::new()),
    };
    // The scenario's own pin when it has one. An unpinned scenario that could
    // not resolve a workspace has none, and the record honestly says so rather
    // than filing itself under whichever folder happened to be on screen.
    let workspace_id = workspace_id
        .map(str::to_string)
        .or_else(|| skill.as_ref().and_then(|s| s.workspace_id.clone()));
    let run_id = ulid::Ulid::generate().to_string();
    let at = now_ms();
    append(RunEvent::Started(RunStarted {
        version: RUN_JOURNAL_VERSION,
        run_id: run_id.clone(),
        at,
        trigger: RunTrigger::Schedule,
        skill_id: skill_id.to_string(),
        name,
        icon,
        workspace_id,
        cwd: String::new(),
        branch: None,
        session_id: None,
        params: skill
            .as_ref()
            .and_then(|s| s.schedule.as_ref())
            .map(|s| s.defaults.clone())
            .unwrap_or_default(),
        prompt: None,
        continues_run_id: None,
        // Nothing was launched, so nothing ran this. Naming a CLI here would put
        // a fiction in the record, which is the rule this function already
        // follows for the scenario's own name.
        cli_kind: None,
    }));
    append(RunEvent::Closed(RunClosed {
        version: RUN_JOURNAL_VERSION,
        run_id,
        at,
        status: RunStatus::FailedToLaunch,
        result: None,
        reason: Some(reason.to_string()),
        tokens: None,
        result_source: ResultSource::None,
    }));
    announce(skill_id);
}

/// Startup: close every record still `running`, and prune.
///
/// Nothing has a live PTY behind it at this point — the app has only just
/// started — so every open record is one a crash, a `kill` or a closed laptop
/// lid left behind. Those are exactly the cases a journal exists for, and a
/// record left open forever would report them as still going.
///
/// Runs whether or not recording is switched on. The switch means "open no new
/// records"; finishing one this app already opened is not a new record, and
/// retention is a storage policy rather than a preference.
pub fn sweep_and_compact() {
    let Some(store) = store() else { return };
    for rec in store.runs() {
        if rec.status == RunStatus::Running {
            close_record(
                &rec.run_id,
                &rec.skill_id,
                RunStatus::Interrupted,
                None,
                rec.transcript_path.clone(),
            );
        }
    }
    match store.compact_runs() {
        Ok(0) => {}
        Ok(n) => eprintln!("run journal: pruned {n} record(s) past the retention limit"),
        Err(e) => eprintln!("warning: could not compact the run journal ({e})"),
    }
}

/// Write the close, reading whatever result there is to read.
///
/// `transcript` is the file to read the final assistant message from — what the
/// hooks reported for a live session, or what the record itself remembers for
/// one being swept at startup. No path, or a path that no longer resolves, is
/// `result: null` with `resultSource: "none"`: the run happening and the run
/// producing nothing are different facts, and an empty string would conflate
/// them.
fn close_record(
    run_id: &str,
    skill_id: &str,
    status: RunStatus,
    reason: Option<String>,
    transcript: Option<String>,
) {
    let read = transcript
        .as_deref()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(&p).ok().map(|body| (p, body)));
    let (result, tokens, source) = match read {
        Some((path, body)) => (
            last_assistant_text(&body),
            Some(crate::commands::transcript_spend(&body, &path)),
            ResultSource::Transcript,
        ),
        None => (None, None, ResultSource::None),
    };
    append(RunEvent::Closed(RunClosed {
        version: RUN_JOURNAL_VERSION,
        run_id: run_id.to_string(),
        at: now_ms(),
        status,
        result,
        reason,
        tokens,
        result_source: source,
    }));
    announce(skill_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::UiStatePatch;

    /// [`close`] hands the read to a thread, which a test cannot wait on without
    /// the writer being observable. This is the same close, run to completion.
    fn close_blocking(session: &str, status: RunStatus) {
        let Some((open, transcript)) = take_for_close(session) else { return };
        close_record(&open.run_id, &open.skill_id, status, None, transcript);
    }

    /// One directory for the whole test binary, because `dir()` is the process-
    /// wide `OnceLock` the module is built around and a test that wanted its own
    /// would be testing a different module. [`fresh`] serialises the tests and
    /// wipes the journal between them, which is what makes that safe.
    fn test_dir() -> PathBuf {
        dir()
            .get_or_init(|| {
                let mut p = std::env::temp_dir();
                p.push(format!("coworkdeck-journal-test-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                p
            })
            .clone()
    }

    /// An empty journal, the recording switch where the test wants it, and no
    /// session left open by whatever ran before. The guard is what keeps two
    /// tests from sharing the one directory at the same time; a panicking test
    /// poisons it, and recovering rather than cascading keeps the failure to the
    /// one test that caused it.
    fn fresh(recording: bool) -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = test_dir();
        let _ = std::fs::remove_file(dir.join("runs.jsonl"));
        Store::new(dir)
            .save_ui_state(&UiStatePatch {
                record_scenario_runs: Some(recording),
                ..Default::default()
            })
            .unwrap();
        open_runs().lock().unwrap_or_else(|e| e.into_inner()).clear();
        journalled_paths().lock().unwrap_or_else(|e| e.into_inner()).clear();
        guard
    }

    fn store_now() -> Store {
        Store::new(test_dir())
    }

    fn lines() -> Vec<String> {
        std::fs::read_to_string(test_dir().join("runs.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn launch(run_id: &str, continues: Option<&str>) -> ScenarioLaunch {
        ScenarioLaunch {
            run_id: run_id.to_string(),
            skill_id: "s1".to_string(),
            trigger: RunTrigger::Manual,
            params: HashMap::new(),
            continues_run_id: continues.map(str::to_string),
        }
    }

    /// The switch means "open no new records", and that is the whole of what it
    /// means — see the pair below.
    #[test]
    fn recording_off_opens_nothing() {
        let _g = fresh(false);
        open("sess", &launch("r1", None), "/tmp", Some("w"), Some("hello"));
        assert!(lines().is_empty());
        assert_eq!(current_run("sess"), None);
    }

    /// Deliberate, and the reason `close` does not check the switch: a record
    /// this app opened is finished by this app. Leaving it `running` forever
    /// would be a worse answer to "stop recording" than finishing it.
    #[test]
    fn a_run_already_open_is_still_closed_after_recording_stops() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), Some("hello"));
        store_now()
            .save_ui_state(&UiStatePatch { record_scenario_runs: Some(false), ..Default::default() })
            .unwrap();

        close_blocking("sess", RunStatus::Ended);

        let runs = store_now().runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Ended);
    }

    /// A transcript path arriving twice is one fact, not two, and the first one
    /// is not a `/clear` — there was nothing before it to clear.
    #[test]
    fn the_first_transcript_is_not_a_clear_and_repeats_write_nothing() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        let after_open = lines().len();

        note_transcript("sess", "/t/a.jsonl");
        note_transcript("sess", "/t/a.jsonl");

        assert_eq!(lines().len(), after_open + 1);
        close_blocking("sess", RunStatus::Ended);
        let runs = store_now().runs();
        assert_eq!(runs[0].transcript_path.as_deref(), Some("/t/a.jsonl"));
        assert!(!runs[0].cleared);
    }

    /// A changed path **is** a `/clear`, and saying so is what stops the screen
    /// presenting the tail of a conversation as the whole of it.
    #[test]
    fn a_changed_transcript_path_is_recorded_as_a_clear() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        note_transcript("sess", "/t/a.jsonl");
        note_transcript("sess", "/t/b.jsonl");

        close_blocking("sess", RunStatus::Ended);
        let runs = store_now().runs();
        assert_eq!(runs[0].transcript_path.as_deref(), Some("/t/b.jsonl"));
        assert!(runs[0].cleared);
    }

    /// A hook for a session in no record has nothing to attach to, and must not
    /// invent one.
    #[test]
    fn a_transcript_for_a_session_in_no_record_writes_nothing() {
        let _g = fresh(true);
        note_transcript("nobody", "/t/a.jsonl");
        assert!(lines().is_empty());
    }

    /// The record is opened before the spawn, so the spawn failing has to close
    /// it. Left `running`, it would be relabelled `interrupted` at the next
    /// start — reporting a launch that failed instantly as a run cut short.
    #[test]
    fn a_spawn_that_failed_closes_the_record_with_its_reason() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        failed_to_start("sess", "claude-not-found");

        let runs = store_now().runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Error);
        assert_eq!(runs[0].reason.as_deref(), Some("claude-not-found"));
        // And the session is out of the map, so a late exit cannot reopen it.
        assert_eq!(current_run("sess"), None);
    }

    /// Whichever of the two closes arrives first takes the record; the second
    /// finds nothing. `Ended` comes from both the reporter's hook and the PTY.
    #[test]
    fn closing_twice_writes_one_close() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        close_blocking("sess", RunStatus::Ended);
        let after_first = lines().len();
        close_blocking("sess", RunStatus::Error);

        assert_eq!(lines().len(), after_first);
        assert_eq!(store_now().runs()[0].status, RunStatus::Ended);
    }

    /// Nothing has a live PTY behind it at startup, so every record still open
    /// is one a crash or a closed lid left behind.
    #[test]
    fn the_startup_sweep_closes_a_running_record_as_interrupted() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        // The app restarts: the map is gone, the line on disk is not.
        open_runs().lock().unwrap_or_else(|e| e.into_inner()).clear();

        sweep_and_compact();

        let runs = store_now().runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Interrupted);
    }

    /// Retention is storage policy, not a preference — the sweep runs whether or
    /// not recording is on, or a switched-off app would never finish the records
    /// it left open.
    #[test]
    fn the_sweep_runs_with_recording_off() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), None);
        open_runs().lock().unwrap_or_else(|e| e.into_inner()).clear();
        store_now()
            .save_ui_state(&UiStatePatch { record_scenario_runs: Some(false), ..Default::default() })
            .unwrap();

        sweep_and_compact();

        assert_eq!(store_now().runs()[0].status, RunStatus::Interrupted);
    }

    /// A resume carries no prompt of its own — nothing was sent, the
    /// conversation was picked up — so the chain's own text is inherited. This is
    /// the path both auto-restore and the tile's ⟳ take.
    #[test]
    fn a_resume_chains_to_its_predecessor_and_inherits_its_prompt() {
        let _g = fresh(true);
        open("first", &launch("r1", None), "/tmp", Some("w"), Some("review the diff"));
        close_blocking("first", RunStatus::Ended);

        open("second", &launch("r2", Some("r1")), "/tmp", Some("w"), None);
        close_blocking("second", RunStatus::Ended);

        let runs = store_now().runs();
        let second = runs.iter().find(|r| r.run_id == "r2").unwrap();
        assert_eq!(second.continues_run_id.as_deref(), Some("r1"));
        assert_eq!(second.prompt.as_deref(), Some("review the diff"));
    }

    /// A relaunch under a session id that is still open ends what is open there,
    /// whatever the caller did or did not name: one PTY is one record.
    #[test]
    fn relaunching_a_live_session_closes_what_was_open_under_it() {
        let _g = fresh(true);
        open("sess", &launch("r1", None), "/tmp", Some("w"), Some("first prompt"));
        open("sess", &launch("r2", None), "/tmp", Some("w"), None);

        let runs = store_now().runs();
        let first = runs.iter().find(|r| r.run_id == "r1").unwrap();
        let second = runs.iter().find(|r| r.run_id == "r2").unwrap();
        assert_eq!(first.status, RunStatus::Ended);
        assert_eq!(second.status, RunStatus::Running);
        assert_eq!(second.continues_run_id.as_deref(), Some("r1"));
    }

    /// The schedule fired and nothing started. One record, opened and closed
    /// together, with no `sessionId` because there never was a session.
    #[test]
    fn a_fire_that_launched_nothing_is_one_closed_record() {
        let _g = fresh(true);
        failed_to_launch("s1", Some("w"), "no-workspace");

        let runs = store_now().runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::FailedToLaunch);
        assert_eq!(runs[0].reason.as_deref(), Some("no-workspace"));
        assert_eq!(runs[0].trigger, RunTrigger::Schedule);
        assert_eq!(runs[0].session_id, None);
    }

    #[test]
    fn recording_off_records_no_failed_fire_either() {
        let _g = fresh(false);
        failed_to_launch("s1", Some("w"), "no-workspace");
        assert!(lines().is_empty());
    }
}
