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

pub mod model;
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
/// Which CLI each session runs is `Claude` for all of them, because that is what
/// every session in every stored layout is: `start_session` resolves `claude` and
/// nothing else. #327 puts a recorded kind on the session and this is where it
/// will be read; until then the dispatch has nothing to dispatch on, and saying
/// so here is better than a lookup that can only ever return one answer.
///
/// **This must not ride the five-second poll.** See `registry::roll_for`.
#[tauri::command(async)]
pub async fn session_activity(
    session_ids: Vec<String>,
) -> std::collections::HashMap<String, ActivityRoll> {
    let jobs: Vec<_> = session_ids
        .into_iter()
        .map(|id| {
            let cli = CliKind::default();
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
    out
}
