//! The wrapup queue: what makes capture a promise rather than a best effort.
//!
//! A summary job takes a Claude call's worth of seconds, and by the time it
//! runs the session it is about is already gone — the tile is closed and the PTY
//! is dead. So whatever this file does not survive is memory nobody can recover
//! by trying again, which is a different class of loss from a request that can
//! simply be repeated.
//!
//! # Append-only, and folded on read
//!
//! `wrapup.jsonl` beside `runs.jsonl`, written and read by exactly the rules
//! [`crate::store::Store::append_run_event`] and [`crate::runs::fold_events`]
//! already established, because the failure being designed against is the same
//! one: a process killed mid-write. One `write` of one line so two writers
//! cannot splice a line together; a missing trailing newline healed before the
//! next append, so a crash costs the record being written and never the one
//! after it; and an unreadable line costs that line alone.
//!
//! # What durability actually requires here
//!
//! Recovery is in this module and not a later task on purpose. A queue that
//! writes a durable file and never re-reads it after a crash is durable in its
//! format and not in its behaviour, and the test for the guarantee would land
//! after the code that is supposed to provide it.
//!
//! `Running` on disk at startup means the app died inside that job — nothing
//! else can leave the state behind, since this process has only just begun and
//! holds no job. [`Queue::recover`] clears every such claim before anything
//! reads the queue, so after it runs no job on disk is `Running` and
//! [`fold_events`] is single-valued.
//!
//! The guarantee is against a process that dies, not against a machine that
//! does. `File::write_all` is unbuffered, so a line has reached the kernel
//! before the call returns and no signal — `SIGKILL` included — can take it
//! back; nothing here calls `fsync`, so a power cut can still lose the tail of
//! the file. That boundary is deliberate. An `fsync` per append would put a
//! disk flush on the path of closing a tile to buy durability against a failure
//! whose cost is one session's summary.
//!
//! This is also why the tests model a restart by building a second [`Queue`]
//! over the same file rather than by killing a real process: there is no state
//! anywhere but the file, so a fresh handle over it *is* the next process. What
//! a real `SIGKILL` would additionally prove is that the write reached the
//! kernel, which is the unbuffered-`write_all` property above rather than
//! anything this module decides.
//!
//! # The poison job
//!
//! Recovery that simply requeues is an infinite loop for the one job that kills
//! the app every time it runs: crash, requeue, crash. So an attempt is counted
//! by the `started` event rather than by a successful finish, which means a job
//! that dies with the app has still spent one. After [`MAX_ATTEMPTS`] the job is
//! `failed` and stays visible instead of being tried forever or dropped.
//!
//! # This file does not travel
//!
//! Nothing has to be done to keep it that way: sync's ignore is deny-by-default
//! (`sync::manifest`), so a new file in the config directory is untracked until
//! somebody adds it to `ALLOWED`. Nobody should — a queued job names a
//! transcript path on this machine, and a job half-run here must not be picked
//! up there. [`tests::the_queue_does_not_travel`] is what keeps that true.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

/// The highest line version this build writes, and the highest it can read.
///
/// In the spirit of [`crate::runs::RUN_JOURNAL_VERSION`], and for the same
/// reason: a reader has to be able to tell which rule a line was written under,
/// and skip a line from a build that is not installed any more rather than
/// mis-parse it into the shape this one happens to have.
pub const WRAPUP_QUEUE_VERSION: u8 = 1;

/// How many times one job may be *started* before it is given up on.
///
/// Started, not failed. A job that takes the app down with it never reports a
/// failure, and counting only reported failures is how "retry until it works"
/// becomes "crash on every launch until somebody deletes a file they have never
/// heard of".
pub const MAX_ATTEMPTS: u32 = 3;

/// How many finished jobs are kept. Enough to answer "did that session get
/// captured?" about anything recent, and bounded so the file does not grow for
/// the lifetime of the install.
const KEEP_TERMINAL: usize = 200;

const FILE: &str = "wrapup.jsonl";

fn queue_version() -> u8 {
    WRAPUP_QUEUE_VERSION
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Everything a capture job needs, snapshotted at the moment it is queued.
///
/// **Nothing here is resolved later**, and that is the point of the type. See
/// [`Queue::enqueue`] for the specific thing that makes late resolution
/// impossible rather than merely untidy.
// Constructed by the close path, which is #366. Named here rather than left to
// a module-wide allow, so the next unused thing in this file is a real warning.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnqueueRequest {
    /// The deck's own session id — the tile that was closed. Kept for the
    /// record rather than for resolution: by the time the job runs there is no
    /// session by this id to ask anything of.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    /// Which CLI ran the session, and therefore which reader can make sense of
    /// its log.
    ///
    /// Recorded at the close rather than assumed at the run. Without it the
    /// runner has no way to tell a Claude Code transcript from a Copilot one,
    /// and a reader handed the wrong format finds no turns, concludes the
    /// session was empty and writes nothing — silently. `SessionEntry.cli_kind`
    /// exists for exactly this dispatch and carries the same tolerance: an
    /// unrecognised name is Claude.
    #[serde(rename = "cliKind", default, skip_serializing_if = "Option::is_none")]
    pub cli_kind: Option<String>,
    /// The transcript to summarise, as the app knew it at the close.
    #[serde(rename = "transcriptPath")]
    pub transcript_path: String,
    /// What the tile was called, so a panel listing failed jobs can name
    /// something a person recognises instead of an id.
    #[serde(rename = "sessionName", default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

/// A job enters the queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobQueued {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    /// Absent on a line written before this field existed, and by
    /// `CliKind::parse`'s rule that reads as Claude — which is what every
    /// session was when those lines were written.
    #[serde(rename = "cliKind", default, skip_serializing_if = "Option::is_none")]
    pub cli_kind: Option<String>,
    #[serde(rename = "transcriptPath")]
    pub transcript_path: String,
    #[serde(rename = "sessionName", default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

/// A job is picked up. One of these is one attempt, spent whether or not the
/// attempt ever reports back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobStarted {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
}

