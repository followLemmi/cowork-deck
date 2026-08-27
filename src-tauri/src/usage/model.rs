//! What a limit IS, before anything knows whose limit it is.
//!
//! The unit here is not "a limit" but **a window that refills**, because that is
//! the one shape all three metering styles share: a subscription is metered on a
//! 5-hour session window and a weekly one, an API key on per-minute request and
//! token buckets, a free tier usually per day. One shape covers all three, and
//! nothing downstream has to learn which provider it is drawing.
//!
//! The other half of the shape is the part that is easy to leave out: **the
//! source of a number is part of the number** (ADR-0007). A percentage the
//! provider vouches for and a percentage this app inferred from watching its own
//! terminals are different claims, and printing them in the same typeface with no
//! label is the failure mode this module is designed against. So `UsageSource`
//! sits on every window rather than on the snapshot, and the snapshot's own
//! source is derived from its windows — never asserted beside them.

use serde::Serialize;

/// Where a number came from, worst to best. The ordering is load-bearing:
/// `AiUsage::from_windows` takes the **minimum** across a snapshot's windows, so
/// a snapshot can never advertise a tier that one of its own numbers does not
/// earn. See `derive(PartialOrd)` below and the note on that function.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSource {
    /// Nothing is known. Not "zero" — the distinction this whole module exists
    /// for.
    Unknown,
    /// This app worked it out from something adjacent, and says so.
    Estimated,
    /// This app can see it for itself, from the sessions it runs. Real, and
    /// narrower than the account: other terminals, other machines and subagents
    /// outside this app are not in it.
    Observed,
    /// The account's own accounting. What `/usage` draws.
    Reported,
}

/// How full a window is, in the only terms that change what a person does next.
///
/// Separate from `used_fraction` because a source can know it is exhausted
/// without knowing a share — which is precisely where the observed source lands
/// when a limit banner goes past on a PTY (#303).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LimitState {
    Ok,
    Near,
    Exhausted,
    Unknown,
}

/// The share at which a window stops being "fine" and starts being worth
/// knowing about. Not a round 0.9: at 0.9 of a 5-hour window there is rarely
/// time to change plan, and the whole point of showing the number is that there
/// is.
pub const NEAR_AT: f32 = 0.85;

/// `Ok` or `Near` from a share, and nothing else — `Exhausted` is a claim about
/// having been refused, not about arithmetic. A source at 1.0 has told us it
/// spent everything, which is not the same as having been turned away, and the
/// two read differently on screen for good reason.
pub fn state_from_fraction(f: f32) -> LimitState {
    if f >= NEAR_AT { LimitState::Near } else { LimitState::Ok }
}

/// Absolutes, where a source gives them. `limit: None` is the ordinary case for
/// an observed count: this app can add up what it spent without having any idea
/// what the ceiling is, and inventing a denominator to draw a nicer meter would
/// turn an observed number into an estimated one under an observed label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Amount {
    pub used: u64,
    pub limit: Option<u64>,
    pub unit: String,
}

/// One window that refills.
///
/// `used_fraction` and `amount` are both optional and both may be present: a
/// source that gives "62%" and one that gives "1.2M of 2M tokens" are equally
/// welcome, and a row renders from whichever it has.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// Stable across renders and versions — the UI keys rows on it.
    pub id: String,
    /// What to call it on screen. Taken from the provider's own vocabulary where
    /// it has one, so the dialog reads the same as the provider's own report.
    pub label: String,
    pub used_fraction: Option<f32>,
    pub amount: Option<Amount>,
    /// Epoch ms. `None` is legitimate and common: a window known to be spent
    /// whose reset time the provider did not say, or did not say parseably.
    pub resets_at: Option<i64>,
    pub state: LimitState,
    /// Where the **quantity** above came from — `used_fraction` and `amount`.
    /// One source per window, always: a window whose share is reported and whose
    /// absolutes are observed would be a row nobody could label truthfully, so a
    /// provider picks the better of the two and fills only that one's fields.
    ///
    /// `state` is deliberately outside this. "Refused at 14:02, resets 16:00" is
    /// not a quantity and can be known alongside a reported share — so an
    /// `Exhausted` window says which refusal it saw in `note`, whatever tier its
    /// number is on.
    pub source: UsageSource,
    /// The caveat, in words, for the dialog to print under the number. This is
    /// where "other terminals and other machines are not in this" lives — not in
    /// a tooltip and not in a commit message.
    pub note: Option<String>,
}

