//! What the deck can see for itself, with no credential and no network.
//!
//! Two signals, and they answer different questions:
//!
//! **a. Exhaustion, seen directly.** The app owns every session's PTY, so a limit
//! banner passes through it on its way to the screen. This yields `Exhausted`
//! and, when the prose parses, a reset time — the fact a person actually acts on.
//! It is worth more than any percentage.
//!
//! **b. Burn, accumulated.** The app already knows where each session's
//! transcript is and already tallies usage out of one (`commands::fold_usage_lines`).
//! Summing that over a rolling window says what this deck has spent.
//!
//! Both are `Observed`, and (b) is the weaker: subagents inside other terminals,
//! other machines, and anything run outside this app are not in it. (b) also
//! deliberately produces **no share**. The rolling sum is a numerator with no
//! denominator — nothing here knows what the ceiling is — and dividing by a
//! guessed ceiling would make an estimate wear an observed label, which is the
//! one thing ADR-0009 forbids. So the burn goes on screen as an absolute, with
//! the caveat in words beside it.

use crate::model::UsageExhaustion;
use crate::usage::banner::{self, SignalKind};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// How much of each session's recent output is kept to match against.
///
/// A banner is a couple of hundred bytes, and a redraw can split it across two
/// reads — so there has to be *some* buffer. 4 KB is about twenty lines of an
/// 80-column terminal, which is long enough to hold a banner split by anything a
/// redraw does and short enough that it cannot accumulate a match from two
/// unrelated screens ten minutes apart.
const TAIL: usize = 4096;

/// How long a refusal with no known reset time is believed for.
///
/// Something has to bound it: a record with no `resets_at` would otherwise say
/// "exhausted" for the rest of the app's life. Five hours is the shortest real
/// window, so this errs towards **forgetting too early** — which is the right
/// direction, and the same direction as everything else here: a miss sends
/// someone to look at a working deck, a false positive sends them away from one.
const ASSUMED_MS: i64 = 5 * 60 * 60 * 1000;

/// The two windows this app counts a rolling burn over. Here rather than in
/// `claude.rs` because the scan below needs both in one pass: a request inside
/// the five hours is also inside the week, and reading every transcript twice to
/// discover that would double the file I/O of every fetch.
pub const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
pub const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Raw bytes, not normalised text, and that is a performance decision rather
/// than a shortcut: this is appended to for **every batch of every session's
/// output**, so a build log scrolling past must not pay for a copy-and-lowercase
/// of itself. Normalising happens only once the buffer contains something worth
/// parsing — see `note_output`.
fn tails() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static T: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The cheap gate in front of the parser. `imit` rather than `limit` so it
/// matches whatever case the word arrives in, and a plain byte scan rather than a
/// regex because it runs on the PTY's own thread.
///
/// It can be defeated — an escape sequence landing *inside* the word "limit"
/// would hide it — and that is accepted: the cost is a missed banner, which is
/// the direction everything here errs in, and the reported source covers the same
/// ground properly.
fn worth_parsing(tail: &[u8]) -> bool {
    tail.windows(4).any(|w| w == b"imit")
}

fn seen() -> &'static Mutex<Vec<UsageExhaustion>> {
    static S: OnceLock<Mutex<Vec<UsageExhaustion>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

/// Where to persist. A path rather than a `Store`, and set once at startup: the
/// PTY callback that feeds `note_output` is built inside `start_session` and has
/// no route to `AppState`, so the alternative is threading a handle through the
/// pty layer for the sake of a write that happens a few times a day.
fn config_dir() -> &'static Mutex<Option<std::path::PathBuf>> {
    static D: OnceLock<Mutex<Option<std::path::PathBuf>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(None))
}

/// Point the persistence at the store's directory and load what is still true.
///
/// Called once from `main`, after the store exists. Records whose reset has
/// already passed are dropped on the way in rather than kept and filtered later:
/// the file is then self-cleaning, and an app left closed over a weekend does not
/// come back holding a week of dead records.
pub fn restore(dir: std::path::PathBuf, now_ms: i64) {
    let live: Vec<UsageExhaustion> = crate::store::Store::new(dir.clone())
        .usage_state()
        .into_iter()
        .filter(|e| !expired(e, now_ms))
        .collect();
    if let Ok(mut d) = config_dir().lock() {
        *d = Some(dir);
    }
    if let Ok(mut s) = seen().lock() {
        *s = live;
    }
    persist();
}

