//! Gemini CLI, as the second provider — which is the only thing that finds out
//! whether the shape in `model.rs` was a shape or just Claude's code with extra
//! indirection (#308).
//!
//! It was picked because it differs from Claude on every axis on purpose:
//!
//! - **different windows.** Requests per minute and requests per day, not a
//!   5-hour token budget. `LimitWindow` carries both without a special case,
//!   because it was never about tokens: `Amount.unit` is a string and
//!   `used_fraction` is optional.
//! - **different credential.** Its own file (`~/.gemini/oauth_creds.json`), its
//!   own logged-out state, and — unlike Claude — no subprocess that will answer
//!   the question. `needs_credential` is therefore `true` here and `false` there,
//!   which is the first thing that would have needed a special case if
//!   capabilities had been a boolean.
//! - **no observed signal at all.** This app has never seen a Gemini quota
//!   message go past a PTY, and it does not launch Gemini sessions, so there is
//!   nothing to watch. Every window is honestly `Unknown`.
//!
//! That last point is the interesting one, and it is why this file is short. An
//! `Unknown` row that offers the command which would answer it is the row #304
//! specified, and getting one here took no new field, no new state and no branch
//! in `src/`. What the file does **not** contain is the proof: see the closing
//! comment on #308.

use crate::usage::model::{
    AiUsage, Detection, UsageCapabilities, UsageError, WindowSpec,
};
use crate::usage::provider::UsageProvider;
use std::time::Duration;

pub struct GeminiUsage;

impl UsageProvider for GeminiUsage {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn label(&self) -> &'static str {
        "Gemini"
    }

    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            // Gemini's own vocabulary, and neither of them is a token budget.
            windows: vec![
                WindowSpec::new("rpm", "Requests this minute"),
                WindowSpec::new("rpd", "Requests today"),
            ],
            // The honest answer, and the one that changes the screen: this app
            // would need Gemini's own credential to say anything, and it is not
            // going to take one. So the row explains itself instead of offering a
            // sign-in this app cannot honour.
            needs_credential: true,
            min_poll_secs: 300,
            // `/stats` is where a person sees their own session's request counts.
            probe_command: Some("gemini".to_string()),
        }
    }

    fn detect(&self) -> Detection {
        // Cached once found, like `CLAUDE_CACHE` in `commands.rs` and for the
        // same reason: discovery can end in a login shell, and a program does not
        // move while the app is open. A *failure* is not cached here — the
        // registry does that, and keeps it retryable, because installing a CLI
        // mid-session is a thing people do.
        static FOUND: std::sync::OnceLock<crate::which::Resolution> = std::sync::OnceLock::new();
        if FOUND.get().is_some() {
            return Detection::Present { version: None };
        }
        let names: &[&str] = if cfg!(windows) { &["gemini.cmd", "gemini"] } else { &["gemini"] };
        let mut candidates = crate::which::under_home(if cfg!(windows) {
            &[".volta\\bin\\gemini.exe", ".bun\\bin\\gemini.exe"]
        } else {
            &[".local/bin/gemini", ".npm-global/bin/gemini", ".volta/bin/gemini", ".bun/bin/gemini"]
        });
        if !cfg!(windows) {
            candidates.push("/opt/homebrew/bin/gemini".to_string());
            candidates.push("/usr/local/bin/gemini".to_string());
        }
        // Through the shared discovery, so an app launched from a launcher — with
        // the display session's minimal PATH rather than the login shell's —
        // finds it in the same three places it finds `claude` and `gh`.
        match crate::which::discover(names, &candidates, &crate::which::version_runs) {
            Some(r) => {
                let _ = FOUND.set(r);
                Detection::Present { version: None }
            }
            None => Detection::Absent,
        }
    }

    fn fetch(&self, now_ms: i64, _deadline: Duration) -> Result<AiUsage, UsageError> {
        // Nothing to read, and that is a state rather than a failure — so this
        // returns a snapshot rather than an `Err`. An `Err` would put "something
        // went wrong" on a row where nothing did.
        let caps = self.capabilities();
        let mut snap = AiUsage::unknown(self.id(), self.label(), &caps, now_ms);
        for w in &mut snap.windows {
            // The window's own fact, and nothing more. Where to look instead is
            // said once by the `needs_credential` hint the dialog already draws
            // — a sentence repeated per window read as three separate problems
            // on a two-window provider.
            w.note = Some(
                "Gemini CLI does not report what is left, and this app has never seen it \
                 say so on a terminal."
                    .to_string(),
            );
        }
        Ok(snap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::model::{LimitState, UsageSource};

    /// The pressure this provider was added to apply: two windows that are not a
    /// token budget, carried by the same struct, with no new field.
    #[test]
    fn its_windows_are_requests_rather_than_tokens_and_the_shape_holds() {
        let caps = GeminiUsage.capabilities();
        let ids: Vec<&str> = caps.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["rpm", "rpd"]);
        assert!(caps.needs_credential, "unlike Claude, which asks the program that holds one");
    }

    /// The row that must still be useful: it says it does not know, it says why,
    /// and it names what would answer it.
    #[test]
    fn every_window_is_honestly_unknown_and_says_why() {
        let snap = GeminiUsage.fetch(1_000, Duration::from_secs(1)).unwrap();
        assert_eq!(snap.source, UsageSource::Unknown);
        assert_eq!(snap.error, None, "not knowing is not an error");
        assert_eq!(snap.windows.len(), 2);
        for w in &snap.windows {
            assert_eq!(w.state, LimitState::Unknown);
            assert_eq!(w.used_fraction, None);
            assert!(w.note.as_ref().unwrap().contains("does not report"));
        }
        assert!(GeminiUsage.capabilities().probe_command.is_some());
    }
}
