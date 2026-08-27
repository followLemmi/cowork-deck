//! Which reader answers for which CLI, and the one read loop all of them go
//! through.

use super::model::{ActivityRoll, CliKind, ReaderCapabilities, Source, Unavailable};
use super::reader::ActivityReader;

/// The reader for a CLI, or nothing.
///
/// Nothing is an ordinary answer and the panel has a sentence for it: a CLI with
/// no reader in this build is a different thing from a log that would not open,
/// and #326 says so in different words.
pub fn reader_for(cli: CliKind) -> Option<Box<dyn ActivityReader>> {
    match cli {
        CliKind::Claude => Some(Box::new(super::claude::ClaudeReader)),
        CliKind::Copilot => Some(Box::new(super::copilot::CopilotReader)),
        // Every remaining arm is filled by the issue that measures that CLI's
        // log. A panel opened on one of them says "no reader" rather than
        // drawing zeroes.
        CliKind::Opencode | CliKind::Codex => None,
    }
}

/// What a reader that does not exist can do, which is nothing. Used for the
/// `NoReader` roll so the panel is handed capabilities either way and never has
/// to branch on their absence.
const NOTHING: ReaderCapabilities = ReaderCapabilities { outcomes: false, agents: false };

/// One session's roll: find the reader, ask it where the log is, read it, fold
/// it, and total it.
///
/// The whole of the file I/O for one session happens here, and it is why this is
/// not on the five-second poll. The heaviest transcript measured on one machine
/// is 3.1 MB over 1728 lines and 47 files are past 1 MB; re-reading every open
/// session's log every five seconds to fill a panel nobody has opened is the cost
/// this is shaped to avoid. #326 calls it on open and re-calls it on the tick
/// only while a panel is on screen.
pub fn roll_for(cli: CliKind, session: &str) -> ActivityRoll {
    let Some(reader) = reader_for(cli) else {
        return ActivityRoll::unavailable(cli, Unavailable::NoReader, NOTHING);
    };
    roll_with(reader.as_ref(), session)
}

/// The read loop itself, against a reader that is already in hand.
///
/// Split from [`roll_for`] so the loop can be tested against a reader that
/// touches no filesystem and names no CLI — the rules being checked here (a
/// missing source is not zero calls, the two tool lists agree, a capability is
/// what the panel is told) belong to the loop and not to any log format.
pub fn roll_with(reader: &dyn ActivityReader, session: &str) -> ActivityRoll {
    let cli = reader.cli();
    let caps = reader.capabilities();
    let sources = reader.sources(session);
    if sources.is_empty() {
        return ActivityRoll::unavailable(cli, Unavailable::NoLog, caps);
    }

    let mut roll = ActivityRoll::empty(cli, caps);
    let mut read_any = false;
    for src in &sources {
        match src {
            Source::File(path) => {
                match std::fs::read_to_string(path) {
                    Ok(buf) => {
                        read_any = true;
                        reader.fold(path, &buf, &mut roll);
                    }
                    // One unreadable source understates the tally rather than
                    // discarding what the others contributed — the rule
                    // `snapshot_from_main` already follows for a subagent whose
                    // transcript will not open.
                    Err(_) => continue,
                }
            }
            Source::Tree { dir, ext, cap } => {
                let (files, truncated) = walk(dir, ext, *cap);
                if truncated {
                    roll.truncated = Some(*cap as u32);
                }
                for path in files {
                    if let Ok(buf) = std::fs::read_to_string(&path) {
                        read_any = true;
                        reader.fold(&path, &buf, &mut roll);
                    }
                }
            }
        }
    }

    // Sources were named and not one of them opened. That is a log that is gone
    // from under the session, which is neither "no log" nor "no calls".
    if !read_any {
        return ActivityRoll::unavailable(cli, Unavailable::Unreadable, caps);
    }

    // A log that opened and named no agent at all still has an honest answer:
    // zero calls. The main chain's row is what makes `calls: 0` renderable as a
    // sentence rather than as an absence.
    if roll.agents.is_empty() {
        roll.agent(session, super::model::AgentRole::Main, 0);
    }
    roll.finish();
    roll
}

