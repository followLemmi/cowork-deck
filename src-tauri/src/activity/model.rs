//! What a session did, as a tally rather than a log.
//!
//! Nothing in this file knows the word Claude. Every name here is drawn from
//! three logs that were read — Claude Code's, the Copilot CLI's and opencode's —
//! rather than from what a CLI might plausibly write, and the fourth reader
//! exists to find out whether three was enough.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Which CLI a session runs.
///
/// `Claude` is the default everywhere a stored session predates the field, which
/// is every layout written before #327: `start_session` resolved `claude` and
/// nothing else, so a session with no recorded kind is a Claude session by
/// construction rather than by assumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CliKind {
    #[default]
    Claude,
    Copilot,
    Opencode,
    Codex,
}

impl CliKind {
    /// Parse a stored string, tolerantly. **An unrecognised name is `Claude`**,
    /// not a refusal: a layout entry naming a CLI this build has never heard of
    /// must still restore its tile, and the worst that follows is a panel saying
    /// there is no reader for it.
    pub fn parse(s: &str) -> CliKind {
        match s.trim().to_ascii_lowercase().as_str() {
            "copilot" => CliKind::Copilot,
            "opencode" => CliKind::Opencode,
            "codex" => CliKind::Codex,
            _ => CliKind::Claude,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CliKind::Claude => "claude",
            CliKind::Copilot => "copilot",
            CliKind::Opencode => "opencode",
            CliKind::Codex => "codex",
        }
    }
}

/// A lens over native tool names, never a rename of them.
///
/// A category is comparability across CLIs — codex's `shell` sits under `Run`
/// beside Claude Code's `Bash` — and it never becomes the label a row shows.
/// Renaming another tool's vocabulary would make the panel lie about the session
/// it is describing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolCategory {
    Run,
    Read,
    Edit,
    Search,
    Web,
    Mcp,
    Delegate,
    Task,
    Ask,
    Other,
}

/// One tool, as invoked by one agent, counted.
///
/// `errors` and `denials` are separate counters because they are different
/// events: a denied call never ran, and rolling it into a failure rate would
/// make a session that refused three commands look like a session that broke
/// three times. Measured across one project's transcripts the two do arrive on
/// the same line — a Claude Code denial is a `tool_result` with `is_error: true`
/// *and* a `toolDenialKind` beside it — so keeping them apart is a rule a reader
/// has to apply, not a distinction the log makes for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTally {
    /// The name the CLI itself used: `Bash`, `bash`, `shell`, `view`.
    pub native: String,
    pub category: ToolCategory,
    /// The MCP server, for a name shaped `mcp__<server>__<tool>`. `None` for
    /// every other name, and never invented for one.
    pub server: Option<String>,
    pub calls: u32,
    /// The call ran and came back an error.
    pub errors: u32,
    /// The call never ran.
    pub denials: u32,
}

impl ToolTally {
    pub fn new(native: &str, category: ToolCategory, server: Option<String>) -> ToolTally {
        ToolTally {
            native: native.to_string(),
            category,
            server,
            calls: 0,
            errors: 0,
            denials: 0,
        }
    }
}

/// Whether an agent is the conversation itself or something it delegated to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    Main,
    Subagent,
}

/// One agent's own calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTally {
    /// The main chain, or a subagent's file stem. Stable within one read, and
    /// the key the panel draws a row against.
    pub id: String,
    pub kind: AgentRole,
    /// `"Code Reviewer"`, where the log names it. `None` where it does not, or
    /// where the metadata beside the transcript would not parse — the calls
    /// survive the loss of the name.
    pub agent_type: Option<String>,
    pub description: Option<String>,
    /// 0 for the main chain.
    pub depth: u8,
    /// The tool-call id that started this agent, joining it to the delegation in
    /// its parent's chain.
    pub spawned_by: Option<String>,
    pub tools: Vec<ToolTally>,
    /// This agent's own calls, summed over `tools`.
    pub calls: u32,
}

impl AgentTally {
    pub fn main(id: &str) -> AgentTally {
        AgentTally {
            id: id.to_string(),
            kind: AgentRole::Main,
            agent_type: None,
            description: None,
            depth: 0,
            spawned_by: None,
            tools: Vec::new(),
            calls: 0,
        }
    }

    pub fn subagent(id: &str, depth: u8) -> AgentTally {
        AgentTally {
            id: id.to_string(),
            kind: AgentRole::Subagent,
            agent_type: None,
            description: None,
            depth,
            spawned_by: None,
            tools: Vec::new(),
            calls: 0,
        }
    }

    /// The row for `native`, created on first sight. Kept as a `Vec` rather than
    /// a map because the order matters at the end — the panel sorts by count,
    /// and a stable first-seen order is what makes a tie deterministic.
    pub fn tool(&mut self, native: &str, category: ToolCategory, server: Option<String>) -> &mut ToolTally {
        if let Some(i) = self.tools.iter().position(|t| t.native == native) {
            return &mut self.tools[i];
        }
        self.tools.push(ToolTally::new(native, category, server));
        let last = self.tools.len() - 1;
        &mut self.tools[last]
    }
}

/// Why there is nothing to read.
///
/// **`unavailable: Some(_)` is not `calls: 0`.** The first is "there is no log
/// for this session"; the second is "the log is here and the session has made no
/// calls". `SessionSnapshot` already draws this distinction for tokens and hides
/// the badge rather than rendering four zeroes, and the panel needs the same two
/// sentences from a field of its own — one number cannot carry both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    /// This CLI has no reader in this build.
    NoReader,
    /// The tile is not an agent session at all — a `command` tile never had a
    /// conversation and never will have a log. Decided by the caller that knows
    /// what a tile is, which is the frontend.
    NotAnAgent,
    /// A log was expected and there is none: never started, deleted underneath
    /// the session, or a session this deck did not launch and cannot join to one.
    NoLog,
    /// A path was found and would not open.
    Unreadable,
}

