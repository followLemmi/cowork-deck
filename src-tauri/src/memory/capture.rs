//! Capture: one `claude -p` per closed session, turning a transcript into a
//! note somebody can find again.
//!
//! The corpus fills itself or the feature does not work. #35 rejected indexing
//! raw transcripts as noise — tool calls, diffs, abandoned reasoning — so
//! something has to read a session and write prose about it. This is that
//! something, and it is the first headless Claude invocation anywhere in the
//! app.
//!
//! # It spends the person's money
//!
//! `claude -p` runs under their own Claude Code credentials, so every capture is
//! billed to their subscription or their API budget. That is the reason consent
//! is asked at the close (#366) rather than assumed, and the reason this module
//! is built to be economical rather than thorough:
//!
//! - the transcript is reduced to its prose before it is sent, not shipped
//!   whole — [`super::transcript`] drops tool calls, tool results, thinking
//!   blocks, injected reminders and slash-command echoes, which is most of the
//!   bytes of a working session;
//! - what survives is capped at [`DIGEST_CHARS`], keeping the head and the tail
//!   over the middle;
//! - a session with nothing in it is never sent at all;
//! - the default system prompt is replaced rather than appended to, and
//!   `--restricted` strips the tools, so the request carries this task and
//!   little else;
//! - [`CAPTURE_MODEL`] is the cheap model, because the job is summarising prose
//!   that is already in front of it.
//!
//! What it cost comes back in the `--output-format json` envelope, and is kept
//! on the job record. A number we already have and would have to re-run the
//! model to recover is not worth throwing away — least of all this number.
//!
//! # Whose transcript, and who summarises it
//!
//! Two independent axes, and they are deliberately separate. **How a session's
//! log is read** depends on the CLI that wrote it, and lives in
//! [`super::transcript`] behind a per-CLI digester — the deck runs sessions on
//! four CLIs and their logs have nothing in common. **Who writes the summary**
//! is this module's choice, and it is Claude for every session regardless of
//! which CLI produced the transcript: summarising prose is not a job that needs
//! the model to be the one that did the work.
//!
//! A session whose CLI has no digester yet fails visibly rather than producing
//! nothing — see [`super::transcript`] for why that distinction is the whole
//! reason the seam exists.
//!
//! # The call is isolated on purpose
//!
//! Four flags, each closing a specific hole rather than being hygiene:
//!
//! - `--restricted` ignores the user, project and local settings files, which is
//!   what keeps **the deck's own hooks** out of this call. Without it a capture
//!   could fire the reporter and have the listener attribute its events to a
//!   session that has already closed.
//! - `--strict-mcp-config` skips every MCP server the person has configured.
//!   Summarising prose needs none of them, and starting a handful of stdio
//!   servers to do it would cost more than the call.
//! - `--no-session-persistence` keeps the call out of `~/.claude/projects`, so
//!   it never becomes a transcript the deck might later read, count or resume.
//! - a scratch working directory, because `--restricted` ignores project
//!   *settings* and a `CLAUDE.md` is loaded by directory. Running in the
//!   person's repository would put their project instructions into a request
//!   that has nothing to do with their project.

use super::corpus::{Corpus, DiaryEntry, Note, Section};
use super::queue::WrapupJob;
use super::transcript::{self, Digest};
use crate::which::{self, RunFault};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The model a capture runs on.
///
/// The cheap one, deliberately: the job is reducing prose that is already in the
/// request to a shorter piece of prose, which is the task least sensitive to
/// model strength — and it is charged to the person on every closed tile. An
/// alias rather than a pinned id, so it follows the latest model of that tier
/// instead of going stale in a constant.
///
/// Overridable through `COWORK_MEMORY_CAPTURE_MODEL` while #368 settles whether
/// this belongs in the interface. The escape hatch is the same one
/// `COWORK_MEMORY_MODEL_DIR` gives the sidecar's tests.
pub const CAPTURE_MODEL: &str = "haiku";

/// How long one capture may take before it is reaped and retried.
///
/// A summary is worth a bounded wait and nothing more. A mirror that accepts the
/// connection and goes quiet would otherwise hold the queue forever, and the
/// queue is serial — one hung call is every later summary.
const DEADLINE: Duration = Duration::from_secs(180);

/// How much conversation, in **characters**, goes into one prompt.
///
/// Characters, not bytes: the same rule ADR-0003 names as the port's standing
/// hazard, and a budget counted in bytes silently halves on Cyrillic.
const DIGEST_CHARS: usize = 24_000;

/// How much of an unparseable reply a failed job keeps.
///
/// The reply is ours — the model wrote it — so keeping it is how a parse failure
/// becomes debuggable instead of mysterious. Bounded because it lands in a
/// record, and unbounded text in a record is a record nobody opens.
const KEEP_REPLY_CHARS: usize = 2_000;

