//! opencode's log, which is not a file at all.
//!
//! `~/.local/share/opencode/storage/`, measured on 2026-08-25. A tree, one JSON
//! document per part:
//!
//! ```text
//! storage/session/<projectHash>/<sessionID>.json
//! storage/message/<sessionID>/<messageID>.json
//! storage/part/<messageID>/<partID>.json
//! ```
//!
//! One call is a part with `type: "tool"`:
//!
//! ```json
//! { "id": "prt_c259339f1001aOOCUG67BElnW7",
//!   "sessionID": "ses_3da6d8bc8ffeUv4XuO9mz20TJn",
//!   "type": "tool", "tool": "read", "callID": "toolu_01QXMd5zrYvvpgmVCr5AysRx",
//!   "state": { "status": "completed", "title": "src/…/application.properties" } }
//! ```
//!
//! The outcome is `state.status`: `completed`, `error`, or `pending` for a call
//! still in flight. **`state.title` names the target** — a path, a search
//! pattern, a command line — which no other measured format gives directly. It
//! is deliberately not in `ToolTally`: a tally counts, it does not list. Whoever
//! eventually wants a timeline should start here.
//!
//! ## Why this reader is in the epic
//!
//! Every other reader answers `sources()` with a file path or two. This one
//! cannot, and finding that out is the point: if `Source` could not name a
//! directory, the shape would have been wrong and better found out here than at
//! the fourth reader.
//!
//! What it does **not** do is walk `storage/part/` whole. Measured: 784 part
//! directories over 788 messages in 20 sessions, and every part directory is a
//! message of some session — so `storage/message/<sessionID>/` is a complete
//! index of exactly this session's messages, and one cheap directory listing
//! replaces a walk of everyone else's parts. The panel is on a five-second tick
//! while it is open; reading twenty sessions' logs to answer about one is not
//! something it may do.
//!
//! The read is still bounded. The index scopes it to one session, and the cap
//! bounds that session — a conversation grows without limit too — and a roll
//! that hit the cap says so rather than quietly stopping.

use super::model::{ActivityRoll, AgentRole, CliKind, ReaderCapabilities, Source, ToolCategory};
use super::reader::{classify, ActivityReader};
use std::path::{Path, PathBuf};

/// How many part files one read may open.
///
/// The heaviest session measured holds 150 parts, so this is roughly ten times
/// the largest real conversation on one machine — high enough that no honest
/// session is ever truncated, low enough that a runaway tree cannot hang a tick.
const PART_CAP: usize = 1500;

/// Reads one session's parts.
///
/// Holds the session id, unlike its two siblings, and that is not an
/// inconsistency: a Claude Code transcript and a Copilot session log are named
/// after their session, so locating the file *is* the filter. An opencode part
/// carries its `sessionID` **inside the document**, so the fold has to check it
/// as well.
pub struct OpencodeReader {
    session: String,
}

impl OpencodeReader {
    pub fn for_session(session: &str) -> OpencodeReader {
        OpencodeReader { session: session.to_string() }
    }
}

/// Measured names in one project.
///
/// The MCP-shaped ones — `github_issue_read`, `youtrack_create_issue` and the
/// rest — are **not** `mcp__<server>__<tool>` and so are not recognised as MCP.
/// They land in `Other` and keep their own names, which is the honest answer:
/// this log flattens the server out of the name, and inventing one back from a
/// prefix would be a guess presented as a fact.
fn category(name: &str) -> Option<ToolCategory> {
    Some(match name {
        "bash" => ToolCategory::Run,
        "read" | "list" => ToolCategory::Read,
        "edit" | "write" | "patch" => ToolCategory::Edit,
        "glob" | "grep" => ToolCategory::Search,
        "webfetch" => ToolCategory::Web,
        "task" => ToolCategory::Delegate,
        "todowrite" | "todoread" => ToolCategory::Task,
        "question" => ToolCategory::Ask,
        _ => return None,
    })
}

fn storage() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local/share/opencode/storage"))
}

impl ActivityReader for OpencodeReader {
    fn cli(&self) -> CliKind {
        CliKind::Opencode
    }

    /// Outcomes yes, agents no — as for the Copilot CLI, and for the same
    /// reason: no delegation was observed in any measured session.
    fn capabilities(&self) -> ReaderCapabilities {
        ReaderCapabilities { outcomes: true, agents: false }
    }

    fn sources(&self, session: &str) -> Vec<Source> {
        let Some(root) = storage() else { return Vec::new() };
        let messages = root.join("message").join(session);
        // No index for this session means no conversation under that id here,
        // which is ordinary rather than an error.
        let Ok(entries) = std::fs::read_dir(&messages) else { return Vec::new() };
        let mut ids: Vec<String> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .collect();
        // Sorted so a capped read takes the same parts every time rather than
        // whichever the filesystem happened to hand back first.
        ids.sort();
        let parts = root.join("part");
        ids.into_iter()
            .map(|id| Source::Tree {
                dir: parts.join(id),
                ext: "json".to_string(),
                // The cap is a budget across the whole read, not a limit per
                // message — see `registry::roll_with`.
                cap: PART_CAP,
            })
            .collect()
    }

