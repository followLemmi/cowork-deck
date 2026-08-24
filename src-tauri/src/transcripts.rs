//! Where each deck session's transcript currently is.
//!
//! The deck names a session by the id it launched it with, and reads
//! `<launch-id>.jsonl`. That holds until someone types `/clear`: Claude Code
//! then mints a **new** session id, opens a new transcript, and never writes to
//! the old file again — so the tile's name and its token count freeze on the
//! conversation the person just left. That is measured behaviour, not a guess:
//! a `/clear` in a live session was observed writing a second `<new-id>.jsonl`
//! beside the first and leaving the first untouched from that moment on.
//!
//! Every Claude Code hook payload carries `transcript_path`, and the reporter is
//! invoked with **this app's** session id in argv, so each event says exactly
//! "tile X is now reading file Y". That binding needs no filename convention, no
//! id inside the file, and nothing from `~/.claude/sessions/`.
//!
//! A process-wide map rather than a field on `AppState`, for two reasons that
//! are about this program rather than about taste: the listener is started
//! before `AppState` is built (`main.rs`), so the callback has nothing to write
//! into; and `session_snapshots` is an async command, where taking `State` would
//! force a borrowed lifetime and a `Result` return for no gain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn paths() -> &'static Mutex<HashMap<String, String>> {
    static PATHS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record what a hook just reported. Last one wins: a session moves forward
/// through `/clear`, never back.
pub fn record(session: &str, path: &str) {
    if session.is_empty() || path.is_empty() {
        return;
    }
    if let Ok(mut m) = paths().lock() {
        m.insert(session.to_string(), path.to_string());
    }
}

/// The transcript last reported for this session, if any has been.
pub fn get(session: &str) -> Option<String> {
    paths().lock().ok()?.get(session).cloned()
}

/// Drop a closed session. Not a leak fix — one short string per session per app
/// run — but a tile that is gone should not keep answering questions.
pub fn forget(session: &str) {
    if let Ok(mut m) = paths().lock() {
        m.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_path_comes_back_and_the_newest_wins() {
        record("t-newest", "/a/one.jsonl");
        assert_eq!(get("t-newest").as_deref(), Some("/a/one.jsonl"));
        // What /clear looks like from here.
        record("t-newest", "/a/two.jsonl");
        assert_eq!(get("t-newest").as_deref(), Some("/a/two.jsonl"));
    }

    #[test]
    fn an_unknown_session_has_no_path() {
        assert_eq!(get("t-never-seen"), None);
    }

    #[test]
    fn empty_values_are_not_recorded() {
        record("t-empty", "");
        record("", "/a/one.jsonl");
        assert_eq!(get("t-empty"), None);
        assert_eq!(get(""), None);
    }

    #[test]
    fn a_forgotten_session_stops_answering() {
        record("t-forgotten", "/a/one.jsonl");
        forget("t-forgotten");
        assert_eq!(get("t-forgotten"), None);
    }
}
