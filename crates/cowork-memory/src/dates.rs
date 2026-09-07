//! When a note was written, and how to ask for a period of them.
//!
//! #462: `search_scoped` ranked by cosine distance alone, so "what did we do
//! yesterday" — a question whose selector is **when** — was put to a retriever
//! that could only select on **what**. The nearest neighbours to that sentence
//! are whatever notes happen to talk about doing things, from any month.
//!
//! # The date comes off the note, and is never stored beside it
//!
//! ADR-0004 makes the markdown the memory and the index a cache, so a date the
//! index kept as a field of its own would be a second truth — one that a note
//! moved or renamed by hand would silently contradict. The corpus already
//! records the date in the only place that cannot drift from the file: its
//! path. `memory::corpus` writes
//!
//! ```text
//! {workspace}/Sessions/YYYY-MM/DD-topic.md
//! Diaries/{room}/YYYY-MM.md
//! ```
//!
//! and [`note_date`] reads it back. Nothing is added to the cache and no
//! reindex is needed for a corpus to acquire a time axis — the same derivation
//! `labelHit` in `src/memory-page.ts` already performs on the other side of the
//! IPC, which is why the two agree by construction rather than by hope.
//!
//! # Two granularities, because the corpus has two
//!
//! A session note is a day and a diary is a month, and flattening the second
//! into "the first of the month" would put an August lesson outside a window
//! asking for late August. A month is therefore a *range*, and a window admits
//! a note whose range overlaps it.
//!
//! # A note with no date is not in any period
//!
//! `Facts.md` has no date in its path — its lines are dated individually, below
//! the granularity anything here can see. A window is a claim about a period, so
//! an undated note cannot satisfy one and is left out whenever a window is
//! given. Without a window it is admitted as before.

/// A calendar day, ordered as it reads.
///
/// Derived rather than validated: these come from paths this app wrote, and a
/// path with `2026-13-40` in it sorts harmlessly rather than needing a branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Day {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl Day {
    pub fn new(year: i32, month: u32, day: u32) -> Day {
        Day { year, month, day }
    }
}

/// When a note was written, to whatever precision its path records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoteDate {
    pub year: i32,
    pub month: u32,
    /// `None` for a diary, which the corpus files one file per month.
    pub day: Option<u32>,
}

impl NoteDate {
    /// `2026-08-31` for a session note, `2026-08` for a diary.
    ///
    /// The string a reader sees, and the same two shapes the memory page shows,
    /// so a date in an injected block and a date on screen are the same date
    /// written the same way.
    pub fn label(&self) -> String {
        match self.day {
            Some(d) => format!("{:04}-{:02}-{:02}", self.year, self.month, d),
            None => format!("{:04}-{:02}", self.year, self.month),
        }
    }

    /// The earliest day this note could have been written.
    pub fn first(&self) -> Day {
        Day::new(self.year, self.month, self.day.unwrap_or(1))
    }

    /// The latest.
    ///
    /// 31 for a month, unconditionally. This is only ever compared against a
    /// real day, and no real day exceeds the length of its own month — so the
    /// slack at the end of a short month can never admit anything a correct
    /// length would exclude, and the alternative is a leap-year table for no
    /// difference in outcome.
    pub fn last(&self) -> Day {
        Day::new(self.year, self.month, self.day.unwrap_or(31))
    }
}

/// The date a corpus path records, or `None` for a note that carries none.
///
/// The layout is `memory::corpus`'s and `scan::detect_scope` is what agrees
/// this is a note at all; this reads the same two shapes for their dates and
/// declines everything else — a file somebody dropped into the corpus by hand
/// is a note without a date rather than a note with a guessed one.
pub fn note_date(rel_path: &str) -> Option<NoteDate> {
    let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    // Diaries/{room}/YYYY-MM.md
    if parts.first() == Some(&"Diaries") && parts.len() == 3 {
        let (y, m) = year_month(parts[2].strip_suffix(".md")?)?;
        return Some(NoteDate { year: y, month: m, day: None });
    }
    // {workspace}/Sessions/YYYY-MM/DD-topic.md
    if parts.len() == 4 && parts[1] == "Sessions" {
        let (y, m) = year_month(parts[2])?;
        let stem = parts[3].strip_suffix(".md")?;
        // `DD-topic`: exactly two digits, because `corpus::write_note` writes
        // `{:02}` and a one-digit prefix would be somebody else's file.
        let dd = stem.get(..2)?;
        let d: u32 = dd.parse().ok()?;
        if stem.len() > 2 && !stem[2..].starts_with('-') {
            return None;
        }
        return Some(NoteDate { year: y, month: m, day: Some(d) });
    }
    None
}