    fn fold(&self, _path: &Path, buf: &str, roll: &mut ActivityRoll) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(buf) else { return };
        if v["type"].as_str() != Some("tool") {
            return;
        }
        // The walk already scoped this to one session's messages. The check is
        // here anyway because the fact it rests on lives in the document rather
        // than in the path, and a reader that trusts the walk for that would be
        // trusting a layout rather than a field.
        if v["sessionID"].as_str() != Some(self.session.as_str()) {
            return;
        }
        let Some(name) = v["tool"].as_str() else { return };

        let (cat, server) = classify(name, category);
        let agent = roll.agent(&self.session, AgentRole::Main, 0);
        let t = agent.tool(name, cat, server);
        t.calls += 1;
        // `error` is a failure. `pending` is a call still running, which is the
        // ordinary state of the panel being open on a working session — counted,
        // with no outcome. Anything else this reader has not seen is treated the
        // same way rather than being guessed at as a failure.
        if v["state"]["status"].as_str() == Some("error") {
            t.errors += 1;
        }
        // `denials` stays 0. This log has no refusal status: a call refused by a
        // permission rule was measured arriving as `status: "error"` with the
        // rule quoted in `state.error`, which is indistinguishable from a
        // genuine failure without parsing a message. Guessing from that text
        // would put a fiction in the tally, so the refusal is billed as the
        // failure the log calls it.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::model::ToolTally;

    fn reader() -> OpencodeReader {
        OpencodeReader::for_session("ses_target")
    }

    fn fold_all(r: &OpencodeReader, docs: &[&str]) -> ActivityRoll {
        let mut roll = ActivityRoll::empty(CliKind::Opencode, r.capabilities());
        for (i, d) in docs.iter().enumerate() {
            roll.agent(&r.session, AgentRole::Main, 0);
            r.fold(&PathBuf::from(format!("/p/part/msg/prt_{i}.json")), d, &mut roll);
        }
        roll.finish();
        roll
    }

