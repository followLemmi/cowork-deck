//! The scenario run journal: events on disk, records in memory.
//!
//! A scenario is a saved prompt launched as a session, and until this existed
//! the app kept nothing once its tile was closed — `sessions.json` dropped the
//! entry and only the scheduler's `schedule_state.json` remembered anything at
//! all, one record *per scenario* and only for scheduled fires. This module is
//! the shape of the record that survives.
//!
//! # Events, not records
//!
//! The file holds **events**, appended one JSON object per line, folded into
//! records on read. Append-only rather than the truncate-then-write
//! `Store::write_vec` uses elsewhere: the comment on `try_read_vec` already
//! admits that a crash mid-write leaves an empty file (#117), and a journal
//! written on every launch cannot afford that. A half-written appended line
//! costs that line and nothing else.
//!
//! # Versioned per line, not per file
//!
//! An append-only file physically holds lines written by several app versions
//! after an upgrade, so a header would lie about the ones below it. Every line
//! carries its own `v`; a line whose `v` is above ours, or whose `t` we do not
//! know, is skipped with a warning and the rest of the journal stands.
//!
//! # Immutability
//!
//! A record carries a **snapshot** of the scenario's name, icon and expanded
//! prompt. `skillId` is a filter key and nothing more, so deleting or renaming
//! the scenario — or deleting its workspace — cannot rewrite the past. That is a
//! lesson this repository has already learned once: `schedule_state.json` is
//! kept out of `Skill.schedule` precisely so that editing a scenario cannot
//! clobber runtime state.

use crate::model::TokenUsage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The highest line version this build writes, and the highest it can read.
///
/// In the spirit of `SCHEDULE_STATE_VERSION`, and for the same reason: the
/// timestamps below are true epochs, which version 1 of `ScheduleRun` was not,
/// and a reader has to be able to tell which rule a line was written under.
pub const RUN_JOURNAL_VERSION: u8 = 1;

/// How many runs of one scenario the journal keeps.
///
/// Per scenario rather than per file, and a count rather than a time window: at
/// 90 days a monthly scenario would keep three records and an hourly one two
/// thousand — detailed exactly where nobody needs it.
pub const RUNS_PER_SKILL: usize = 100;

/// How the launch that opened this record started.
///
/// Scheduled fires are **not** split off into a journal of their own. The
/// question a person brings to a history is "when did this scenario last run",
/// not "when did the scheduler last run it"; filtering by this in the UI is
/// cheaper than records that were never written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunTrigger {
    /// Clicking the scenario in the sidebar, or on the empty deck.
    Manual,
    /// The ⏰ button on a scheduled scenario.
    RunNow,
    /// The backend scheduler came due.
    Schedule,
    /// Auto-restore after a restart, or the tile's own ⟳. A new record chained
    /// to its predecessor via `continuesRunId` — see `RunRecord`.
    Resume,
}

/// What a record is, or how it ended.
///
/// `Running` is the only one that is not a close: a record is born with it and
/// leaves it exactly once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    Running,
    /// The process finished, or the person closed the tile.
    Ended,
    /// The process exited non-zero.
    Error,
    /// Still `running` at app start with no live PTY behind it — a crash, a
    /// `kill`, a closed laptop lid. Recorded rather than left open, because
    /// those are precisely the cases a journal exists for.
    Interrupted,
    /// A scheduled occurrence fired and no session started. There is no
    /// `sessionId` and never was one. "The schedule silently did nothing" is
    /// what people open a history to find out.
    FailedToLaunch,
}

/// Where `result` came from, said out loud so the UI never has to guess whether
/// an absent result means "nothing was said" or "nothing could be read".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSource {
    /// Read out of the transcript this run last reported.
    Transcript,
    /// No transcript was ever reported, or the file is gone. `result` is
    /// `None` — never an invented empty string.
    None,
}

fn journal_version() -> u8 {
    RUN_JOURNAL_VERSION
}