/// A job goes back into the queue, with the reason it came out.
///
/// One event for two causes, which are the same fact from the queue's point of
/// view — a job that was running and is not finished. `reason` is what tells
/// them apart for somebody reading the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRequeued {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
    pub reason: String,
}

/// A job is finished, and this is the note it wrote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobDone {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
    /// Absent when the job succeeded and deliberately wrote nothing — an empty
    /// session has nothing worth indexing, and that is a success rather than a
    /// fault.
    #[serde(rename = "notePath", default, skip_serializing_if = "Option::is_none")]
    pub note_path: Option<String>,
    /// What the model call cost, straight off the CLI's own envelope.
    ///
    /// Recorded because capture spends the person's money on every closed tile,
    /// which is the one thing about this feature somebody could reasonably be
    /// annoyed to discover late. The figure arrives with the reply; throwing it
    /// away would mean re-running the model to get it back. Absent for a job
    /// that never called anything — an empty session — and for a CLI that
    /// reported no usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<super::capture::CaptureCost>,
}

/// A person asked for a job to be tried again.
///
/// Its own event rather than a [`JobRequeued`], and the difference is who is
/// speaking. `fold_events` refuses to revise a terminal job — "the moment
/// something finished is not open to correction by a later, less informed
/// writer" — and this line is *more* informed, not less: somebody looked at the
/// failure, presumably fixed something, and said try again. So it is the one
/// event that reopens a job, and the fold names it as the exception rather than
/// relaxing the rule for everything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRetried {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
}

/// A job is given up on, and stays visible saying why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobFailed {
    #[serde(default = "queue_version")]
    pub v: u8,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub at: i64,
    pub error: String,
}

/// One line of `wrapup.jsonl`.
///
/// Internally tagged on `t`, like [`crate::runs::RunEvent`], so the tag
/// spelling is derived in both directions and cannot disagree with itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum JobEvent {
    Queued(JobQueued),
    Started(JobStarted),
    Requeued(JobRequeued),
    Retried(JobRetried),
    Done(JobDone),
    Failed(JobFailed),
}

impl JobEvent {
    /// Serialise to the single line that is appended. Never contains a newline:
    /// `serde_json::to_string` does not emit one and the strings inside are
    /// escaped.
    pub fn to_line(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

/// Where a job has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    /// Some process claims to be running it. On disk at startup this means the
    /// app died inside the job — see [`Queue::recover`].
    Running,
    Done,
    /// Given up on after [`MAX_ATTEMPTS`], and kept rather than dropped.
    Failed,
}

impl JobState {
    fn is_terminal(self) -> bool {
        matches!(self, JobState::Done | JobState::Failed)
    }
}

/// One job, folded out of its events. This is what the frontend reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WrapupJob {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "queuedAt")]
    pub queued_at: i64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "transcriptPath")]
    pub transcript_path: String,
    /// Parsed rather than raw, so no caller has to remember that an
    /// unrecognised name means Claude.
    #[serde(rename = "cliKind")]
    pub cli: crate::activity::model::CliKind,
    #[serde(rename = "sessionName")]
    pub session_name: Option<String>,
    pub state: JobState,
    /// How many times this job has been started, which is what
    /// [`MAX_ATTEMPTS`] is measured against.
    pub attempts: u32,
    /// Why it last came out of `running` without finishing, or why it was given
    /// up on.
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "notePath")]
    pub note_path: Option<String>,
    /// What the model call cost, for a job that made one.
    pub cost: Option<super::capture::CaptureCost>,
}

/// Read one line, or say why it was skipped.
///
/// Every refusal costs **that line** and nothing else, for the reason
/// [`crate::runs`] gives about its own journal: a reader that aborted on the
/// first thing it did not understand would lose the queue it exists to keep.
fn parse_line(line: &str) -> Option<JobEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            // The ordinary case is the last line of a file the process died
            // half-way through writing, which is exactly what append-only is
            // for. Everything before it stands.
            eprintln!("warning: skipping an unreadable line of the wrapup queue ({e})");
            return None;
        }
    };
    // The version is read before the body, so a line from a newer build is
    // skipped rather than mis-parsed into the shape this build happens to have.
    if let Some(v) = raw.get("v").and_then(serde_json::Value::as_u64) {
        if v > WRAPUP_QUEUE_VERSION as u64 {
            eprintln!(
                "warning: skipping a wrapup queue line written by a newer version \
                 (v{v} > v{WRAPUP_QUEUE_VERSION})",
            );
            return None;
        }
    }
    match serde_json::from_value::<JobEvent>(raw) {
        Ok(ev) => Some(ev),
        Err(e) => {
            eprintln!("warning: skipping an unrecognised wrapup queue line ({e})");
            None
        }
    }
}