/// Every `*.<ext>` under `dir`, one directory deep, sorted, to a limit.
///
/// One directory deep because that is the shape measured — opencode's
/// `storage/part/<messageID>/<partID>.json` — and a walk without a floor over a
/// tree that grows without limit is not something a panel on a five-second tick
/// may do.
///
/// Returns the files and whether the cap cut the list short. The flag reaches the
/// roll: a tally that quietly stopped counting is worse than one that says it
/// stopped.
fn walk(dir: &std::path::Path, ext: &str, cap: usize) -> (Vec<std::path::PathBuf>, bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (Vec::new(), false);
    };
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            dirs.push(p);
        } else if p.extension().is_some_and(|x| x == ext) {
            files.push(p);
        }
    }
    // Sorted so a cap cuts the same files every time rather than whichever the
    // filesystem happened to hand back first.
    dirs.sort();
    for d in dirs {
        let Ok(inner) = std::fs::read_dir(&d) else { continue };
        let mut found: Vec<std::path::PathBuf> = inner
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == ext))
            .collect();
        found.sort();
        files.extend(found);
    }
    files.sort();
    if files.len() > cap {
        files.truncate(cap);
        return (files, true);
    }
    (files, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_walk_finds_files_one_directory_deep_and_ignores_other_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("top.json"), "{}").unwrap();
        std::fs::write(root.join("ignored.txt"), "x").unwrap();
        std::fs::create_dir_all(root.join("msg_a")).unwrap();
        std::fs::write(root.join("msg_a").join("prt_1.json"), "{}").unwrap();
        std::fs::write(root.join("msg_a").join("prt_2.json"), "{}").unwrap();
        std::fs::write(root.join("msg_a").join("notes.md"), "x").unwrap();

        let (files, truncated) = walk(root, "json", 100);
        assert_eq!(files.len(), 3);
        assert!(!truncated);
    }

    #[test]
    fn the_cap_cuts_the_list_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("msg_a")).unwrap();
        for i in 0..10 {
            std::fs::write(root.join("msg_a").join(format!("prt_{i}.json")), "{}").unwrap();
        }
        let (files, truncated) = walk(root, "json", 4);
        assert_eq!(files.len(), 4);
        assert!(truncated);

        let (files, truncated) = walk(root, "json", 40);
        assert_eq!(files.len(), 10);
        assert!(!truncated);
    }

    #[test]
    fn a_directory_that_is_not_there_is_not_an_error() {
        let (files, truncated) = walk(std::path::Path::new("/no/such/place/at/all"), "json", 10);
        assert!(files.is_empty());
        assert!(!truncated);
    }
}

/// The read loop's own rules, against readers that name no CLI's format.
///
/// Every assertion here is about the contract rather than about a log: what
/// distinguishes "no log" from "no calls", that the two tool lists cannot
/// disagree, and that a capability rather than a zero is what the panel is told.
#[cfg(test)]
mod roll_tests {
    use super::*;
    use crate::activity::model::{AgentRole, ToolCategory};
    use crate::activity::reader::classify;
    use std::path::Path;

    fn caps(outcomes: bool, agents: bool) -> ReaderCapabilities {
        ReaderCapabilities { outcomes, agents }
    }

    fn demo_map(name: &str) -> Option<ToolCategory> {
        match name {
            "Bash" => Some(ToolCategory::Run),
            "Read" => Some(ToolCategory::Read),
            _ => None,
        }
    }

    /// Reads whatever files it is handed and counts one call per line, each line
    /// being `<agent> <tool>`. Not a log format — a way to drive the loop.
    struct Fake {
        sources: Vec<Source>,
        capabilities: ReaderCapabilities,
    }

    impl ActivityReader for Fake {
        fn cli(&self) -> CliKind {
            CliKind::Codex
        }
        fn capabilities(&self) -> ReaderCapabilities {
            self.capabilities
        }
        fn sources(&self, _session: &str) -> Vec<Source> {
            self.sources.clone()
        }
        fn fold(&self, _path: &Path, buf: &str, roll: &mut ActivityRoll) {
            for line in buf.lines() {
                let Some((agent, name)) = line.split_once(' ') else { continue };
                let role = if agent == "main" { AgentRole::Main } else { AgentRole::Subagent };
                let depth = u8::from(role == AgentRole::Subagent);
                let (cat, server) = classify(name, demo_map);
                let outcomes = self.capabilities.outcomes;
                let a = roll.agent(agent, role, depth);
                let t = a.tool(name, cat, server);
                t.calls += 1;
                // A reader that cannot tell outcomes apart reports none, which is
                // what makes the flag rather than the zero the honest signal.
                if outcomes && name == "Bash" {
                    t.errors += 1;
                }
            }
        }
    }

    fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn a_roll_with_no_sources_reports_unavailable_never_zero_calls() {
        let reader = Fake { sources: Vec::new(), capabilities: caps(true, true) };
        let roll = roll_with(&reader, "s1");
        assert_eq!(roll.unavailable, Some(Unavailable::NoLog));
        assert_eq!(roll.calls, 0);
        assert!(roll.agents.is_empty(), "an unavailable roll names no agents");
    }

