//! The Copilot CLI's log, and the first real test of whether the shape holds for
//! a CLI it was not drawn around.
//!
//! `~/.copilot/session-state/<sessionId>.jsonl`, measured on 2026-08-25 against
//! `copilot-agent` 0.0.361. One JSON object per line, each with `type`, `data`,
//! `id`, `timestamp` and `parentId`. Event types observed across four sessions:
//! `session.start`, `session.info`, `session.error`, `session.truncation`,
//! `user.message`, `assistant.turn_start`, `assistant.message`,
//! `assistant.turn_end`, `tool.execution_start`, `tool.execution_complete`.
//!
//! One call is a `tool.execution_start`:
//!
//! ```json
//! {"type":"tool.execution_start",
//!  "data":{"toolCallId":"tooluse_mwFTvMHESpyrMbhRPAEqsg","toolName":"view",
//!          "arguments":{"path":"…"}}}
//! ```
//!
//! The outcome is the matching `tool.execution_complete`, whose `data` carries
//! `success`, `error` and the same `toolCallId`. Note that the completion's own
//! `toolName` is `null` in every measured case — the name is only on the start,
//! which is why the two events have to be joined rather than read separately.

use super::model::{ActivityRoll, AgentRole, CliKind, ReaderCapabilities, Source, ToolCategory};
use super::reader::{classify, ActivityReader};
use std::collections::HashMap;
use std::path::Path;

pub struct CopilotReader;

/// The id the main chain's `AgentTally` carries. Copilot's log attributes
/// nothing, so there is one agent and it needs a name that is not a file stem
/// pretending to be one.
const MAIN: &str = "session";

/// Measured names, all seven of them across four sessions.
///
/// `report_intent` is a real call the model makes and is counted like any other.
/// It is not a file operation and it is not hidden — a tally that quietly drops
/// the calls it considers uninteresting is a tally nobody can reconcile against
/// the transcript.
///
/// Unrecognised names land in `Other` and keep their own name, as in the Claude
/// reader.
fn category(name: &str) -> Option<ToolCategory> {
    Some(match name {
        "bash" => ToolCategory::Run,
        "view" => ToolCategory::Read,
        "edit" | "create" => ToolCategory::Edit,
        "glob" | "grep" => ToolCategory::Search,
        // Not a file operation, and counted anyway.
        "report_intent" => ToolCategory::Other,
        _ => return None,
    })
}

impl ActivityReader for CopilotReader {
    fn cli(&self) -> CliKind {
        CliKind::Copilot
    }

    /// Outcomes yes, agents no.
    ///
    /// **No delegation was observed** in any measured session, so the roll
    /// carries a single `AgentTally` and the panel omits the by-agent section
    /// rather than drawing a one-row tree. That is the abstraction earning its
    /// keep rather than needing a change.
    fn capabilities(&self) -> ReaderCapabilities {
        ReaderCapabilities { outcomes: true, agents: false }
    }

    /// Copilot's own `sessionId` is in the log's `session.start` line and in the
    /// filename, and **the deck's session id is not it.**
    ///
    /// For a session the deck launches, whatever id it can pin at launch is what
    /// this resolves on; for one it did not launch there is nothing to join on
    /// and `unavailable` is the honest answer. Getting `copilot` launched by the
    /// deck at all is a separate epic — this issue lands the fold and the
    /// location rule, and the binding is as good as the launch path allows.
    fn sources(&self, session: &str) -> Vec<Source> {
        let Some(home) = std::env::var_os("HOME") else { return Vec::new() };
        let path = std::path::PathBuf::from(home)
            .join(".copilot/session-state")
            .join(format!("{session}.jsonl"));
        if !path.is_file() {
            return Vec::new();
        }
        vec![Source::File(path)]
    }