/// Has this record stopped being true?
fn expired(e: &UsageExhaustion, now_ms: i64) -> bool {
    match e.resets_at {
        Some(at) => now_ms >= at,
        None => now_ms - e.at >= ASSUMED_MS,
    }
}

/// A batch of one session's output, on its way to the screen.
///
/// Returns `true` when this batch is what taught the app something new — the
/// caller uses that to force a refresh rather than wait out the cache, because a
/// limit banner is precisely the moment a cached "you are fine" is a lie.
///
/// Cheap on the common path, which matters: this sits on the PTY's coalescer
/// thread, one call per batch per session. A buffer with nothing limit-shaped in
/// it costs an append and a byte scan, and never reaches the parser.
pub fn note_output(session: &str, bytes: &[u8], now_ms: i64) -> bool {
    let mut buf = match tails().lock() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let tail = buf.entry(session.to_string()).or_default();
    tail.extend_from_slice(bytes);
    // Trimmed from the left, so the *end* of the buffer — where a banner being
    // drawn right now is — always survives. A cut can land inside a multi-byte
    // glyph; the lossy decode below turns that into one replacement character at
    // the far left of a buffer nothing is matching against.
    if tail.len() > TAIL {
        let cut = tail.len() - TAIL;
        tail.drain(..cut);
    }
    if !worth_parsing(tail) {
        return false;
    }
    let text = banner::normalise(&String::from_utf8_lossy(tail));
    let Some(signal) = banner::find(&text) else { return false };
    if signal.kind != SignalKind::Exhausted {
        // An approaching warning is not recorded. It is a share without a
        // denominator we can check, it expires with no reset time to expire by,
        // and the reported source gives the same number properly. Matching it
        // earns the parser's keep in the tests and nothing else.
        return false;
    }
    // The banner has been read; drop the buffer so a redraw of the same screen
    // does not re-enter this for every batch that follows.
    tail.clear();
    drop(buf);
    let resets_at = signal
        .reset_text
        .as_deref()
        .and_then(|t| banner::resolve_reset(chrono::Local::now(), t));
    record(UsageExhaustion {
        provider: "claude".to_string(),
        window: signal.window.map(str::to_string),
        resets_at,
        at: now_ms,
        text: Some(quote(&text, signal.reset_text.as_deref())),
    });
    true
}

/// The sentence to show a person, out of a buffer that may hold a screenful.
/// The banner itself and nothing around it: the last 160 characters ending at the
/// reset time, or the last 160 characters, whichever can be found.
fn quote(text: &str, reset: Option<&str>) -> String {
    let end = reset
        .and_then(|r| text.rfind(r).map(|i| i + r.len()))
        .unwrap_or(text.len());
    let from = text[..end].char_indices().rev().nth(160).map(|(i, _)| i).unwrap_or(0);
    text[from..end].trim().to_string()
}

/// Remember one refusal, replacing any earlier one for the same window.
///
/// Last one wins, and it has to: a session refused at 14:00 and again at 14:05
/// with a later reset time is one window, not two, and the newer reading is the
/// one the provider means.
fn record(e: UsageExhaustion) {
    if let Ok(mut s) = seen().lock() {
        s.retain(|old| !(old.provider == e.provider && old.window == e.window));
        s.push(e);
    }
    persist();
}

/// Write the list out. Best-effort by design: failing to persist costs the
/// restart-survival of one fact, and there is nothing useful to do about it here
/// — this runs on a PTY thread with no window to complain to.
fn persist() {
    let dir = match config_dir().lock() {
        Ok(d) => d.clone(),
        Err(_) => None,
    };
    let Some(dir) = dir else { return };
    let items = match seen().lock() {
        Ok(s) => s.clone(),
        Err(_) => return,
    };
    let _ = crate::store::Store::new(dir).save_usage_state(&items);
}

/// Every refusal still believed to hold, expiring the rest as it goes.
pub fn live(now_ms: i64) -> Vec<UsageExhaustion> {
    let mut changed = false;
    let out = match seen().lock() {
        Ok(mut s) => {
            let before = s.len();
            s.retain(|e| !expired(e, now_ms));
            changed = s.len() != before;
            s.clone()
        }
        Err(_) => Vec::new(),
    };
    if changed {
        persist();
    }
    out
}

