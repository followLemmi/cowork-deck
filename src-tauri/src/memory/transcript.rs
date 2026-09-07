//! Reading one session's log into the conversation inside it, whichever CLI
//! wrote it.
//!
//! The deck runs sessions on four CLIs (`activity::model::CliKind`), and their
//! logs have nothing in common: Claude Code writes one JSONL file of
//! `message.content[]` blocks, the Copilot CLI writes one JSONL file of
//! `type`/`data` events, and opencode writes no file at all — a tree of one JSON
//! document per part. So "read the transcript" is a per-CLI question and this is
//! where it is asked, deliberately mirroring `activity::reader::ActivityReader`
//! and `activity::registry`: same `Source`, same `sources`-then-`fold` shape,
//! same read loop.
//!
//! # The failure this exists to prevent
//!
//! A digester that only understood Claude Code's shape would not *fail* on a
//! Copilot session — it would find no turns, conclude the session was empty, and
//! report success having written nothing. Silently, permanently, and identically
//! to a tile somebody opened by accident. That is the same class of fault
//! `Unavailable::NoReader` exists for in the activity epic, and it is answered
//! the same way: a CLI with no digester in this build says so, and the job fails
//! visibly instead of losing the memory.
//!
//! So [`digester_for`] returning `None` is an ordinary answer with a sentence
//! attached, not an oversight. Filling one in is a task per CLI, gated on
//! measuring that CLI's log — which is what `activity/copilot.rs` and
//! `activity/opencode.rs` did for tool calls and what the prose needs in its own
//! right. Guessing at a field name would rebuild the silent failure inside the
//! thing meant to remove it.
//!
//! # This module reads; it does not summarise
//!
//! Two independent axes, and conflating them is how the bug above happened. The
//! **session's** CLI decides how its log is read — that is this module. Which
//! model writes the summary is a separate choice, made in
//! [`super::capture`], and it is Claude for every session regardless of which
//! CLI produced the transcript.

use crate::activity::model::{CliKind, Source};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Person,
    Assistant,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::Person => "[person]",
            Role::Assistant => "[claude]",
        }
    }
}

/// One turn of prose, with everything that was not prose left behind.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

/// A session's log reduced to the conversation inside it.
#[derive(Debug, Clone, PartialEq)]
pub struct Digest {
    /// The conversation, rendered for a prompt.
    pub text: String,
    pub person_turns: usize,
    pub assistant_turns: usize,
    /// Whether the middle was dropped to fit the budget.
    pub truncated: bool,
}

impl Digest {
    /// Whether there is anything here worth paying a model to read.
    ///
    /// Both sides, and that is the test rather than a length: a tile opened by
    /// accident has neither, and a tile that got a prompt and never answered has
    /// one and is not a session anybody wants a note about.
    ///
    /// **Only ever asked of a digest a digester actually produced.** Asked of one
    /// built by a digester that did not understand the format, this would report
    /// an empty session and be believed — which is the fault this module's
    /// documentation opens with.
    pub fn is_substantive(&self) -> bool {
        self.person_turns > 0 && self.assistant_turns > 0
    }
}

/// Reads one CLI's session log into turns.
///
/// Shaped after [`crate::activity::reader::ActivityReader`] rather than taking a
/// single buffer, and for the reason `activity/opencode.rs` records: opencode's
/// log is a directory tree, so a trait that could only be handed one file would
/// be the wrong shape and would have to be redrawn at the second
/// implementation. Better found out here.
pub trait Digester {
    fn cli(&self) -> CliKind;

    /// Where this session's log is.
    ///
    /// `hint` is the path the app already knows, if any: Claude Code reports one
    /// through the deck's hook (`transcripts::record`), which is what makes a
    /// `/clear` survivable. A CLI with no hooks ignores it and locates its own
    /// log from the session id.
    fn sources(&self, session: &str, hint: Option<&str>) -> Vec<Source>;

    /// Fold one source's bytes into turns, appending in order.
    fn fold(&self, path: &Path, buf: &str, turns: &mut Vec<Turn>);
}

