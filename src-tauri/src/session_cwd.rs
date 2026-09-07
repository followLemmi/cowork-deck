//! Where each session is working now, as opposed to where it was launched.
//!
//! A tile records the directory it asked for at construction (`workspacePath`)
//! and used to read that value forever: the git badge, the tools panel's scope
//! line, its file list, its diff and its reveal all described the *launch*
//! directory, whatever the session had done since (#508). This module is the
//! other answer — the one that comes from the session rather than from the app's
//! own memory of what it asked for.
//!
//! # Two sources, and why there are exactly two
//!
//! **A Claude Code hook's `cwd`.** Every hook payload carries it, and the
//! reporter is invoked with *this app's* session id in argv — so each event says
//! "session X is working in directory Y", needing no convention and no guess.
//! That is the source for an agent session, and it is recorded here.
//!
//! **The session leader's directory, read from the OS** — `PtyManager::cwd`.
//! For a session with no hooks to report anything: a command tile, and a shell
//! wherever one comes to have a display of its own. `commands::session_cwds` is
//! where the two are put in order.
//!
//! # What this does NOT do, measured rather than assumed
//!
//! **An agent session does not move, so its answer here is its launch
//! directory.** Claude Code pins its working directory: a `cd` in the agent's own
//! Bash tool is undone before the next call — observed directly, with a session
//! that ran `pwd`, `cd ../b && pwd`, `pwd` and reported `a`, `b`, `a`, printing
//! "Shell cwd was reset to …" in between. The hook's `cwd` was the launch
//! directory at all four events. So for a `claude` tile this says what
//! `workspacePath` says, and the value of recording it is not that it differs
//! today: it is that every display now reads the session's own answer, so the day
//! a session kind moves — a shell tile, another agent CLI, a Claude Code whose
//! `cd` sticks — the displays follow it instead of needing this bug filed again.
//!
//! **OSC 7 is not parsed, and that is a decision.** It is the accurate source for
//! a shell, and it asks the person to have configured their shell to emit it —
//! which this app does not control and cannot check. Reading the leader's
//! directory from the OS answers the same question for the same sessions without
//! asking anything of anybody's dotfiles, so OSC 7 would buy only the case where
//! that read is unavailable, which is Windows — where the pty layer has no
//! process-tree support either (see the header of `pty.rs`). It goes in here if
//! that changes.
//!
//! A process-wide map rather than a field on `AppState`, for the two reasons
//! `crate::transcripts` states beside it: the listener is started before
//! `AppState` is built, so the callback has nothing to write into; and the
//! command that reads it is async, where taking `State` would force a borrowed
//! lifetime for no gain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn dirs() -> &'static Mutex<HashMap<String, String>> {
    static DIRS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    DIRS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record what a hook just reported. Last one wins: a session is wherever it
/// most recently said it was.
///
/// A relative path is refused rather than stored. Nothing downstream could use
/// one — `git -C` would resolve it against the app's own directory, and
/// `reachable` refuses it outright — and storing it would displace the launch
/// path, which is the answer that at least names a real place.
pub fn record(session: &str, cwd: &str) {
    if session.is_empty() || !is_absolute(cwd) {
        return;
    }
    if let Ok(mut m) = dirs().lock() {
        m.insert(session.to_string(), cwd.to_string());
    }
}

/// The directory last reported for this session, if any has been.
pub fn get(session: &str) -> Option<String> {
    dirs().lock().ok()?.get(session).cloned()
}

/// Every session that has reported one, as a list. For `git_roots`, which has to
/// let through a path that no workspace root contains.
pub fn all() -> Vec<(String, String)> {
    match dirs().lock() {
        Ok(m) => m.iter().map(|(s, d)| (s.clone(), d.clone())).collect(),
        Err(_) => Vec::new(),
    }
}

/// Drop a closed session, beside [`crate::transcripts::forget`] — a tile that is
/// gone should not keep answering questions, and the next session to be given
/// this id is somewhere else entirely.
pub fn forget(session: &str) {
    if let Ok(mut m) = dirs().lock() {
        m.remove(session);
    }
}

/// Whether this is a path that could name a directory on this machine.
///
/// Deliberately not `Path::is_absolute`: this has to agree with what
/// `reachable::normalise` will do with the same string, and that refuses a
/// relative path on every platform rather than on the one it is compiled for. A
/// Windows-shaped path is absolute here even on a Linux build, because the
/// question is about the string and not about the host.
fn is_absolute(path: &str) -> bool {
    let p = path.trim();
    if p.is_empty() {
        return false;
    }
    // `/x`, and `\\host\share`.
    if p.starts_with('/') || p.starts_with('\\') {
        return true;
    }
    // `C:\x` or `C:/x`.
    let mut chars = p.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(c), Some(':'), Some('/' | '\\')) if c.is_ascii_alphabetic()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_directory_comes_back_and_the_newest_wins() {
        record("c-newest", "/p/deck");
        assert_eq!(get("c-newest").as_deref(), Some("/p/deck"));
        record("c-newest", "/p/deck-issue/508-a-bug");
        assert_eq!(get("c-newest").as_deref(), Some("/p/deck-issue/508-a-bug"));
    }

    #[test]
    fn an_unknown_session_has_no_directory() {
        assert_eq!(get("c-never-seen"), None);
    }

    /// Both halves have to be refused, and for different reasons: an empty id
    /// belongs to no session, and a path that is not absolute would displace the
    /// launch directory with something no caller could resolve.
    #[test]
    fn a_relative_or_empty_value_is_not_recorded() {
        record("c-relative", "src/app.ts");
        record("c-relative-dots", "../deck");
        record("c-blank", "   ");
        record("", "/p/deck");
        assert_eq!(get("c-relative"), None);
        assert_eq!(get("c-relative-dots"), None);
        assert_eq!(get("c-blank"), None);
        assert_eq!(get(""), None);
    }

    /// A Windows path is absolute on a Linux build too: this agrees with
    /// `reachable::normalise`, which is written the same way round.
    #[test]
    fn a_windows_path_is_absolute_on_every_build() {
        assert!(is_absolute(r"C:\Users\a\deck"));
        assert!(is_absolute("C:/Users/a/deck"));
        assert!(is_absolute(r"\\host\share\deck"));
        assert!(!is_absolute("C:"));
        assert!(!is_absolute("Cx/Users"));
    }

    #[test]
    fn a_forgotten_session_stops_answering() {
        record("c-forgotten", "/p/deck");
        forget("c-forgotten");
        assert_eq!(get("c-forgotten"), None);
    }

    #[test]
    fn every_recorded_session_is_listed() {
        record("c-listed-1", "/p/one");
        record("c-listed-2", "/p/two");
        let all = all();
        assert!(all.contains(&("c-listed-1".to_string(), "/p/one".to_string())));
        assert!(all.contains(&("c-listed-2".to_string(), "/p/two".to_string())));
    }
}