/// The refusal that applies to one window, if any.
///
/// A refusal whose window was never named applies to whichever window the caller
/// asks about **first** — see `claude.rs`, which asks about the session window
/// before the weekly one, and says on screen that it filed an unnamed refusal
/// there.
pub fn for_window(now_ms: i64, provider: &str, window: &str) -> Option<UsageExhaustion> {
    let live = live(now_ms);
    live.iter()
        .find(|e| e.provider == provider && e.window.as_deref() == Some(window))
        .or_else(|| live.iter().find(|e| e.provider == provider && e.window.is_none()))
        .cloned()
}

/// Forget a session's buffer. Not a leak fix — one 4 KB string per session — but
/// a tile that is gone should not contribute a banner to the next one that
/// happens to reuse its id.
pub fn forget(session: &str) {
    if let Ok(mut b) = tails().lock() {
        b.remove(session);
    }
}

/// Clear a refusal by hand, for a person who can see the deck is working.
///
/// The escape hatch this feature needs and #303 does not name: the parser can be
/// wrong, and an app that insists the budget is spent while sessions are plainly
/// running would be worse than one that never said so. Reached from the dialog.
pub fn clear(provider: &str) {
    if let Ok(mut s) = seen().lock() {
        s.retain(|e| e.provider != provider);
    }
    persist();
}

/// What this deck's own sessions have spent, per window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Burn {
    /// Tokens in the last five hours.
    pub session: u64,
    /// Tokens in the last seven days.
    pub week: u64,
}

/// One pass over every transcript this app knows about: what was spent in each
/// window, and whether the provider refused a request in one of them.
///
/// One function rather than two because it is one read. The transcripts of a
/// dozen sessions are the most expensive thing a fetch does, and asking about
/// the five hours and the week separately read all of them twice.
///
/// Subagents are included, for the same reason `transcript_spend` includes them:
/// in one measured case a single subagent outspent the entire main chain, so
/// leaving them out would understate the burn by up to two thirds.
///
/// A refusal found here is **recorded**, not returned: it belongs in the same
/// persisted list a PTY banner lands in, so it survives a restart and expires by
/// the same rule.
pub fn scan(now_ms: i64) -> Burn {
    let mut seen_ids = HashSet::new();
    let mut burn = Burn::default();
    let mut refusal: Option<ApiRefusal> = None;
    let session_from = now_ms - FIVE_HOURS_MS;
    let week_from = now_ms - SEVEN_DAYS_MS;
    for (_, path) in crate::transcripts::all() {
        let path = std::path::PathBuf::from(path);
        let mut files = vec![path.clone()];
        files.extend(crate::commands::subagent_transcripts(&path));
        for file in files {
            let Ok(content) = std::fs::read_to_string(&file) else { continue };
            fold(&content, session_from, week_from, &mut seen_ids, &mut burn, &mut refusal);
        }
    }
    // Newest wins, and only if it is recent enough to still be true: a 429 from
    // three days ago must not put the block back into "spent".
    if let Some(r) = refusal.filter(|r| now_ms - r.at < ASSUMED_MS) {
        record(UsageExhaustion {
            provider: "claude".to_string(),
            // The transcript does not say which window, and this does not guess.
            window: None,
            resets_at: None,
            at: r.at,
            text: Some(r.text),
        });
    }
    burn
}

/// A refused request, as a transcript records one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ApiRefusal {
    at: i64,
    text: String,
}

/// Whether a transcript line is the provider refusing a request for want of
/// budget — and nothing else.
///
/// The shape is measured rather than guessed. Claude Code writes an API failure
/// as a line carrying `isApiErrorMessage: true`, a bare `error` string naming the
/// kind, and `apiErrorStatus`:
///
/// ```text
/// {"type":"assistant","timestamp":"…","error":"authentication_failed",
///  "isApiErrorMessage":true,"apiErrorStatus":"403", …}
/// ```
///
/// **Only that structured form is accepted.** Scanning for the bare token
/// `rate_limit_error` anywhere in a line would match the agent writing about rate
/// limits — this very repository's transcripts contain the string in prose — and
/// a row that wrongly says "exhausted" sends somebody away from a working deck. A
/// line Claude Code words differently is a miss, and a miss is the safe direction:
/// the PTY banner is watching for the same event.
fn api_refusal(v: &serde_json::Value) -> Option<ApiRefusal> {
    if v["isApiErrorMessage"] != serde_json::Value::Bool(true) {
        return None;
    }
    let kind = v["error"].as_str().unwrap_or_default();
    // Either name for it. `429` is the status a budget refusal arrives with, and
    // `rate_limit_error` is what the body calls it; a version that reports one
    // without the other should still be read.
    let status = v["apiErrorStatus"].as_str().unwrap_or_default();
    if kind != "rate_limit_error" && status != "429" {
        return None;
    }
    let at = parse_iso(v["timestamp"].as_str()?)?;
    Some(ApiRefusal {
        at,
        text: format!(
            "Claude Code recorded a refused request in a transcript: {}",
            if kind.is_empty() { "HTTP 429" } else { kind },
        ),
    })
}