/// The digester for a CLI, or nothing.
///
/// Nothing is an ordinary answer: see this module's documentation for why it is
/// deliberately not a fallback to Claude's reader.
pub fn digester_for(cli: CliKind) -> Option<Box<dyn Digester>> {
    match cli {
        CliKind::Claude => Some(Box::new(ClaudeDigester)),
        // Each of these needs that CLI's log measured for *prose* — the activity
        // readers measured it for tool calls, which is a different set of
        // fields. Until then a capture on one of these fails saying so.
        CliKind::Copilot | CliKind::Opencode | CliKind::Codex => None,
    }
}

/// Read a session's conversation, within `budget` characters.
///
/// `Err` names the reason there is no conversation to read, and every reason is
/// one a person could act on. It is never "the session was empty" — that
/// question is [`Digest::is_substantive`]'s, and it is only meaningful once a
/// digester that understands the format has had a look.
pub fn read(
    cli: CliKind,
    session: &str,
    hint: Option<&str>,
    budget: usize,
) -> Result<Digest, String> {
    let Some(digester) = digester_for(cli) else {
        return Err(format!(
            "this build cannot read a {} session's log yet, so it was not summarised",
            cli.as_str(),
        ));
    };
    // A mis-wired match arm in `digester_for` — Copilot handed Claude's reader —
    // would produce exactly the silent empty digest this module exists to
    // prevent, and would produce it while looking correct. Cheap to rule out.
    debug_assert_eq!(
        digester.cli(),
        cli,
        "digester_for returned a reader for the wrong CLI",
    );
    let sources = digester.sources(session, hint);
    if sources.is_empty() {
        // The path is named when there is one: it is the app's own record of
        // where the log was, never the person's content, and "not there" about a
        // named file is a fault somebody can actually chase.
        return Err(match hint {
            Some(h) => {
                format!("no {} log for this session: {h} is not there", cli.as_str())
            }
            None => format!("no {} log was recorded for this session", cli.as_str()),
        });
    }

    let mut turns: Vec<Turn> = Vec::new();
    let mut read_any = false;
    for src in &sources {
        match src {
            Source::File(path) => {
                // Lossily, and on purpose. #195 is a real non-UTF-8 transcript
                // in the wild; a capture that refused one would give up on a
                // session it could have summarised imperfectly.
                let Ok(bytes) = std::fs::read(path) else { continue };
                read_any = true;
                digester.fold(path, &String::from_utf8_lossy(&bytes), &mut turns);
            }
            Source::Tree { dir, ext, cap } => {
                let (files, _truncated) = crate::activity::registry::walk(dir, ext, *cap);
                for path in files {
                    let Ok(bytes) = std::fs::read(&path) else { continue };
                    read_any = true;
                    digester.fold(&path, &String::from_utf8_lossy(&bytes), &mut turns);
                }
            }
        }
    }
    if !read_any {
        // Sources were named and not one opened: the log is gone from under the
        // session. Distinct from "no log", exactly as `Unavailable::Unreadable`
        // is distinct from `Unavailable::NoLog`.
        return Err("this session's log could not be opened".to_string());
    }
    Ok(assemble(&turns, budget))
}

/// Render turns into a budget. Split out so the budget's rules are testable
/// without a log of any format.
pub fn assemble(turns: &[Turn], budget: usize) -> Digest {
    let person_turns = turns.iter().filter(|t| t.role == Role::Person).count();
    let assistant_turns = turns.len() - person_turns;
    let rendered: Vec<String> =
        turns.iter().map(|t| format!("{}\n{}", t.role.label(), t.text)).collect();
    let (text, truncated) = fit(&rendered, budget);
    Digest { text, person_turns, assistant_turns, truncated }
}

/// Join whole turns into `budget` characters, dropping from the middle.
///
/// The head says what the session was asked to do and the tail says how it
/// ended; the middle is where the retries and the false starts live. Dropping
/// whole turns rather than cutting inside one keeps every surviving turn
/// attributable to a speaker — half a turn under a `[claude]` label reads as
/// something Claude said and stopped saying.
fn fit(turns: &[String], budget: usize) -> (String, bool) {
    const SEP: &str = "\n\n";
    const MARK: &str = "\n\n[… the middle of this session was left out …]\n\n";

    let total: usize = turns.iter().map(|t| t.chars().count() + SEP.len()).sum();
    if total <= budget {
        return (turns.join(SEP), false);
    }

    let half = budget.saturating_sub(MARK.chars().count()) / 2;
    let mut head: Vec<&String> = Vec::new();
    let mut used = 0usize;
    for t in turns {
        let n = t.chars().count() + SEP.len();
        if used + n > half {
            break;
        }
        used += n;
        head.push(t);
    }
    let mut tail: Vec<&String> = Vec::new();
    let mut used = 0usize;
    for t in turns.iter().rev().take(turns.len() - head.len()) {
        let n = t.chars().count() + SEP.len();
        if used + n > half {
            break;
        }
        used += n;
        tail.push(t);
    }
    tail.reverse();

    let head_s = head.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(SEP);
    let tail_s = tail.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(SEP);
    (format!("{head_s}{MARK}{tail_s}"), true)
}