/// `YYYY-MM`.
fn year_month(s: &str) -> Option<(i32, u32)> {
    let (y, m) = s.split_once('-')?;
    if y.len() != 4 || m.len() != 2 {
        return None;
    }
    Some((y.parse().ok()?, m.parse().ok()?))
}

/// The period a search is confined to, either end open.
///
/// Inclusive at both ends: a person who asks about the third means the third.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Window {
    pub since: Option<Day>,
    pub until: Option<Day>,
}

/// Every note there is — what a search that named no period asks for.
pub const ANY: Window = Window { since: None, until: None };

impl Window {
    /// Whether this window is no window at all.
    ///
    /// Read by [`crate::index::search`] to decide two things at once: whether to
    /// filter by date, and whether the similarity floor still applies.
    pub fn is_any(&self) -> bool {
        self.since.is_none() && self.until.is_none()
    }

    /// A window from the two strings a caller passes across a process boundary.
    ///
    /// Each end is `YYYY-MM-DD` or `YYYY-MM`, and a month means the whole of it:
    /// `since: "2026-08"` is the first of August and `until: "2026-08"` is the
    /// end of it. Anything else is an error rather than a silently ignored
    /// argument — a window nobody applied returns the whole corpus, which reads
    /// exactly like a window that matched everything.
    pub fn parse(since: Option<&str>, until: Option<&str>) -> Result<Window, String> {
        Ok(Window {
            since: since.map(|s| bound(s, false)).transpose()?,
            until: until.map(|s| bound(s, true)).transpose()?,
        })
    }

    /// Whether a note at this path falls inside the window.
    ///
    /// Overlap rather than containment, because a diary is a month: a window
    /// over three days in August admits August's diary, which is the file those
    /// three days' lessons were written into.
    pub fn admits(&self, rel_path: &str) -> bool {
        if self.is_any() {
            return true;
        }
        let Some(d) = note_date(rel_path) else {
            // Undated, and a window is a claim about a period. See the module note.
            return false;
        };
        if let Some(since) = self.since {
            if d.last() < since {
                return false;
            }
        }
        if let Some(until) = self.until {
            if d.first() > until {
                return false;
            }
        }
        true
    }

    /// The period in the words a person would read it back in.
    ///
    /// For the sentence a search says when a window found nothing: "nothing from
    /// that period" is only useful if it names the period.
    pub fn describe(&self) -> String {
        match (self.since, self.until) {
            (Some(a), Some(b)) if a == b => day_label(a),
            (Some(a), Some(b)) => format!("{} to {}", day_label(a), day_label(b)),
            (Some(a), None) => format!("{} onwards", day_label(a)),
            (None, Some(b)) => format!("up to {}", day_label(b)),
            (None, None) => "any time".to_string(),
        }
    }
}

fn day_label(d: Day) -> String {
    format!("{:04}-{:02}-{:02}", d.year, d.month, d.day)
}