/// A run begins. Everything here is a snapshot of the moment of launch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunStarted {
    #[serde(rename = "v", default = "journal_version")]
    pub version: u8,
    #[serde(rename = "runId")]
    pub run_id: String,
    /// A **true epoch** in millis. Not `naive_local().and_utc()` — that is the
    /// version-1 bug `ScheduleRun` had to grow a version field to escape.
    pub at: i64,
    pub trigger: RunTrigger,
    /// A filter key, never a source of display text. See the module docs.
    #[serde(rename = "skillId")]
    pub skill_id: String,
    /// The scenario's name **as it was**, so a deleted or renamed scenario's
    /// history still reads correctly.
    pub name: String,
    pub icon: String,
    #[serde(rename = "workspaceId", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Absent on a `failed-to-launch` record: nothing was launched.
    #[serde(rename = "sessionId", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub params: HashMap<String, String>,
    /// The **expanded** text, placeholders substituted — never the template.
    /// The template lives in `skills.json` and changes; what ran was this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// The run this one resumed, when it resumed one. A run is one launched
    /// PTY, so auto-restore and ⟳ open a new record rather than reopening the
    /// old one — a record that spanned an app restart could never say which
    /// side of the crash a result came from.
    #[serde(rename = "continuesRunId", default, skip_serializing_if = "Option::is_none")]
    pub continues_run_id: Option<String>,
}

/// Where this run's transcript is *now*.
///
/// Written on the first hook that reports a path and again whenever the path
/// changes — the same "forward, never back" rule as `transcripts::record`. A
/// change of path **is** a `/clear`: Claude Code mints a new session id and a
/// new file mid-conversation, and never writes to the old one again — see the
/// module comment on `transcripts` for the measured behaviour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunTranscript {
    #[serde(rename = "v", default = "journal_version")]
    pub version: u8,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub at: i64,
    pub path: String,
    /// True when this path replaces an earlier one, so the UI can say that the
    /// beginning of this run is in another file rather than quietly presenting
    /// the tail of a conversation as the whole of it.
    #[serde(default)]
    pub cleared: bool,
}

/// A run ends. Exactly one of these matters per run; see [`fold_events`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunClosed {
    #[serde(rename = "v", default = "journal_version")]
    pub version: u8,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub at: i64,
    pub status: RunStatus,
    /// The final assistant message, or `None` when there was no transcript to
    /// read it from. Metadata alone cannot say *what* a scenario did, which is
    /// what people came to the history for; a copy of the whole transcript
    /// would duplicate megabytes whose lifetime this app does not own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Why a run produced nothing, where there is a reason to give: the
    /// scheduler's own `no-workspace` / `skipped-overlap` / `not-scheduled`.
    ///
    /// Beyond the shape the epic sketched, and deliberately. Without it a
    /// `failed-to-launch` record says the schedule did nothing without saying
    /// why — which is half of what somebody opened the history to find out. An
    /// older reader ignores the field; that is what per-line versioning buys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    #[serde(rename = "resultSource")]
    pub result_source: ResultSource,
}

/// One line of `runs.jsonl`.
///
/// Internally tagged on `t`, so the tag spelling is derived in both directions
/// and cannot disagree with itself — the same rule `KnownTrackerProvider`
/// follows in `model.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum RunEvent {
    Started(RunStarted),
    Transcript(RunTranscript),
    Closed(RunClosed),
}

impl RunEvent {
    /// Serialise to the single line that is appended to the journal. Never
    /// contains a newline: `serde_json::to_string` does not emit one, and the
    /// strings inside are escaped.
    pub fn to_line(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

/// One run, folded out of its events. This is what the frontend reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunRecord {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "closedAt")]
    pub closed_at: Option<i64>,
    pub trigger: RunTrigger,
    pub status: RunStatus,
    #[serde(rename = "skillId")]
    pub skill_id: String,
    pub name: String,
    pub icon: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub cwd: String,
    pub branch: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub params: HashMap<String, String>,
    pub prompt: Option<String>,
    #[serde(rename = "continuesRunId")]
    pub continues_run_id: Option<String>,
    /// The latest transcript this run reported, if any ever arrived.
    #[serde(rename = "transcriptPath")]
    pub transcript_path: Option<String>,
    /// A `/clear` happened during this run, so `result` is the tail of a
    /// conversation whose beginning is in another file.
    pub cleared: bool,
    pub result: Option<String>,
    /// Why nothing came of the run, where there is a reason to give — see
    /// `RunClosed::reason`.
    pub reason: Option<String>,
    pub tokens: Option<TokenUsage>,
    #[serde(rename = "resultSource")]
    pub result_source: ResultSource,
}

impl RunRecord {
    fn open(e: RunStarted) -> RunRecord {
        RunRecord {
            run_id: e.run_id,
            started_at: e.at,
            closed_at: None,
            trigger: e.trigger,
            status: RunStatus::Running,
            skill_id: e.skill_id,
            name: e.name,
            icon: e.icon,
            workspace_id: e.workspace_id,
            cwd: e.cwd,
            branch: e.branch,
            session_id: e.session_id,
            params: e.params,
            prompt: e.prompt,
            continues_run_id: e.continues_run_id,
            transcript_path: None,
            cleared: false,
            result: None,
            reason: None,
            tokens: None,
            // A record that is still open has read nothing yet, and saying
            // `Transcript` here would claim a reading that never happened.
            result_source: ResultSource::None,
        }
    }