/// Strip what is in a log but was never part of the conversation.
///
/// Injected rather than typed: a `<system-reminder>` block the harness adds to a
/// turn, a slash command's machine-readable echo, and the stdout a local command
/// wrote back into the transcript. Sending any of it would be paying to
/// summarise the plumbing.
///
/// Shared rather than per-digester because the constructs are the harness's, not
/// Claude Code's — a `<command-name>` echo appears in any CLI that grew slash
/// commands.
pub fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<system-reminder>") {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find("</system-reminder>") {
            Some(end) => &rest[start + end + "</system-reminder>".len()..],
            // Unterminated: the rest of this block is reminder, so drop it.
            None => "",
        };
    }
    out.push_str(rest);
    let out = out.trim();
    for echo in [
        "<command-name>",
        "<command-message>",
        "<local-command-stdout>",
        "<local-command-stderr>",
    ] {
        if out.starts_with(echo) {
            return String::new();
        }
    }
    out.to_string()
}

// ----------------------------------------------------------------- Claude Code

/// Claude Code's log: `~/.claude/projects/<slug>/<id>.jsonl`, one JSON object
/// per line, prose in `message.content[]` blocks of `type: "text"`.
///
/// The same file `activity::claude` reads for tool calls, and the same
/// hook-reported path — which is what makes a `/clear` survivable rather than
/// leaving the summary pointed at a conversation the person has left.
pub struct ClaudeDigester;

impl Digester for ClaudeDigester {
    fn cli(&self) -> CliKind {
        CliKind::Claude
    }

    fn sources(&self, _session: &str, hint: Option<&str>) -> Vec<Source> {
        // The hint is what the wrapup job recorded at the close, and it is the
        // only path worth trusting: by the time a job runs, `transcripts::forget`
        // has run and the app can no longer answer the question itself.
        match hint.map(std::path::PathBuf::from).filter(|p| p.is_file()) {
            Some(p) => vec![Source::File(p)],
            None => Vec::new(),
        }
    }

    fn fold(&self, _path: &Path, buf: &str, turns: &mut Vec<Turn>) {
        for line in buf.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            // Injected context, not a turn. `isSidechain` is a subagent's own
            // conversation: its conclusion reaches the main thread as a tool
            // result, and summarising its internal working would double the bill
            // for the same work.
            if v["isMeta"] == true || v["isSidechain"] == true {
                continue;
            }
            let role = match v["message"]["role"].as_str() {
                Some("user") => Role::Person,
                Some("assistant") => Role::Assistant,
                _ => continue,
            };
            let text = message_prose(&v["message"]);
            if text.is_empty() {
                continue;
            }
            turns.push(Turn { role, text });
        }
    }
}

