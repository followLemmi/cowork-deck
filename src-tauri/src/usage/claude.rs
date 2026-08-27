//! Claude, as a usage provider: two windows, and up to three ways of knowing
//! anything about either.
//!
//! The order of preference is the whole design. For each window, the best
//! available **quantity** wins — a reported share over an observed token count —
//! and a refusal this app watched happen outranks both for the **state**, because
//! "you were turned away at 14:02 and it lifts at 16:00" is a harder fact than
//! any percentage and it is the one a person acts on.
//!
//! Nothing here ever produces a zero it would have to apologise for. A window
//! with a burn figure and no ceiling is `Unknown` with an absolute beside it, not
//! `Ok`: this app knows what it spent, not how much was allowed.

use crate::usage::model::{
    state_from_fraction, AiUsage, Amount, Detection, LimitState, LimitWindow, UsageCapabilities,
    UsageError, UsageSource, WindowSpec,
};
use crate::usage::provider::UsageProvider;
use crate::usage::{banner, observed, reported};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The caveat that goes under every observed number, in words, on screen.
/// One string so the two windows cannot drift into saying it differently.
const OBSERVED_CAVEAT: &str =
    "Counted from the transcripts of this deck's own sessions. Other terminals, \
     other machines and anything run outside this app are not in it, so the real \
     figure is higher.";

pub struct ClaudeUsage {
    /// Whether the reported source may be asked. A whole `claude` process every
    /// five minutes is a thing a person may reasonably refuse, and refusing it
    /// leaves this provider on `Observed` with the block still on screen — which
    /// is the capability flag #306 asked for, in the only form that lets somebody
    /// change their mind without a rebuild.
    reported: Arc<AtomicBool>,
}

impl ClaudeUsage {
    pub fn new(reported: Arc<AtomicBool>) -> ClaudeUsage {
        ClaudeUsage { reported }
    }
}

impl UsageProvider for ClaudeUsage {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn label(&self) -> &'static str {
        "Claude"
    }

    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            // Claude Code's own names for them, so the dialog reads the way
            // `/usage` reads. The weekly label is replaced per fetch when a
            // model-scoped week is the binding one.
            windows: vec![
                WindowSpec::new(banner::SESSION, "Current session"),
                WindowSpec::new(banner::WEEK, "Current week"),
            ],
            // The reported source asks the program that holds the credential
            // rather than reaching for the credential — the `gh.rs` move. So
            // nothing here needs one, and the screen does not offer to sign
            // anybody in.
            needs_credential: false,
            // A whole `claude` process answers this, in about four seconds. A
            // 5-hour window moves roughly 0.3% a minute, so five minutes of
            // staleness is invisible and a window left open all day costs 288
            // invocations of something that spends no quota.
            min_poll_secs: 300,
            // What a person can run to see the truth with their own eyes, in a
            // tile, when this provider has nothing to show. It is the same
            // command the reported source uses.
            probe_command: Some("claude -p \"/usage\"".to_string()),
        }
    }

    fn detect(&self) -> Detection {
        match crate::commands::which_claude() {
            Some(_) => Detection::Present { version: None },
            None => Detection::Absent,
        }
    }

    fn fetch(&self, now_ms: i64, deadline: Duration) -> Result<AiUsage, UsageError> {
        // Detection is cached by the registry for the run, so it can be stale by
        // the time this runs — an upgrade that moves the binary, an uninstall.
        // Saying "not found on this machine" is worth more than a row of
        // unexplained unknowns.
        if crate::commands::which_claude().is_none() {
            return Err(UsageError::NotDetected);
        }

        // Two subprocesses share one deadline, and the split is by cost: asking
        // who is signed in is a fast read, asking what is left starts a session.
        let auth_budget = deadline / 4;
        let auth = reported::ask_auth(auth_budget);

        // Not asked at all when the flag is down, and not asked when we have just
        // been told nobody is signed in — the second is not an optimisation, it
        // is the difference between a row that says "sign in" and four seconds
        // spent finding that out again.
        let signed_in = auth.as_ref().map(|a| a.logged_in).unwrap_or(true);
        let rep = if self.reported.load(Ordering::Relaxed) && signed_in {
            reported::ask_usage(deadline - auth_budget)
        } else {
            None
        };

        // One pass over every transcript, before the windows are built: it fills
        // both burn figures and records a refusal if a transcript holds one, so
        // the windows below see it. Skipped entirely when the reported source
        // answered both windows — there is no burn figure to show then, and
        // reading a dozen files to discard the result is the kind of work a
        // screen refreshing every five minutes should not do.
        let need_burn = rep.as_ref().is_none_or(|r| r.session.is_none() || r.week.is_none());
        let burn = if need_burn { observed::scan(now_ms) } else { observed::Burn::default() };

        let mut windows = Vec::new();
        windows.push(window(
            banner::SESSION,
            "Current session",
            rep.as_ref().and_then(|r| r.session.clone()),
            None,
            now_ms,
            burn.session,
        ));
        windows.push(window(
            banner::WEEK,
            "Current week",
            rep.as_ref().and_then(|r| r.week.clone()),
            rep.as_ref()
                .filter(|r| r.model_scoped)
                .map(|_| "This is a model-scoped weekly limit, which is the one binding first."),
            now_ms,
            burn.week,
        ));

        let mut snap = AiUsage::from_windows(self.id(), self.label(), windows, now_ms);
        if let Some(a) = &auth {
            snap.account = a.account.clone();
            snap.plan = a.plan.clone();
            if !a.logged_in {
                // An error rather than a silent unknown, because this one has an
                // answer a person can act on in ten seconds.
                snap.error = Some("not signed in — run `claude auth login`".to_string());
            }
        }
        Ok(snap)
    }
}