    fn row<'a>(roll: &'a ActivityRoll, native: &str) -> &'a ToolTally {
        roll.tools.iter().find(|t| t.native == native).expect("a row for that tool")
    }

    fn part(session: &str, tool: &str, status: &str) -> String {
        format!(
            r#"{{"id":"prt_x","sessionID":"{session}","messageID":"msg_x","type":"tool",
                "tool":"{tool}","callID":"toolu_x","state":{{"status":"{status}"}}}}"#
        )
    }

    #[test]
    fn a_completed_call_is_a_call_and_no_error() {
        let roll = fold_all(&reader(), &[&part("ses_target", "read", "completed")]);
        let r = row(&roll, "read");
        assert_eq!((r.calls, r.errors, r.denials), (1, 0, 0));
        assert_eq!(r.category, ToolCategory::Read);
    }

    #[test]
    fn an_errored_call_is_an_error() {
        let roll = fold_all(&reader(), &[&part("ses_target", "read", "error")]);
        assert_eq!(row(&roll, "read").errors, 1);
    }

    /// A call still in flight, which is the ordinary state of the panel being
    /// open on a working session. Counted, with no outcome — never guessed at as
    /// a failure.
    #[test]
    fn a_pending_call_is_counted_without_an_outcome() {
        let roll = fold_all(&reader(), &[&part("ses_target", "bash", "pending")]);
        let r = row(&roll, "bash");
        assert_eq!((r.calls, r.errors), (1, 0));
    }

    #[test]
    fn a_part_that_is_not_a_tool_is_not_a_call() {
        let doc = r#"{"id":"prt_x","sessionID":"ses_target","type":"text","text":"hello"}"#;
        assert_eq!(fold_all(&reader(), &[doc]).calls, 0);
    }

    #[test]
    fn a_part_belonging_to_another_session_is_skipped() {
        let roll = fold_all(&reader(), &[&part("ses_someone_else", "bash", "completed")]);
        assert_eq!(roll.calls, 0);
    }

    #[test]
    fn a_file_that_is_not_json_is_skipped_without_failing_the_read() {
        let roll = fold_all(&reader(), &["{not json,,,", &part("ses_target", "bash", "completed")]);
        assert_eq!(roll.calls, 1);
    }

    #[test]
    fn the_category_map_covers_the_measured_vocabulary() {
        for (name, want) in [
            ("bash", ToolCategory::Run),
            ("read", ToolCategory::Read),
            ("glob", ToolCategory::Search),
            ("grep", ToolCategory::Search),
            ("edit", ToolCategory::Edit),
            ("write", ToolCategory::Edit),
            ("todowrite", ToolCategory::Task),
            ("question", ToolCategory::Ask),
        ] {
            assert_eq!(category(name), Some(want), "for {name}");
        }
    }

    /// This log flattens the MCP server out of the name, so `github_issue_read`
    /// is not `mcp__github__issue_read` and must not be read as if it were.
    /// Inventing a server back from a prefix would be a guess presented as fact.
    #[test]
    fn a_flattened_mcp_name_keeps_its_own_name_and_gains_no_server() {
        let roll = fold_all(&reader(), &[&part("ses_target", "github_issue_read", "completed")]);
        let r = row(&roll, "github_issue_read");
        assert_eq!(r.calls, 1);
        assert_eq!(r.category, ToolCategory::Other);
        assert_eq!(r.server, None);
    }

    // --- the golden fixture, which is a tree rather than a file -------------

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/activity/opencode/part")
    }

    /// Drive the read loop's own tree walk over the fixture, since the shape of
    /// the source is half of what this reader is here to prove.
    fn fold_fixture(session: &str, cap: usize) -> ActivityRoll {
        let r = OpencodeReader::for_session(session);
        let mut roll = ActivityRoll::empty(CliKind::Opencode, r.capabilities());
        roll.agent(session, AgentRole::Main, 0);
        let mut budget = cap;
        let mut truncated = false;
        let mut dirs: Vec<PathBuf> =
            std::fs::read_dir(fixture()).unwrap().flatten().map(|e| e.path()).collect();
        dirs.sort();
        for d in dirs {
            let mut files: Vec<PathBuf> = std::fs::read_dir(&d)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect();
            files.sort();
            if files.len() > budget {
                files.truncate(budget);
                truncated = true;
            }
            budget -= files.len();
            for f in files {
                r.fold(&f, &std::fs::read_to_string(&f).unwrap(), &mut roll);
            }
        }
        if truncated {
            roll.truncated = Some(cap as u32);
        }
        roll.finish();
        roll
    }

    const TARGET: &str = "ses_520321d38ffetAr10eJi9fYSM6";
    const OTHER: &str = "ses_53532cb61ffeXtQoDVsWTdprxr";

    #[test]
    fn the_fixture_tree_folds_to_the_roll_it_was_measured_at() {
        let roll = fold_fixture(TARGET, PART_CAP);
        assert_eq!(roll.calls, 26);
        assert_eq!(row(&roll, "read").calls, 12);
        assert_eq!(row(&roll, "bash").calls, 6);
        assert_eq!(row(&roll, "write").calls, 5);
        assert_eq!(row(&roll, "list").calls, 2);
        assert_eq!(row(&roll, "edit").calls, 1);
        // Six of the twelve reads came back an error.
        assert_eq!(row(&roll, "read").errors, 6);
        assert_eq!(roll.tools.iter().map(|t| t.denials).sum::<u32>(), 0);
        assert_eq!(roll.truncated, None);
        // The tree carries a text part and a file that is not JSON, and neither
        // costs the read anything.
        assert_eq!(roll.tools.iter().map(|t| t.calls).sum::<u32>(), roll.calls);
    }

    /// The one part in the tree that belongs to somebody else, from the other
    /// direction: asking as that session finds only it.
    #[test]
    fn the_filter_cuts_both_ways() {
        assert_eq!(fold_fixture(OTHER, PART_CAP).calls, 1);
    }

    #[test]
    fn a_session_present_in_no_part_yields_an_empty_roll_rather_than_everything() {
        let roll = fold_fixture("ses_never_seen_here", PART_CAP);
        assert_eq!(roll.calls, 0);
        assert!(roll.tools.is_empty());
        // And it is not `unavailable` — that is the read loop's answer, not the
        // fold's. A tree that was read and held nothing for this session is a
        // different sentence again, and the loop decides it.
        assert_eq!(roll.unavailable, None);
    }

    /// A tally that quietly stopped counting is worse than one that says it
    /// stopped.
    #[test]
    fn a_capped_read_reports_the_cap_and_an_uncapped_one_does_not() {
        let capped = fold_fixture(TARGET, 5);
        assert_eq!(capped.truncated, Some(5));
        assert!(capped.calls < 26, "the cap actually cut the read");
        assert_eq!(fold_fixture(TARGET, PART_CAP).truncated, None);
    }

    #[test]
    fn pointed_at_claudes_log_it_finds_nothing_rather_than_something() {
        let claude = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/activity/claude/session.jsonl");
        let r = reader();
        let mut roll = ActivityRoll::empty(CliKind::Opencode, r.capabilities());
        r.fold(&claude, &std::fs::read_to_string(&claude).unwrap(), &mut roll);
        roll.finish();
        assert_eq!(roll.calls, 0);
    }

    #[test]
    fn a_session_with_no_message_index_names_no_sources() {
        assert!(reader().sources("ses_no_such_session_at_all").is_empty());
    }
}
