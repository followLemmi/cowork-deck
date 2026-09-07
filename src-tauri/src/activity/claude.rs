//! Claude Code's log, and the only measured format that attributes delegated
//! work to a named agent.
//!
//! `~/.claude/projects/<slug>/<id>.jsonl`, located by `commands::current_transcript`
//! — the hook-reported path first, the launch id's filename as the fallback.
//! That function is reused rather than reimplemented: it is what makes `/clear`
//! survivable, and a second copy of the rule would drift from it.
//!
//! One call is a `tool_use` block inside an `assistant` message's
//! `message.content[]`, carrying `id` and `name`. The outcome is the
//! `tool_result` block naming the same id in a later `user` message.

use super::model::{
    ActivityRoll, AgentRole, CliKind, ReaderCapabilities, Source, ToolCategory,
};
use super::reader::{classify, ActivityReader};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub struct ClaudeReader;

/// Measured names, mapped once.
///
/// An unrecognised name lands in `Other` and is still counted, still under its
/// own name. The map is a lens; a tool the deck has never heard of must not
/// vanish from a tally because of it. New Claude Code tools ship regularly, and
/// a tally that is wrong is a worse failure than a category that is vague.
fn category(name: &str) -> Option<ToolCategory> {
    Some(match name {
        "Bash" | "BashOutput" | "KillShell" => ToolCategory::Run,
        "Read" | "NotebookRead" => ToolCategory::Read,
        "Edit" | "Write" | "NotebookEdit" => ToolCategory::Edit,
        "Glob" | "Grep" => ToolCategory::Search,
        "WebFetch" | "WebSearch" => ToolCategory::Web,
        "Agent" | "Task" => ToolCategory::Delegate,
        "TaskCreate" | "TaskUpdate" | "TaskStop" | "TaskList" => ToolCategory::Task,
        "AskUserQuestion" => ToolCategory::Ask,
        // Everything else — `Skill`, `ToolSearch`, `Monitor`, `ListAgents`,
        // `SendMessage` — is `Other` and keeps its name.
        _ => return None,
    })
}

/// What happened to a call, where the log says.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// The call ran and came back an error.
    Error,
    /// The call never ran.
    Denied,
}

impl ActivityReader for ClaudeReader {
    fn cli(&self) -> CliKind {
        CliKind::Claude
    }

    fn capabilities(&self) -> ReaderCapabilities {
        ReaderCapabilities { outcomes: true, agents: true }
    }

    fn sources(&self, session: &str) -> Vec<Source> {
        let Some(main) = crate::commands::current_transcript(session) else {
            return Vec::new();
        };
        let mut out = vec![Source::File(main.clone())];
        out.extend(crate::commands::subagent_transcripts(&main).into_iter().map(Source::File));
        out
    }

    fn fold(&self, path: &Path, buf: &str, roll: &mut ActivityRoll) {
        // Two collections rather than one pass that tallies as it goes: a result
        // names a call that appeared earlier, and a call whose result never
        // arrives is still a call. Deciding both at the end is what makes "no
        // outcome" a state rather than an ordering accident.
        let mut seen: HashSet<String> = HashSet::new();
        let mut calls: Vec<(String, String)> = Vec::new();
        let mut outcomes: HashMap<String, Outcome> = HashMap::new();

        for line in buf.lines() {
            // Tolerant of a line that is not JSON, as `fold_usage_lines` is: a
            // truncated tail is the ordinary state of a file being written to.
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };

            // A denial is a line-level fact, and it arrives on the SAME line as a
            // `tool_result` whose `is_error` is true. Measured over one machine's
            // transcripts: 255 denial lines, every one of them carrying an errored
            // result. So the kind has to be read first and win, or every refusal
            // would also be billed as a failure.
            let denied = v["toolDenialKind"].as_str().is_some();

            // Measured: `message.content` is a string on 177 of 6624 lines. Skip
            // those the way `fold_usage_lines` skips a line without usage —
            // tolerantly, without failing the file.
            let Some(blocks) = v["message"]["content"].as_array() else { continue };

            for b in blocks {
                match b["type"].as_str() {
                    Some("tool_use") => {
                        let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) else {
                            continue;
                        };
                        // Measured: 1673 blocks across 27 files carried 1673
                        // distinct ids, so this guards rather than fixes. It is
                        // worth the `HashSet` anyway — the neighbouring token fold
                        // had to learn the opposite rule for a different reason
                        // (`fold_usage_lines` dedupes by `message.id` because every
                        // content-block line repeats one request's usage object),
                        // and the two rules being different is exactly the kind of
                        // thing a later reader assumes rather than checks.
                        if seen.insert(id.to_string()) {
                            calls.push((id.to_string(), name.to_string()));
                        }
                    }
                    Some("tool_result") => {
                        let Some(id) = b["tool_use_id"].as_str() else { continue };
                        let outcome = if denied {
                            Outcome::Denied
                        } else if b["is_error"].as_bool().unwrap_or(false) {
                            Outcome::Error
                        } else {
                            continue;
                        };
                        outcomes.insert(id.to_string(), outcome);
                    }
                    _ => {}
                }
            }
        }

        let who = agent_of(path);
        let agent = roll.agent(&who.id, who.role, who.depth);
        if who.role == AgentRole::Subagent {
            // A subagent whose metadata is missing or unparseable still
            // contributes its calls, under its file stem and with no name — the
            // rule `snapshot_from_main` follows, where one unreadable subagent
            // understates the total rather than discarding the main chain's
            // figure with it.
            agent.agent_type = who.agent_type;
            agent.description = who.description;
            agent.spawned_by = who.spawned_by;
        }
        for (id, name) in calls {
            let (cat, server) = classify(&name, category);
            let t = agent.tool(&name, cat, server);
            t.calls += 1;
            match outcomes.get(&id) {
                Some(Outcome::Error) => t.errors += 1,
                Some(Outcome::Denied) => t.denials += 1,
                // A call whose result never arrived: counted, with no outcome.
                // The turn may still be in flight, which is the ordinary state of
                // the panel being open on a working session.
                None => {}
            }
        }
    }
}

