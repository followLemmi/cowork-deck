//! Who answers, how often they may be asked, and what happens when they do not
//! answer at all.
//!
//! Two rules here are not negotiable, and both were learned elsewhere in this
//! codebase rather than reasoned out here:
//!
//! - **Never on the paint tick.** `src/sessions.ts` polls every five seconds. A
//!   provider that spawns a process must not ride that, so this holds a TTL cache
//!   and answers from it — with a forced refresh on demand and on a limit signal.
//! - **Every probe is bounded**, as in `which.rs`. A provider that hangs must
//!   produce an error row at the deadline, not a frozen window; and one hanging
//!   provider must not cost the others their turn.
//!
//! The abandoned thread in `fetch_bounded` is the same trade `gh::token` makes:
//! a thread stuck on a subprocess is left to finish on its own, because waiting
//! for it is the freeze we are avoiding.

use crate::usage::model::{AiUsage, LimitWindow, UsageCapabilities, UsageError, UsageSource};
use crate::usage::provider::UsageProvider;
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// The floor under every provider's own `min_poll_secs`. Sixty seconds is the
/// number the poll tick makes necessary: at five seconds a provider would be
/// asked twelve times a minute by a loop that is redrawing a list of names.
pub const TTL_FLOOR_SECS: u64 = 60;

/// How long an *absent* provider stays absent before it is looked for again.
/// A successful detection is cached for the run — a program does not uninstall
/// itself while the app is open — but installing one mid-session is a thing
/// people do, which is the same reasoning `which.rs` gives for keeping its
/// discovery failures retryable.
const ABSENT_TTL_SECS: u64 = 300;

struct Cached {
    at: i64,
    snap: AiUsage,
}

pub struct Registry {
    providers: Vec<Arc<dyn UsageProvider>>,
    cache: Mutex<HashMap<String, Cached>>,
    /// `id -> (present, when it was probed)`. Present entries never expire.
    detected: Mutex<HashMap<String, (bool, i64)>>,
}

impl Registry {
    pub fn with(providers: Vec<Arc<dyn UsageProvider>>) -> Registry {
        Registry {
            providers,
            cache: Mutex::new(HashMap::new()),
            detected: Mutex::new(HashMap::new()),
        }
    }

    /// Every detected AI's limits, from the cache where the cache is still good.
    ///
    /// `force` is a person pressing "read again", or a limit banner having just
    /// gone past on a PTY — the two moments where a stale number is worse than a
    /// wait.
    pub fn snapshot(&self, now_ms: i64, force: bool, deadline: Duration) -> Vec<AiUsage> {
        let mut out = Vec::new();
        let mut jobs = Vec::new();

        for p in &self.providers {
            if !self.is_present(p.as_ref(), now_ms) {
                continue;
            }
            let caps = p.capabilities();
            if !force {
                if let Some(snap) = self.fresh(p.id(), now_ms, &caps) {
                    out.push(snap);
                    continue;
                }
            }
            jobs.push((Arc::clone(p), caps, fetch_bounded(Arc::clone(p), now_ms, deadline)));
        }

        // Every provider was started before any of them was waited on, so the
        // wall clock is the slowest one rather than the sum of all of them — and
        // one that never answers costs its own row, not the screen.
        let started = Instant::now();
        for (p, caps, rx) in jobs {
            let left = deadline.saturating_sub(started.elapsed());
            let snap = match rx.recv_timeout(left) {
                Ok(Ok(snap)) => normalise(snap, &caps, now_ms),
                Ok(Err(e)) => errored(p.as_ref(), &caps, now_ms, &e),
                Err(_) => errored(p.as_ref(), &caps, now_ms, &UsageError::Timeout),
            };
            // Errors are cached like answers. Without that, a provider that
            // hangs would be re-spawned on every snapshot, which is a slow leak
            // of processes behind a screen that is already saying "unknown".
            self.remember(p.id(), now_ms, &snap);
            out.push(snap);
        }
        out
    }

    /// Drop everything cached for one provider, so the next snapshot re-reads it.
    /// What a limit signal calls (#303): the app has just learned something the
    /// cache cannot know.
    pub fn invalidate(&self, provider: &str) {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(provider);
        }
    }

    fn fresh(&self, id: &str, now_ms: i64, caps: &UsageCapabilities) -> Option<AiUsage> {
        let ttl = ttl_ms(caps);
        let c = self.cache.lock().ok()?;
        let hit = c.get(id)?;
        // A clock that went backwards (a laptop waking, an NTP step) must not
        // pin a cache entry in the future forever: any negative age counts as
        // stale rather than as fresh.
        let age = now_ms - hit.at;
        (age >= 0 && age < ttl).then(|| hit.snap.clone())
    }

    fn remember(&self, id: &str, now_ms: i64, snap: &AiUsage) {
        if let Ok(mut c) = self.cache.lock() {
            c.insert(id.to_string(), Cached { at: now_ms, snap: snap.clone() });
        }
    }

    fn is_present(&self, p: &dyn UsageProvider, now_ms: i64) -> bool {
        if let Ok(d) = self.detected.lock() {
            if let Some((present, at)) = d.get(p.id()).copied() {
                if present {
                    return true;
                }
                let age = now_ms - at;
                if age >= 0 && age < ABSENT_TTL_SECS as i64 * 1000 {
                    return false;
                }
            }
        }
        let present = p.detect().is_present();
        if let Ok(mut d) = self.detected.lock() {
            d.insert(p.id().to_string(), (present, now_ms));
        }
        present
    }
}

