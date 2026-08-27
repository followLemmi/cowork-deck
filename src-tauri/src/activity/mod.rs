//! What a session did: which tools it ran, through which agents, how many times.
//!
//! The one decision the rest of this module follows from: **activity is read
//! from the agent's own log, never from the hooks the deck installs.** The hooks
//! are already there and `hooks.rs` maps `PreToolUse` to `working`, so the
//! reporter is a few lines from carrying `tool_name` — and it would still be the
//! wrong source. It counts only what the deck watched, so `--resume` and the
//! restart button both leave the tally at zero for a conversation with hundreds
//! of calls behind it; `PreToolUse` fires *before* the call, so a refusal would
//! be counted as a call that ran; and no CLI but Claude Code offers that API.
//!
//! A log reader is retrospective. Open the panel on a session resumed from last
//! week and the numbers are already there. See `docs/adr/` for the record.

pub mod claude;
pub mod copilot;
pub mod model;
pub mod opencode;
pub mod reader;
pub mod registry;

use model::{ActivityRoll, CliKind};

/// What each of these sessions did.
///
/// Two contracts, both taken verbatim from `session_snapshots`, which reads the
/// same bytes for a different question:
///
/// - **`spawn_blocking` per session, then join**, so the worst case is
///   max-of-N rather than sum-of-N.
/// - **Every requested id gets an entry.** `tsconfig.json` has `strict` but not
///   `noUncheckedIndexedAccess`, so a dropped key is typed as present on the TS
///   side and becomes a runtime `undefined` with no compile error at the call
///   site. A session with no log gets a roll with `unavailable` set.
///
/// Which CLI each session runs comes off the stored layout, read **once** before
/// any of the reads start — one store read per invocation rather than per
/// session, with the lock released before the file I/O begins. A session the
/// layout has not caught up with is `Claude`, which is what every session in
/// every stored layout is until the deck can launch anything else.
///
/// **This must not ride the five-second poll.** See `registry::roll_for`.
#[tauri::command(async)]
pub async fn session_activity(
    state: tauri::State<'_, crate::commands::AppState>,
    session_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, ActivityRoll>, String> {
    let kinds = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        cli_kinds(&store.layout())
    };

    let jobs: Vec<_> = session_ids
        .into_iter()
        .map(|id| {
            let cli = kinds.get(&id).copied().unwrap_or_default();
            tokio::task::spawn_blocking(move || {
                let roll = registry::roll_for(cli, &id);
                (id, roll)
            })
        })
        .collect();
    let mut out = std::collections::HashMap::new();
    for job in jobs {
        if let Ok((id, roll)) = job.await {
            out.insert(id, roll);
        }
    }
    Ok(out)
}

/// Every session in a layout, by the CLI it runs.
///
/// Split out so the one rule with something to get wrong is testable without a
/// store: **an entry with no `cliKind`, or one naming a CLI this build has never
/// heard of, is `Claude`.** The first is every layout written before the field
/// existed; the second is a layout written by a newer version, and dropping the
/// tile over it would be worse than reading it as the only CLI the deck has ever
/// launched.
fn cli_kinds(layout: &[crate::model::SessionEntry]) -> std::collections::HashMap<String, CliKind> {
    layout
        .iter()
        .map(|e| {
            let cli = e.cli_kind.as_deref().map(CliKind::parse).unwrap_or_default();
            (e.session_id.clone(), cli)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionEntry;

    fn entry(session: &str, cli: Option<&str>) -> SessionEntry {
        SessionEntry {
            session_id: session.into(),
            cwd: "/p".into(),
            name: session.into(),
            workspace_id: None,
            task_id: None,
            scheduled_skill_id: None,
            user_name: None,
            name_kind: None,
            skill_id: None,
            run_id: None,
            owner: None,
            cli_kind: cli.map(Into::into),
        }
    }

    #[test]
    fn an_entry_with_no_kind_is_claude() {
        let kinds = cli_kinds(&[entry("s1", None)]);
        assert_eq!(kinds["s1"], CliKind::Claude);
    }

    #[test]
    fn an_entry_naming_a_cli_this_build_never_heard_of_is_claude_rather_than_dropped() {
        let kinds = cli_kinds(&[entry("s1", Some("some-cli-from-2027"))]);
        assert_eq!(kinds["s1"], CliKind::Claude, "an unrecognised CLI is a session the deck can still show");
    }

    #[test]
    fn every_recorded_kind_reads_back() {
        let layout = [
            entry("s1", Some("claude")),
            entry("s2", Some("copilot")),
            entry("s3", Some("opencode")),
            entry("s4", Some("codex")),
            // Case and stray whitespace are what a hand-edited file looks like.
            entry("s5", Some("  Copilot  ")),
        ];
        let kinds = cli_kinds(&layout);
        assert_eq!(kinds["s1"], CliKind::Claude);
        assert_eq!(kinds["s2"], CliKind::Copilot);
        assert_eq!(kinds["s3"], CliKind::Opencode);
        assert_eq!(kinds["s4"], CliKind::Codex);
        assert_eq!(kinds["s5"], CliKind::Copilot);
    }

    /// The dispatch, end to end and without a store: a kind with no reader gets
    /// `NoReader`, and not the Claude reader pointed at a path that will never
    /// exist.
    #[test]
    fn a_kind_with_no_reader_is_told_so_rather_than_read_as_claude() {
        let roll = registry::roll_for(CliKind::Codex, "s1");
        assert_eq!(roll.cli, CliKind::Codex);
        assert_eq!(roll.unavailable, Some(model::Unavailable::NoReader));
    }
}