/// Who wrote this file.
struct Who {
    id: String,
    role: AgentRole,
    depth: u8,
    agent_type: Option<String>,
    description: Option<String>,
    spawned_by: Option<String>,
}

/// The agent a transcript belongs to, from its own filename and the metadata
/// beside it.
///
/// `agent-*.jsonl` in a `subagents/` directory is delegated work; anything else
/// is the conversation itself. Beside each subagent transcript sits an
/// `agent-*.meta.json` that nothing in this codebase read before:
///
/// ```json
/// { "agentType": "Explore", "description": "Explore hooks and agent-team wiring",
///   "toolUseId": "toolu_01AHWahzGwe8zw5rVAVDsFMh", "spawnDepth": 1 }
/// ```
///
/// That is the whole attribution problem solved by a join rather than by a
/// heuristic: `agentType` and `description` name the agent, `toolUseId` is the
/// `Agent` call in the parent chain that started it, and `spawnDepth` fills
/// `AgentTally::depth`. No inference from timestamps, no matching on
/// descriptions.
///
/// Three measured facts about what is actually in these files, because the
/// obvious reading of the shape above is too strong:
///
/// - **`toolUseId` is present on 217 of 486.** The ones without it carry
///   `taskKind: "in_process_teammate"` and `spawnDepth: 0` — a teammate raised
///   with the session rather than delegated to from a tool call. `spawned_by`
///   is `Option` for that reason and not for tidiness.
/// - **`description` is absent on 30 of 486.** Also optional, also real.
/// - **`spawnDepth` reaches 2 and 3, and those transcripts sit in the SAME flat
///   `subagents/` directory.** So `subagent_transcripts` already finds them and
///   this reader already counts them; what is not drawn yet is the tree, and
///   `parentAgentId` — present on the deeper ones, naming the parent's file stem
///   — is what would draw it. That is a panel decision, not a reading one.
fn agent_of(path: &Path) -> Who {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let in_subagents = path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == "subagents");
    if !(in_subagents && stem.starts_with("agent-")) {
        return Who {
            id: stem,
            role: AgentRole::Main,
            depth: 0,
            agent_type: None,
            description: None,
            spawned_by: None,
        };
    }

    let meta = path.with_extension("meta.json");
    let parsed = std::fs::read_to_string(&meta)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let (agent_type, description, spawned_by, depth) = match parsed {
        Some(v) => (
            v["agentType"].as_str().map(str::to_string),
            v["description"].as_str().map(str::to_string),
            v["toolUseId"].as_str().map(str::to_string),
            // Clamped rather than wrapped: a depth that does not fit a `u8` is a
            // file this reader does not understand, and saturating there beats
            // drawing an agent at depth 0 that is nested forty deep.
            v["spawnDepth"].as_u64().unwrap_or(1).min(u8::MAX as u64) as u8,
        ),
        // Missing or malformed metadata costs the name and nothing else.
        None => (None, None, None, 1),
    };
    Who {
        id: stem,
        role: AgentRole::Subagent,
        // A subagent is never at depth 0 in the panel's tree, whatever the
        // metadata says: `spawnDepth: 0` is what a teammate carries, and drawing
        // it level with the main chain would say it was the conversation.
        depth: depth.max(1),
        agent_type,
        description,
        spawned_by,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::model::ActivityRoll;

    fn caps() -> ReaderCapabilities {
        ClaudeReader.capabilities()
    }

    /// Fold one buffer as if it were the session's own transcript.
    fn fold_main(buf: &str) -> ActivityRoll {
        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(Path::new("/p/session.jsonl"), buf, &mut roll);
        roll.finish();
        roll
    }

    fn row<'a>(roll: &'a ActivityRoll, native: &str) -> &'a super::super::model::ToolTally {
        roll.tools.iter().find(|t| t.native == native).expect("a row for that tool")
    }

    fn call(id: &str, name: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"{name}"}}]}}}}"#
        )
    }

    fn result(id: &str, is_error: bool) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","is_error":{is_error}}}]}}}}"#
        )
    }

    fn denial(id: &str, kind: &str) -> String {
        format!(
            r#"{{"type":"user","toolDenialKind":"{kind}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","is_error":true}}]}}}}"#
        )
    }

    #[test]
    fn a_call_with_a_successful_result_is_a_call_and_nothing_else() {
        let roll = fold_main(&format!("{}\n{}\n", call("t1", "Bash"), result("t1", false)));
        let r = row(&roll, "Bash");
        assert_eq!((r.calls, r.errors, r.denials), (1, 0, 0));
        assert_eq!(r.category, ToolCategory::Run);
    }

    #[test]
    fn a_call_whose_result_is_an_error_counts_as_an_error() {
        let roll = fold_main(&format!("{}\n{}\n", call("t1", "Read"), result("t1", true)));
        let r = row(&roll, "Read");
        assert_eq!((r.calls, r.errors, r.denials), (1, 1, 0));
    }

    /// The measured shape, and the reason the two counters cannot be one: a
    /// denial line carries `is_error: true` as well. Read naively it would be
    /// billed twice — once as a failure and once as a refusal — or, worse, only
    /// as a failure.
    #[test]
    fn a_refusal_is_a_denial_and_never_also_an_error() {
        for kind in ["user-rejected", "automode-blocked", "permission-rule", "automode-unavailable"] {
            let roll = fold_main(&format!("{}\n{}\n", call("t1", "Bash"), denial("t1", kind)));
            let r = row(&roll, "Bash");
            assert_eq!((r.calls, r.errors, r.denials), (1, 0, 1), "for {kind}");
        }
    }

    #[test]
    fn a_call_whose_result_never_arrives_is_still_a_call() {
        let roll = fold_main(&format!("{}\n", call("t1", "Bash")));
        let r = row(&roll, "Bash");
        assert_eq!((r.calls, r.errors, r.denials), (1, 0, 0));
        assert_eq!(roll.calls, 1);
    }

    #[test]
    fn a_result_whose_call_never_appeared_counts_as_nothing() {
        let roll = fold_main(&format!("{}\n", result("t-orphan", true)));
        assert_eq!(roll.calls, 0);
        assert!(roll.tools.is_empty());
    }

    #[test]
    fn a_line_whose_content_is_a_string_is_skipped_without_failing_the_file() {
        let buf = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"just a sentence"}}"#,
            call("t1", "Bash"),
            result("t1", false),
        );
        let roll = fold_main(&buf);
        assert_eq!(roll.calls, 1);
    }

    #[test]
    fn a_line_that_is_not_json_is_skipped_without_failing_the_file() {
        let buf = format!("not json at all\n{}\n{{\"half\": \n", call("t1", "Bash"));
        let roll = fold_main(&buf);
        assert_eq!(roll.calls, 1);
    }

    #[test]
    fn the_same_tool_use_id_appearing_twice_is_counted_once() {
        let buf = format!("{}\n{}\n{}\n", call("t1", "Bash"), call("t1", "Bash"), call("t2", "Bash"));
        let roll = fold_main(&buf);
        assert_eq!(row(&roll, "Bash").calls, 2);
    }

    #[test]
    fn an_mcp_name_keeps_its_own_name_and_gains_its_server() {
        let roll = fold_main(&format!("{}\n", call("t1", "mcp__gitnexus__impact")));
        let r = row(&roll, "mcp__gitnexus__impact");
        assert_eq!(r.category, ToolCategory::Mcp);
        assert_eq!(r.server.as_deref(), Some("gitnexus"));
    }

    #[test]
    fn a_tool_this_build_has_never_heard_of_is_counted_under_its_own_name() {
        let roll = fold_main(&format!("{}\n", call("t1", "ShippedLastTuesday")));
        let r = row(&roll, "ShippedLastTuesday");
        assert_eq!(r.calls, 1);
        assert_eq!(r.category, ToolCategory::Other);
    }

    #[test]
    fn the_category_map_covers_the_measured_vocabulary() {
        for (name, want) in [
            ("Bash", ToolCategory::Run),
            ("BashOutput", ToolCategory::Run),
            ("Read", ToolCategory::Read),
            ("Write", ToolCategory::Edit),
            ("Edit", ToolCategory::Edit),
            ("Grep", ToolCategory::Search),
            ("WebSearch", ToolCategory::Web),
            ("Agent", ToolCategory::Delegate),
            ("TaskUpdate", ToolCategory::Task),
            ("AskUserQuestion", ToolCategory::Ask),
            ("Skill", ToolCategory::Other),
            ("ToolSearch", ToolCategory::Other),
        ] {
            assert_eq!(category(name).unwrap_or(ToolCategory::Other), want, "for {name}");
        }
    }

    // --- the golden fixture ------------------------------------------------
    //
    // Trimmed from a real session and its two subagents: every line keeps only
    // the fields this reader reads, so the shape is real and no prompt, path or
    // result text came along with it.

    fn fixture() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/activity/claude")
    }

    fn fold_fixture() -> ActivityRoll {
        let root = fixture();
        let main = root.join("session.jsonl");
        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(&main, &std::fs::read_to_string(&main).unwrap(), &mut roll);
        for sub in crate::commands::subagent_transcripts(&main) {
            ClaudeReader.fold(&sub, &std::fs::read_to_string(&sub).unwrap(), &mut roll);
        }
        roll.finish();
        roll
    }

    #[test]
    fn the_fixture_folds_to_the_roll_it_was_measured_at() {
        let roll = fold_fixture();
        // 30 in the main chain and 12 in each subagent.
        assert_eq!(roll.calls, 54);
        assert_eq!(roll.agents.len(), 3);

        assert_eq!(row(&roll, "Bash").calls, 31);
        assert_eq!(row(&roll, "Edit").calls, 8);
        assert_eq!(row(&roll, "Read").calls, 7);
        assert_eq!(row(&roll, "Agent").calls, 2);
        assert_eq!(row(&roll, "Agent").category, ToolCategory::Delegate);

        // Two servers over two MCP names, which is the shape the by-server
        // section exists for.
        let mcp: Vec<_> = roll.tools.iter().filter(|t| t.category == ToolCategory::Mcp).collect();
        assert_eq!(mcp.len(), 2);
        let mut servers: Vec<&str> = mcp.iter().filter_map(|t| t.server.as_deref()).collect();
        servers.sort();
        assert_eq!(servers, vec!["jira-cloud", "serena"]);

        // Two failures in the main chain, one refusal in a subagent, and the two
        // never blur into each other.
        assert_eq!(roll.tools.iter().map(|t| t.errors).sum::<u32>(), 2);
        assert_eq!(roll.tools.iter().map(|t| t.denials).sum::<u32>(), 1);
        assert_eq!(row(&roll, "Read").denials, 1);
        assert_eq!(row(&roll, "Read").errors, 0);

        // The two lists agree, which is the whole reason `finish` computes one
        // from the other.
        assert_eq!(roll.tools.iter().map(|t| t.calls).sum::<u32>(), roll.calls);
        assert_eq!(roll.agents.iter().map(|a| a.calls).sum::<u32>(), roll.calls);
    }

    #[test]
    fn a_subagent_is_named_by_its_own_metadata_and_joined_to_the_call_that_spawned_it() {
        let roll = fold_fixture();
        assert_eq!(roll.agents[0].kind, AgentRole::Main);
        assert_eq!(roll.agents[0].depth, 0);

        let subs: Vec<_> = roll.agents.iter().filter(|a| a.kind == AgentRole::Subagent).collect();
        assert_eq!(subs.len(), 2);
        for s in &subs {
            assert_eq!(s.agent_type.as_deref(), Some("Explore"));
            assert!(s.description.as_deref().is_some_and(|d| d.starts_with("delegated work")));
            assert_eq!(s.depth, 1);
            assert_eq!(s.calls, 12);
            // The join: the id it carries is an `Agent` call in the main chain.
            let spawned_by = s.spawned_by.as_deref().expect("a toolUseId");
            assert!(spawned_by.starts_with("toolu_"));
        }

        // Neither is counted into the other: the main chain's two `Agent` calls
        // stay two calls, and the 24 the subagents made are theirs.
        assert_eq!(roll.agents[0].calls, 30);
        assert_eq!(subs.iter().map(|a| a.calls).sum::<u32>(), 24);
    }

    #[test]
    fn a_subagent_with_no_metadata_keeps_its_calls_and_loses_only_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let subagents = dir.path().join("session").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let orphan = subagents.join("agent-abc123.jsonl");
        std::fs::write(&orphan, format!("{}\n{}\n", call("t1", "Bash"), call("t2", "Read"))).unwrap();

        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(Path::new("/p/session.jsonl"), &call("t0", "Agent"), &mut roll);
        ClaudeReader.fold(&orphan, &std::fs::read_to_string(&orphan).unwrap(), &mut roll);
        roll.finish();

        let sub = roll.agents.iter().find(|a| a.kind == AgentRole::Subagent).unwrap();
        assert_eq!(sub.id, "agent-abc123");
        assert_eq!(sub.calls, 2);
        assert_eq!(sub.agent_type, None);
        assert_eq!(sub.spawned_by, None);
        // A subagent is never drawn level with the conversation.
        assert_eq!(sub.depth, 1);
        // And the main chain is untouched.
        assert_eq!(roll.agents[0].calls, 1);
        assert_eq!(roll.calls, 3);
    }

    #[test]
    fn a_subagent_whose_metadata_is_malformed_is_treated_as_one_with_none() {
        let dir = tempfile::tempdir().unwrap();
        let subagents = dir.path().join("session").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let sub = subagents.join("agent-abc123.jsonl");
        std::fs::write(&sub, format!("{}\n", call("t1", "Bash"))).unwrap();
        std::fs::write(subagents.join("agent-abc123.meta.json"), "{not json,,,").unwrap();

        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(&sub, &std::fs::read_to_string(&sub).unwrap(), &mut roll);
        roll.finish();

        let a = &roll.agents[0];
        assert_eq!(a.calls, 1);
        assert_eq!(a.agent_type, None);
        assert_eq!(a.description, None);
    }

    /// A teammate carries `spawnDepth: 0` and no `toolUseId` — 238 of 486
    /// measured metadata files are this shape. It is still delegated work and
    /// still drawn below the conversation rather than level with it.
    #[test]
    fn a_teammate_with_no_tool_use_id_is_still_a_subagent_below_the_main_chain() {
        let dir = tempfile::tempdir().unwrap();
        let subagents = dir.path().join("session").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let sub = subagents.join("agent-aR6-spinners-30b40512bba0e6be.jsonl");
        std::fs::write(&sub, format!("{}\n", call("t1", "Bash"))).unwrap();
        std::fs::write(
            subagents.join("agent-aR6-spinners-30b40512bba0e6be.meta.json"),
            r#"{"agentType":"R6-spinners","description":"Recon UPI spinners","spawnDepth":0,"taskKind":"in_process_teammate"}"#,
        )
        .unwrap();

        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(&sub, &std::fs::read_to_string(&sub).unwrap(), &mut roll);
        roll.finish();

        let a = &roll.agents[0];
        assert_eq!(a.kind, AgentRole::Subagent);
        assert_eq!(a.agent_type.as_deref(), Some("R6-spinners"));
        assert_eq!(a.spawned_by, None);
        assert_eq!(a.depth, 1);
    }

    /// A file outside a `subagents/` directory is the conversation, whatever it
    /// happens to be called.
    #[test]
    fn only_a_file_in_a_subagents_directory_is_delegated_work() {
        let mut roll = ActivityRoll::empty(CliKind::Claude, caps());
        ClaudeReader.fold(Path::new("/p/agent-looks-like-one.jsonl"), &call("t1", "Bash"), &mut roll);
        roll.finish();
        assert_eq!(roll.agents[0].kind, AgentRole::Main);
    }

    #[test]
    fn a_session_with_no_transcript_names_no_sources() {
        assert!(ClaudeReader.sources("no-such-session-id-at-all-0000").is_empty());
    }
}