impl LimitWindow {
    /// A declared window nothing could say anything about. The shape every
    /// provider falls back to, and the reason the UI never has to draw a zero it
    /// would have to apologise for.
    pub fn unknown(spec: &WindowSpec) -> LimitWindow {
        LimitWindow {
            id: spec.id.clone(),
            label: spec.label.clone(),
            used_fraction: None,
            amount: None,
            resets_at: None,
            state: LimitState::Unknown,
            source: UsageSource::Unknown,
            note: None,
        }
    }
}

/// One connected AI, as of one moment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    /// The registry key — `"claude"`, `"gemini"`. Never printed.
    pub provider: String,
    /// What to print. Here rather than in a table on the frontend, because a
    /// provider name in `src/` is exactly the coupling #308 measures for.
    pub label: String,
    pub account: Option<String>,
    /// "Max 20x", "Pro", "API key", "team". Whatever the provider calls it.
    pub plan: Option<String>,
    pub windows: Vec<LimitWindow>,
    /// The **weakest** source among the windows below, so this field can never
    /// over-claim whatever anyone does with it. A row that prints one number
    /// prints that window's own source, not this.
    pub source: UsageSource,
    pub fetched_at: i64,
    /// Set when something went wrong that the person can act on. A provider that
    /// simply cannot answer is not an error — it is `Unknown` windows.
    pub error: Option<String>,
}

impl AiUsage {
    /// Build a snapshot and derive its source from the windows in it.
    ///
    /// The minimum rather than the maximum, and that is the whole argument of
    /// ADR-0007 compressed into one line: a snapshot is worth what its least
    /// trustworthy number is worth. Taking the maximum would let one reported
    /// window put a "Reported" badge over a row whose other number this app
    /// guessed from a terminal.
    pub fn from_windows(
        provider: &str,
        label: &str,
        windows: Vec<LimitWindow>,
        fetched_at: i64,
    ) -> AiUsage {
        let source = windows.iter().map(|w| w.source).min().unwrap_or(UsageSource::Unknown);
        AiUsage {
            provider: provider.to_string(),
            label: label.to_string(),
            account: None,
            plan: None,
            windows,
            source,
            fetched_at,
            error: None,
        }
    }

    /// Every declared window, all `Unknown`. What a detected provider that
    /// cannot answer looks like — and it is a screen, not a failure: the row is
    /// there, it says it does not know, and #304 gives it the action that would
    /// answer it.
    pub fn unknown(
        provider: &str,
        label: &str,
        caps: &UsageCapabilities,
        fetched_at: i64,
    ) -> AiUsage {
        let windows = caps.windows.iter().map(LimitWindow::unknown).collect();
        AiUsage::from_windows(provider, label, windows, fetched_at)
    }
}

/// A window a provider claims it can report, named before anything is known
/// about it. The registry renders the snapshot in this order and drops anything
/// not on this list, so a provider that starts returning a window it never
/// declared cannot quietly grow a row on the screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpec {
    pub id: String,
    pub label: String,
}

impl WindowSpec {
    pub fn new(id: &str, label: &str) -> WindowSpec {
        WindowSpec { id: id.to_string(), label: label.to_string() }
    }
}

/// What a provider can actually do. Declared, never faked — the discipline
/// `ProviderCapabilities` in `tasks/provider.rs` already applies to the board:
/// "not supported" is answered by hiding the control, never by failing at call
/// time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCapabilities {
    /// Every window this provider could ever report, in the order to draw them.
    pub windows: Vec<WindowSpec>,
    /// Whether answering needs a credential this app would have to reach for.
    /// On screen, because "we could tell you if you signed in" and "we cannot
    /// tell you" are different sentences.
    pub needs_credential: bool,
    /// The floor on how often `fetch` may run, in seconds. The registry enforces
    /// it; a provider that spawns a process to answer sets it high enough that a
    /// window left open all day costs nothing anyone would notice.
    pub min_poll_secs: u64,
    /// The command a person could run, in a tile, that would answer what this
    /// provider cannot. Here rather than on the frontend for the same reason as
    /// `label`: it is provider knowledge, and #308's acceptance criterion is that
    /// adding a provider changes nothing in `src/`.
    pub probe_command: Option<String>,
}