/// Fold a whole `wrapup.jsonl` body into jobs, oldest first.
///
/// The rules a reader must not care about, because the writer might get one of
/// them wrong one day:
///
/// - anything with no matching `queued` is ignored — there is no job for it to
///   be about;
/// - a second `queued` for a job id already seen is ignored;
/// - **once a job is terminal, nothing revises it.** A `done` job cannot be
///   walked back into `running` by a stale writer, which is the same rule
///   `runs::fold_events` applies to a run's close and for the same reason: the
///   moment something finished is not open to correction by a later, less
///   informed line.
pub fn fold_events(content: &str) -> Vec<WrapupJob> {
    let mut order: Vec<WrapupJob> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for line in content.lines() {
        let Some(ev) = parse_line(line) else { continue };
        match ev {
            JobEvent::Queued(e) => {
                if index.contains_key(&e.job_id) {
                    continue;
                }
                index.insert(e.job_id.clone(), order.len());
                order.push(WrapupJob {
                    job_id: e.job_id,
                    queued_at: e.at,
                    session_id: e.session_id,
                    workspace_id: e.workspace_id,
                    transcript_path: e.transcript_path,
                    cli: crate::activity::model::CliKind::parse(
                        e.cli_kind.as_deref().unwrap_or_default(),
                    ),
                    session_name: e.session_name,
                    state: JobState::Queued,
                    attempts: 0,
                    last_error: None,
                    note_path: None,
                    cost: None,
                });
            }
            JobEvent::Started(e) => {
                if let Some(job) = at_mut(&mut order, &index, &e.job_id) {
                    job.attempts += 1;
                    job.state = JobState::Running;
                }
            }
            JobEvent::Requeued(e) => {
                if let Some(job) = at_mut(&mut order, &index, &e.job_id) {
                    job.state = JobState::Queued;
                    job.last_error = Some(e.reason);
                }
            }
            JobEvent::Retried(e) => {
                // The one event that reaches a terminal job, so it goes through
                // the index rather than through `at_mut`.
                if let Some(&i) = index.get(&e.job_id) {
                    let job = &mut order[i];
                    job.state = JobState::Queued;
                    // A fresh set of attempts: the person has presumably changed
                    // something, and carrying the spent ones would make the retry
                    // fail on its first stumble.
                    job.attempts = 0;
                    job.last_error = None;
                }
            }
            JobEvent::Done(e) => {
                if let Some(job) = at_mut(&mut order, &index, &e.job_id) {
                    job.state = JobState::Done;
                    job.note_path = e.note_path;
                    job.cost = e.cost;
                }
            }
            JobEvent::Failed(e) => {
                if let Some(job) = at_mut(&mut order, &index, &e.job_id) {
                    job.state = JobState::Failed;
                    job.last_error = Some(e.error);
                }
            }
        }
    }
    order
}

/// The job a line is about, unless it is already finished with.
fn at_mut<'a>(
    order: &'a mut [WrapupJob],
    index: &HashMap<String, usize>,
    job_id: &str,
) -> Option<&'a mut WrapupJob> {
    let &i = index.get(job_id)?;
    if order[i].state.is_terminal() {
        return None;
    }
    Some(&mut order[i])
}

/// What one recovery pass did, so the caller can say it out loud.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Recovered {
    /// Jobs the app died inside, put back in the queue.
    pub requeued: usize,
    /// Jobs that had spent their attempts and were given up on.
    pub failed: usize,
    /// Finished jobs dropped past the retention limit.
    pub pruned: usize,
}

/// The queue file under one directory.
pub struct Queue {
    path: PathBuf,
}

impl Queue {
    pub fn new(dir: PathBuf) -> Queue {
        Queue { path: dir.join(FILE) }
    }

    /// Called by the tests, and by #366 when it reports where a queue lives.
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every job, oldest first. A missing file is an empty queue.
    pub fn jobs(&self) -> Vec<WrapupJob> {
        fold_events(&self.body())
    }

    /// Put a job on the queue, and return its id.
    ///
    /// The caller passes the transcript path rather than a way of finding one
    /// later, and it has to: `close_session` calls
    /// [`crate::transcripts::forget`], so the instant a tile closes the app can
    /// no longer answer "which file was this session writing to". A job that
    /// stored a session id and resolved the path when it ran would work
    /// perfectly every time it was drained promptly, and find nothing at all
    /// after a restart — a failure that only appears in the case the queue
    /// exists for.
    #[allow(dead_code)] // The caller is the close path, #366.
    pub fn enqueue(&self, req: &EnqueueRequest) -> io::Result<String> {
        if req.session_id.trim().is_empty() {
            return Err(invalid("a wrapup job with no session id"));
        }
        if req.workspace_id.trim().is_empty() {
            return Err(invalid("a wrapup job with no workspace id"));
        }
        // Not a defensive nicety: without a path the job can only fail, three
        // times, and the person is told a summary failed rather than that it was
        // never possible.
        if req.transcript_path.trim().is_empty() {
            return Err(invalid("a wrapup job with no transcript path"));
        }
        let job_id = ulid::Ulid::generate().to_string();
        self.append(&JobEvent::Queued(JobQueued {
            v: WRAPUP_QUEUE_VERSION,
            job_id: job_id.clone(),
            at: now_ms(),
            session_id: req.session_id.clone(),
            workspace_id: req.workspace_id.clone(),
            cli_kind: req.cli_kind.clone(),
            transcript_path: req.transcript_path.clone(),
            session_name: req.session_name.clone(),
        }))?;
        Ok(job_id)
    }