/// The prose of one Claude Code message, with every non-prose block left behind.
///
/// `content` is a string on a plain user turn and an array of blocks otherwise.
/// Only `text` blocks survive: `thinking` is the model's scratch, `tool_use` and
/// `tool_result` are the noise #35 refused to index, and an unrecognised block
/// type is left out rather than guessed at.
fn message_prose(message: &serde_json::Value) -> String {
    match &message["content"] {
        serde_json::Value::String(s) => clean(s),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .map(clean)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUDGET: usize = 24_000;

    fn line(role: &str, text: &str) -> String {
        serde_json::json!({
            "type": role,
            "message": { "role": role, "content": [{ "type": "text", "text": text }] },
        })
        .to_string()
    }

    fn claude_turns(content: &str) -> Vec<Turn> {
        let mut turns = Vec::new();
        ClaudeDigester.fold(Path::new("t.jsonl"), content, &mut turns);
        turns
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cd-digest-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // ----- the registry, which is the point of the module -----

    /// The whole reason this module exists. A Claude-only digester handed a
    /// Copilot log would find no turns, call the session empty and report
    /// success having written nothing — indistinguishable from a tile opened by
    /// accident, and permanent.
    #[test]
    fn a_cli_with_no_digester_refuses_rather_than_reporting_an_empty_session() {
        for cli in [CliKind::Copilot, CliKind::Opencode, CliKind::Codex] {
            assert!(digester_for(cli).is_none(), "{cli:?} has no prose reader yet");
            let e = read(cli, "s-1", Some("/some/path.jsonl"), BUDGET)
                .expect_err("it must not silently produce an empty digest");
            assert!(e.contains(cli.as_str()), "the reason names the CLI: {e}");
            assert!(!e.contains("empty"), "and never claims the session was empty: {e}");
        }
    }

    #[test]
    fn claude_has_one_and_it_answers_for_claude() {
        let d = digester_for(CliKind::Claude).expect("a Claude digester");
        assert_eq!(d.cli(), CliKind::Claude);
    }

    /// A log that is gone from under the session is a different fact from a log
    /// that was never named — the distinction `Unavailable` draws in the
    /// activity epic.
    #[test]
    fn a_log_that_is_not_there_is_told_apart_from_a_cli_that_cannot_be_read() {
        let e = read(CliKind::Claude, "s-1", Some("/no/such/transcript.jsonl"), BUDGET)
            .expect_err("a missing log is a failure");
        assert!(e.contains("no claude log"), "{e}");
        assert!(e.contains("/no/such/transcript.jsonl"), "and it names what it looked for: {e}");

        let e = read(CliKind::Claude, "s-1", None, BUDGET)
            .expect_err("no hint means no source at all");
        assert!(e.contains("no claude log was recorded"), "{e}");
    }

    #[test]
    fn a_claude_log_is_read_through_the_path_the_close_recorded() {
        let dir = tmp("hint");
        let path = dir.join("t.jsonl");
        std::fs::write(
            &path,
            [line("user", "the ask"), line("assistant", "the answer")].join("\n"),
        )
        .unwrap();

        let d = read(CliKind::Claude, "s-1", path.to_str(), BUDGET).unwrap();
        assert!(d.is_substantive());
        assert!(d.text.contains("the ask"));
        assert!(d.text.contains("the answer"));
    }

    #[test]
    fn a_non_utf8_log_is_read_lossily_rather_than_refused() {
        let dir = tmp("non-utf8");
        let path = dir.join("t.jsonl");
        let mut bytes = line("user", "a question").into_bytes();
        bytes.push(b'\n');
        bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
        bytes.push(b'\n');
        bytes.extend_from_slice(line("assistant", "an answer").as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        let d = read(CliKind::Claude, "s-1", path.to_str(), BUDGET).unwrap();
        assert!(d.is_substantive(), "the readable turns were enough");
    }

    // ----- Claude's own fold -----

    #[test]
    fn claude_keeps_the_conversation_and_drops_the_machinery() {
        let content = [
            line("user", "make the sidecar staging work on a cross build"),
            serde_json::json!({
                "type": "assistant",
                "message": { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "let me look at the script" },
                    { "type": "tool_use", "id": "t1", "name": "Read", "input": {} },
                ]},
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "the whole file" },
                ]},
            })
            .to_string(),
            line("assistant", "it read the host triple instead of TAURI_ENV_TARGET_TRIPLE"),
            "not json at all".to_string(),
        ]
        .join("\n");

        let turns = claude_turns(&content);
        assert_eq!(turns.len(), 2, "the tool turns are not turns: {turns:?}");
        assert_eq!(turns[0].role, Role::Person);
        assert_eq!(turns[1].role, Role::Assistant);
        assert!(turns[1].text.contains("TAURI_ENV_TARGET_TRIPLE"));
    }

    #[test]
    fn claude_ignores_injected_context_and_subagent_working() {
        let content = [
            serde_json::json!({
                "type": "user", "isMeta": true,
                "message": { "role": "user", "content": "injected project context" },
            })
            .to_string(),
            serde_json::json!({
                "type": "assistant", "isSidechain": true,
                "message": { "role": "assistant", "content": [
                    { "type": "text", "text": "a subagent's private working" },
                ]},
            })
            .to_string(),
            line("user", "the real question"),
            line("assistant", "the real answer"),
        ]
        .join("\n");
        let turns = claude_turns(&content);
        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|t| !t.text.contains("injected")));
        assert!(turns.iter().all(|t| !t.text.contains("subagent")));
    }

    #[test]
    fn a_claude_user_turn_can_be_a_plain_string() {
        let content = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "a sentence, not an array" },
        })
        .to_string();
        let turns = claude_turns(&content);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "a sentence, not an array");
    }

    // ----- the harness's own constructs, which are not any CLI's -----

    #[test]
    fn a_system_reminder_is_stripped_from_a_turn_that_is_otherwise_real() {
        assert_eq!(
            clean("fix the flake\n<system-reminder>context…</system-reminder>\nand that is all"),
            "fix the flake\n\nand that is all"
        );
    }

    #[test]
    fn an_unterminated_reminder_does_not_leak_the_rest_of_the_turn() {
        assert_eq!(clean("keep this<system-reminder>and not this"), "keep this");
    }

    #[test]
    fn a_slash_command_echo_is_not_prose() {
        assert_eq!(clean("<command-name>/wrapup</command-name>"), "");
        assert_eq!(clean("<local-command-stdout>a listing</local-command-stdout>"), "");
        assert_eq!(clean("  a real question  "), "a real question");
    }

    // ----- emptiness and the budget, which belong to no format -----

    #[test]
    fn a_session_with_only_one_side_is_not_worth_a_call() {
        let one = |role| vec![Turn { role, text: "x".into() }];
        assert!(!assemble(&[], BUDGET).is_substantive());
        assert!(!assemble(&one(Role::Person), BUDGET).is_substantive());
        assert!(!assemble(&one(Role::Assistant), BUDGET).is_substantive());
    }

    #[test]
    fn one_exchange_is_enough() {
        let turns = vec![
            Turn { role: Role::Person, text: "why is this flaky".into() },
            Turn { role: Role::Assistant, text: "a timing assumption".into() },
        ];
        let d = assemble(&turns, BUDGET);
        assert!(d.is_substantive());
        assert_eq!(d.person_turns, 1);
        assert_eq!(d.assistant_turns, 1);
        assert!(!d.truncated);
    }

    #[test]
    fn a_long_session_keeps_its_head_and_its_tail() {
        let mut turns = vec![Turn { role: Role::Person, text: "THE OPENING ASK".into() }];
        for i in 0..200 {
            turns.push(Turn {
                role: Role::Assistant,
                text: format!("middle turn {i} {}", "x".repeat(300)),
            });
        }
        turns.push(Turn { role: Role::Assistant, text: "THE CLOSING ANSWER".into() });

        let d = assemble(&turns, 4_000);
        assert!(d.truncated);
        assert!(d.text.chars().count() <= 4_000, "{}", d.text.chars().count());
        assert!(d.text.contains("THE OPENING ASK"), "the ask says what the work was");
        assert!(d.text.contains("THE CLOSING ANSWER"), "the end says how it went");
        assert!(d.text.contains("the middle of this session was left out"));
        assert_eq!(d.person_turns, 1, "the counts are of the log, not of what was sent");
        assert_eq!(d.assistant_turns, 201);
    }

    /// Bytes would halve this budget, and a naive byte slice would panic
    /// mid-character. The hazard ADR-0003 names, in a second place.
    #[test]
    fn the_budget_counts_characters_not_bytes() {
        let turns = vec![
            Turn { role: Role::Person, text: "я".repeat(3_000) },
            Turn { role: Role::Assistant, text: "ж".repeat(3_000) },
        ];
        let d = assemble(&turns, 2_000);
        assert!(d.truncated);
        assert!(d.text.chars().count() <= 2_000);
    }

    #[test]
    fn a_session_that_fits_is_rendered_whole_and_in_order() {
        let turns = vec![
            Turn { role: Role::Person, text: "first".into() },
            Turn { role: Role::Assistant, text: "second".into() },
            Turn { role: Role::Person, text: "third".into() },
        ];
        let d = assemble(&turns, BUDGET);
        assert!(!d.truncated);
        let at = |s: &str| d.text.find(s).unwrap();
        assert!(at("first") < at("second") && at("second") < at("third"));
        assert_eq!(d.text.matches("[person]").count(), 2);
        assert_eq!(d.text.matches("[claude]").count(), 1);
    }
}