fn ttl_ms(caps: &UsageCapabilities) -> i64 {
    caps.min_poll_secs.max(TTL_FLOOR_SECS) as i64 * 1000
}

/// Run one provider's `fetch` on a thread of its own and hand back the channel
/// to wait on. The thread is never joined: see the module note.
fn fetch_bounded(
    p: Arc<dyn UsageProvider>,
    now_ms: i64,
    deadline: Duration,
) -> mpsc::Receiver<Result<AiUsage, UsageError>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(p.fetch(now_ms, deadline));
    });
    rx
}

/// The snapshot a failed fetch becomes: every declared window `Unknown`, and one
/// sentence saying what happened. The block stays on screen — a screen that is
/// honest about knowing less is not a failed screen, and blanking it is how a
/// person ends up not knowing whether the feature exists.
fn errored(
    p: &dyn UsageProvider,
    caps: &UsageCapabilities,
    now_ms: i64,
    e: &UsageError,
) -> AiUsage {
    let mut snap = AiUsage::unknown(p.id(), p.label(), caps, now_ms);
    snap.error = Some(e.message());
    snap
}

/// Bring a provider's answer into line with what it declared.
///
/// Two things happen here and both are about the screen rather than about the
/// provider: a window the capabilities do not claim is dropped, so a provider
/// cannot quietly grow a row; and a declared window the provider left out is
/// padded with `Unknown`, so a partial answer reads as "we do not know about
/// that one" instead of the row simply not being there. The order is the
/// declared order, so the block does not reshuffle itself between reads.
fn normalise(snap: AiUsage, caps: &UsageCapabilities, now_ms: i64) -> AiUsage {
    let mut windows = Vec::with_capacity(caps.windows.len());
    for spec in &caps.windows {
        match snap.windows.iter().find(|w| w.id == spec.id) {
            Some(w) => windows.push(w.clone()),
            None => windows.push(LimitWindow::unknown(spec)),
        }
    }
    let source = windows.iter().map(|w| w.source).min().unwrap_or(UsageSource::Unknown);
    AiUsage { windows, source, fetched_at: now_ms, ..snap }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::model::{Detection, LimitState, WindowSpec};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        caps: UsageCapabilities,
        calls: AtomicUsize,
        answer: Box<dyn Fn(i64) -> Result<AiUsage, UsageError> + Send + Sync>,
        present: bool,
        sleep: Duration,
    }

    impl Fake {
        fn new(windows: Vec<WindowSpec>) -> Fake {
            Fake {
                caps: UsageCapabilities {
                    windows,
                    needs_credential: false,
                    min_poll_secs: 60,
                    probe_command: None,
                },
                calls: AtomicUsize::new(0),
                answer: Box::new(|_| Err(UsageError::Unsupported)),
                present: true,
                sleep: Duration::ZERO,
            }
        }
    }

    impl UsageProvider for Fake {
        fn id(&self) -> &'static str { "fake" }
        fn label(&self) -> &'static str { "Fake" }
        fn capabilities(&self) -> UsageCapabilities { self.caps.clone() }
        fn detect(&self) -> Detection {
            if self.present { Detection::Present { version: None } } else { Detection::Absent }
        }
        fn fetch(&self, now_ms: i64, _d: Duration) -> Result<AiUsage, UsageError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.sleep);
            (self.answer)(now_ms)
        }
    }

    /// A second provider id, so two fakes can sit in one registry.
    struct Other(Arc<Fake>);
    impl UsageProvider for Other {
        fn id(&self) -> &'static str { "other" }
        fn label(&self) -> &'static str { "Other" }
        fn capabilities(&self) -> UsageCapabilities { self.0.capabilities() }
        fn detect(&self) -> Detection { self.0.detect() }
        fn fetch(&self, n: i64, d: Duration) -> Result<AiUsage, UsageError> { self.0.fetch(n, d) }
    }

    fn win(id: &str, source: UsageSource) -> LimitWindow {
        let mut w = LimitWindow::unknown(&WindowSpec::new(id, id));
        w.source = source;
        w.used_fraction = Some(0.5);
        w.state = LimitState::Ok;
        w
    }

    fn spec(id: &str) -> WindowSpec { WindowSpec::new(id, id) }

    #[test]
    fn a_second_call_inside_the_ttl_does_not_re_enter_fetch_and_one_after_it_does() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("fake", "Fake", vec![win("session", UsageSource::Observed)], now))
            });
            f
        });
        let r = Registry::with(vec![f.clone()]);
        r.snapshot(0, false, Duration::from_secs(2));
        r.snapshot(30_000, false, Duration::from_secs(2));
        assert_eq!(f.calls.load(Ordering::SeqCst), 1, "the second read was inside the TTL");
        r.snapshot(61_000, false, Duration::from_secs(2));
        assert_eq!(f.calls.load(Ordering::SeqCst), 2, "the third read was past it");
    }

    #[test]
    fn a_forced_read_goes_past_the_cache() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("fake", "Fake", vec![win("session", UsageSource::Observed)], now))
            });
            f
        });
        let r = Registry::with(vec![f.clone()]);
        r.snapshot(0, false, Duration::from_secs(2));
        r.snapshot(1_000, true, Duration::from_secs(2));
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    /// The rule that keeps a provider from growing a row nobody declared, and
    /// the one that keeps a partial answer from losing one.
    #[test]
    fn a_window_the_capabilities_do_not_claim_never_appears_and_a_missing_one_is_padded() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session"), spec("week")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows(
                    "fake",
                    "Fake",
                    // One declared window, and one that was never declared.
                    vec![win("session", UsageSource::Reported), win("smuggled", UsageSource::Reported)],
                    now,
                ))
            });
            f
        });
        let snap = Registry::with(vec![f]).snapshot(0, false, Duration::from_secs(2));
        let ids: Vec<&str> = snap[0].windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["session", "week"]);
        assert_eq!(snap[0].windows[1].state, LimitState::Unknown);
        // And the padding drags the snapshot's own claim down with it, which is
        // the point of taking the minimum.
        assert_eq!(snap[0].source, UsageSource::Unknown);
    }

    #[test]
    fn a_provider_that_sleeps_past_its_deadline_errors_and_the_others_survive() {
        let slow = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.sleep = Duration::from_millis(600);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("fake", "Fake", vec![win("session", UsageSource::Reported)], now))
            });
            f
        });
        let quick = Arc::new(Other(Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("other", "Other", vec![win("session", UsageSource::Observed)], now))
            });
            f
        })));
        let r = Registry::with(vec![slow, quick]);
        let snap = r.snapshot(0, false, Duration::from_millis(150));
        assert_eq!(snap.len(), 2, "the snapshot still returned every detected provider");
        let slow_row = snap.iter().find(|s| s.provider == "fake").unwrap();
        assert_eq!(slow_row.error.as_deref(), Some("did not answer in time"));
        assert_eq!(slow_row.windows[0].state, LimitState::Unknown);
        let quick_row = snap.iter().find(|s| s.provider == "other").unwrap();
        assert_eq!(quick_row.windows[0].source, UsageSource::Observed);
        assert_eq!(quick_row.error, None);
    }

    #[test]
    fn an_absent_provider_is_absent_from_the_snapshot_rather_than_broken_in_it() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.present = false;
            f
        });
        assert!(Registry::with(vec![f]).snapshot(0, false, Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn a_failed_fetch_still_produces_a_row_carrying_its_reason() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|_| Err(UsageError::Failed("keyring is locked".into())));
            f
        });
        let snap = Registry::with(vec![f]).snapshot(0, false, Duration::from_secs(1));
        assert_eq!(snap[0].error.as_deref(), Some("keyring is locked"));
        assert_eq!(snap[0].source, UsageSource::Unknown);
    }

    #[test]
    fn an_invalidated_provider_is_read_again_inside_the_ttl() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("fake", "Fake", vec![win("session", UsageSource::Observed)], now))
            });
            f
        });
        let r = Registry::with(vec![f.clone()]);
        r.snapshot(0, false, Duration::from_secs(2));
        r.invalidate("fake");
        r.snapshot(1_000, false, Duration::from_secs(2));
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    /// A clock that steps backwards must not freeze the block on one reading for
    /// the rest of the run.
    #[test]
    fn a_cache_entry_stamped_in_the_future_is_stale_rather_than_eternal() {
        let f = Arc::new({
            let mut f = Fake::new(vec![spec("session")]);
            f.answer = Box::new(|now| {
                Ok(AiUsage::from_windows("fake", "Fake", vec![win("session", UsageSource::Observed)], now))
            });
            f
        });
        let r = Registry::with(vec![f.clone()]);
        r.snapshot(100_000, false, Duration::from_secs(2));
        r.snapshot(0, false, Duration::from_secs(2));
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }
}