    #[test]
    fn a_roll_whose_sources_are_empty_reports_no_calls_and_is_not_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "empty.log", "");
        let reader = Fake { sources: vec![Source::File(path)], capabilities: caps(true, true) };
        let roll = roll_with(&reader, "s1");
        assert_eq!(roll.unavailable, None);
        assert_eq!(roll.calls, 0);
        // The main chain's row is what makes "no tool calls yet" renderable as a
        // sentence rather than as an absence.
        assert_eq!(roll.agents.len(), 1);
        assert_eq!(roll.agents[0].kind, AgentRole::Main);
    }

    #[test]
    fn sources_that_all_fail_to_open_are_unreadable_rather_than_empty() {
        let missing = std::path::PathBuf::from("/no/such/file/at/all.log");
        let reader = Fake { sources: vec![Source::File(missing)], capabilities: caps(true, true) };
        let roll = roll_with(&reader, "s1");
        assert_eq!(roll.unavailable, Some(Unavailable::Unreadable));
    }

    #[test]
    fn an_mcp_name_folds_to_mcp_with_its_server_and_its_own_name_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "one.log", "main mcp__claude-in-chrome__computer\n");
        let reader = Fake { sources: vec![Source::File(path)], capabilities: caps(true, true) };
        let roll = roll_with(&reader, "s1");
        let row = &roll.tools[0];
        assert_eq!(row.native, "mcp__claude-in-chrome__computer");
        assert_eq!(row.category, ToolCategory::Mcp);
        assert_eq!(row.server.as_deref(), Some("claude-in-chrome"));
    }

    #[test]
    fn a_name_that_is_not_mcp_never_acquires_a_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "one.log", "main Bash\nmain SomethingNew\n");
        let reader = Fake { sources: vec![Source::File(path)], capabilities: caps(false, true) };
        let roll = roll_with(&reader, "s1");
        assert!(roll.tools.iter().all(|t| t.server.is_none()));
        let unknown = roll.tools.iter().find(|t| t.native == "SomethingNew").unwrap();
        assert_eq!(unknown.category, ToolCategory::Other, "an unknown name is counted, not dropped");
    }

    #[test]
    fn folding_two_sources_sums_into_one_list_and_keeps_the_per_agent_split() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(dir.path(), "a.log", "main Bash\nmain Bash\nmain Read\n");
        let b = write(dir.path(), "b.log", "sub-1 Bash\nsub-1 Read\n");
        let reader = Fake {
            sources: vec![Source::File(a), Source::File(b)],
            capabilities: caps(true, true),
        };
        let roll = roll_with(&reader, "s1");

        assert_eq!(roll.calls, 5);
        // The two lists agree on the total, because one is computed from the other.
        let by_tool: u32 = roll.tools.iter().map(|t| t.calls).sum();
        let by_agent: u32 = roll.agents.iter().map(|a| a.calls).sum();
        assert_eq!(by_tool, 5);
        assert_eq!(by_agent, 5);

        // Sorted by count, descending.
        assert_eq!(roll.tools[0].native, "Bash");
        assert_eq!(roll.tools[0].calls, 3);
        assert_eq!(roll.tools[1].native, "Read");
        assert_eq!(roll.tools[1].calls, 2);

        // And the split survives the fold: the main chain first, then the subagent.
        assert_eq!(roll.agents.len(), 2);
        assert_eq!(roll.agents[0].id, "main");
        assert_eq!(roll.agents[0].calls, 3);
        assert_eq!(roll.agents[1].id, "sub-1");
        assert_eq!(roll.agents[1].calls, 2);
        assert_eq!(roll.agents[1].depth, 1);
    }

    #[test]
    fn a_reader_that_disclaims_outcomes_produces_no_errors_and_says_which() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "a.log", "main Bash\nmain Bash\n");
        let reader = Fake { sources: vec![Source::File(path)], capabilities: caps(false, false) };
        let roll = roll_with(&reader, "s1");
        assert_eq!(roll.tools[0].errors, 0);
        // The flag, not the zero, is what the panel is told.
        assert!(!roll.capabilities.outcomes);
        assert!(!roll.capabilities.agents);
    }

    #[test]
    fn a_tree_source_is_expanded_and_a_cap_is_reported_rather_than_absorbed() {
        let dir = tempfile::tempdir().unwrap();
        let parts = dir.path().join("part");
        std::fs::create_dir_all(parts.join("msg_a")).unwrap();
        for i in 0..6 {
            std::fs::write(parts.join("msg_a").join(format!("p{i}.json")), "main Bash\n").unwrap();
        }
        let capped = Fake {
            sources: vec![Source::Tree { dir: parts.clone(), ext: "json".into(), cap: 4 }],
            capabilities: caps(true, false),
        };
        let roll = roll_with(&capped, "s1");
        assert_eq!(roll.calls, 4);
        assert_eq!(roll.truncated, Some(4));

        let whole = Fake {
            sources: vec![Source::Tree { dir: parts, ext: "json".into(), cap: 40 }],
            capabilities: caps(true, false),
        };
        let roll = roll_with(&whole, "s1");
        assert_eq!(roll.calls, 6);
        assert_eq!(roll.truncated, None);
    }

    #[test]
    fn a_cli_with_no_reader_is_told_apart_from_a_log_that_would_not_open() {
        let roll = roll_for(CliKind::Codex, "s1");
        assert_eq!(roll.unavailable, Some(Unavailable::NoReader));
        assert_eq!(roll.cli, CliKind::Codex);
        assert_eq!(roll.calls, 0);
    }
}