    /// The events that reproduce this record, for compaction.
    ///
    /// Lossy in exactly one way, and deliberately: several `transcript` events
    /// collapse into the latest path plus the `cleared` flag, which is all
    /// anything reads them for.
    pub fn to_events(&self) -> Vec<RunEvent> {
        let mut out = vec![RunEvent::Started(RunStarted {
            version: RUN_JOURNAL_VERSION,
            run_id: self.run_id.clone(),
            at: self.started_at,
            trigger: self.trigger,
            skill_id: self.skill_id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            workspace_id: self.workspace_id.clone(),
            cwd: self.cwd.clone(),
            branch: self.branch.clone(),
            session_id: self.session_id.clone(),
            params: self.params.clone(),
            prompt: self.prompt.clone(),
            continues_run_id: self.continues_run_id.clone(),
        })];
        if let Some(path) = &self.transcript_path {
            out.push(RunEvent::Transcript(RunTranscript {
                version: RUN_JOURNAL_VERSION,
                run_id: self.run_id.clone(),
                at: self.closed_at.unwrap_or(self.started_at),
                path: path.clone(),
                cleared: self.cleared,
            }));
        }
        if let Some(at) = self.closed_at {
            out.push(RunEvent::Closed(RunClosed {
                version: RUN_JOURNAL_VERSION,
                run_id: self.run_id.clone(),
                at,
                status: self.status,
                result: self.result.clone(),
                reason: self.reason.clone(),
                tokens: self.tokens,
                result_source: self.result_source,
            }));
        }
        out
    }
}

/// Read one line, or say why it was skipped.
///
/// Every refusal here costs **that line** and nothing else. A journal that
/// aborted on the first thing it did not understand would lose the history it
/// exists to keep, over a line written by a version that is not even installed
/// any more.
fn parse_line(line: &str) -> Option<RunEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // The version is read before the body, so a line from a newer build is
    // skipped rather than mis-parsed into the shape this build happens to have.
    let raw: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            // The ordinary case is the last line of a file the process died
            // half-way through writing, which is exactly what append-only is
            // for. Everything before it stands.
            eprintln!("warning: skipping an unreadable line of the run journal ({e})");
            return None;
        }
    };
    match raw.get("v").and_then(serde_json::Value::as_u64) {
        Some(v) if v > RUN_JOURNAL_VERSION as u64 => {
            eprintln!(
                "warning: skipping a run journal line written by a newer version (v{v} > v{RUN_JOURNAL_VERSION})",
            );
            return None;
        }
        _ => {}
    }
    match serde_json::from_value::<RunEvent>(raw) {
        Ok(ev) => Some(ev),
        Err(e) => {
            eprintln!("warning: skipping an unrecognised run journal line ({e})");
            None
        }
    }
}

/// Fold a whole `runs.jsonl` body into records, oldest first.
///
/// The rules a reader must not care about, because the writer might get one of
/// them wrong one day:
///
/// - a `closed` or `transcript` with no matching `started` is ignored — there is
///   no record for it to be about;
/// - a second `started` for a run id already seen is ignored;
/// - a second `closed` for one run is ignored: **the first one wins**, so the
///   moment a run stopped cannot be revised by a later, less-informed writer.
pub fn fold_events(content: &str) -> Vec<RunRecord> {
    let mut order: Vec<RunRecord> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for line in content.lines() {
        let Some(ev) = parse_line(line) else { continue };
        match ev {
            RunEvent::Started(e) => {
                if index.contains_key(&e.run_id) {
                    continue;
                }
                index.insert(e.run_id.clone(), order.len());
                order.push(RunRecord::open(e));
            }
            RunEvent::Transcript(e) => {
                let Some(&i) = index.get(&e.run_id) else { continue };
                let rec = &mut order[i];
                rec.transcript_path = Some(e.path);
                // Sticky: a run that cleared once has cleared, and a later
                // event that forgot to say so must not un-say it.
                rec.cleared = rec.cleared || e.cleared;
            }
            RunEvent::Closed(e) => {
                let Some(&i) = index.get(&e.run_id) else { continue };
                let rec = &mut order[i];
                if rec.closed_at.is_some() {
                    continue;
                }
                rec.closed_at = Some(e.at);
                rec.status = e.status;
                rec.result = e.result;
                rec.reason = e.reason;
                rec.tokens = e.tokens;
                rec.result_source = e.result_source;
            }
        }
    }
    order
}