/// A diary room, as the capture prompt needs to see it.
///
/// Declared here because capture is the only thing that reads one today. #367
/// owns the configuration — where the list comes from, how it is edited, whether
/// it travels — and this type moves there with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    pub name: String,
    /// What belongs in it, in the person's own words. The only thing the model
    /// has to route a lesson by, which is why it is a field rather than a
    /// comment.
    pub description: String,
}

/// What one capture cost, off the CLI's own envelope.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CaptureCost {
    #[serde(rename = "inputTokens", default)]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: u64,
    /// What the CLI says it cost, when it says. Absent on a plan where the
    /// question does not have a dollar answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
}

// ---------------------------------------------------------------- the prompt

/// The system prompt, which **replaces** Claude Code's default rather than
/// adding to it.
///
/// The default is a coding agent's prompt: tool policies, a repository, a
/// harness. None of it applies to reading a transcript and writing a summary,
/// and all of it would be paid for on every closed tile.
const SYSTEM_PROMPT: &str = "\
You summarise one software-development session into a durable note for a \
personal memory corpus that is searched semantically. You do not write code, \
do not use tools, and reply with one JSON object and nothing else.";

/// What the model is asked for, and the shape it has to come back in.
///
/// The conventions in here are not preferences. The `## TL;DR` is the indexer's
/// priority chunk and the only one allowed to be terse; a fact is a dated bullet
/// that is grepped; a lesson is one pipe-separated line. They are described to
/// the model because the note is only as useful as its shape.
fn prompt(digest: &Digest, rooms: &[Room]) -> String {
    let mut s = String::new();
    s.push_str(
        "Below is one session between a person and an AI coding assistant, with \
         tool calls and their output removed. Summarise it.\n\n",
    );
    s.push_str("Reply with exactly one JSON object, no prose around it, no code fence:\n\n");
    s.push_str(
        r#"{
  "empty": false,
  "topic": "two to five words, used as a filename",
  "title": "one line naming what this session was",
  "tldr": "5-10 lines, facts only, no preamble. This is what a search returns first.",
  "sections": [{"heading": "What we did", "body": "markdown"}],
  "facts": ["subject — predicate — object"],
  "lessons": [{"room": "<one of the rooms below>", "severity": "low|medium|high", "category": "two or three words", "what": "what happened", "avoid": "how to avoid it next time"}]
}
"#,
    );
    s.push_str(
        "\nRules:\n\
         - Set \"empty\": true and omit everything else if the session did nothing \
           worth remembering — no work done, only a greeting, or an accidental open. \
           Prefer this over inventing a summary.\n\
         - Write in the language the session itself was in. This note is for the \
           person who did the work.\n\
         - \"tldr\" is the load-bearing field. Concrete: what changed, what was \
           decided, what broke and why. No \"the user asked about…\".\n\
         - \"facts\" are durable claims that will still be true next month — a \
           decision, a constraint, a path, a version. Not events. Omit the list if \
           there are none.\n\
         - \"sections\" are optional. Good ones: What we did, Decisions, Changes, \
           Next steps. Omit any you would have to pad.\n",
    );
    if rooms.is_empty() {
        s.push_str(
            "- There are no diary rooms configured, so omit \"lessons\" entirely.\n",
        );
    } else {
        s.push_str(
            "- \"lessons\" are generalisable mistakes worth carrying to other \
             projects. Route each to the room whose description fits it. If none \
             fits, leave the lesson out rather than forcing it. Rooms:\n",
        );
        for r in rooms {
            s.push_str(&format!("    - {}: {}\n", r.name, r.description));
        }
    }
    if digest.truncated {
        s.push_str(
            "- This transcript was too long to send whole; its middle was left \
             out. Summarise what is here and do not speculate about the gap.\n",
        );
    }
    s.push_str("\n--- session ---\n");
    s.push_str(&digest.text);
    s.push_str("\n--- end of session ---\n");
    s
}

// ------------------------------------------------------------- what comes back