/// `commands::fold_usage_lines`, plus a clock and an eye for a refusal.
///
/// The sibling of that function and it shares its one hard-won rule: **usage
/// belongs to a request, not to a line.** A transcript writes one line per
/// content block of an assistant turn and every one of them repeats the identical
/// usage object, so counting per line billed one turn three times. `seen` is
/// threaded in by the caller so a session's transcript and its subagents
/// deduplicate against one shared set of request ids.
///
/// What it adds is the `timestamp` filter, and that is why it is a separate
/// function rather than a parameter on that one: a rolling window needs a
/// per-request time, and a line with no parseable timestamp has to be **left
/// out** — counting it would put an unknown amount of history into a five-hour
/// bucket and make the number grow without bound.
///
/// Both windows are filled in one pass, because a request inside the five hours
/// is also inside the week and the alternative is reading every file twice.
fn fold(
    content: &str,
    session_from: i64,
    week_from: i64,
    seen: &mut HashSet<String>,
    burn: &mut Burn,
    refusal: &mut Option<ApiRefusal>,
) {
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Newest wins: a session refused at 14:00 and again at 14:05 is one
        // window, and the later reading is the one that holds.
        if let Some(r) = api_refusal(&v) {
            if refusal.as_ref().is_none_or(|old| r.at > old.at) {
                *refusal = Some(r);
            }
        }
        let usage = &v["message"]["usage"];
        if !usage.is_object() {
            continue;
        }
        let Some(ts) = v["timestamp"].as_str().and_then(parse_iso) else { continue };
        if ts < week_from {
            continue;
        }
        if let Some(id) = v["message"]["id"].as_str() {
            if !seen.insert(id.to_string()) {
                continue;
            }
        }
        // Cache reads are in, and that is deliberate: they are what the account
        // is metered on, and a deck of twelve sessions at >150k context is almost
        // entirely cache reads. Leaving them out would report a tenth of the
        // truth on exactly the workload this feature exists for.
        let mut spent = 0u64;
        for f in ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] {
            spent += usage[f].as_u64().unwrap_or(0);
        }
        burn.week += spent;
        if ts >= session_from {
            burn.session += spent;
        }
    }
}

fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Fresh global state per test, under a lock.
    ///
    /// These maps are process-wide by design — the PTY callback that writes to
    /// them has nowhere else to write — so every test that touches them has to
    /// hold this while it does. Without it `cargo test`'s own parallelism has one
    /// test's reset clearing what another just recorded, which is a failure about
    /// the test harness and not about the code.
    ///
    /// Poisoning is recovered from rather than propagated: one test panicking
    /// should fail that test, not every test after it.
    pub(crate) fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reset_state() {
        if let Ok(mut s) = seen().lock() {
            s.clear();
        }
        if let Ok(mut b) = tails().lock() {
            b.clear();
        }
        if let Ok(mut d) = config_dir().lock() {
            *d = None;
        }
    }

    const NOW: i64 = 1_772_000_000_000;

    #[test]
    fn a_banner_on_a_pty_becomes_a_refusal_with_its_window() {
        let _g = guard();
        reset_state();
        let learned = note_output(
            "s-banner",
            b"...working...\r\nYou've hit your 5-hour limit \xc2\xb7 resets 4pm\r\n",
            NOW,
        );
        assert!(learned, "the app learned something the cache could not know");
        let e = for_window(NOW, "claude", "session").expect("a refusal on the session window");
        assert_eq!(e.window.as_deref(), Some("session"));
        assert!(e.text.unwrap().contains("hit your 5-hour limit"));
    }

    /// The banner arriving in two batches, as a redraw delivers it. Neither half
    /// matches alone; the buffer is what makes the pair match.
    #[test]
    fn a_banner_split_across_two_batches_still_matches_once() {
        let _g = guard();
        reset_state();
        assert!(!note_output("s-split", b"You've hit your 5-hour li", NOW));
        assert!(note_output("s-split", b"mit \xc2\xb7 resets 4pm\r\n", NOW));
        assert_eq!(live(NOW).len(), 1);
        // And the same screen redrawn does not record it again.
        note_output("s-split", b"\x1b[2K\r", NOW);
        assert_eq!(live(NOW).len(), 1);
    }

    #[test]
    fn ordinary_output_that_mentions_a_limit_records_nothing() {
        let _g = guard();
        reset_state();
        assert!(!note_output("s-quiet", b"the rate limit resets every minute\r\n", NOW));
        assert!(!note_output("s-quiet", b"Context limit reached - /compact\r\n", NOW));
        assert!(live(NOW).is_empty());
    }

    #[test]
    fn an_unparseable_reset_time_is_a_refusal_with_no_reset() {
        let _g = guard();
        reset_state();
        note_output("s-vague", b"You've hit your 5-hour limit, resets later today\r\n", NOW);
        let e = for_window(NOW, "claude", "session").unwrap();
        assert_eq!(e.resets_at, None, "a guessed clock time would be worse than none");
    }

    #[test]
    fn a_refusal_is_dropped_once_its_reset_has_passed() {
        let _g = guard();
        reset_state();
        record(UsageExhaustion {
            provider: "claude".into(),
            window: Some("session".into()),
            resets_at: Some(NOW + 1000),
            at: NOW,
            text: None,
        });
        assert!(for_window(NOW, "claude", "session").is_some());
        assert!(for_window(NOW + 1001, "claude", "session").is_none());
    }

    /// A refusal with no reset time cannot live forever, and the direction it
    /// errs in is towards forgetting.
    #[test]
    fn a_refusal_with_no_reset_expires_on_the_shortest_real_window() {
        let _g = guard();
        reset_state();
        record(UsageExhaustion {
            provider: "claude".into(),
            window: None,
            resets_at: None,
            at: NOW,
            text: None,
        });
        assert!(for_window(NOW + ASSUMED_MS - 1, "claude", "session").is_some());
        assert!(for_window(NOW + ASSUMED_MS, "claude", "session").is_none());
    }

    #[test]
    fn a_refusal_that_did_not_name_its_window_answers_for_the_window_asked_about() {
        let _g = guard();
        reset_state();
        note_output("s-unnamed", b"Claude usage limit reached. Your limit will reset at 7pm\r\n", NOW);
        assert!(for_window(NOW, "claude", "session").is_some());
        assert!(for_window(NOW, "claude", "week").is_some());
        assert!(for_window(NOW, "gemini", "session").is_none(), "and not for another provider");
    }

    #[test]
    fn a_second_banner_for_one_window_replaces_the_first_rather_than_stacking() {
        let _g = guard();
        reset_state();
        note_output("s-again", b"You've hit your 5-hour limit \xc2\xb7 resets 4pm\r\n", NOW);
        note_output("s-again", b"You've hit your 5-hour limit \xc2\xb7 resets 5pm\r\n", NOW + 60_000);
        assert_eq!(live(NOW).len(), 1);
    }

    #[test]
    fn a_refusal_cleared_by_hand_stays_cleared() {
        let _g = guard();
        reset_state();
        note_output("s-clear", b"You've hit your 5-hour limit \xc2\xb7 resets 4pm\r\n", NOW);
        clear("claude");
        assert!(live(NOW).is_empty());
    }

    /// Persistence, end to end: what a restart actually does.
    #[test]
    fn a_refusal_survives_a_restart_and_a_dead_one_does_not() {
        let _g = guard();
        let dir = std::env::temp_dir().join(format!("cowork-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        reset_state();
        if let Ok(mut d) = config_dir().lock() {
            *d = Some(dir.clone());
        }
        record(UsageExhaustion {
            provider: "claude".into(),
            window: Some("session".into()),
            resets_at: Some(NOW + 4 * 60 * 60 * 1000),
            at: NOW,
            text: None,
        });
        record(UsageExhaustion {
            provider: "claude".into(),
            window: Some("week".into()),
            resets_at: Some(NOW - 1),
            at: NOW - 10_000,
            text: None,
        });

        // What the next launch does.
        reset_state();
        restore(dir.clone(), NOW);
        let live = live(NOW);
        assert_eq!(live.len(), 1, "the passed one was dropped on the way in");
        assert_eq!(live[0].window.as_deref(), Some("session"));
        // And the file itself was rewritten without the dead record.
        assert_eq!(crate::store::Store::new(dir.clone()).usage_state().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn line(id: &str, ts: &str, input: u64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","message":{{"id":"{id}","usage":{{"input_tokens":{input},"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
        )
    }

    /// Fold one buffer, for the tests that are about the fold rather than about
    /// the file walk. Both windows and the refusal, exactly as `scan` calls it.
    fn fold_one(content: &str, session_from: i64, week_from: i64) -> (Burn, Option<ApiRefusal>) {
        let mut seen = HashSet::new();
        let mut burn = Burn::default();
        let mut refusal = None;
        fold(content, session_from, week_from, &mut seen, &mut burn, &mut refusal);
        (burn, refusal)
    }

    const H06: &str = "2026-08-27T06:00:00.000Z";
    const H11: &str = "2026-08-27T11:00:00.000Z";

    #[test]
    fn the_rolling_sum_buckets_requests_by_their_own_timestamps() {
        let _g = guard();
        let content = [line("msg_old", H06, 100), line("msg_new", H11, 10)].join("\n");
        let session_from = parse_iso("2026-08-27T09:00:00.000Z").unwrap();
        let week_from = parse_iso("2026-08-21T00:00:00.000Z").unwrap();
        let (burn, _) = fold_one(&content, session_from, week_from);
        // The five hours hold the newer request only; the week holds both. Both
        // of each request's token fields are counted.
        assert_eq!(burn.session, 11);
        assert_eq!(burn.week, 112);
    }

    /// Two transcripts, one clock. The sum is per window and not per file.
    #[test]
    fn two_transcripts_land_in_the_right_windows() {
        let _g = guard();
        let session_from = parse_iso("2026-08-27T09:00:00.000Z").unwrap();
        let week_from = parse_iso("2026-08-21T00:00:00.000Z").unwrap();
        let mut seen = HashSet::new();
        let mut burn = Burn::default();
        let mut refusal = None;
        fold(&line("msg_a", H06, 100), session_from, week_from, &mut seen, &mut burn, &mut refusal);
        fold(&line("msg_b", H11, 10), session_from, week_from, &mut seen, &mut burn, &mut refusal);
        assert_eq!(burn.session, 11, "only the one inside the five hours");
        assert_eq!(burn.week, 112, "both, in the week");
    }

    /// The rule this shares with `fold_usage_lines`: one request, counted once,
    /// however many lines it wrote.
    #[test]
    fn one_request_written_as_three_lines_is_counted_once() {
        let _g = guard();
        let l = line("msg_dup", H11, 10);
        let content = [l.clone(), l.clone(), l].join("\n");
        assert_eq!(fold_one(&content, 0, 0).0.session, 11);
    }

    /// A line with no usable timestamp is left out rather than counted, or a
    /// rolling window would accumulate all of history.
    #[test]
    fn a_line_with_no_parseable_timestamp_is_left_out() {
        let _g = guard();
        let content = r#"{"message":{"id":"msg_nots","usage":{"input_tokens":99}}}"#;
        assert_eq!(fold_one(content, 0, 0).0, Burn::default());
    }

    #[test]
    fn non_json_and_usageless_lines_are_tolerated() {
        let _g = guard();
        let content = format!(
            "not json at all\n{{\"message\":{{\"role\":\"user\"}}}}\n{}",
            line("msg_ok", H11, 5),
        );
        assert_eq!(fold_one(&content, 0, 0).0.session, 6);
    }

    /* --- the refusal a transcript records -------------------------------- */

    /// The shape measured off a real transcript: `isApiErrorMessage`, a bare
    /// `error` string, and `apiErrorStatus`.
    fn api_error(kind: &str, status: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","error":"{kind}","isApiErrorMessage":true,"apiErrorStatus":"{status}"}}"#
        )
    }

    #[test]
    fn a_transcript_carrying_a_rate_limit_error_is_a_refusal() {
        let _g = guard();
        let (_, refusal) = fold_one(&api_error("rate_limit_error", "429", H11), 0, 0);
        let r = refusal.expect("a refusal");
        assert_eq!(r.at, parse_iso(H11).unwrap());
        assert!(r.text.contains("rate_limit_error"));
    }

    /// Either name for it, so a version that reports one without the other is
    /// still read.
    #[test]
    fn a_bare_429_counts_even_without_the_error_name() {
        let _g = guard();
        assert!(fold_one(&api_error("", "429", H11), 0, 0).1.is_some());
    }

    /// The false positive this is shaped to avoid. An agent writing *about* rate
    /// limits — which the transcripts of this very repository do — must not be
    /// read as the account being out.
    #[test]
    fn prose_about_rate_limits_is_not_a_refusal() {
        let _g = guard();
        for content in [
            // The token in a message the model wrote.
            format!(r#"{{"type":"assistant","timestamp":"{H11}","message":{{"content":"a rate_limit_error means 429"}}}}"#),
            // The whole API error body, quoted inside prose.
            format!(r#"{{"type":"assistant","timestamp":"{H11}","message":{{"content":"{{\"type\":\"error\",\"error\":{{\"type\":\"rate_limit_error\"}}}}"}}}}"#),
            // A tool result carrying it.
            format!(r#"{{"type":"user","timestamp":"{H11}","toolUseResult":"grep found rate_limit_error"}}"#),
        ] {
            assert_eq!(fold_one(&content, 0, 0).1, None, "{content}");
        }
    }

    /// Another kind of API failure is not a budget refusal.
    #[test]
    fn a_different_api_error_is_not_a_refusal() {
        let _g = guard();
        assert_eq!(fold_one(&api_error("authentication_failed", "403", H11), 0, 0).1, None);
        assert_eq!(fold_one(&api_error("overloaded_error", "529", H11), 0, 0).1, None);
    }

    #[test]
    fn the_newest_refusal_in_a_transcript_is_the_one_that_holds() {
        let _g = guard();
        let content = [
            api_error("rate_limit_error", "429", H06),
            api_error("rate_limit_error", "429", H11),
        ]
        .join("\n");
        assert_eq!(fold_one(&content, 0, 0).1.unwrap().at, parse_iso(H11).unwrap());
    }

    /// End to end, through the transcript map the rest of the app fills: a
    /// refused request on disk becomes a refusal the windows can see, and it is
    /// filed with no window named because the transcript does not say which.
    #[test]
    fn a_refusal_on_disk_reaches_the_windows_through_a_scan() {
        let _g = guard();
        reset_state();
        let dir = std::env::temp_dir().join(format!("cowork-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t-scan.jsonl");
        // Stamped relative to a now the test controls, because `scan` refuses a
        // refusal older than the shortest real window.
        let now = chrono::Utc::now().timestamp_millis();
        let ts = chrono::DateTime::from_timestamp_millis(now - 60_000)
            .unwrap()
            .to_rfc3339();
        std::fs::write(
            &file,
            format!(
                r#"{{"type":"assistant","timestamp":"{ts}","error":"rate_limit_error","isApiErrorMessage":true,"apiErrorStatus":"429"}}"#
            ),
        )
        .unwrap();
        crate::transcripts::record("t-scan", &file.to_string_lossy());

        scan(now);
        let e = for_window(now, "claude", "session").expect("a refusal the session window can see");
        assert_eq!(e.window, None, "the transcript did not say which window");
        assert_eq!(e.resets_at, None, "and it did not say when it lifts");
        assert!(e.text.unwrap().contains("rate_limit_error"));

        crate::transcripts::forget("t-scan");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// And one that is too old to still be true is not resurrected.
    #[test]
    fn a_refusal_older_than_the_shortest_window_is_not_resurrected() {
        let _g = guard();
        reset_state();
        let dir = std::env::temp_dir().join(format!("cowork-scan-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t-old.jsonl");
        let now = chrono::Utc::now().timestamp_millis();
        let ts = chrono::DateTime::from_timestamp_millis(now - ASSUMED_MS - 60_000)
            .unwrap()
            .to_rfc3339();
        std::fs::write(
            &file,
            format!(
                r#"{{"type":"assistant","timestamp":"{ts}","error":"rate_limit_error","isApiErrorMessage":true,"apiErrorStatus":"429"}}"#
            ),
        )
        .unwrap();
        crate::transcripts::record("t-old", &file.to_string_lossy());

        scan(now);
        assert!(live(now).is_empty(), "a 429 from days ago is not today's ceiling");

        crate::transcripts::forget("t-old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refusal_with_no_timestamp_is_not_readable_and_is_left_alone() {
        let _g = guard();
        let content = r#"{"type":"assistant","error":"rate_limit_error","isApiErrorMessage":true}"#;
        assert_eq!(fold_one(content, 0, 0).1, None);
    }
}
