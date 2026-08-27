//! Reading a limit out of what went past on a terminal.
//!
//! The deck owns the PTY of every session, so when Claude Code says the limit is
//! reached, and when it resets, those bytes pass through this app on their way to
//! the screen. That is the cheapest true thing the app can know about a ceiling:
//! no credential, no network, and it is the fact a person actually acts on —
//! "nothing moves until 19:00" is the difference between going for a coffee and
//! thinking the app is broken.
//!
//! Three traps, and the code is shaped by them rather than by the happy case:
//!
//! - **Escape sequences.** Matching raw PTY bytes misses a banner broken across a
//!   redraw, so everything here works on stripped, whitespace-collapsed text.
//! - **A false positive is worse than a miss.** A row that wrongly says
//!   "exhausted" sends someone away from a working deck. So this matches specific
//!   phrasings, never a co-occurrence of "limit" and "reset", and it carries an
//!   explicit list of the other things Claude Code calls a limit — a context
//!   limit, a subagent limit, a spend limit — every one of which would otherwise
//!   read as the account being out.
//! - **Reset times are prose, in local time.** They are parsed conservatively and
//!   the parse is allowed to fail: a window known to be spent with no known reset
//!   is a legitimate state, and inventing a clock time would be worse than
//!   admitting to not having one.

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone};

/// The two window ids the Claude provider declares. Here rather than in
/// `claude.rs` because the parser has to name what it found.
pub const SESSION: &str = "session";
pub const WEEK: &str = "week";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    /// The account has been refused. The one that changes what a person does.
    Exhausted,
    /// A warning short of refusal, with a share attached.
    Approaching,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Signal {
    pub kind: SignalKind,
    /// `None` when the text said a limit was hit without saying which window.
    /// Left as `None` rather than guessed: the caller decides where to file it,
    /// and says that it guessed.
    pub window: Option<&'static str>,
    pub used_fraction: Option<f32>,
    /// The prose as it appeared, so a caller that cannot parse it can still say
    /// what it was told. Parsing is `resolve_reset`'s job, separately.
    pub reset_text: Option<String>,
}

/// Everything Claude Code calls a "limit" that is **not** the account's budget.
/// Every one of these strings was taken out of the shipped binary rather than
/// imagined, and each of them ends with "limit reached" — which is exactly why
/// the generic match is not allowed to exist.
const NOT_A_BUDGET: [&str; 12] = [
    "context limit",
    "concurrent subagent limit",
    "subagent nesting limit",
    "concurrency limit",
    "concurrent export limit",
    "budget limit",
    "spend limit",
    "jit stack limit",
    "size limit",
    "device limit",
    "fast limit",
    "trigger limit",
];

/// CSI, OSC and the two-byte escapes, out; every run of whitespace, including the
/// carriage returns a redraw is made of, collapsed to one space; lowercased.
///
/// One function for all of it because the three steps are only correct together:
/// stripping without collapsing leaves a banner split by a `\r\n` in the middle
/// of its own sentence, which is the shape the naive version missed.
pub fn normalise(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: runs to BEL or ST (ESC \).
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            // Anything else is a two-byte escape and the second byte goes with it.
            _ => {}
        }
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut space = false;
    for c in out.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        space = false;
        for l in c.to_lowercase() {
            collapsed.push(l);
        }
    }
    collapsed
}

/// The strongest signal in a chunk of already-normalised text, or nothing.
///
/// "Strongest" rather than "first": a screen can carry an approaching warning
/// from ten minutes ago above the refusal that just happened, and the refusal is
/// the one worth reporting.
pub fn find(normalised: &str) -> Option<Signal> {
    exhausted(normalised).or_else(|| approaching(normalised))
}

/// Convenience for the caller that has raw bytes: normalise, then find.
pub fn find_raw(raw: &str) -> Option<Signal> {
    find(&normalise(raw))
}

fn exhausted(t: &str) -> Option<Signal> {
    // Three phrasings, all observed in the shipped binary's own strings:
    // "you've hit your <window> limit", "<window> limit reached", and the older
    // "claude usage limit reached".
    let at = ["you've hit your", "you have hit your", "usage limit reached", "limit reached"]
        .iter()
        .find_map(|p| t.find(p).map(|i| (i, *p)))?;
    let (i, phrase) = at;
    if phrase == "limit reached" && !is_budget_limit(t, i) {
        return None;
    }
    // The window name sits either just after "your" or just before "limit
    // reached", so both sides of the match are worth reading.
    let around = window_span(t, i, phrase.len());
    Some(Signal {
        kind: SignalKind::Exhausted,
        window: window_of(around),
        used_fraction: None,
        reset_text: reset_text(&t[i..]),
    })
}