/// The model's answer, before it becomes a note.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Summary {
    #[serde(default)]
    pub empty: bool,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tldr: String,
    #[serde(default)]
    pub sections: Vec<SummarySection>,
    #[serde(default)]
    pub facts: Vec<String>,
    #[serde(default)]
    pub lessons: Vec<SummaryLesson>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SummarySection {
    #[serde(default)]
    pub heading: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SummaryLesson {
    #[serde(default)]
    pub room: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub what: String,
    #[serde(default)]
    pub avoid: String,
}

/// The CLI's `--output-format json` envelope, reduced to what is used.
#[derive(Debug, Clone, Deserialize)]
struct Envelope {
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    usage: Option<EnvelopeUsage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct EnvelopeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// The model's reply and what it cost, out of the CLI's stdout.
///
/// Falls back to treating stdout as the reply when it is not an envelope. A
/// build of the CLI that stops wrapping, or one that never started, should cost
/// the cost figure and not the summary.
fn unwrap_envelope(stdout: &str) -> Result<(String, Option<CaptureCost>), String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("the model returned nothing at all".to_string());
    }
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Ok((trimmed.to_string(), None));
    };
    // Every field of `Envelope` has a default, so *any* JSON object
    // deserialises into one — including the summary object we asked the model
    // for. Deciding "is this an envelope?" by whether it parses would therefore
    // read a perfectly good `{"empty": true}` as an envelope carrying no result.
    // The marks are the ones the CLI actually sets and our own schema never
    // does.
    let is_envelope = raw.get("result").is_some()
        || raw.get("type").and_then(serde_json::Value::as_str) == Some("result");
    if !is_envelope {
        return Ok((trimmed.to_string(), None));
    }
    let env: Envelope = serde_json::from_value(raw)
        .map_err(|e| format!("the CLI's envelope was not the shape expected ({e})"))?;
    if env.is_error {
        // The envelope's own error text, not the transcript's.
        return Err(format!(
            "the model reported an error: {}",
            env.result.as_deref().unwrap_or("no detail given").trim(),
        ));
    }
    let Some(result) = env.result else {
        return Err("the envelope carried no result".to_string());
    };
    let cost = env.usage.map(|u| CaptureCost {
        input_tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        output_tokens: u.output_tokens,
        usd: env.total_cost_usd,
    });
    Ok((result, cost))
}

/// The JSON object inside a reply, however it was wrapped.
///
/// A model asked for "one JSON object and nothing else" complies almost always;
/// the residual cases are a ```json fence and a sentence of preamble. Both are
/// cheaper to tolerate here than to pay for a retry over.
pub fn parse_summary(reply: &str) -> Result<Summary, String> {
    let body = reply.trim();
    // A fence, with or without a language tag.
    let body = match body.strip_prefix("```") {
        Some(rest) => {
            let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
            rest.rsplit_once("```").map(|(head, _)| head).unwrap_or(rest)
        }
        None => body,
    };
    let start = body.find('{').ok_or("the reply held no JSON object")?;
    let end = body.rfind('}').ok_or("the reply held no JSON object")?;
    if end <= start {
        return Err("the reply held no JSON object".to_string());
    }
    serde_json::from_str::<Summary>(&body[start..=end])
        .map_err(|e| format!("the reply was not the shape asked for ({e})"))
}

/// A summary that is safe to write, or the reason it is not.
///
/// The TL;DR check is here rather than only in the corpus because this is where
/// a retry is still possible: a reply with an empty TL;DR is a bad reply, and
/// asking again is more likely to help than writing a note that will never come
/// back from a search.
fn checked(summary: &Summary) -> Result<(), String> {
    if summary.tldr.trim().is_empty() {
        return Err("the reply had no TL;DR, which is the chunk a search returns".to_string());
    }
    if summary.topic.trim().is_empty() && summary.title.trim().is_empty() {
        return Err("the reply named neither a topic nor a title".to_string());
    }
    Ok(())
}

// ----------------------------------------------------------------- the call

/// Where `claude` is, discovered the way a session discovers it.
///
/// Through `which::discover` rather than a bare `Command::new("claude")`: an app
/// launched from Finder or the Dock inherits the display session's minimal PATH,
/// which is how #332 became a released bug. The resolution also carries the
/// login shell's PATH when it needed one, and `Resolution::command` applies it.
fn claude() -> Option<which::Resolution> {
    which::discover(
        &["claude"],
        &which::under_home(&[
            ".claude/local/claude",
            ".local/bin/claude",
            ".bun/bin/claude",
            ".npm-global/bin/claude",
        ]),
        &which::version_runs,
    )
}