/// Whether this AI is on the machine at all. An absent provider is absent from
/// the snapshot — not a broken row — so the screen lists the AIs a person
/// actually has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detection {
    Absent,
    Present { version: Option<String> },
}

impl Detection {
    pub fn is_present(&self) -> bool {
        matches!(self, Detection::Present { .. })
    }
}

/// Why a `fetch` produced nothing. Distinguished rather than collapsed into a
/// string because the registry treats them differently: a timeout is a sentence
/// about this app's own deadline, and everything else is the provider's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageError {
    /// The provider is not on this machine after all — it was between the
    /// detection and the fetch.
    NotDetected,
    /// The deadline passed. The snapshot still returns; this row says so.
    Timeout,
    /// The provider can be asked, but not about this.
    Unsupported,
    Failed(String),
}

impl UsageError {
    /// One sentence, for `AiUsage::error` and therefore for the screen.
    pub fn message(&self) -> String {
        match self {
            UsageError::NotDetected => "not found on this machine".to_string(),
            UsageError::Timeout => "did not answer in time".to_string(),
            UsageError::Unsupported => "cannot report its limits".to_string(),
            UsageError::Failed(m) => m.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> UsageCapabilities {
        UsageCapabilities {
            windows: vec![WindowSpec::new("session", "Current session"), WindowSpec::new("week", "Current week")],
            needs_credential: false,
            min_poll_secs: 60,
            probe_command: None,
        }
    }

    /// The invariant the whole module is for: nothing known reads as `Unknown`,
    /// never as a zero anybody could mistake for "you have spent nothing".
    #[test]
    fn a_provider_that_knows_nothing_yields_unknown_and_never_a_zero() {
        let u = AiUsage::unknown("p", "P", &caps(), 1_000);
        assert_eq!(u.source, UsageSource::Unknown);
        assert_eq!(u.windows.len(), 2);
        for w in &u.windows {
            assert_eq!(w.state, LimitState::Unknown);
            assert_eq!(w.used_fraction, None);
            assert_eq!(w.amount, None);
            assert_eq!(w.source, UsageSource::Unknown);
        }
    }

    /// A snapshot is worth what its worst number is worth. One reported window
    /// beside an observed one is an observed snapshot.
    #[test]
    fn a_snapshots_source_is_the_weakest_of_its_windows() {
        let mut a = LimitWindow::unknown(&WindowSpec::new("session", "Current session"));
        a.source = UsageSource::Reported;
        let mut b = LimitWindow::unknown(&WindowSpec::new("week", "Current week"));
        b.source = UsageSource::Observed;
        let u = AiUsage::from_windows("p", "P", vec![a, b], 0);
        assert_eq!(u.source, UsageSource::Observed);
    }

    #[test]
    fn a_snapshot_with_no_windows_at_all_is_unknown_rather_than_reported() {
        // `min()` over an empty iterator has to fall the safe way round, and the
        // safe way is the one that claims least.
        assert_eq!(AiUsage::from_windows("p", "P", vec![], 0).source, UsageSource::Unknown);
    }

    /// Arithmetic never produces `Exhausted`: being spent and being refused are
    /// different facts, and only one of them means "nothing will move".
    #[test]
    fn a_share_can_reach_near_but_never_exhausted() {
        assert_eq!(state_from_fraction(0.0), LimitState::Ok);
        assert_eq!(state_from_fraction(0.84), LimitState::Ok);
        assert_eq!(state_from_fraction(NEAR_AT), LimitState::Near);
        assert_eq!(state_from_fraction(1.0), LimitState::Near);
    }

    #[test]
    fn source_order_puts_unknown_at_the_bottom_and_reported_at_the_top() {
        assert!(UsageSource::Unknown < UsageSource::Estimated);
        assert!(UsageSource::Estimated < UsageSource::Observed);
        assert!(UsageSource::Observed < UsageSource::Reported);
    }
}