    /// Clear every `running` claim left by a process that is gone, and prune.
    ///
    /// Called once at startup, before anything reads the queue. Nothing has a
    /// job in flight at that point — this process has only just begun — so every
    /// `running` job on disk is one the app died inside.
    ///
    /// A job that has spent [`MAX_ATTEMPTS`] is failed rather than requeued.
    /// That is the whole defence against a job that takes the app down every
    /// time it is tried: without it, recovery is the loop.
    pub fn recover(&self) -> io::Result<Recovered> {
        let mut out = Recovered::default();
        for job in self.jobs() {
            if job.state != JobState::Running {
                continue;
            }
            if job.attempts >= MAX_ATTEMPTS {
                self.append(&JobEvent::Failed(JobFailed {
                    v: WRAPUP_QUEUE_VERSION,
                    job_id: job.job_id,
                    at: now_ms(),
                    error: format!(
                        "the app stopped while this job was running, {} time(s); \
                         not trying again",
                        job.attempts
                    ),
                }))?;
                out.failed += 1;
            } else {
                self.append(&JobEvent::Requeued(JobRequeued {
                    v: WRAPUP_QUEUE_VERSION,
                    job_id: job.job_id,
                    at: now_ms(),
                    reason: "the app stopped while this job was running".to_string(),
                }))?;
                out.requeued += 1;
            }
        }
        out.pruned = self.prune()?;
        Ok(out)
    }

    /// Take one job by name, marking it started, or `None` if it is not queued
    /// any more.
    ///
    /// **By name, and that is the point.** This took the oldest queued job until
    /// the bug in [`Queue::drain`] that the ordering caused: `drain` works
    /// through a snapshot of what was queued when it began, and a taker that
    /// always returns the oldest hands straight back the job `drain` has just
    /// requeued — spending every attempt on the first failure in the queue and
    /// skipping everything behind it. Order is `drain`'s to decide, and it reads
    /// it off `jobs()`, which is oldest first.
    fn take(&self, job_id: &str) -> io::Result<Option<WrapupJob>> {
        let Some(job) = self.jobs().into_iter().find(|j| j.job_id == job_id) else {
            return Ok(None);
        };
        if job.state != JobState::Queued {
            return Ok(None);
        }
        self.mark_started(job).map(Some)
    }

    fn mark_started(&self, mut job: WrapupJob) -> io::Result<WrapupJob> {
        self.append(&JobEvent::Started(JobStarted {
            v: WRAPUP_QUEUE_VERSION,
            job_id: job.job_id.clone(),
            at: now_ms(),
        }))?;
        job.attempts += 1;
        job.state = JobState::Running;
        Ok(job)
    }

    /// The job wrote its note, or decided there was nothing to write.
    pub fn finish(
        &self,
        job_id: &str,
        note_path: Option<String>,
        cost: Option<super::capture::CaptureCost>,
    ) -> io::Result<()> {
        self.append(&JobEvent::Done(JobDone {
            v: WRAPUP_QUEUE_VERSION,
            job_id: job_id.to_string(),
            at: now_ms(),
            note_path,
            cost,
        }))
    }

    /// The job did not work. Requeued for another attempt, or failed for good
    /// once its attempts are spent.
    ///
    /// Returns whether the job will be tried again, because the caller usually
    /// wants to say which of the two happened.
    pub fn fail(&self, job_id: &str, error: &str) -> io::Result<bool> {
        let attempts = self
            .jobs()
            .into_iter()
            .find(|j| j.job_id == job_id)
            .map(|j| j.attempts)
            .unwrap_or(MAX_ATTEMPTS);
        if attempts >= MAX_ATTEMPTS {
            self.append(&JobEvent::Failed(JobFailed {
                v: WRAPUP_QUEUE_VERSION,
                job_id: job_id.to_string(),
                at: now_ms(),
                error: error.to_string(),
            }))?;
            return Ok(false);
        }
        self.append(&JobEvent::Requeued(JobRequeued {
            v: WRAPUP_QUEUE_VERSION,
            job_id: job_id.to_string(),
            at: now_ms(),
            reason: error.to_string(),
        }))?;
        Ok(true)
    }

    /// Put a finished-with job back on the queue, because somebody asked.
    ///
    /// Returns whether there was such a job. Only a terminal one is worth
    /// retrying — a queued job is already going to run, and reopening a running
    /// one would race the process holding it.
    pub fn retry(&self, job_id: &str) -> io::Result<bool> {
        let Some(job) = self.jobs().into_iter().find(|j| j.job_id == job_id) else {
            return Ok(false);
        };
        if !job.state.is_terminal() {
            return Ok(false);
        }
        self.append(&JobEvent::Retried(JobRetried {
            v: WRAPUP_QUEUE_VERSION,
            job_id: job_id.to_string(),
            at: now_ms(),
        }))?;
        Ok(true)
    }

    /// Run every job that is queued right now, one at a time, and report what
    /// happened.
    ///
    /// `run` returns the note it wrote — `None` for a session that deliberately
    /// produced nothing — with what the call cost, or the reason it could not.
    ///
    /// **One at a time, and each of these jobs at most once.** Serial because
    /// the handler spawns `claude` (#365) and a queue that drained in parallel
    /// would spawn as many as the person closed tiles. At most once because a
    /// job that fails is requeued rather than failed, and picking it straight
    /// back up would burn all [`MAX_ATTEMPTS`] in a single pass — three model
    /// calls in a row for something that is failing for a reason that will not
    /// have changed in the intervening millisecond.
    pub fn drain<F>(&self, mut run: F) -> io::Result<DrainReport>
    where
        F: FnMut(&WrapupJob) -> Result<CaptureOutcome, String>,
    {
        let planned: Vec<String> = self
            .jobs()
            .into_iter()
            .filter(|j| j.state == JobState::Queued)
            .map(|j| j.job_id)
            .collect();

        let mut report = DrainReport::default();
        for job_id in planned {
            // By name, and re-read rather than trusted from the snapshot: `run`
            // is arbitrary code and may have finished or failed this job itself,
            // and asking for the *oldest* queued job here would keep handing
            // back whichever one this pass has already requeued.
            let Some(job) = self.take(&job_id)? else { continue };
            match run(&job) {
                Ok((note, cost)) => {
                    let wrote = note.is_some();
                    self.finish(&job.job_id, note, cost)?;
                    if wrote {
                        report.wrote += 1;
                    } else {
                        report.empty += 1;
                    }
                }
                Err(e) => {
                    if self.fail(&job.job_id, &e)? {
                        report.requeued += 1;
                    } else {
                        report.failed += 1;
                    }
                }
            }
        }
        Ok(report)
    }