/// One window, from the best of what is known about it.
///
/// The three-way preference, in one place so the two windows cannot disagree:
///
/// 1. a **refusal** this app watched, which sets the state and can supply a reset
///    time — whatever tier the number beside it is on;
/// 2. a **reported** share, which is the quantity when there is one;
/// 3. an **observed** burn, which is an absolute with no ceiling, and therefore
///    leaves the state `Unknown` rather than claiming `Ok`.
fn window(
    id: &str,
    label: &str,
    rep: Option<reported::ReportedWindow>,
    extra_note: Option<&str>,
    now_ms: i64,
    // `burn` is what this deck spent in this window, already counted: passed in
    // rather than read here, so one pass over the transcripts serves both.
    burn: u64,
) -> LimitWindow {
    let refusal = observed::for_window(now_ms, "claude", id);
    let mut notes: Vec<String> = Vec::new();

    let (label, used_fraction, amount, source, mut resets_at) = match &rep {
        Some(r) => (
            // The provider's own words for this window, which for a
            // model-scoped week is the only place the model's name appears.
            r.label.clone(),
            Some(r.used_fraction),
            None,
            UsageSource::Reported,
            reported::resolve(r.reset_text.as_deref()),
        ),
        None => {
            notes.push(OBSERVED_CAVEAT.to_string());
            (
                label.to_string(),
                None,
                // Zero is a real reading here, not a missing one: it means no
                // session of this deck has spent anything in the window. The
                // `Unknown` state below is what stops it reading as "you are
                // fine".
                Some(Amount { used: burn, limit: None, unit: "tokens".to_string() }),
                UsageSource::Observed,
                None,
            )
        }
    };

    let state = match (&refusal, used_fraction) {
        (Some(_), _) => LimitState::Exhausted,
        (None, Some(f)) => state_from_fraction(f),
        // A numerator with no denominator. Saying `Ok` here would be this app
        // vouching for something it cannot see.
        (None, None) => LimitState::Unknown,
    };

    if let Some(r) = &refusal {
        // The reported reset time wins when there is one — it is the provider's
        // own, where the observed one came out of prose on a terminal.
        resets_at = resets_at.or(r.resets_at);
        notes.push(match (&r.window, &r.text) {
            (None, Some(t)) => format!(
                "A session was refused and Claude Code did not say which window, \
                 so it is shown against every one: \u{201c}{t}\u{201d}"
            ),
            (_, Some(t)) => format!("A session was refused: \u{201c}{t}\u{201d}"),
            (_, None) => "A session of this deck was refused by this limit.".to_string(),
        });
        if r.resets_at.is_none() && resets_at.is_none() {
            notes.push(
                "Claude Code did not say when it lifts, or said it in words this app \
                 does not parse — so no time is shown rather than a guessed one."
                    .to_string(),
            );
        }
    }
    if let Some(extra) = extra_note {
        notes.push(extra.to_string());
    }

    LimitWindow {
        id: id.to_string(),
        label,
        used_fraction,
        amount,
        resets_at,
        state,
        source,
        note: (!notes.is_empty()).then(|| notes.join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::reported::ReportedWindow;

    const NOW: i64 = 1_772_000_000_000;

    /// The same process-wide state `observed`'s own tests share, and the same
    /// lock: these tests write refusals into it, so they cannot run beside the
    /// tests that clear it.
    ///
    /// Taken **once** per test and held to the end. Calling it twice in one test
    /// is a deadlock, which is why no test tidies up after itself: the next
    /// test's own call is the tidying.
    fn clean() -> std::sync::MutexGuard<'static, ()> {
        let g = observed::tests::guard();
        observed::clear("claude");
        g
    }

    fn rep(pct: f32) -> Option<ReportedWindow> {
        Some(ReportedWindow {
            label: "Current session".to_string(),
            used_fraction: pct,
            reset_text: Some("4pm".to_string()),
        })
    }

    #[test]
    fn a_reported_share_is_the_quantity_and_carries_its_own_tier() {
        let _g = clean();
        let w = window(banner::SESSION, "Current session", rep(0.23), None, NOW, 0);
        assert_eq!(w.source, UsageSource::Reported);
        assert_eq!(w.used_fraction, Some(0.23));
        assert_eq!(w.amount, None);
        assert_eq!(w.state, LimitState::Ok);
        assert!(w.resets_at.is_some());
    }

    #[test]
    fn a_reported_share_past_the_threshold_is_near_but_never_exhausted() {
        let _g = clean();
        let w = window(banner::SESSION, "Current session", rep(0.97), None, NOW, 0);
        assert_eq!(w.state, LimitState::Near);
    }

    /// The rule the whole module turns on: no ceiling, no `Ok`.
    #[test]
    fn an_observed_burn_leaves_the_state_unknown_rather_than_claiming_ok() {
        let _g = clean();
        let w = window(banner::SESSION, "Current session", None, None, NOW, 1_250_000);
        assert_eq!(w.source, UsageSource::Observed);
        assert_eq!(w.used_fraction, None);
        assert_eq!(w.state, LimitState::Unknown);
        let amount = w.amount.as_ref().unwrap();
        assert_eq!(amount.used, 1_250_000);
        assert_eq!(amount.limit, None, "a numerator with no denominator");
        assert_eq!(amount.unit, "tokens");
        assert!(w.note.unwrap().contains("Other terminals"));
    }

    /// A refusal outranks a comfortable reported share, and the note says which
    /// refusal it was — the number stays labelled `Reported`, because the number
    /// still is.
    #[test]
    fn a_watched_refusal_outranks_a_reported_share_without_relabelling_it() {
        let _g = clean();
        observed::note_output(
            "t-claude-1",
            b"You've hit your 5-hour limit \xc2\xb7 resets 4pm\r\n",
            NOW,
        );
        let w = window(banner::SESSION, "Current session", rep(0.42), None, NOW, 0);
        assert_eq!(w.state, LimitState::Exhausted);
        assert_eq!(w.source, UsageSource::Reported, "the share is still the provider's");
        assert_eq!(w.used_fraction, Some(0.42));
        assert!(w.note.unwrap().contains("was refused"));
    }

    #[test]
    fn a_model_scoped_weekly_window_says_so_and_keeps_its_own_label() {
        let _g = clean();
        let scoped = Some(ReportedWindow {
            label: "Current week (Opus)".to_string(),
            used_fraction: 0.91,
            reset_text: None,
        });
        let w = window(
            banner::WEEK,
            "Current week",
            scoped,
            Some("This is a model-scoped weekly limit, which is the one binding first."),
            NOW,
            0,
        );
        assert_eq!(w.label, "Current week (Opus)");
        assert!(w.note.unwrap().contains("model-scoped"));
    }

    /// A refusal with no parseable reset says so in words instead of showing a
    /// time nobody printed.
    #[test]
    fn a_refusal_with_no_reset_time_explains_the_absence() {
        let _g = clean();
        observed::note_output(
            "t-claude-2",
            b"You've hit your 5-hour limit, resets sometime later\r\n",
            NOW,
        );
        let w = window(banner::SESSION, "Current session", None, None, NOW, 0);
        assert_eq!(w.state, LimitState::Exhausted);
        assert_eq!(w.resets_at, None);
        assert!(w.note.unwrap().contains("does not parse"));
    }

    #[test]
    fn the_declared_windows_are_the_two_the_epic_names() {
        let caps = ClaudeUsage::new(Arc::new(AtomicBool::new(true))).capabilities();
        let ids: Vec<&str> = caps.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["session", "week"]);
        assert!(!caps.needs_credential, "the credential belongs to claude, not to this app");
        assert!(caps.probe_command.is_some(), "an unknown row has to offer an answer");
    }
}