/// Which records survive retention: the newest [`RUNS_PER_SKILL`] of each
/// scenario, in the order they were given.
///
/// Per scenario, so a nightly job is not evicted by an hourly one. Order is
/// preserved rather than rebuilt, so compaction rewrites the file in the same
/// sequence it was appended in.
pub fn retain_recent(records: Vec<RunRecord>, per_skill: usize) -> Vec<RunRecord> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for r in &records {
        *counts.entry(r.skill_id.as_str()).or_insert(0) += 1;
    }
    // How many of each scenario's records, counting from the oldest, have to
    // go. Computed up front so the walk stays forward and the surviving order
    // is the file's own.
    let mut to_drop: HashMap<String, usize> = counts
        .into_iter()
        .filter(|(_, n)| *n > per_skill)
        .map(|(id, n)| (id.to_string(), n - per_skill))
        .collect();
    if to_drop.is_empty() {
        return records;
    }
    records
        .into_iter()
        .filter(|r| match to_drop.get_mut(&r.skill_id) {
            Some(left) if *left > 0 => {
                *left -= 1;
                false
            }
            _ => true,
        })
        .collect()
}

/// Narrow a journal to one workspace and/or one scenario.
///
/// Records with **no** `workspaceId` pass every workspace filter. An unpinned
/// scenario whose scheduled fire never resolved a folder belongs to no
/// workspace, and hiding it everywhere would hide precisely the failure worth
/// seeing — the same rule the deck already applies to orphaned tiles.
pub fn scoped(
    records: Vec<RunRecord>,
    workspace_id: Option<&str>,
    skill_id: Option<&str>,
) -> Vec<RunRecord> {
    records
        .into_iter()
        .filter(|r| match (workspace_id, &r.workspace_id) {
            (Some(want), Some(have)) => want == have,
            (Some(_), None) => true,
            (None, _) => true,
        })
        .filter(|r| skill_id.is_none_or(|want| want == r.skill_id))
        .collect()
}

