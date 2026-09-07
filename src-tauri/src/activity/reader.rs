//! The contract every CLI's log reader satisfies, and the two rules that are the
//! same whatever the log looks like.

use super::model::{ActivityRoll, CliKind, ReaderCapabilities, Source, ToolCategory};
use std::path::Path;

pub trait ActivityReader: Send + Sync {
    fn cli(&self) -> CliKind;

    fn capabilities(&self) -> ReaderCapabilities;

    /// Where this session's logs are *now* — the main chain plus any delegated
    /// ones — or nothing, which is ordinary rather than an error.
    ///
    /// Separate from [`ActivityReader::fold`] for the reason `current_transcript`
    /// exists in `commands.rs`: where a session's log lives is a question with an
    /// answer of its own that moves under the app — `/clear` mints a new Claude
    /// Code transcript mid-session — and it has to be re-asked on every read
    /// rather than resolved once and remembered.
    fn sources(&self, session: &str) -> Vec<Source>;

    /// Fold one source's buffer into the roll.
    ///
    /// `path` is the file the buffer came from, which a reader needs where the
    /// filename carries information the contents do not — Claude Code names a
    /// subagent by its file stem. A `Source::Tree` never reaches here: the read
    /// loop expands it into the files it names first.
    fn fold(&self, path: &Path, buf: &str, roll: &mut ActivityRoll);
}

/// The MCP server in a tool name, for a name shaped `mcp__<server>__<tool>`.
///
/// The one naming rule that is not a CLI's own vocabulary, so it lives here
/// rather than in a reader. Measured over one project's transcripts, 13 of 26
/// distinct tool names were MCP across just two servers — which is why the panel
/// groups by server at all, and why the split has to survive into the tally
/// rather than be recovered from the name later.
///
/// Returns `None` for a name that is not MCP-shaped, and for one that is shaped
/// like it but names nothing: `mcp____x` has an empty server, and an empty
/// string is not a server name.
pub fn mcp_server(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some(server)
}

/// The category and server for one native name, given the CLI's own map.
///
/// The MCP rule comes first and wins: `mcp__gitnexus__impact` is `Mcp`, whatever
/// a per-CLI map might say about a name that begins with `mcp`. Everything the
/// map does not know is `Other` — **and is still counted, still under its own
/// name**. New tools ship regularly, and a tally that is wrong is a worse failure
/// than a category that is vague.
pub fn classify(name: &str, map: fn(&str) -> Option<ToolCategory>) -> (ToolCategory, Option<String>) {
    if let Some(server) = mcp_server(name) {
        return (ToolCategory::Mcp, Some(server.to_string()));
    }
    (map(name).unwrap_or(ToolCategory::Other), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_mcp_name_yields_its_server() {
        assert_eq!(mcp_server("mcp__claude-in-chrome__computer"), Some("claude-in-chrome"));
        assert_eq!(mcp_server("mcp__gitnexus__impact"), Some("gitnexus"));
    }

    #[test]
    fn a_name_that_is_not_mcp_never_acquires_a_server() {
        assert_eq!(mcp_server("Bash"), None);
        assert_eq!(mcp_server("mcp_not_really"), None);
        assert_eq!(mcp_server("mcp__nosecondseparator"), None);
        assert_eq!(mcp_server("mcp____empty"), None);
        assert_eq!(mcp_server("mcp__server__"), None);
    }

    #[test]
    fn a_server_name_may_carry_the_separator_in_its_tool_half() {
        // `mcp__claude_ai_Microsoft_365__chat_message_search` is a measured name.
        // The split is on the FIRST `__`, so the server is everything up to it.
        assert_eq!(
            mcp_server("mcp__claude_ai_Microsoft_365__chat_message_search"),
            Some("claude_ai_Microsoft_365"),
        );
    }

    fn demo_map(name: &str) -> Option<ToolCategory> {
        match name {
            "Bash" => Some(ToolCategory::Run),
            _ => None,
        }
    }

    #[test]
    fn the_mcp_rule_outranks_the_per_cli_map() {
        let (cat, server) = classify("mcp__gitnexus__impact", demo_map);
        assert_eq!(cat, ToolCategory::Mcp);
        assert_eq!(server.as_deref(), Some("gitnexus"));
    }

    #[test]
    fn an_unknown_name_is_other_and_keeps_no_server() {
        let (cat, server) = classify("SomethingShippedLastWeek", demo_map);
        assert_eq!(cat, ToolCategory::Other);
        assert_eq!(server, None);
    }

    #[test]
    fn a_known_name_takes_its_category() {
        assert_eq!(classify("Bash", demo_map).0, ToolCategory::Run);
    }
}