    /// Drop the oldest finished jobs past [`KEEP_TERMINAL`], and return how
    /// many went.
    ///
    /// By **filtering lines** rather than re-rendering the jobs that stay. A
    /// re-render would have to reproduce each kept job's events from its folded
    /// state, which loses whatever the fold does not carry — and it would
    /// rewrite lines this build does not fully understand into the shape it
    /// does. Filtering keeps every line it cannot attribute to a dropped job,
    /// so a line from a newer version survives compaction by an older one.
    fn prune(&self) -> io::Result<usize> {
        let jobs = self.jobs();
        let terminal: Vec<&WrapupJob> = jobs.iter().filter(|j| j.state.is_terminal()).collect();
        if terminal.len() <= KEEP_TERMINAL {
            return Ok(0);
        }
        let drop: std::collections::HashSet<&str> = terminal[..terminal.len() - KEEP_TERMINAL]
            .iter()
            .map(|j| j.job_id.as_str())
            .collect();

        let body = self.body();
        let mut kept = String::with_capacity(body.len());
        for line in body.lines() {
            match job_id_of_line(line) {
                Some(id) if drop.contains(id.as_str()) => continue,
                _ => {
                    kept.push_str(line);
                    kept.push('\n');
                }
            }
        }
        write_atomic(&self.path, &kept)?;
        Ok(drop.len())
    }

    /// Append one event.
    ///
    /// `OpenOptions::append` and one `write` of one line, exactly as
    /// `Store::append_run_event` does it, including healing a file whose last
    /// line was cut off mid-write — without that the next append is glued onto
    /// the wreckage and **both** lines are lost, which is the very failure
    /// append-only is here to avoid.
    fn append(&self, ev: &JobEvent) -> io::Result<()> {
        use std::io::{Read, Seek, SeekFrom, Write};
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut line = String::new();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&self.path)?;
        let len = f.metadata()?.len();
        if len > 0 {
            f.seek(SeekFrom::Start(len - 1))?;
            let mut last = [0u8; 1];
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                line.push('\n');
            }
        }
        line.push_str(&ev.to_line().map_err(|e| io::Error::other(e.to_string()))?);
        line.push('\n');
        f.write_all(line.as_bytes())
    }

    fn body(&self) -> String {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                eprintln!(
                    "warning: failed to read {} ({e}); treating the wrapup queue as empty",
                    self.path.display(),
                );
                String::new()
            }
        }
    }
}

/// What a drained job produced: the note it wrote, if any, and what the model
/// call cost, if it made one.
pub type CaptureOutcome = (Option<String>, Option<super::capture::CaptureCost>);

/// What one drain pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DrainReport {
    /// Jobs that wrote a note.
    pub wrote: usize,
    /// Jobs that succeeded with nothing worth writing.
    pub empty: usize,
    /// Jobs that failed and will be tried again.
    pub requeued: usize,
    /// Jobs given up on.
    pub failed: usize,
}