/// The final assistant message of a transcript, sanitised for display.
///
/// Scanned **backwards**: the last assistant turn is at the end, and a
/// transcript can run to megabytes. Tolerant of everything a file read while
/// another process is writing to it contains — non-JSON lines, a truncated last
/// line, a content block of an unexpected shape.
///
/// Text blocks of one message are joined with a blank line, which is how they
/// were meant to read; a message with no text block at all (a turn that only
/// called tools) is not the final *message* anyone means, so the walk continues.
pub fn last_assistant_text(content: &str) -> Option<String> {
    for line in content.lines().rev() {
        // Cheap prefilter: most lines of a transcript are not assistant turns,
        // and parsing every one of them backwards would read the whole file.
        if !line.contains("\"assistant\"") {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v["message"]["role"] != "assistant" {
            continue;
        }
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        let text = blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(run_id: &str, skill: &str, at: i64) -> RunEvent {
        RunEvent::Started(RunStarted {
            version: RUN_JOURNAL_VERSION,
            run_id: run_id.into(),
            at,
            trigger: RunTrigger::Manual,
            skill_id: skill.into(),
            name: "Morning triage".into(),
            icon: "bolt".into(),
            workspace_id: Some("w1".into()),
            cwd: "/p".into(),
            branch: Some("main".into()),
            session_id: Some(format!("sess-{run_id}")),
            params: HashMap::new(),
            prompt: Some("do the thing".into()),
            continues_run_id: None,
        })
    }

    fn closed(run_id: &str, at: i64, status: RunStatus) -> RunEvent {
        RunEvent::Closed(RunClosed {
            version: RUN_JOURNAL_VERSION,
            run_id: run_id.into(),
            at,
            status,
            result: Some("done".into()),
            reason: None,
            tokens: None,
            result_source: ResultSource::Transcript,
        })
    }

    fn journal(events: &[RunEvent]) -> String {
        events
            .iter()
            .map(|e| e.to_line().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_started_and_a_closed_fold_into_one_record() {
        let body = journal(&[started("r1", "s1", 10), closed("r1", 20, RunStatus::Ended)]);
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].run_id, "r1");
        assert_eq!(recs[0].status, RunStatus::Ended);
        assert_eq!(recs[0].started_at, 10);
        assert_eq!(recs[0].closed_at, Some(20));
        assert_eq!(recs[0].result.as_deref(), Some("done"));
    }

    #[test]
    fn an_unclosed_record_is_still_running() {
        let recs = fold_events(&journal(&[started("r1", "s1", 10)]));
        assert_eq!(recs[0].status, RunStatus::Running);
        assert_eq!(recs[0].closed_at, None);
        // Never `Transcript`: nothing has been read.
        assert_eq!(recs[0].result_source, ResultSource::None);
    }

    /// The crash case, and the reason the file is append-only rather than
    /// rewritten: everything before the half-written line survives.
    #[test]
    fn a_truncated_final_line_costs_that_line_and_nothing_else() {
        let mut body = journal(&[started("r1", "s1", 10), closed("r1", 20, RunStatus::Ended)]);
        body.push('\n');
        body.push_str(r#"{"v":1,"t":"started","runId":"r2","at":30,"trig"#);
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 1, "the complete run survives: {recs:?}");
        assert_eq!(recs[0].run_id, "r1");
    }

    /// A line from a build that is not even installed any more must not take
    /// the journal down with it.
    #[test]
    fn an_unknown_kind_or_a_newer_version_skips_only_that_line() {
        let body = [
            started("r1", "s1", 10).to_line().unwrap(),
            r#"{"v":1,"t":"paused","runId":"r1","at":15}"#.to_string(),
            r#"{"v":99,"t":"closed","runId":"r1","at":16,"status":"error","resultSource":"none"}"#
                .to_string(),
            closed("r1", 20, RunStatus::Ended).to_line().unwrap(),
        ]
        .join("\n");
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 1);
        assert_eq!(
            recs[0].status,
            RunStatus::Ended,
            "the v99 close must not have been applied",
        );
    }

    #[test]
    fn a_closed_without_a_started_is_ignored() {
        let recs = fold_events(&journal(&[closed("ghost", 20, RunStatus::Ended)]));
        assert!(recs.is_empty());
    }

    /// The writer must not emit two, and the reader must not care that it did.
    /// The first wins, so the moment a run stopped cannot be revised later by a
    /// writer that knows less about it.
    #[test]
    fn the_first_close_wins() {
        let body = journal(&[
            started("r1", "s1", 10),
            closed("r1", 20, RunStatus::Ended),
            closed("r1", 30, RunStatus::Interrupted),
        ]);
        let recs = fold_events(&body);
        assert_eq!(recs[0].status, RunStatus::Ended);
        assert_eq!(recs[0].closed_at, Some(20));
    }

    #[test]
    fn a_repeated_start_for_one_run_is_ignored() {
        let body = journal(&[started("r1", "s1", 10), started("r1", "s1", 99)]);
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].started_at, 10);
    }

    /// `/clear` mid-run: a second path for the same run, and no second run.
    #[test]
    fn a_transcript_switch_marks_the_record_cleared_without_opening_a_second_run() {
        let body = journal(&[
            started("r1", "s1", 10),
            RunEvent::Transcript(RunTranscript {
                version: 1, run_id: "r1".into(), at: 11,
                path: "/t/a.jsonl".into(), cleared: false,
            }),
            RunEvent::Transcript(RunTranscript {
                version: 1, run_id: "r1".into(), at: 12,
                path: "/t/b.jsonl".into(), cleared: true,
            }),
        ]);
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].transcript_path.as_deref(), Some("/t/b.jsonl"));
        assert!(recs[0].cleared);
    }

    /// Once cleared, always cleared. Presenting the tail of a conversation as
    /// the whole of it is the one lie this flag exists to prevent, and a later
    /// event that merely forgot to repeat it must not undo the warning.
    #[test]
    fn the_cleared_marker_is_sticky() {
        let body = journal(&[
            started("r1", "s1", 10),
            RunEvent::Transcript(RunTranscript {
                version: 1, run_id: "r1".into(), at: 11,
                path: "/t/b.jsonl".into(), cleared: true,
            }),
            RunEvent::Transcript(RunTranscript {
                version: 1, run_id: "r1".into(), at: 12,
                path: "/t/c.jsonl".into(), cleared: false,
            }),
        ]);
        assert!(fold_events(&body)[0].cleared);
    }

    #[test]
    fn a_chain_keeps_pointing_at_its_predecessor() {
        let mut second = started("r2", "s1", 30);
        if let RunEvent::Started(e) = &mut second {
            e.trigger = RunTrigger::Resume;
            e.continues_run_id = Some("r1".into());
        }
        let body = journal(&[
            started("r1", "s1", 10),
            closed("r1", 20, RunStatus::Interrupted),
            second,
        ]);
        let recs = fold_events(&body);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1].trigger, RunTrigger::Resume);
        assert_eq!(recs[1].continues_run_id.as_deref(), Some("r1"));
    }

    /// Retention counts per scenario, so a nightly job is not evicted by an
    /// hourly one that happens to share the file.
    #[test]
    fn retention_keeps_the_newest_n_of_each_scenario() {
        let mut evs = Vec::new();
        for i in 0..5 {
            evs.push(started(&format!("busy-{i}"), "hourly", i));
        }
        for i in 0..2 {
            evs.push(started(&format!("rare-{i}"), "nightly", 100 + i));
        }
        let kept = retain_recent(fold_events(&journal(&evs)), 3);
        let busy: Vec<&str> = kept
            .iter()
            .filter(|r| r.skill_id == "hourly")
            .map(|r| r.run_id.as_str())
            .collect();
        assert_eq!(busy, vec!["busy-2", "busy-3", "busy-4"]);
        assert_eq!(kept.iter().filter(|r| r.skill_id == "nightly").count(), 2);
        // The surviving order is the file's own, so compaction rewrites the
        // journal in the sequence it was appended in.
        assert_eq!(kept.first().unwrap().run_id, "busy-2");
    }

    #[test]
    fn retention_below_the_cap_changes_nothing() {
        let evs = [started("a", "s", 1), started("b", "s", 2)];
        let recs = fold_events(&journal(&evs));
        assert_eq!(retain_recent(recs.clone(), 100), recs);
    }

    /// Compaction rewrites the file from records, so the round trip has to be
    /// faithful — including the `/clear` marker, which is the one thing the
    /// event stream carries that a naive record→event mapping would drop.
    #[test]
    fn a_record_round_trips_through_its_own_events() {
        let body = journal(&[
            started("r1", "s1", 10),
            RunEvent::Transcript(RunTranscript {
                version: 1, run_id: "r1".into(), at: 11,
                path: "/t/b.jsonl".into(), cleared: true,
            }),
            closed("r1", 20, RunStatus::Error),
        ]);
        let original = fold_events(&body);
        let rewritten = journal(&original[0].to_events());
        assert_eq!(fold_events(&rewritten), original);
    }

    #[test]
    fn a_failed_to_launch_record_carries_no_session() {
        let body = [
            r#"{"v":1,"t":"started","runId":"r1","at":10,"trigger":"schedule","skillId":"s1","name":"Nightly","icon":"bolt","cwd":"/p"}"#,
            r#"{"v":1,"t":"closed","runId":"r1","at":10,"status":"failed-to-launch","resultSource":"none"}"#,
        ]
        .join("\n");
        let recs = fold_events(&body);
        assert_eq!(recs[0].status, RunStatus::FailedToLaunch);
        assert_eq!(recs[0].session_id, None);
        assert_eq!(recs[0].result, None);
        assert_eq!(recs[0].result_source, ResultSource::None);
    }

    /// The four close statuses are spelled on disk exactly as the frontend
    /// reads them. `failed-to-launch` is the one a `rename_all` mistake would
    /// silently turn into `failedToLaunch`, with the UI falling through to no
    /// state at all.
    #[test]
    fn the_close_statuses_serialise_as_the_frontend_spells_them() {
        for (status, spelling) in [
            (RunStatus::Running, "running"),
            (RunStatus::Ended, "ended"),
            (RunStatus::Error, "error"),
            (RunStatus::Interrupted, "interrupted"),
            (RunStatus::FailedToLaunch, "failed-to-launch"),
        ] {
            let line = closed("r", 1, status).to_line().unwrap();
            assert!(line.contains(&format!(r#""status":"{spelling}""#)), "{line}");
        }
        for (trigger, spelling) in [
            (RunTrigger::Manual, "manual"),
            (RunTrigger::RunNow, "runNow"),
            (RunTrigger::Schedule, "schedule"),
            (RunTrigger::Resume, "resume"),
        ] {
            let mut ev = started("r", "s", 1);
            if let RunEvent::Started(e) = &mut ev {
                e.trigger = trigger;
            }
            let line = ev.to_line().unwrap();
            assert!(line.contains(&format!(r#""trigger":"{spelling}""#)), "{line}");
        }
    }

    /// The screen is scoped to one workspace, like every other screen in the
    /// app — so a run of an unpinned scenario appears in the workspace it
    /// actually ran in, not in all of them.
    #[test]
    fn scoping_narrows_to_one_workspace_and_one_scenario() {
        let mut evs = Vec::new();
        for (id, skill, ws) in [
            ("a", "s1", Some("w1")),
            ("b", "s2", Some("w1")),
            ("c", "s1", Some("w2")),
        ] {
            let mut ev = started(id, skill, 1);
            if let RunEvent::Started(e) = &mut ev {
                e.workspace_id = ws.map(str::to_string);
            }
            evs.push(ev);
        }
        let all = fold_events(&journal(&evs));
        let ids = |v: Vec<RunRecord>| v.into_iter().map(|r| r.run_id).collect::<Vec<_>>();
        assert_eq!(ids(scoped(all.clone(), Some("w1"), None)), vec!["a", "b"]);
        assert_eq!(ids(scoped(all.clone(), None, Some("s1"))), vec!["a", "c"]);
        assert_eq!(ids(scoped(all.clone(), Some("w2"), Some("s1"))), vec!["c"]);
        assert_eq!(ids(scoped(all, None, None)).len(), 3);
    }

    /// A scheduled fire that resolved no workspace belongs to none — and hiding
    /// it everywhere would hide precisely the failure worth seeing. It passes
    /// every workspace filter, the way an orphaned tile stays visible in every
    /// deck.
    #[test]
    fn a_record_with_no_workspace_shows_up_under_every_one() {
        let mut ev = started("homeless", "s1", 1);
        if let RunEvent::Started(e) = &mut ev {
            e.workspace_id = None;
        }
        let all = fold_events(&journal(&[ev]));
        assert_eq!(scoped(all.clone(), Some("w1"), None).len(), 1);
        assert_eq!(scoped(all, Some("w2"), None).len(), 1);
    }

    #[test]
    fn the_last_assistant_message_is_read_off_the_tail() {
        let content = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"last"}]}}"#,
        ]
        .join("\n");
        assert_eq!(last_assistant_text(&content).as_deref(), Some("last"));
    }

    /// A turn that only called a tool is not the final *message* anybody means,
    /// so the walk goes past it to the last one that actually said something.
    #[test]
    fn a_tool_only_turn_is_not_the_result() {
        let content = [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the answer"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}"#,
        ]
        .join("\n");
        assert_eq!(last_assistant_text(&content).as_deref(), Some("the answer"));
    }

    #[test]
    fn several_text_blocks_of_one_turn_read_as_one_message() {
        let content = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"a"},{"type":"text","text":"b"}]}}"#;
        assert_eq!(last_assistant_text(content).as_deref(), Some("a\n\nb"));
    }

    /// A transcript being appended to while this reads it, and one with nothing
    /// in it. Neither is an error, and neither may produce `Some("")` — an
    /// empty result and an unreadable one are different facts.
    #[test]
    fn a_damaged_or_silent_transcript_yields_no_result_rather_than_an_empty_one() {
        assert_eq!(last_assistant_text(""), None);
        assert_eq!(last_assistant_text("not json at all"), None);
        let half = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tex"#;
        assert_eq!(last_assistant_text(half), None);
        let blank = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"   "}]}}"#;
        assert_eq!(last_assistant_text(blank), None);
    }
}