/// `true` when the "limit reached" at `i` is the account's budget rather than one
/// of the dozen other things Claude Code limits. Fails closed: an unrecognised
/// prefix is not the budget.
fn is_budget_limit(t: &str, i: usize) -> bool {
    // Look back far enough to see the qualifier that precedes the word "limit".
    let from = t[..i].char_indices().rev().nth(40).map(|(n, _)| n).unwrap_or(0);
    let before = &t[from..i + "limit".len()];
    if NOT_A_BUDGET.iter().any(|bad| before.contains(bad)) {
        return false;
    }
    ["usage limit", "5-hour limit", "5 hour limit", "session limit", "weekly limit", "week limit"]
        .iter()
        .any(|good| before.contains(good))
}

fn approaching(t: &str) -> Option<Signal> {
    // "You've used NN% of your <window>", and the plain "approaching your
    // <window> limit". A share without a window is still worth having.
    if let Some(i) = t.find("% of your") {
        let pct = percent_before(t, i)?;
        let around = &t[i..(i + 60).min(t.len())];
        return Some(Signal {
            kind: SignalKind::Approaching,
            window: window_of(around),
            used_fraction: Some(pct / 100.0),
            reset_text: reset_text(&t[i..]),
        });
    }
    let i = t.find("approaching your").or_else(|| t.find("approaching the"))?;
    let around = &t[i..(i + 60).min(t.len())];
    Some(Signal {
        kind: SignalKind::Approaching,
        window: window_of(around),
        used_fraction: None,
        reset_text: reset_text(&t[i..]),
    })
}

/// The number immediately before a `%`, as a percentage. Bounded to 0..=100 —
/// a "300%" is a string this app has not understood, not a window three times
/// spent.
fn percent_before(t: &str, at_percent: usize) -> Option<f32> {
    let head = &t[..at_percent];
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let v: f32 = digits.parse().ok()?;
    (0.0..=100.0).contains(&v).then_some(v)
}

/// The stretch of text a window name could be hiding in: a little before the
/// matched phrase and a little after it.
fn window_span(t: &str, i: usize, len: usize) -> &str {
    let from = t[..i].char_indices().rev().nth(30).map(|(n, _)| n).unwrap_or(0);
    let to = t[i + len..]
        .char_indices()
        .nth(30)
        .map(|(n, _)| i + len + n)
        .unwrap_or(t.len());
    &t[from..to]
}

fn window_of(span: &str) -> Option<&'static str> {
    if span.contains("week") {
        return Some(WEEK);
    }
    if span.contains("5-hour") || span.contains("5 hour") || span.contains("session") {
        return Some(SESSION);
    }
    None
}

/// The prose after whichever way the text said "resets". Capped at 40 characters
/// because everything past that is another sentence.
fn reset_text(t: &str) -> Option<String> {
    let markers = ["will reset at ", "resets at ", "resets ", "reset at "];
    let (i, m) = markers.iter().find_map(|m| t.find(m).map(|i| (i, *m)))?;
    let rest = &t[i + m.len()..];
    let end = rest.char_indices().nth(40).map(|(n, _)| n).unwrap_or(rest.len());
    let s = rest[..end].trim().to_string();
    (!s.is_empty()).then_some(s)
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// Prose to an instant, or nothing.
///
/// Local time throughout, and that is correct by construction rather than by
/// luck: the process printing the prose is a child of this one, so its idea of
/// "4pm" is this machine's. The parenthesised zone Claude Code appends is
/// therefore redundant and is ignored rather than half-understood.
///
/// Two forms are accepted and everything else is refused: `"aug 27, 4pm"` and a
/// bare clock time. A year is never printed, so it is chosen as the one that puts
/// the answer nearest to `now` — a window resets within days, never within
/// months, so "nearest" cannot pick wrong for a real reset.
pub fn resolve_reset(now: DateTime<Local>, text: &str) -> Option<i64> {
    let t = text.trim();
    if let Some((month, day, rest)) = month_day(t) {
        let time = clock(rest)?;
        // Try this year and its neighbours, and take whichever lands closest.
        return (-1..=1)
            .filter_map(|off| {
                let d = NaiveDate::from_ymd_opt(now.year() + off, month, day)?;
                at_local(now, d.and_time(time))
            })
            .min_by_key(|ms| (ms - now.timestamp_millis()).abs());
    }
    let time = clock(t)?;
    // A bare clock time is the next time that clock reads it — including today,
    // if it has not passed yet.
    let today = at_local(now, now.date_naive().and_time(time))?;
    if today > now.timestamp_millis() {
        return Some(today);
    }
    at_local(now, (now.date_naive() + chrono::Duration::days(1)).and_time(time))
}

/// A naive local time to epoch ms. `earliest()` rather than `single()`: an hour
/// that happens twice on a DST fall-back is not a reason to lose the reset time,
/// and the earlier of the two is the safer answer for "when can I work again".
fn at_local(now: DateTime<Local>, naive: chrono::NaiveDateTime) -> Option<i64> {
    let _ = now;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp_millis())
}