/// The job id a line is about, read out of the raw JSON.
///
/// Deliberately version-independent: it does not go through [`parse_line`],
/// because compaction needs to identify a line written by a build it cannot
/// otherwise read. A line whose id cannot be found is kept.
fn job_id_of_line(line: &str) -> Option<String> {
    let raw: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    raw.get("jobId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// Write through a temp file and rename over the target. The one place this
/// file is not append-only is also the one place it cannot afford to be
/// truncated in.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| invalid("the queue path has no parent directory"))?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_e| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cd-wrapup-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn req(session: &str) -> EnqueueRequest {
        EnqueueRequest {
            session_id: session.into(),
            workspace_id: "ws-1".into(),
            cli_kind: Some("claude".into()),
            transcript_path: format!("/tmp/{session}.jsonl"),
            session_name: Some("relay".into()),
        }
    }

    fn one(q: &Queue, job_id: &str) -> WrapupJob {
        q.jobs().into_iter().find(|j| j.job_id == job_id).expect("the job")
    }

    // ----- enqueue -----

    #[test]
    fn an_enqueued_job_carries_everything_the_runner_will_need() {
        let q = Queue::new(tmp("enqueue"));
        let id = q.enqueue(&req("s-1")).unwrap();
        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.attempts, 0);
        assert_eq!(job.session_id, "s-1");
        assert_eq!(job.workspace_id, "ws-1");
        assert_eq!(job.transcript_path, "/tmp/s-1.jsonl");
        assert_eq!(job.session_name.as_deref(), Some("relay"));
    }

    /// A job with no transcript path can only fail, three times, and then tell
    /// somebody a summary failed rather than that it was never possible.
    #[test]
    fn a_job_missing_what_cannot_be_resolved_later_is_refused_at_the_door() {
        let q = Queue::new(tmp("enqueue-bad"));
        // Named, because clippy counts the tuple-of-fn-pointer as complex and it
        // is: what each entry is, is "a field name and the way to blank it".
        type Blank = (&'static str, fn(&mut EnqueueRequest));
        let blank: [Blank; 3] = [
            ("transcript path", |r| r.transcript_path = "  ".into()),
            ("session id", |r| r.session_id = String::new()),
            ("workspace id", |r| r.workspace_id = "   ".into()),
        ];
        for (what, blank_it) in blank {
            let mut r = req("s-1");
            blank_it(&mut r);
            let e = q.enqueue(&r).expect_err("a job with no {what} must be refused");
            assert_eq!(e.kind(), io::ErrorKind::InvalidInput, "{what}");
        }
        assert!(q.jobs().is_empty(), "and nothing was written");
    }

    #[test]
    fn jobs_come_back_oldest_first() {
        let q = Queue::new(tmp("order"));
        let a = q.enqueue(&req("s-1")).unwrap();
        let b = q.enqueue(&req("s-2")).unwrap();
        let ids: Vec<String> = q.jobs().into_iter().map(|j| j.job_id).collect();
        assert_eq!(ids, vec![a, b]);
    }

    // ----- the drain -----

    #[test]
    fn a_drain_runs_each_job_once_and_records_what_it_wrote() {
        let q = Queue::new(tmp("drain"));
        q.enqueue(&req("s-1")).unwrap();
        q.enqueue(&req("s-2")).unwrap();

        let mut seen: Vec<String> = Vec::new();
        let report = q
            .drain(|job| {
                seen.push(job.session_id.clone());
                Ok((Some(format!("/notes/{}.md", job.session_id)), None))
            })
            .unwrap();

        assert_eq!(seen, vec!["s-1", "s-2"], "oldest first, one at a time");
        assert_eq!(report, DrainReport { wrote: 2, empty: 0, requeued: 0, failed: 0 });
        for job in q.jobs() {
            assert_eq!(job.state, JobState::Done);
            assert_eq!(job.note_path, Some(format!("/notes/{}.md", job.session_id)));
        }
    }

    #[test]
    fn a_job_that_wrote_nothing_still_succeeded() {
        let q = Queue::new(tmp("drain-empty"));
        let id = q.enqueue(&req("s-1")).unwrap();
        let report = q.drain(|_| Ok((None, None))).unwrap();
        assert_eq!(report, DrainReport { wrote: 0, empty: 1, requeued: 0, failed: 0 });
        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Done);
        assert_eq!(job.note_path, None);
    }

    /// Three model calls in a row for something failing for a reason that has
    /// not changed in the intervening millisecond is not a retry policy.
    #[test]
    fn a_failed_job_waits_for_the_next_drain_rather_than_burning_its_attempts() {
        let q = Queue::new(tmp("drain-fail"));
        let id = q.enqueue(&req("s-1")).unwrap();

        let mut calls = 0;
        let report = q
            .drain(|_| {
                calls += 1;
                Err("claude timed out".into())
            })
            .unwrap();
        assert_eq!(calls, 1, "one attempt per drain");
        assert_eq!(report, DrainReport { wrote: 0, empty: 0, requeued: 1, failed: 0 });

        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Queued, "back in the queue");
        assert_eq!(job.attempts, 1);
        assert_eq!(job.last_error.as_deref(), Some("claude timed out"));
    }

    /// The test above only queues one job, which is exactly the shape that hid
    /// this: `drain` walked a snapshot of job ids but asked for the *oldest
    /// queued* job on each turn, so a first job that failed was requeued and
    /// handed straight back — spending every attempt in one pass and never
    /// reaching the jobs behind it.
    #[test]
    fn a_failure_does_not_cost_the_jobs_behind_it_their_turn() {
        let q = Queue::new(tmp("drain-order"));
        let first = q.enqueue(&req("s-1")).unwrap();
        let second = q.enqueue(&req("s-2")).unwrap();
        let third = q.enqueue(&req("s-3")).unwrap();

        let mut seen: Vec<String> = Vec::new();
        let report = q
            .drain(|job| {
                seen.push(job.session_id.clone());
                if job.session_id == "s-1" {
                    Err("claude timed out".into())
                } else {
                    Ok((Some(format!("{}.md", job.session_id)), None))
                }
            })
            .unwrap();

        assert_eq!(seen, ["s-1", "s-2", "s-3"], "each queued job once, oldest first");
        assert_eq!(report, DrainReport { wrote: 2, empty: 0, requeued: 1, failed: 0 });
        let failed = one(&q, &first);
        assert_eq!(failed.attempts, 1, "one attempt, not three");
        assert_eq!(failed.state, JobState::Queued, "waiting for the next drain");
        assert_eq!(one(&q, &second).state, JobState::Done);
        assert_eq!(one(&q, &third).state, JobState::Done);
    }

    #[test]
    fn a_job_that_keeps_failing_is_given_up_on_and_stays_visible() {
        let q = Queue::new(tmp("drain-cap"));
        let id = q.enqueue(&req("s-1")).unwrap();

        let mut calls = 0;
        for _ in 0..MAX_ATTEMPTS + 2 {
            q.drain(|_| {
                calls += 1;
                Err("still broken".into())
            })
            .unwrap();
        }

        assert_eq!(calls, MAX_ATTEMPTS as usize, "not tried past the cap");
        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Failed);
        assert_eq!(job.attempts, MAX_ATTEMPTS);
        assert_eq!(job.last_error.as_deref(), Some("still broken"));
    }

    #[test]
    fn a_drain_of_an_empty_queue_does_nothing_at_all() {
        let q = Queue::new(tmp("drain-none"));
        let mut calls = 0;
        let report = q
            .drain(|_| {
                calls += 1;
                Ok((None, None))
            })
            .unwrap();
        assert_eq!(calls, 0);
        assert_eq!(report, DrainReport::default());
    }

    // ----- durability -----

    /// The guarantee. `take` without a matching `finish` is what a `SIGKILL`
    /// mid-job leaves on disk, and nothing else can leave it.
    #[test]
    fn a_job_the_app_died_inside_is_queued_again_after_a_restart() {
        let dir = tmp("recover");
        let id = {
            let q = Queue::new(dir.clone());
            let id = q.enqueue(&req("s-1")).unwrap();
            let taken = q.take(&id).unwrap().expect("a job to take");
            assert_eq!(taken.state, JobState::Running);
            id
        };

        // A fresh process, reading the same file.
        let q = Queue::new(dir.clone());
        assert_eq!(one(&q, &id).state, JobState::Running, "the claim is still on disk");

        let out = q.recover().unwrap();
        assert_eq!(out.requeued, 1);
        assert_eq!(out.failed, 0);

        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.attempts, 1, "the crashed attempt was spent");
        assert!(job.last_error.is_some(), "and the file says why it came back");

        // And it actually runs the next time round.
        let mut calls = 0;
        q.drain(|_| {
            calls += 1;
            Ok((Some("/notes/s-1.md".into()), None))
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(one(&q, &id).state, JobState::Done);
    }

    /// Without the attempt cap applying to crashes, this is an app that dies on
    /// every launch until somebody deletes a file they have never heard of.
    #[test]
    fn a_job_that_kills_the_app_every_time_is_eventually_given_up_on() {
        let dir = tmp("poison");
        let q = Queue::new(dir.clone());
        let id = q.enqueue(&req("s-1")).unwrap();

        for _ in 0..MAX_ATTEMPTS {
            // Each iteration: the job is taken, and the app dies inside it.
            assert!(q.take(&id).unwrap().is_some());
            q.recover().unwrap();
        }

        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Failed, "not queued for a fourth launch");
        assert_eq!(job.attempts, MAX_ATTEMPTS);

        // A later launch does not pick it up again.
        let mut calls = 0;
        q.drain(|_| {
            calls += 1;
            Ok((None, None))
        })
        .unwrap();
        assert_eq!(calls, 0);
    }

    #[test]
    fn recovery_leaves_a_queue_with_nothing_running() {
        let dir = tmp("recover-clean");
        let q = Queue::new(dir);
        let first = q.enqueue(&req("s-1")).unwrap();
        q.enqueue(&req("s-2")).unwrap();
        q.take(&first).unwrap();
        q.recover().unwrap();
        assert!(q.jobs().iter().all(|j| j.state != JobState::Running));
    }

    #[test]
    fn recovering_a_queue_that_never_ran_does_nothing() {
        let q = Queue::new(tmp("recover-idle"));
        q.enqueue(&req("s-1")).unwrap();
        assert_eq!(q.recover().unwrap(), Recovered::default());
        assert_eq!(q.jobs().len(), 1);
        assert_eq!(q.jobs()[0].state, JobState::Queued);
    }

    #[test]
    fn a_missing_file_is_an_empty_queue_and_recovery_is_happy_with_it() {
        let q = Queue::new(tmp("recover-missing"));
        assert!(q.jobs().is_empty());
        assert_eq!(q.recover().unwrap(), Recovered::default());
    }

    // ----- a torn file -----

    #[test]
    fn a_queue_with_a_torn_last_line_loads_as_the_lines_before_it() {
        let dir = tmp("torn");
        let q = Queue::new(dir);
        let a = q.enqueue(&req("s-1")).unwrap();
        q.enqueue(&req("s-2")).unwrap();

        // What a kill during the last append leaves: a line cut mid-write, with
        // no trailing newline.
        let mut body = std::fs::read_to_string(q.path()).unwrap();
        let cut = body.len() - 20;
        body.truncate(cut);
        std::fs::write(q.path(), &body).unwrap();

        let jobs = q.jobs();
        assert_eq!(jobs.len(), 1, "the first job stands");
        assert_eq!(jobs[0].job_id, a);
    }

    /// The healing append. Without it the next line is glued onto the wreckage
    /// and the crash costs the record being written *and* the one after it.
    #[test]
    fn an_append_after_a_torn_line_does_not_glue_itself_to_the_wreckage() {
        let dir = tmp("torn-append");
        let q = Queue::new(dir);
        let a = q.enqueue(&req("s-1")).unwrap();
        let mut body = std::fs::read_to_string(q.path()).unwrap();
        body.truncate(body.len() - 15);
        std::fs::write(q.path(), &body).unwrap();

        let b = q.enqueue(&req("s-2")).unwrap();
        let ids: BTreeSet<String> = q.jobs().into_iter().map(|j| j.job_id).collect();
        assert!(ids.contains(&b), "the new line is readable");
        assert!(!ids.contains(&a), "the torn one is not, and cost only itself");
    }

    #[test]
    fn a_line_from_a_newer_build_is_skipped_rather_than_mis_parsed() {
        let dir = tmp("newer");
        let q = Queue::new(dir);
        let id = q.enqueue(&req("s-1")).unwrap();
        let line = serde_json::json!({
            "t": "started",
            "v": WRAPUP_QUEUE_VERSION as u64 + 1,
            "jobId": id,
            "at": 1,
        });
        let mut body = std::fs::read_to_string(q.path()).unwrap();
        body.push_str(&format!("{line}\n"));
        std::fs::write(q.path(), &body).unwrap();

        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Queued, "the newer line was not applied");
        assert_eq!(job.attempts, 0);
    }

    // ----- the fold's rules -----

    // ----- retrying by hand -----

    /// The exception to "a terminal job is not revised", and the reason it is an
    /// exception: this line is *more* informed than the one it overrides.
    #[test]
    fn a_person_can_reopen_a_job_that_was_given_up_on() {
        let q = Queue::new(tmp("retry"));
        let id = q.enqueue(&req("s-1")).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            q.drain(|_| Err("still broken".into())).unwrap();
        }
        assert_eq!(one(&q, &id).state, JobState::Failed);

        assert!(q.retry(&id).unwrap());
        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Queued);
        // A fresh set of attempts, or the retry would fail on its first stumble
        // having already spent them.
        assert_eq!(job.attempts, 0);
        assert_eq!(job.last_error, None, "and the old reason is not left standing");

        let mut calls = 0;
        q.drain(|_| {
            calls += 1;
            Ok((Some("/notes/s-1.md".into()), None))
        })
        .unwrap();
        assert_eq!(calls, 1, "and it actually runs");
        assert_eq!(one(&q, &id).state, JobState::Done);
    }

    #[test]
    fn a_done_job_can_be_asked_for_again() {
        let q = Queue::new(tmp("retry-done"));
        let id = q.enqueue(&req("s-1")).unwrap();
        q.drain(|_| Ok((Some("/notes/a.md".into()), None))).unwrap();
        assert!(q.retry(&id).unwrap());
        assert_eq!(one(&q, &id).state, JobState::Queued);
    }

    /// A queued job is already going to run, and reopening a running one would
    /// race the process holding it.
    #[test]
    fn only_a_finished_job_is_worth_retrying() {
        let q = Queue::new(tmp("retry-live"));
        let id = q.enqueue(&req("s-1")).unwrap();
        assert!(!q.retry(&id).unwrap(), "already queued");
        q.take(&id).unwrap();
        assert!(!q.retry(&id).unwrap(), "and running is not to be reopened");
        assert!(!q.retry("never-existed").unwrap());
    }

    #[test]
    fn a_terminal_job_is_not_revised_by_a_later_line() {
        let dir = tmp("terminal");
        let q = Queue::new(dir);
        let id = q.enqueue(&req("s-1")).unwrap();
        q.take(&id).unwrap();
        q.finish(&id, Some("/notes/a.md".into()), None).unwrap();

        // A stale writer trying to reopen it.
        q.append(&JobEvent::Started(JobStarted {
            v: WRAPUP_QUEUE_VERSION,
            job_id: id.clone(),
            at: now_ms(),
        }))
        .unwrap();

        let job = one(&q, &id);
        assert_eq!(job.state, JobState::Done);
        assert_eq!(job.attempts, 1, "and the attempt count is not inflated either");
    }

    #[test]
    fn an_event_for_a_job_nobody_queued_is_ignored() {
        let body = serde_json::json!({ "t": "started", "v": 1, "jobId": "ghost", "at": 1 });
        assert!(fold_events(&format!("{body}\n")).is_empty());
    }

    #[test]
    fn a_second_queued_line_for_one_job_does_not_duplicate_it() {
        let dir = tmp("dupe");
        let q = Queue::new(dir);
        let id = q.enqueue(&req("s-1")).unwrap();
        q.append(&JobEvent::Queued(JobQueued {
            v: WRAPUP_QUEUE_VERSION,
            job_id: id.clone(),
            at: now_ms(),
            session_id: "s-other".into(),
            workspace_id: "ws-other".into(),
            cli_kind: None,
            transcript_path: "/tmp/other.jsonl".into(),
            session_name: None,
        }))
        .unwrap();
        assert_eq!(q.jobs().len(), 1);
        assert_eq!(one(&q, &id).session_id, "s-1", "the first line wins");
    }

    // ----- retention -----

    #[test]
    fn finished_jobs_are_kept_but_not_forever() {
        let dir = tmp("prune");
        let q = Queue::new(dir);
        // One live job, to prove retention does not touch what is not finished.
        let live = q.enqueue(&req("s-live")).unwrap();

        let mut ids = Vec::new();
        for i in 0..KEEP_TERMINAL + 5 {
            let id = q.enqueue(&req(&format!("s-{i}"))).unwrap();
            q.take(&id).unwrap();
            q.finish(&id, None, None).unwrap();
            ids.push(id);
        }

        let out = q.recover().unwrap();
        assert_eq!(out.pruned, 5);

        let kept: BTreeSet<String> = q.jobs().into_iter().map(|j| j.job_id).collect();
        assert!(kept.contains(&live), "an unfinished job is never pruned");
        for gone in &ids[..5] {
            assert!(!kept.contains(gone), "the oldest finished jobs went");
        }
        for stays in &ids[5..] {
            assert!(kept.contains(stays), "the newest {KEEP_TERMINAL} stayed");
        }
    }

    /// Compaction filters lines rather than re-rendering them, so a line an
    /// older build cannot read is not rewritten into the shape it can.
    #[test]
    fn a_line_it_cannot_attribute_survives_compaction() {
        assert_eq!(job_id_of_line(r#"{"t":"started","jobId":"j-1","at":1}"#).as_deref(), Some("j-1"));
        assert_eq!(job_id_of_line("half a line {"), None);
        assert_eq!(job_id_of_line(r#"{"t":"whatever-comes-next","at":1}"#), None);
    }

    // ----- the contract with sync -----

    /// A queued job names a transcript path on this machine, and a job half-run
    /// here must not be picked up there. Nothing had to be done to keep the file
    /// off the wire — this asserts that deny-by-default is in fact what is
    /// keeping it off.
    #[test]
    fn the_queue_does_not_travel() {
        let dir = tmp("travels");
        let q = Queue::new(dir.clone());
        q.enqueue(&req("s-1")).unwrap();
        assert!(q.path().exists());

        std::fs::write(dir.join(".gitignore"), crate::sync::manifest::gitignore()).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(["-c", "core.quotePath=false"])
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        let tracked: Vec<String> = git(&["ls-files"]).lines().map(str::to_string).collect();
        assert_eq!(tracked, vec![".gitignore".to_string()], "the queue must stay here");
    }
}