/// One end of a window. `end` picks which edge of a bare month is meant.
fn bound(s: &str, end: bool) -> Result<Day, String> {
    let s = s.trim();
    let bad = || format!("{s:?} is not a date; write YYYY-MM-DD or YYYY-MM");
    let parts: Vec<&str> = s.split('-').collect();
    match parts.len() {
        2 => {
            let (y, m) = year_month(s).ok_or_else(bad)?;
            Ok(Day::new(y, m, if end { 31 } else { 1 }))
        }
        3 => {
            let (y, m) = year_month(&s[..7.min(s.len())]).ok_or_else(bad)?;
            if parts[2].len() != 2 {
                return Err(bad());
            }
            let d: u32 = parts[2].parse().map_err(|_| bad())?;
            Ok(Day::new(y, m, d))
        }
        _ => Err(bad()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_note_is_dated_to_the_day_and_a_diary_to_the_month() {
        let s = note_date("ws-1/Sessions/2026-08/31-topic.md").unwrap();
        assert_eq!(s, NoteDate { year: 2026, month: 8, day: Some(31) });
        assert_eq!(s.label(), "2026-08-31");

        let d = note_date("Diaries/code-reviewer/2026-07.md").unwrap();
        assert_eq!(d, NoteDate { year: 2026, month: 7, day: None });
        assert_eq!(d.label(), "2026-07");
    }

    /// `Facts.md` is dated line by line, below anything a path can see, and a
    /// file somebody dropped in by hand carries no date at all.
    #[test]
    fn a_note_the_layout_does_not_date_has_no_date() {
        assert!(note_date("ws-1/Facts.md").is_none());
        assert!(note_date("ws-1/Sessions/2026-08/notes.md").is_none());
        assert!(note_date("ws-1/Sessions/august/31-topic.md").is_none());
        assert!(note_date("loose.md").is_none());
    }

    #[test]
    fn a_window_is_inclusive_at_both_ends() {
        let w = Window::parse(Some("2026-08-10"), Some("2026-08-12")).unwrap();
        assert!(!w.admits("ws-1/Sessions/2026-08/09-a.md"));
        assert!(w.admits("ws-1/Sessions/2026-08/10-a.md"));
        assert!(w.admits("ws-1/Sessions/2026-08/12-a.md"));
        assert!(!w.admits("ws-1/Sessions/2026-08/13-a.md"));
    }

    /// A diary is a month, so a window over three days in August admits it —
    /// that file is where those three days' lessons went.
    #[test]
    fn a_month_long_note_overlaps_a_window_inside_it() {
        let w = Window::parse(Some("2026-08-10"), Some("2026-08-12")).unwrap();
        assert!(w.admits("Diaries/code-reviewer/2026-08.md"));
        assert!(!w.admits("Diaries/code-reviewer/2026-07.md"));
    }

    #[test]
    fn a_bare_month_bound_means_the_whole_month() {
        let w = Window::parse(Some("2026-08"), Some("2026-08")).unwrap();
        assert!(w.admits("ws-1/Sessions/2026-08/01-a.md"));
        assert!(w.admits("ws-1/Sessions/2026-08/31-a.md"));
        assert!(!w.admits("ws-1/Sessions/2026-07/31-a.md"));
        assert!(!w.admits("ws-1/Sessions/2026-09/01-a.md"));
    }

    /// Either end may be open.
    #[test]
    fn one_ended_windows() {
        let since = Window::parse(Some("2026-08-01"), None).unwrap();
        assert!(since.admits("ws-1/Sessions/2026-09/01-a.md"));
        assert!(!since.admits("ws-1/Sessions/2026-07/31-a.md"));

        let until = Window::parse(None, Some("2026-08-01")).unwrap();
        assert!(!until.admits("ws-1/Sessions/2026-09/01-a.md"));
        assert!(until.admits("ws-1/Sessions/2026-07/31-a.md"));
    }

    #[test]
    fn no_window_admits_everything_including_the_undated() {
        assert!(ANY.is_any());
        assert!(ANY.admits("ws-1/Facts.md"));
        assert!(ANY.admits("ws-1/Sessions/2026-08/31-a.md"));
    }

    /// A window is a claim about a period, and an undated note cannot satisfy one.
    #[test]
    fn a_window_leaves_undated_notes_out() {
        let w = Window::parse(Some("2026-08-10"), None).unwrap();
        assert!(!w.admits("ws-1/Facts.md"));
    }

    /// A bound nobody could apply is an error, not a window quietly widened to
    /// everything — which would read exactly like a window that matched.
    #[test]
    fn an_unreadable_bound_is_refused() {
        assert!(Window::parse(Some("yesterday"), None).is_err());
        assert!(Window::parse(Some("2026/08/10"), None).is_err());
        assert!(Window::parse(Some("26-08-10"), None).is_err());
        assert!(Window::parse(None, Some("2026-8-1")).is_err());
    }

    #[test]
    fn a_window_names_its_period() {
        let one = Window::parse(Some("2026-09-06"), Some("2026-09-06")).unwrap();
        assert_eq!(one.describe(), "2026-09-06");
        let span = Window::parse(Some("2026-08-31"), Some("2026-09-06")).unwrap();
        assert_eq!(span.describe(), "2026-08-31 to 2026-09-06");
        assert_eq!(Window::parse(Some("2026-09"), None).unwrap().describe(), "2026-09-01 onwards");
        assert_eq!(ANY.describe(), "any time");
    }
}
