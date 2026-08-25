//! Which window owns which session, and the refusal a window that has lost one
//! gets back.
//!
//! The frontend cannot own this question, and no amount of discipline there
//! would make it able to. `write_session` and `resize_session` took a session id
//! and nothing else, and `AppState` is app-global — so any webview reached any
//! PTY. Worse than a race: both `PtyManager::write` and `PtyManager::resize`
//! answered `Ok(())` for a session they did not hold, so a stale caller got
//! silence and could never learn it was stale.
//!
//! Two concrete losses that only this layer can prevent, because the frontend is
//! the layer mid-transition:
//!
//! - A resize from the old window can be in flight across the IPC boundary when
//!   ownership changes. Nothing downstream looked at where it came from, so the
//!   child got a SIGWINCH for a geometry no visible window has, and Ink repainted
//!   at the wrong width.
//! - The old window's panels stay alive until it processes the change, and a
//!   keystroke in that gap was written into a session that window no longer
//!   renders.
//!
//! Deliberately a label compare and a map, nothing more. A lease or a
//! negotiation protocol was considered for the hand-off in #241 and rejected:
//! nothing here needs a lock beyond this one.

use std::collections::HashMap;
use std::sync::Mutex;

/// Why an operation on a session was refused.
///
/// Two cases and not one, because the frontend must do opposite things with
/// them. `NotOwner` means "this window is stale" — the answer is to dispose, not
/// to report. `NoSession` means the session is gone, which for a keystroke or a
/// resize arriving a moment after a close is ordinary and worth nothing louder
/// than a debug line. Both were `Ok(())` before, which is precisely why a stale
/// window could not detect itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotOwner,
    NoSession,
}

/// The wire form. These strings cross into TypeScript and are matched there, so
/// they are an interface: `src/ipc.ts` carries the same two literals and
/// `tests/session-refusal.test.ts` pins them.
pub const NOT_OWNER: &str = "not-owner";
pub const NO_SESSION: &str = "no-session";

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NotOwner => NOT_OWNER,
            Refusal::NoSession => NO_SESSION,
        }
    }
}

/// Session id to the label of the window that may write to it.
#[derive(Default)]
pub struct SessionOwners {
    owners: Mutex<HashMap<String, String>>,
}

impl SessionOwners {
    /// Record `label` as the owner of `session`, replacing whoever held it.
    ///
    /// Called where a session is spawned, and — from #241 — where one is claimed
    /// by the window it is moving to. Unconditional: the caller has already
    /// decided, and a claim that could silently fail would be a worse shape than
    /// one that cannot.
    pub fn claim(&self, session: &str, label: &str) {
        self.owners.lock().unwrap().insert(session.to_string(), label.to_string());
    }

    /// May `label` act on `session`?
    ///
    /// A session with no entry is `NoSession` rather than "unowned, help
    /// yourself": every spawn claims, so an id with no owner is one that was
    /// never started or has already been released.
    pub fn check(&self, session: &str, label: &str) -> Result<(), Refusal> {
        match self.owners.lock().unwrap().get(session) {
            None => Err(Refusal::NoSession),
            Some(owner) if owner == label => Ok(()),
            Some(_) => Err(Refusal::NotOwner),
        }
    }

    /// Forget one session, because it closed.
    pub fn release(&self, session: &str) {
        self.owners.lock().unwrap().remove(session);
    }

    /// Forget every session `label` owned, and say which they were.
    ///
    /// **This does not end them.** Closing a window returns its workspace and
    /// never kills a session — PTYs die on app exit only — so what happens here
    /// is that the sessions become unowned and wait to be re-homed (#245). A
    /// version of this that killed them would turn an accidental Cmd+W into lost
    /// work, which is the whole thing the epic's third invariant forbids.
    ///
    /// The returned ids are what a re-homing caller needs; a caller that only
    /// wants the clearing can ignore them.
    pub fn release_window(&self, label: &str) -> Vec<String> {
        let mut owners = self.owners.lock().unwrap();
        let gone: Vec<String> = owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == label)
            .map(|(session, _)| session.clone())
            .collect();
        for session in &gone {
            owners.remove(session);
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_that_started_a_session_may_write_to_it() {
        let owners = SessionOwners::default();
        owners.claim("s1", "main");
        assert_eq!(owners.check("s1", "main"), Ok(()));
    }

    /// The defect this exists for: any webview reached any PTY, and got `Ok(())`
    /// back whether or not it had any business there.
    #[test]
    fn a_window_that_does_not_own_a_session_is_refused() {
        let owners = SessionOwners::default();
        owners.claim("s1", "main");
        assert_eq!(owners.check("s1", "workspace-w1"), Err(Refusal::NotOwner));
    }

    /// Distinguishable from the refusal above, and that is the point of having
    /// two: one means "dispose, you are stale" and the other means "this is
    /// ordinary, say nothing".
    #[test]
    fn an_unknown_session_is_a_different_refusal_from_a_stale_window() {
        let owners = SessionOwners::default();
        assert_eq!(owners.check("s1", "main"), Err(Refusal::NoSession));
        assert_ne!(Refusal::NoSession, Refusal::NotOwner);
        assert_ne!(Refusal::NoSession.as_str(), Refusal::NotOwner.as_str());
    }

    /// The hand-off in #241: the receiving window becomes authoritative, and the
    /// window that had it is refused from that moment — which is what lets the
    /// source release last without a gap.
    #[test]
    fn a_claim_moves_the_session_and_the_previous_owner_is_refused_at_once() {
        let owners = SessionOwners::default();
        owners.claim("s1", "main");
        owners.claim("s1", "workspace-w1");
        assert_eq!(owners.check("s1", "workspace-w1"), Ok(()));
        assert_eq!(owners.check("s1", "main"), Err(Refusal::NotOwner));
    }

    #[test]
    fn closing_a_session_forgets_who_owned_it() {
        let owners = SessionOwners::default();
        owners.claim("s1", "main");
        owners.release("s1");
        assert_eq!(owners.check("s1", "main"), Err(Refusal::NoSession));
    }

    /// A destroyed window's sessions become unowned — not ended. Only that
    /// window's, and the ids come back so a re-homing caller knows what to take.
    #[test]
    fn a_destroyed_window_gives_up_its_sessions_and_only_its_own() {
        let owners = SessionOwners::default();
        owners.claim("s1", "workspace-w1");
        owners.claim("s2", "workspace-w1");
        owners.claim("s3", "main");

        let mut released = owners.release_window("workspace-w1");
        released.sort();
        assert_eq!(released, ["s1", "s2"]);

        assert_eq!(owners.check("s1", "workspace-w1"), Err(Refusal::NoSession));
        assert_eq!(owners.check("s3", "main"), Ok(()), "another window keeps its own");
    }

    /// Releasing a window that owns nothing is not an error and not a surprise:
    /// the pill owns no session and is destroyed like any other window.
    #[test]
    fn destroying_a_window_that_owns_nothing_takes_nothing() {
        let owners = SessionOwners::default();
        owners.claim("s1", "main");
        assert!(owners.release_window("pill").is_empty());
        assert_eq!(owners.check("s1", "main"), Ok(()));
    }
}