fn model() -> String {
    std::env::var("COWORK_MEMORY_CAPTURE_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| CAPTURE_MODEL.to_string())
}

/// The argv of one capture. Separated from the spawn so the flags can be
/// asserted without spending anything.
fn args(model: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        model,
        // Ignores the user, project and local settings files — which is what
        // keeps the deck's own hooks out of this call.
        "--restricted",
        // No MCP servers. Summarising prose needs none, and starting a handful
        // of stdio servers would cost more than the call.
        "--strict-mcp-config",
        // Never lands in ~/.claude/projects, so it cannot become a transcript
        // the deck later reads, counts or resumes.
        "--no-session-persistence",
        // The envelope, which is also where the cost figure comes from.
        "--output-format",
        "json",
        // Replaces the coding agent's prompt rather than appending to it.
        "--system-prompt",
        SYSTEM_PROMPT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Ask the model, and give back its reply and what it cost.
fn ask(prompt_body: &str) -> Result<(String, Option<CaptureCost>), String> {
    let Some(resolution) = claude() else {
        return Err("claude was not found on this machine".to_string());
    };
    // A scratch directory, not the person's repository: `--restricted` ignores
    // project settings but a CLAUDE.md is loaded by directory, and their project
    // instructions have nothing to do with this request.
    let cwd = std::env::temp_dir();
    let mut cmd = resolution.command();
    cmd.args(args(&model())).current_dir(&cwd);

    let stdout = which::output_with_stdin_and_deadline(cmd, prompt_body, DEADLINE).map_err(
        |fault| match fault {
            // Named separately because it is the one the queue should retry and
            // the one a person is most likely to see twice.
            RunFault::Timeout => {
                format!("claude did not answer within {}s", DEADLINE.as_secs())
            }
            other => format!("claude failed: {other}"),
        },
    )?;
    unwrap_envelope(&stdout)
}

// ----------------------------------------------------------------- the job

/// What one capture did.
#[derive(Debug, Clone, PartialEq)]
pub struct Captured {
    /// The note that was written, or `None` for a session that deliberately
    /// produced nothing.
    pub note: Option<String>,
    pub facts: usize,
    pub lessons: usize,
    pub cost: Option<CaptureCost>,
}

/// Read the transcript, ask the model, write what comes back.
///
/// The error strings are what the job record keeps, so each says what a person
/// could act on. **None of them contains anything from the transcript**: a
/// transcript holds whatever was typed into the session, and this is the one
/// place in the feature where that text is near an error path. The model's own
/// reply is a different matter — it is ours, and a bounded amount of it is kept
/// so a parse failure is debuggable rather than mysterious.
pub fn run(job: &WrapupJob, corpus: &Corpus, rooms: &[Room]) -> Result<Captured, String> {
    run_with(job, corpus, rooms, &ask)
}

/// [`run`] with the model call as a parameter.
///
/// The seam exists so the pipeline — read, digest, prompt, parse, write — can be
/// tested end to end against a closure instead of against somebody's Claude
/// account. A test that had to spend money to run is a test that does not get
/// run, and this is the module where that temptation is strongest.
pub fn run_with(
    job: &WrapupJob,
    corpus: &Corpus,
    rooms: &[Room],
    ask: &dyn Fn(&str) -> Result<(String, Option<CaptureCost>), String>,
) -> Result<Captured, String> {
    // Through the registry, never by parsing here: which reader understands this
    // log is a property of the session's CLI, and an `Err` names a reason a
    // person could act on. Crucially it is never "the session was empty" — a
    // reader that did not understand the format must not be able to say that.
    let digest = transcript::read(
        job.cli,
        &job.session_id,
        Some(job.transcript_path.as_str()),
        DIGEST_CHARS,
    )?;
    if !digest.is_substantive() {
        // A success that writes nothing, and — the point of checking here — a
        // success that costs nothing.
        return Ok(Captured { note: None, facts: 0, lessons: 0, cost: None });
    }

    let (reply, cost) = ask(&prompt(&digest, rooms))?;
    let summary = parse_summary(&reply).map_err(|e| {
        let kept: String = reply.chars().take(KEEP_REPLY_CHARS).collect();
        format!("{e}; the reply began: {kept}")
    })?;
    if summary.empty {
        return Ok(Captured { note: None, facts: 0, lessons: 0, cost });
    }
    checked(&summary)?;

    let date = super::corpus::today();
    let topic = if summary.topic.trim().is_empty() {
        summary.title.clone()
    } else {
        summary.topic.clone()
    };
    let note = Note {
        title: if summary.title.trim().is_empty() { topic.clone() } else { summary.title.clone() },
        tldr: summary.tldr.clone(),
        sections: summary
            .sections
            .iter()
            .map(|s| Section { heading: s.heading.clone(), body: s.body.clone() })
            .collect(),
    };
    let note_path = corpus
        .write_session_note(&job.workspace_id, date, &topic, &note)
        .map_err(|e| format!("could not write the note ({e})"))?;

    // Written after the note, and each failing loudly rather than being
    // swallowed: a job that reported success having written only some of what
    // the model returned is a job whose record cannot be trusted.
    let facts: Vec<String> =
        summary.facts.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    if !facts.is_empty() {
        corpus
            .append_facts(&job.workspace_id, date, &facts)
            .map_err(|e| format!("the note was written, but its facts were not ({e})"))?;
    }

    let mut lessons = 0usize;
    for lesson in &summary.lessons {
        // A room the model invented is not a room. #367 owns the list; capture
        // routes into it and never extends it, because a diary directory created
        // by a hallucination is one nobody configured and nobody reads.
        if !rooms.iter().any(|r| r.name == lesson.room) {
            continue;
        }
        if lesson.what.trim().is_empty() {
            continue;
        }
        corpus
            .append_diary(
                &lesson.room,
                date,
                &DiaryEntry {
                    workspace: job.session_name.clone().unwrap_or_else(|| job.workspace_id.clone()),
                    severity: lesson.severity.clone(),
                    category: lesson.category.clone(),
                    what: lesson.what.clone(),
                    avoid: lesson.avoid.clone(),
                },
            )
            .map_err(|e| format!("the note was written, but a lesson was not ({e})"))?;
        lessons += 1;
    }

    Ok(Captured {
        note: Some(note_path.to_string_lossy().into_owned()),
        facts: facts.len(),
        lessons,
        cost,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(role: &str, text: &str) -> String {
        serde_json::json!({
            "type": role,
            "message": { "role": role, "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    // ----- the prompt -----

    /// Built from turns rather than from a log: what the prompt says is a
    /// property of the prompt, and `transcript` owns the reading.
    fn a_digest(person: &str, assistant: &str) -> Digest {
        transcript::assemble(
            &[
                transcript::Turn { role: transcript::Role::Person, text: person.into() },
                transcript::Turn { role: transcript::Role::Assistant, text: assistant.into() },
            ],
            DIGEST_CHARS,
        )
    }

    #[test]
    fn the_prompt_carries_the_rooms_it_may_route_to_and_nothing_else() {
        let d = a_digest("a", "b");
        let rooms = vec![Room {
            name: "reviewer".into(),
            description: "what code review keeps catching".into(),
        }];
        let p = prompt(&d, &rooms);
        assert!(p.contains("reviewer: what code review keeps catching"));
        assert!(p.contains("Route each to the room whose description fits"));
        assert!(p.contains("--- session ---"));
    }

    #[test]
    fn with_no_rooms_configured_the_prompt_asks_for_no_lessons() {
        let d = a_digest("a", "b");
        let p = prompt(&d, &[]);
        assert!(p.contains("no diary rooms configured"));
        assert!(!p.contains("Route each to the room"));
    }

    #[test]
    fn a_truncated_digest_says_so_in_the_prompt() {
        let turns: Vec<transcript::Turn> = (0..200)
            .map(|i| transcript::Turn {
                role: transcript::Role::Assistant,
                text: format!("{i} {}", "x".repeat(300)),
            })
            .collect();
        let d = transcript::assemble(&turns, 2_000);
        assert!(prompt(&d, &[]).contains("its middle was left out"));
    }

    // ----- the flags, asserted without spending anything -----

    #[test]
    fn the_call_is_isolated_from_the_persons_settings_mcp_and_session_store() {
        let a = args("haiku");
        for flag in ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"] {
            assert!(a.iter().any(|x| x == flag), "{flag} must be passed: {a:?}");
        }
        let at = |f: &str| a.iter().position(|x| x == f).map(|i| a[i + 1].clone());
        assert_eq!(at("--model").as_deref(), Some("haiku"));
        assert_eq!(at("--output-format").as_deref(), Some("json"));
        assert_eq!(at("--system-prompt").as_deref(), Some(SYSTEM_PROMPT));
    }

    // ----- the envelope -----

    #[test]
    fn the_envelope_gives_up_the_reply_and_what_it_cost() {
        let out = serde_json::json!({
            "type": "result",
            "is_error": false,
            "result": "{\"empty\":true}",
            "total_cost_usd": 0.0031,
            "usage": {
                "input_tokens": 12,
                "output_tokens": 34,
                "cache_read_input_tokens": 500,
                "cache_creation_input_tokens": 6,
            },
        })
        .to_string();
        let (reply, cost) = unwrap_envelope(&out).unwrap();
        assert_eq!(reply, "{\"empty\":true}");
        let cost = cost.unwrap();
        assert_eq!(cost.input_tokens, 518, "cached input is input somebody paid for");
        assert_eq!(cost.output_tokens, 34);
        assert_eq!(cost.usd, Some(0.0031));
    }

    #[test]
    fn an_envelope_reporting_an_error_is_a_failure_not_a_summary() {
        let out = serde_json::json!({ "is_error": true, "result": "credit balance too low" })
            .to_string();
        let e = unwrap_envelope(&out).expect_err("an error envelope must not parse as a reply");
        assert!(e.contains("credit balance too low"), "{e}");
    }

    /// A CLI that stops wrapping should cost the cost figure, not the summary.
    ///
    /// The bare summary is the sharp case rather than a stray one: every field
    /// of `Envelope` has a default, so the summary object deserialises into an
    /// envelope quite happily and would be read as one carrying no result.
    #[test]
    fn a_reply_that_is_not_an_envelope_is_still_a_reply() {
        let (reply, cost) = unwrap_envelope("  {\"empty\": true}  ").unwrap();
        assert_eq!(reply, "{\"empty\": true}");
        assert_eq!(cost, None);

        let (reply, cost) =
            unwrap_envelope("{\"tldr\":\"it worked\",\"topic\":\"the queue\"}").unwrap();
        assert!(parse_summary(&reply).is_ok(), "and it is still parseable as a summary");
        assert_eq!(cost, None);

        let (reply, _) = unwrap_envelope("not json at all").unwrap();
        assert_eq!(reply, "not json at all", "which then fails at parse_summary, with a reason");
    }

    /// An envelope that really is one, with no result in it, is a failure — the
    /// case the check above must not swallow while it is busy not mistaking a
    /// summary for an envelope.
    #[test]
    fn a_genuine_envelope_with_no_result_is_a_failure() {
        let out = serde_json::json!({ "type": "result", "is_error": false }).to_string();
        let e = unwrap_envelope(&out).expect_err("an envelope with no result cannot be a reply");
        assert!(e.contains("no result"), "{e}");
    }

    #[test]
    fn nothing_at_all_is_a_failure() {
        assert!(unwrap_envelope("   ").is_err());
    }

    // ----- parsing what the model said -----

    #[test]
    fn a_clean_json_reply_parses() {
        let s = parse_summary(
            r#"{"topic":"the queue","title":"a durable queue","tldr":"it survives a kill",
                "sections":[{"heading":"What we did","body":"wrote it"}],
                "facts":["the queue — lives in — the config directory"],
                "lessons":[{"room":"reviewer","severity":"high","category":"durability",
                            "what":"recovery was split from the queue","avoid":"keep a guarantee with its test"}]}"#,
        )
        .unwrap();
        assert_eq!(s.topic, "the queue");
        assert_eq!(s.tldr, "it survives a kill");
        assert_eq!(s.sections.len(), 1);
        assert_eq!(s.facts.len(), 1);
        assert_eq!(s.lessons[0].room, "reviewer");
        assert!(!s.empty);
    }

    #[test]
    fn a_fenced_reply_parses_because_paying_for_a_retry_is_worse() {
        let s = parse_summary("```json\n{\"tldr\":\"x\",\"topic\":\"t\"}\n```").unwrap();
        assert_eq!(s.tldr, "x");
        let s = parse_summary("Here it is:\n{\"tldr\":\"y\",\"topic\":\"t\"}\nHope that helps.")
            .unwrap();
        assert_eq!(s.tldr, "y");
    }

    #[test]
    fn a_reply_that_is_not_json_is_a_failure_with_a_reason() {
        for bad in ["I could not summarise that.", "", "   ", "[1, 2, 3"] {
            assert!(parse_summary(bad).is_err(), "{bad:?} must not parse");
        }
    }

    #[test]
    fn an_empty_verdict_is_a_valid_reply() {
        let s = parse_summary(r#"{"empty": true}"#).unwrap();
        assert!(s.empty);
        assert_eq!(s.tldr, "");
    }

    // ----- the whole pipeline, against a closure rather than an account -----

    fn fixture(dir: &std::path::Path, content: &str) -> WrapupJob {
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, content).unwrap();
        WrapupJob {
            job_id: "j-1".into(),
            queued_at: 0,
            session_id: "s-1".into(),
            workspace_id: "ws-1".into(),
            transcript_path: transcript.to_string_lossy().into_owned(),
            cli: crate::activity::model::CliKind::Claude,
            session_name: Some("relay".into()),
            state: super::super::queue::JobState::Running,
            attempts: 1,
            last_error: None,
            note_path: None,
            cost: None,
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cd-capture-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_real_session_becomes_a_note_its_facts_and_its_lessons() {
        let root = scratch("pipeline");
        let job = fixture(
            &root,
            &[
                line("user", "why does staging pick the wrong architecture"),
                line("assistant", "it read the host triple instead of the tauri one"),
            ]
            .join("\n"),
        );
        let corpus = Corpus::new(root.join("corpus"));
        let rooms = vec![Room { name: "reviewer".into(), description: "review lessons".into() }];

        let reply = serde_json::json!({
            "empty": false,
            "topic": "sidecar staging",
            "title": "staging picked the host triple",
            "tldr": "stage-memory.sh read rustc -Vv instead of TAURI_ENV_TARGET_TRIPLE.",
            "sections": [{ "heading": "What we did", "body": "read the hook's environment" }],
            "facts": ["stage-memory.sh — must read — TAURI_ENV_TARGET_TRIPLE"],
            "lessons": [{
                "room": "reviewer", "severity": "high", "category": "packaging",
                "what": "a cross build staged a host binary",
                "avoid": "read the triple the hook exports",
            }],
        })
        .to_string();

        // A Cell, because the seam is `&dyn Fn`: `run` passes a plain function
        // and nothing about a capture wants a handler that can hold state.
        let asked = std::cell::Cell::new(0);
        let out = run_with(&job, &corpus, &rooms, &|prompt_body| {
            asked.set(asked.get() + 1);
            // The prompt carries the conversation and not the machinery.
            assert!(prompt_body.contains("why does staging pick the wrong architecture"));
            Ok((reply.clone(), Some(CaptureCost { input_tokens: 900, output_tokens: 120, usd: Some(0.002) })))
        })
        .unwrap();

        assert_eq!(asked.get(), 1, "one call per session");
        assert_eq!(out.facts, 1);
        assert_eq!(out.lessons, 1);
        assert_eq!(out.cost.unwrap().output_tokens, 120);

        let note = out.note.expect("a note");
        let body = std::fs::read_to_string(&note).unwrap();
        assert!(note.contains("ws-1/Sessions/"), "{note}");
        assert!(note.ends_with("-sidecar-staging.md"), "{note}");
        assert!(body.contains("## TL;DR\nstage-memory.sh read rustc -Vv"), "{body}");
        assert!(body.contains("## What we did"), "{body}");

        let facts = std::fs::read_to_string(root.join("corpus/ws-1/Facts.md")).unwrap();
        assert!(facts.contains("[active] stage-memory.sh — must read — TAURI_ENV_TARGET_TRIPLE"));

        let diary = std::fs::read_dir(root.join("corpus/Diaries/reviewer")).unwrap().count();
        assert_eq!(diary, 1, "the lesson reached the room it was routed to");
    }

    /// The check that keeps an accidental tile from costing anything at all.
    #[test]
    fn an_empty_session_never_reaches_the_model() {
        let root = scratch("empty");
        let job = fixture(&root, &line("user", "hello?"));
        let corpus = Corpus::new(root.join("corpus"));

        let asked = std::cell::Cell::new(0);
        let out = run_with(&job, &corpus, &[], &|_| {
            asked.set(asked.get() + 1);
            Ok(("{}".into(), None))
        })
        .unwrap();

        assert_eq!(asked.get(), 0, "not one token spent on a tile opened by accident");
        assert_eq!(out.note, None);
        assert_eq!(out.cost, None);
        assert!(!root.join("corpus").exists(), "and nothing was written");
    }

    /// The model's own verdict, which costs a call but must not produce a note.
    #[test]
    fn a_model_that_says_there_was_nothing_worth_writing_is_believed() {
        let root = scratch("verdict");
        let job = fixture(
            &root,
            &[line("user", "never mind"), line("assistant", "ok")].join("\n"),
        );
        let corpus = Corpus::new(root.join("corpus"));
        let out = run_with(&job, &corpus, &[], &|_| {
            Ok((r#"{"empty": true}"#.into(), Some(CaptureCost { input_tokens: 10, output_tokens: 5, usd: None })))
        })
        .unwrap();
        assert_eq!(out.note, None);
        assert!(out.cost.is_some(), "the call still cost something, and it is recorded");
        assert!(!root.join("corpus/ws-1").exists());
    }

    /// #195 is a real transcript in the wild that reports zero tokens and no
    /// name with no error anywhere. A capture that panicked on one would be
    /// retried three times and then give up on a session it could have
    /// summarised imperfectly.
    #[test]
    fn a_non_utf8_transcript_does_not_panic() {
        let root = scratch("non-utf8");
        // The job first: `fixture` writes the transcript, and the point of this
        // test is what happens when those bytes are not text.
        let job = fixture(&root, "");
        let mut bytes = line("user", "a question").into_bytes();
        bytes.push(b'\n');
        bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
        bytes.push(b'\n');
        bytes.extend_from_slice(line("assistant", "an answer").as_bytes());
        std::fs::write(&job.transcript_path, &bytes).unwrap();
        let corpus = Corpus::new(root.join("corpus"));
        let out = run_with(&job, &corpus, &[], &|_| {
            Ok((r#"{"topic":"t","tldr":"it worked anyway"}"#.into(), None))
        })
        .unwrap();
        assert!(out.note.is_some(), "the readable turns were enough");
    }

    #[test]
    fn a_transcript_that_is_gone_is_a_failure_naming_the_path_and_not_its_contents() {
        let root = scratch("missing");
        let mut job = fixture(&root, "");
        job.transcript_path = root.join("not-here.jsonl").to_string_lossy().into_owned();
        let corpus = Corpus::new(root.join("corpus"));
        let e = run_with(&job, &corpus, &[], &|_| unreachable!("no call for a missing file"))
            .expect_err("a missing transcript is a failure");
        assert!(e.contains("not-here.jsonl"), "{e}");
        assert!(!e.contains("empty"), "a missing log is not an empty session: {e}");
    }

    #[test]
    fn a_malformed_reply_writes_no_partial_note_and_keeps_the_reply() {
        let root = scratch("malformed");
        let job = fixture(
            &root,
            &[line("user", "a question"), line("assistant", "an answer")].join("\n"),
        );
        let corpus = Corpus::new(root.join("corpus"));
        let e = run_with(&job, &corpus, &[], &|_| Ok(("I could not do that.".into(), None)))
            .expect_err("an unparseable reply is a failure");
        assert!(e.contains("I could not do that."), "the reply is ours to keep: {e}");
        assert!(!root.join("corpus/ws-1").exists(), "and nothing was half-written");
    }

    /// A diary directory created by a hallucination is one nobody configured and
    /// nobody reads.
    #[test]
    fn a_lesson_routed_to_a_room_nobody_configured_is_dropped() {
        let root = scratch("ghost-room");
        let job = fixture(
            &root,
            &[line("user", "a question"), line("assistant", "an answer")].join("\n"),
        );
        let corpus = Corpus::new(root.join("corpus"));
        let reply = serde_json::json!({
            "topic": "t", "tldr": "something happened",
            "lessons": [{ "room": "invented", "severity": "high", "category": "c",
                          "what": "x", "avoid": "y" }],
        })
        .to_string();
        let rooms = vec![Room { name: "reviewer".into(), description: "d".into() }];
        let out = run_with(&job, &corpus, &rooms, &|_| Ok((reply.clone(), None))).unwrap();
        assert_eq!(out.lessons, 0);
        assert!(!root.join("corpus/Diaries").exists());
    }

    /// The one test that actually calls Claude, and therefore **the one test
    /// that spends money**.
    ///
    /// `#[ignore]`d for the reason the sidecar's ONNX tests are: it needs a
    /// resource CI does not have and a contributor should not be charged for.
    /// Everything above it covers the pipeline against a closure; what only this
    /// can check is that the flag combination in [`args`] is one the installed
    /// CLI accepts, and that a real reply parses.
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///   memory::capture::tests::a_real_claude -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "spends the developer's own tokens; run it deliberately"]
    fn a_real_claude_summarises_a_real_transcript() {
        let root = scratch("live");
        let job = fixture(
            &root,
            &[
                line(
                    "user",
                    "The staging script picks the wrong architecture on a cross build. Why?",
                ),
                line(
                    "assistant",
                    "It reads the host triple from `rustc -Vv` instead of the \
                     TAURI_ENV_TARGET_TRIPLE that the tauri hook exports, so a \
                     cross build stages a binary for the build machine.",
                ),
            ]
            .join("\n"),
        );
        let corpus = Corpus::new(root.join("corpus"));
        let out = run(&job, &corpus, &[]).expect("a live capture");

        let note = out.note.expect("a live capture writes a note");
        let body = std::fs::read_to_string(&note).unwrap();
        eprintln!("--- note at {note} ---\n{body}");
        if let Some(c) = out.cost {
            eprintln!("--- cost: {} in, {} out, {:?} usd ---", c.input_tokens, c.output_tokens, c.usd);
        }
        assert!(body.contains("## TL;DR"), "{body}");
        assert!(body.starts_with("---\n"), "{body}");
        assert!(out.cost.is_some(), "the envelope should have carried a usage figure");
    }

    #[test]
    fn a_reply_missing_the_load_bearing_field_is_refused_while_a_retry_is_still_possible() {
        let s = parse_summary(r#"{"topic":"t","title":"a title","tldr":"  "}"#).unwrap();
        let e = checked(&s).expect_err("no TL;DR is not writable");
        assert!(e.contains("TL;DR"), "{e}");

        let s = parse_summary(r#"{"tldr":"something happened"}"#).unwrap();
        assert!(checked(&s).is_err(), "and a note with no name is not either");

        let s = parse_summary(r#"{"tldr":"something happened","topic":"the queue"}"#).unwrap();
        assert!(checked(&s).is_ok(), "a topic alone is enough of a name");
    }
}