    fn fold(&self, _path: &Path, buf: &str, roll: &mut ActivityRoll) {
        // Collected first and tallied after, for the reason the Claude reader
        // does it: a completion names a start that appeared earlier, and a start
        // whose completion never arrives is still a call.
        let mut calls: Vec<(String, String)> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut failed: HashMap<String, bool> = HashMap::new();

        for line in buf.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            match v["type"].as_str() {
                Some("tool.execution_start") => {
                    let d = &v["data"];
                    let (Some(id), Some(name)) = (d["toolCallId"].as_str(), d["toolName"].as_str())
                    else {
                        continue;
                    };
                    if seen.insert(id.to_string()) {
                        calls.push((id.to_string(), name.to_string()));
                    }
                }
                Some("tool.execution_complete") => {
                    let d = &v["data"];
                    let Some(id) = d["toolCallId"].as_str() else { continue };
                    // A completion with no preceding start is counted as
                    // nothing. It cannot be counted as a call: this event does
                    // not carry the tool's name, so there would be nothing to
                    // count it under.
                    if let Some(ok) = d["success"].as_bool() {
                        failed.insert(id.to_string(), !ok);
                    }
                }
                _ => {}
            }
        }

        let agent = roll.agent(MAIN, AgentRole::Main, 0);
        for (id, name) in calls {
            let (cat, server) = classify(&name, category);
            let t = agent.tool(&name, cat, server);
            t.calls += 1;
            if failed.get(&id).copied().unwrap_or(false) {
                t.errors += 1;
            }
            // `denials` stays 0 for every Copilot roll, and that is a property of
            // the log rather than a claim that nothing was ever refused: no
            // denial event was observed in any measured session. A zero the panel
            // draws should be traceable to why, and this is the why.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::model::{ActivityRoll, ToolTally};

    fn fold(buf: &str) -> ActivityRoll {
        let mut roll = ActivityRoll::empty(CliKind::Copilot, CopilotReader.capabilities());
        CopilotReader.fold(Path::new("/p/s.jsonl"), buf, &mut roll);
        roll.finish();
        roll
    }

    fn row<'a>(roll: &'a ActivityRoll, native: &str) -> &'a ToolTally {
        roll.tools.iter().find(|t| t.native == native).expect("a row for that tool")
    }

    fn start(id: &str, name: &str) -> String {
        format!(
            r#"{{"type":"tool.execution_start","data":{{"toolCallId":"{id}","toolName":"{name}"}}}}"#
        )
    }

    fn complete(id: &str, success: bool) -> String {
        format!(
            r#"{{"type":"tool.execution_complete","data":{{"toolCallId":"{id}","success":{success},"toolName":null}}}}"#
        )
    }

    #[test]
    fn a_start_with_a_successful_complete_is_one_call_and_no_error() {
        let roll = fold(&format!("{}\n{}\n", start("c1", "view"), complete("c1", true)));
        let r = row(&roll, "view");
        assert_eq!((r.calls, r.errors, r.denials), (1, 0, 0));
        assert_eq!(r.category, ToolCategory::Read);
    }

    #[test]
    fn a_complete_that_did_not_succeed_is_an_error() {
        let roll = fold(&format!("{}\n{}\n", start("c1", "edit"), complete("c1", false)));
        let r = row(&roll, "edit");
        assert_eq!((r.calls, r.errors, r.denials), (1, 1, 0));
    }

    #[test]
    fn a_start_whose_complete_never_arrives_is_still_a_call() {
        let roll = fold(&format!("{}\n", start("c1", "bash")));
        assert_eq!(roll.calls, 1);
        assert_eq!(row(&roll, "bash").errors, 0);
    }

    /// Counted as nothing, and specifically not as a negative call: the
    /// completion event does not carry the tool's name, so there would be
    /// nothing to count it under even if one wanted to.
    #[test]
    fn a_complete_with_no_preceding_start_counts_as_nothing() {
        let roll = fold(&format!("{}\n", complete("c-orphan", false)));
        assert_eq!(roll.calls, 0);
        assert!(roll.tools.is_empty());
    }

    #[test]
    fn a_line_that_is_not_json_is_skipped_without_failing_the_file() {
        let buf = format!("not json\n{}\n{{\"half\":\n", start("c1", "view"));
        assert_eq!(fold(&buf).calls, 1);
    }

    #[test]
    fn the_same_call_id_twice_is_counted_once() {
        let buf = format!("{}\n{}\n", start("c1", "view"), start("c1", "view"));
        assert_eq!(fold(&buf).calls, 1);
    }

    #[test]
    fn the_category_map_covers_every_measured_name() {
        for (name, want) in [
            ("bash", ToolCategory::Run),
            ("view", ToolCategory::Read),
            ("edit", ToolCategory::Edit),
            ("create", ToolCategory::Edit),
            ("glob", ToolCategory::Search),
            ("grep", ToolCategory::Search),
            ("report_intent", ToolCategory::Other),
        ] {
            assert_eq!(category(name), Some(want), "for {name}");
        }
    }

    /// A real call the model makes, and one it would be tempting to hide. A
    /// tally that drops what it considers uninteresting cannot be reconciled
    /// against the transcript, which is the only check a person can actually do.
    #[test]
    fn report_intent_is_counted_like_any_other_call() {
        let roll = fold(&format!("{}\n", start("c1", "report_intent")));
        assert_eq!(row(&roll, "report_intent").calls, 1);
    }

    #[test]
    fn a_name_this_build_has_never_heard_of_is_counted_under_its_own_name() {
        let roll = fold(&format!("{}\n", start("c1", "shipped_last_tuesday")));
        let r = row(&roll, "shipped_last_tuesday");
        assert_eq!(r.calls, 1);
        assert_eq!(r.category, ToolCategory::Other);
    }

    // --- the golden fixture ------------------------------------------------

    fn fixture() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/activity/copilot/session.jsonl")
    }

    #[test]
    fn the_fixture_folds_to_the_roll_it_was_measured_at() {
        let roll = fold(&std::fs::read_to_string(fixture()).unwrap());
        assert_eq!(roll.calls, 14);
        assert_eq!(row(&roll, "view").calls, 4);
        assert_eq!(row(&roll, "grep").calls, 3);
        assert_eq!(row(&roll, "edit").calls, 2);
        assert_eq!(row(&roll, "glob").calls, 2);
        assert_eq!(row(&roll, "report_intent").calls, 2);
        assert_eq!(row(&roll, "create").calls, 1);

        assert_eq!(row(&roll, "edit").errors, 2);
        assert_eq!(row(&roll, "create").errors, 1);
        assert_eq!(roll.tools.iter().map(|t| t.errors).sum::<u32>(), 3);
        // No denial event exists in this log, so this zero is the log's shape
        // and not a claim about what was refused.
        assert_eq!(roll.tools.iter().map(|t| t.denials).sum::<u32>(), 0);
    }

    #[test]
    fn the_roll_has_exactly_one_agent_and_says_it_attributes_none() {
        let roll = fold(&std::fs::read_to_string(fixture()).unwrap());
        assert!(!CopilotReader.capabilities().agents);
        assert_eq!(roll.agents.len(), 1);
        assert_eq!(roll.agents[0].kind, AgentRole::Main);
    }

    /// A reader pointed at the wrong CLI's log must return an EMPTY roll, not a
    /// partial one built out of coincidentally-shaped lines. Claude Code's
    /// transcript has `type` on every line too, and neither `tool_use` nor
    /// `tool_result` may be mistaken for an execution event.
    #[test]
    fn pointed_at_claudes_log_it_finds_nothing_rather_than_something() {
        let claude = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/activity/claude/session.jsonl");
        let roll = fold(&std::fs::read_to_string(claude).unwrap());
        assert_eq!(roll.calls, 0);
        assert!(roll.tools.is_empty());
    }

    #[test]
    fn a_session_with_no_log_of_its_own_names_no_sources() {
        assert!(CopilotReader.sources("no-such-copilot-session-0000").is_empty());
    }
}
