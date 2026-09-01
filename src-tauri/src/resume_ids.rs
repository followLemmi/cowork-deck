//! Which conversation each deck session is *in*, as against the one it was
//! launched with.
//!
//! The deck launches a session with an id of its own (`--session-id`) and knows
//! it by that id ever after: it is the PTY key, the `COWORK_SESSION` the
//! reporter carries in argv, and the key every hook event is attributed by.
//! Nothing here changes that.
//!
//! What `/clear` changes is the *conversation*. Claude Code mints a new session
//! id, opens a new transcript, and never writes to the launch id's file again —
//! measured in `docs/superpowers/spikes/2026-08-05-clear-and-the-pinned-session-id.md`
//! (#155). The launch id still names a real, resumable conversation, so
//! `claude --resume <launch-id>` does not fail: it succeeds and brings back the
//! conversation the person left, orphaning the one they were working in (#199).
//!
//! Every hook payload carries `session_id` — the current one — and the reporter
//! is invoked with the launch id in argv, so each event says exactly "tile X is
//! now conversation Y". This is where that is kept, and `start_session` resumes
//! what is here rather than the launch id.
//!
//! Only a *fork* is recorded: an id equal to the launch id says nothing the
//! caller does not already know, and keeping the map empty until a clear happens
//! is what lets `None` mean "this session is still in the conversation it was
//! launched with".
//!
//! A process-wide map, and in memory only, for the reasons
//! [`crate::transcripts`] beside it is: the listener is started before
//! `AppState` exists, so the callback has nothing to write into. It follows that
//! this map is empty for the whole of a restored tile's life until its first
//! hook arrives — which is exactly why the id is *also* persisted in the deck
//! layout (`SessionEntry::resume_id`), the only copy that survives a restart.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn ids() -> &'static Mutex<HashMap<String, String>> {
    static IDS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record what a hook just reported for a deck session. Last one wins: a session
/// moves forward through `/clear`, never back — the same rule
/// [`crate::transcripts::record`] follows, and for the same reason.
///
/// `reported == launch` is not recorded. That is the ordinary case, and an entry
/// for it would make "has this session been cleared" unanswerable.
pub fn record(launch: &str, reported: &str) {
    if launch.is_empty() || reported.is_empty() || launch == reported {
        return;
    }
    if let Ok(mut m) = ids().lock() {
        m.insert(launch.to_string(), reported.to_string());
    }
}

/// The conversation this deck session is in now, if a hook has reported one
/// other than its launch id.
pub fn get(launch: &str) -> Option<String> {
    ids().lock().ok()?.get(launch).cloned()
}

/// Drop a closed session, beside [`crate::transcripts::forget`] — a tile that is
/// gone should not keep answering questions, least of all about which
/// conversation to resume.
pub fn forget(launch: &str) {
    if let Ok(mut m) = ids().lock() {
        m.remove(launch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fork_is_recorded_and_the_newest_wins() {
        record("r-fork", "cleared-once");
        assert_eq!(get("r-fork").as_deref(), Some("cleared-once"));
        // A second /clear in the same session.
        record("r-fork", "cleared-twice");
        assert_eq!(get("r-fork").as_deref(), Some("cleared-twice"));
    }

    /// The ordinary case: every hook of an uncleared session reports the id the
    /// deck launched it with. Recording that would leave every session looking
    /// forked, and `None` is what tells `start_session` there is nothing to
    /// prefer over the launch id.
    #[test]
    fn a_session_reporting_its_own_launch_id_is_not_recorded() {
        record("r-same", "r-same");
        assert_eq!(get("r-same"), None);
    }

    #[test]
    fn an_unknown_session_has_no_id() {
        assert_eq!(get("r-never-seen"), None);
    }

    #[test]
    fn empty_values_are_not_recorded() {
        record("r-empty", "");
        record("", "cleared");
        assert_eq!(get("r-empty"), None);
        assert_eq!(get(""), None);
    }

    #[test]
    fn a_forgotten_session_stops_answering() {
        record("r-forgotten", "cleared");
        forget("r-forgotten");
        assert_eq!(get("r-forgotten"), None);
    }
}