/// What a session did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRoll {
    pub cli: CliKind,
    /// Main chain first, then subagents.
    pub agents: Vec<AgentTally>,
    /// Every agent folded together. Recomputed from `agents` by [`ActivityRoll::finish`],
    /// never written by a reader, so the two lists cannot disagree.
    pub tools: Vec<ToolTally>,
    pub calls: u32,
    /// What this reader can tell apart, so the panel omits a column it would
    /// otherwise fill with zeroes that read as "nothing failed".
    pub capabilities: ReaderCapabilities,
    /// Unix seconds at which the log was read. The reading is retrospective and
    /// only as fresh as this.
    pub read_at: i64,
    /// Nothing to read. Distinct from a roll whose `calls` is 0.
    pub unavailable: Option<Unavailable>,
    /// The read stopped at this many files rather than walking a tree without
    /// end. `None` is "everything was read", which is every roll off a log that
    /// is one file. A tally that quietly stopped counting is worse than one that
    /// says it stopped, so this is reported rather than absorbed.
    pub truncated: Option<u32>,
}

/// What a reader can actually answer. Declared, never faked — in the manner of
/// `ProviderCapabilities` in `tasks/provider.rs`, where "not supported" is
/// answered by hiding the control rather than by failing at call time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderCapabilities {
    /// Whether this CLI's log distinguishes a failed call from a successful one.
    pub outcomes: bool,
    /// Whether it attributes delegated work to a named agent.
    pub agents: bool,
}

impl ActivityRoll {
    pub fn empty(cli: CliKind, capabilities: ReaderCapabilities) -> ActivityRoll {
        ActivityRoll {
            cli,
            agents: Vec::new(),
            tools: Vec::new(),
            calls: 0,
            capabilities,
            read_at: now(),
            unavailable: None,
            truncated: None,
        }
    }

    /// A roll that says why it is empty. Every field a reader would have filled
    /// stays empty, and `unavailable` is what the panel reads first.
    pub fn unavailable(cli: CliKind, why: Unavailable, capabilities: ReaderCapabilities) -> ActivityRoll {
        ActivityRoll {
            unavailable: Some(why),
            ..ActivityRoll::empty(cli, capabilities)
        }
    }

    /// The agent row for `id`, created on first sight.
    pub fn agent(&mut self, id: &str, role: AgentRole, depth: u8) -> &mut AgentTally {
        if let Some(i) = self.agents.iter().position(|a| a.id == id) {
            return &mut self.agents[i];
        }
        self.agents.push(match role {
            AgentRole::Main => AgentTally::main(id),
            AgentRole::Subagent => AgentTally::subagent(id, depth),
        });
        let last = self.agents.len() - 1;
        &mut self.agents[last]
    }

    /// Fold every agent's tools into one list and sum the totals.
    ///
    /// Called once, by the read loop, after every source has been folded. Readers
    /// fill `agents` and nothing else, which is what guarantees the by-tool list
    /// and the by-agent list agree on the total: there is one addition, in one
    /// place, and neither list is a second transcription of the numbers.
    ///
    /// Sorting is by calls descending, then by name, so a tie is stable rather
    /// than left to whichever agent happened to be read first.
    pub fn finish(&mut self) {
        // Main chain first, then subagents in the order they were found —
        // `sort_by_key` is stable, so a shallow agent never sinks below a deeper
        // one it did not spawn.
        self.agents.sort_by_key(|a| (a.kind == AgentRole::Subagent, a.depth));
        let mut folded: Vec<ToolTally> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut total = 0;
        for agent in &mut self.agents {
            agent.calls = agent.tools.iter().map(|t| t.calls).sum();
            total += agent.calls;
            for t in &agent.tools {
                match index.get(&t.native) {
                    Some(&i) => {
                        let row: &mut ToolTally = &mut folded[i];
                        row.calls += t.calls;
                        row.errors += t.errors;
                        row.denials += t.denials;
                    }
                    None => {
                        index.insert(t.native.clone(), folded.len());
                        folded.push(t.clone());
                    }
                }
            }
            agent.tools.sort_by(|a, b| b.calls.cmp(&a.calls).then(a.native.cmp(&b.native)));
        }
        folded.sort_by(|a, b| b.calls.cmp(&a.calls).then(a.native.cmp(&b.native)));
        self.tools = folded;
        self.calls = total;
    }
}

/// Where one part of a session's log is.
///
/// Two shapes, because two were measured and neither reduces to the other.
/// Claude Code and the Copilot CLI each answer with a file. opencode's log is
/// not a file at all: `storage/part/<messageID>/<partID>.json` is one JSON
/// document per part, discovered by walking and filtered on a `sessionID` that
/// is inside each document rather than in its name.
///
/// A `Tree` is expanded into `File`s by the read loop before any reader sees it,
/// so `ActivityReader::fold` only ever receives one buffer and the path it came
/// from. The cap lives here, on the answer to "where is the log", because it is
/// a property of that log's shape and not of the fold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// One file, read whole and folded once.
    File(PathBuf),
    /// Every `*.<ext>` under `dir`, one directory deep, folded one file at a
    /// time — at most `cap` of them.
    Tree { dir: PathBuf, ext: String, cap: usize },
}

impl Source {
    pub fn file(path: impl Into<PathBuf>) -> Source {
        Source::File(path.into())
    }
}

/// Unix seconds. One place, so a roll and its tests agree on what `read_at` is.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