fn month_day(t: &str) -> Option<(u32, u32, &str)> {
    let (m, rest) = MONTHS
        .iter()
        .enumerate()
        .find_map(|(i, m)| t.strip_prefix(m).map(|r| (i as u32 + 1, r)))?;
    // "aug 27, 4pm" and "august 27, 4pm" both arrive here; the tail of a long
    // month name is letters, so skip them.
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    let rest = rest.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let day: u32 = digits.parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let rest = rest[digits.len()..].trim_start().trim_start_matches(',').trim_start();
    Some((m, day, rest))
}

/// `4pm`, `4:30pm`, `16:00`. Anything else is refused.
fn clock(t: &str) -> Option<NaiveTime> {
    let t = t.trim();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let mut hour: u32 = digits.parse().ok()?;
    let rest = &t[digits.len()..];
    let (minute, rest) = match rest.strip_prefix(':') {
        Some(after) => {
            let m: String = after.chars().take(2).filter(|c| c.is_ascii_digit()).collect();
            if m.len() != 2 {
                return None;
            }
            (m.parse::<u32>().ok()?, &after[2..])
        }
        None => (0, rest),
    };
    let rest = rest.trim_start();
    if let Some(_) = rest.strip_prefix("pm") {
        if hour == 12 {
            // 12pm is noon.
        } else if hour < 12 {
            hour += 12;
        } else {
            return None;
        }
    } else if rest.starts_with("am") {
        if hour == 12 {
            hour = 0;
        } else if hour > 12 {
            return None;
        }
    } else if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('(')) {
        // A 24-hour clock is only accepted when nothing unrecognised follows it,
        // so "4 sessions" cannot become 04:00.
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The banner as it arrives, and the same banner broken by the redraw that
    /// drew it. Both must land on one signal — the second is the case matching
    /// raw bytes gets wrong.
    #[test]
    fn a_banner_matches_with_and_without_escape_sequences() {
        let plain = "You've hit your 5-hour limit · resets 4pm";
        let redrawn = "\u{1b}[2K\rYou've hit your \u{1b}[1m5-hour limit\u{1b}[0m ·\r\n  resets 4pm\u{1b}[K";
        for raw in [plain, redrawn] {
            let s = find_raw(raw).expect(raw);
            assert_eq!(s.kind, SignalKind::Exhausted);
            assert_eq!(s.window, Some(SESSION));
            assert_eq!(s.reset_text.as_deref(), Some("4pm"));
        }
    }

    #[test]
    fn a_weekly_refusal_is_filed_against_the_weekly_window() {
        let s = find_raw("You've hit your weekly limit. Your weekly limit resets Sep 1, 8am").unwrap();
        assert_eq!(s.window, Some(WEEK));
        assert_eq!(s.reset_text.as_deref(), Some("sep 1, 8am"));
    }

    /// The clause the whole parser exists to satisfy: ordinary output that
    /// happens to contain both words must not match.
    #[test]
    fn ordinary_output_mentioning_limits_and_resets_does_not_match() {
        for line in [
            "the rate limit on that endpoint resets every minute, see docs",
            "git reset --hard resets the working tree; there is no limit",
            "TODO: raise the limit and reset the counter",
            "Checking whether the limit was reached in the test above",
        ] {
            assert_eq!(find_raw(line), None, "{line}");
        }
    }

    /// Twelve other things Claude Code calls a limit. Every one of them would
    /// have read as the account being out under a generic match.
    #[test]
    fn the_other_limits_claude_code_reports_are_not_the_budget() {
        for line in [
            "Context limit reached — /compact to continue",
            "Concurrent subagent limit reached. You can run 10 at a time",
            "Budget limit reached ($5.00)",
            "spend limit reached (org)",
            "Concurrency Limit reached",
            "Fast limit reached and temporarily disabled",
        ] {
            assert_eq!(find_raw(line), None, "{line}");
        }
    }

    #[test]
    fn a_refusal_that_does_not_name_its_window_leaves_the_window_unsaid() {
        let s = find_raw("Claude usage limit reached. Your limit will reset at 7pm").unwrap();
        assert_eq!(s.kind, SignalKind::Exhausted);
        assert_eq!(s.window, None);
        assert_eq!(s.reset_text.as_deref(), Some("7pm"));
    }

    #[test]
    fn an_approaching_warning_carries_its_share() {
        let s = find_raw("You've used 87% of your 5-hour limit").unwrap();
        assert_eq!(s.kind, SignalKind::Approaching);
        assert_eq!(s.window, Some(SESSION));
        assert_eq!(s.used_fraction, Some(0.87));
    }

    /// A refusal below an older warning on the same screen: the refusal is the
    /// one that changes what a person does next.
    #[test]
    fn a_refusal_outranks_a_warning_higher_up_the_screen() {
        let t = "You've used 87% of your 5-hour limit\nlater...\nYou've hit your 5-hour limit · resets 4pm";
        assert_eq!(find_raw(t).unwrap().kind, SignalKind::Exhausted);
    }

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 8, 27, 13, 30, 0).earliest().unwrap()
    }

    #[test]
    fn a_clock_time_resolves_to_its_next_occurrence() {
        let at = resolve_reset(now(), "4pm").unwrap();
        let want = Local.with_ymd_and_hms(2026, 8, 27, 16, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
    }

    #[test]
    fn a_clock_time_already_past_today_lands_tomorrow() {
        let at = resolve_reset(now(), "9am").unwrap();
        let want = Local.with_ymd_and_hms(2026, 8, 28, 9, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
    }

    #[test]
    fn a_dated_reset_resolves_with_the_year_nobody_printed() {
        let at = resolve_reset(now(), "sep 1, 8am (europe/minsk)").unwrap();
        let want = Local.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
    }

    /// A reset printed in the last days of December for a window that lands in
    /// January: the nearest year is the next one, not this one.
    #[test]
    fn a_dated_reset_across_the_new_year_picks_the_near_side() {
        let dec = Local.with_ymd_and_hms(2026, 12, 30, 22, 0, 0).earliest().unwrap();
        let at = resolve_reset(dec, "jan 2, 9am").unwrap();
        let want = Local.with_ymd_and_hms(2027, 1, 2, 9, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
    }

    #[test]
    fn a_24_hour_clock_works_and_a_number_of_something_else_does_not() {
        let at = resolve_reset(now(), "19:00").unwrap();
        let want = Local.with_ymd_and_hms(2026, 8, 27, 19, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
        assert_eq!(resolve_reset(now(), "4 sessions from now"), None);
    }

    /// The case that must fail rather than guess. A window known to be spent with
    /// no known reset is a legitimate state.
    #[test]
    fn prose_that_is_not_a_time_resolves_to_nothing() {
        for text in ["in a while", "later today", "tomorrow morning", "wed 9am", ""] {
            assert_eq!(resolve_reset(now(), text), None, "{text}");
        }
    }

    #[test]
    fn noon_and_midnight_are_not_off_by_twelve_hours() {
        let at = resolve_reset(now(), "12am").unwrap();
        let want = Local.with_ymd_and_hms(2026, 8, 28, 0, 0, 0).earliest().unwrap();
        assert_eq!(at, want.timestamp_millis());
        let noon = resolve_reset(
            Local.with_ymd_and_hms(2026, 8, 27, 9, 0, 0).earliest().unwrap(),
            "12pm",
        )
        .unwrap();
        let want = Local.with_ymd_and_hms(2026, 8, 27, 12, 0, 0).earliest().unwrap();
        assert_eq!(noon, want.timestamp_millis());
    }
}
