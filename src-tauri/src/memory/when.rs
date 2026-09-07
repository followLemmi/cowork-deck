//! The period a question is about, read out of the question.
//!
//! #462 reported memory answering "what was decided" and not "what did we do
//! yesterday", and named the reason: the second question's selector is **when**,
//! and it was being put to a retriever that could only select on **what**. The
//! nearest neighbours to that sentence are whatever notes happen to talk about
//! doing things, from any month.
//!
//! Giving the corpus a time axis ([`cowork_memory::dates`], mirrored here as
//! [`Window`]) is half of it. The other half is noticing that somebody asked a
//! question about a period at all, which is what this does: the prompt hook has
//! the person's own words, and the words that name a period are a short, closed
//! list in each language.
//!
//! # Deliberately a table and not a model
//!
//! The same argument [`super::prompt::worth_searching`] makes. This runs on the
//! path of every message, and a cleverer reader would be a second model on that
//! path. The failure it would prevent — a period phrased in a way the table does
//! not hold, which then searches the whole corpus exactly as before — is far
//! cheaper than the one it would cause.
//!
//! # Both languages, because #462 is about the second one
//!
//! The character floor this issue also retired was calibrated on English. A time
//! reader that only knew English would be the same mistake with a different
//! surface, so the table is Russian and English together and the tests assert
//! both. Russian is matched on stems rather than on whole words — «на прошлой
//! неделе» and «за прошлую неделю» are the same question in different cases, and
//! a table of inflected forms is a table that is wrong for the next case.
//!
//! # What a window means here
//!
//! An inclusive range of days, either end open, resolved against *today* rather
//! than against the clock: a session started before midnight and asking about
//! "yesterday" after it means the day before the one it is now.

use super::sidecar::Window;
use chrono::{Datelike, Days, NaiveDate};

/// The period a prompt names, or `None` when it names none.
///
/// `today` is a parameter rather than a call to the clock so the tests can say
/// what day it is; [`super::prompt_context`] passes `corpus::today()`.
pub fn window_of(prompt: &str, today: NaiveDate) -> Option<Window> {
    let words = words(prompt);
    if words.is_empty() {
        return None;
    }
    // Most specific first: an explicit date beats a phrase, and a two-word
    // phrase beats either of its halves. `позавчера` is not `вчера` and
    // `последние три дня` is not `дня` — which is why the pass is ordered and
    // why matching is on whole words rather than on substrings.
    explicit(&words)
        .or_else(|| named_day(&words, today))
        .or_else(|| phrase(&words, today))
}

/// A prompt as whole words, lowercased, stripped of the punctuation around them.
///
/// Split on whitespace rather than on every non-letter, so `2026-09-03` survives
/// as one word while `вчера,` and `(yesterday)` lose their edges.
fn words(prompt: &str) -> Vec<String> {
    prompt
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

fn day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn between(from: NaiveDate, to: NaiveDate) -> Window {
    Window { since: Some(day(from)), until: Some(day(to)) }
}

fn on(d: NaiveDate) -> Window {
    between(d, d)
}

fn back(today: NaiveDate, days: u64) -> NaiveDate {
    today.checked_sub_days(Days::new(days)).unwrap_or(today)
}

/// A date written out: `2026-09-03`, or `2026-09` for a whole month.
///
/// Passed through as the person wrote it — the sidecar reads both shapes, and a
/// bare month there already means the whole of it.
fn explicit(words: &[String]) -> Option<Window> {
    for w in words {
        let parts: Vec<&str> = w.split('-').collect();
        let digits = |s: &&str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit());
        match parts.as_slice() {
            [y, m] if digits(y, 4) && digits(m, 2) => {
                return Some(Window { since: Some(w.clone()), until: Some(w.clone()) })
            }
            [y, m, d] if digits(y, 4) && digits(m, 2) && digits(d, 2) => {
                return Some(Window { since: Some(w.clone()), until: Some(w.clone()) })
            }
            _ => {}
        }
    }
    None
}

/// Month names, as a person writes a date in either language.
///
/// **Exact forms, not stems.** A three-letter prefix is far too loose to run
/// over an arbitrary prompt: `mar` is the start of "markers", `sep` of
/// "separate", `dec` of "declaration", and `мар` of «маркера» — and every one of
/// those turns "rename 3 markers" into a question about the third of March.
/// Russian carries the nominative and the genitive because a date is written in
/// the second («3 сентября») and a heading in the first.
const MONTHS: [(&[&str], u32); 12] = [
    (&["january", "jan", "январь", "января"], 1),
    (&["february", "feb", "февраль", "февраля"], 2),
    (&["march", "mar", "март", "марта"], 3),
    (&["april", "apr", "апрель", "апреля"], 4),
    (&["may", "май", "мая"], 5),
    (&["june", "jun", "июнь", "июня"], 6),
    (&["july", "jul", "июль", "июля"], 7),
    (&["august", "aug", "август", "августа"], 8),
    (&["september", "sept", "sep", "сентябрь", "сентября"], 9),
    (&["october", "oct", "октябрь", "октября"], 10),
    (&["november", "nov", "ноябрь", "ноября"], 11),
    (&["december", "dec", "декабрь", "декабря"], 12),
];

/// Which month a word names, if it names one.
fn month_of(word: &str) -> Option<u32> {
    // A trailing full stop is how the abbreviation is usually written.
    let word = word.trim_end_matches('.');
    MONTHS.iter().find(|(forms, _)| forms.contains(&word)).map(|(_, n)| *n)
}

/// A day somebody named: «3 сентября», "September 3", "Sep 3rd".
///
/// Resolved to the most recent such day that is not in the future, because a
/// person asking what happened on a named day is asking about the past — and a
/// corpus has no notes from the future to return either way.
fn named_day(words: &[String], today: NaiveDate) -> Option<Window> {
    for pair in words.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let found = match (number(a), month_of(a), number(b), month_of(b)) {
            // 3 сентября
            (Some(d), _, _, Some(m)) => Some((m, d)),
            // September 3
            (_, Some(m), Some(d), _) => Some((m, d)),
            _ => None,
        };
        let Some((m, d)) = found else { continue };
        if !(1..=31).contains(&d) {
            continue;
        }
        let this_year = NaiveDate::from_ymd_opt(today.year(), m, d);
        let resolved = match this_year {
            Some(date) if date <= today => Some(date),
            // Not yet reached this year, so it was last year.
            _ => NaiveDate::from_ymd_opt(today.year() - 1, m, d),
        };
        if let Some(date) = resolved {
            return Some(on(date));
        }
    }
    None
}

/// A leading run of digits — "3", and "3rd" as a person types an English date.
fn number(word: &str) -> Option<u32> {
    let digits: String = word.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 2 {
        return None;
    }
    digits.parse().ok()
}

/// The relative phrases, in both languages.
///
/// Ordered longest-first within each shape for the reason [`window_of`] gives:
/// a two-word phrase must be tried before either of its halves.
fn phrase(words: &[String], today: NaiveDate) -> Option<Window> {
    // Two words: this/last + week/month. Russian by stem, because the adjective
    // and the noun both inflect and only the stems are stable.
    for pair in words.windows(2) {
        let (a, b) = (pair[0].as_str(), pair[1].as_str());
        let unit = if b.starts_with("недел") || b == "week" {
            Some(7)
        } else if b.starts_with("месяц") || b == "month" {
            Some(30)
        } else {
            None
        };
        let Some(span) = unit else { continue };
        // «прошлой», «прошлую», «прошлом» — and "last"/"past"/"previous".
        if a.starts_with("прошл") || matches!(a, "last" | "past" | "previous") {
            /* Twice the unit, ending today, rather than the previous calendar
               week or month. "Last week" in speech means the recent past, not an
               ISO week boundary — and of the two ways to be wrong, too narrow
               returns nothing from a period that had something in it, while too
               wide is the corpus-wide search this already was. */
            return Some(between(back(today, span * 2), today));
        }
        // «на этой неделе», «в этом месяце» — and "this week".
        if a.starts_with("эт") || a == "this" || a == "current" {
            return Some(between(back(today, span), today));
        }
    }

    // Three words: "за последние пять дней", "in the last 5 days".
    for run in words.windows(3) {
        let unit = run[2].as_str();
        if !(unit.starts_with("дн") || unit.starts_with("ден") || unit == "days" || unit == "day") {
            continue;
        }
        let lead = run[0].as_str();
        if !(lead.starts_with("последн") || matches!(lead, "last" | "past")) {
            continue;
        }
        if let Some(n) = number(&run[1]) {
            return Some(between(back(today, n.max(1) as u64), today));
        }
    }

    // One word.
    for w in words {
        let found = match w.as_str() {
            "сегодня" | "today" => Some(on(today)),
            "вчера" | "yesterday" => Some(on(back(today, 1))),
            "позавчера" => Some(on(back(today, 2))),
            /* Vague on purpose, and a week is the reading that costs least when
               it is wrong: too narrow returns nothing from a period that had
               something in it, and too wide is the corpus-wide search this was
               already doing. */
            "недавно" | "recently" | "lately" => Some(between(back(today, 7), today)),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-09-06 was a Sunday. Every expectation below is arithmetic from it.
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 6).unwrap()
    }

    fn w(prompt: &str) -> Option<(String, String)> {
        window_of(prompt, today()).map(|w| (w.since.unwrap(), w.until.unwrap()))
    }

    /// The prompt from #462, which went to `git log` because memory had no way
    /// to be the better answer.
    #[test]
    fn the_question_that_started_this() {
        assert_eq!(w("что мы вчера делали по проекту"), Some(("2026-09-05".into(), "2026-09-05".into())));
    }

    #[test]
    fn a_day_named_relatively_in_either_language() {
        for p in ["what did we do yesterday", "что мы делали вчера"] {
            assert_eq!(w(p), Some(("2026-09-05".into(), "2026-09-05".into())), "{p}");
        }
        for p in ["what did we do today", "что сегодня сделали"] {
            assert_eq!(w(p), Some(("2026-09-06".into(), "2026-09-06".into())), "{p}");
        }
        assert_eq!(w("а позавчера что было"), Some(("2026-09-04".into(), "2026-09-04".into())));
    }

    /// «позавчера» contains «вчера», which is why matching is on whole words.
    #[test]
    fn the_day_before_yesterday_is_not_yesterday() {
        assert_ne!(w("что мы делали позавчера"), w("что мы делали вчера"));
    }

    #[test]
    fn a_week_and_a_month_in_either_language_and_any_case() {
        for p in [
            "what did we do last week",
            "что мы делали на прошлой неделе",
            "что было за прошлую неделю",
        ] {
            assert_eq!(w(p), Some(("2026-08-23".into(), "2026-09-06".into())), "{p}");
        }
        for p in ["what happened this week", "что было на этой неделе"] {
            assert_eq!(w(p), Some(("2026-08-30".into(), "2026-09-06".into())), "{p}");
        }
        for p in ["what shipped last month", "что мы сделали в прошлом месяце"] {
            assert_eq!(w(p), Some(("2026-07-08".into(), "2026-09-06".into())), "{p}");
        }
    }

    #[test]
    fn a_run_of_days() {
        assert_eq!(w("что было за последние 3 дня"), Some(("2026-09-03".into(), "2026-09-06".into())));
        assert_eq!(w("what changed in the last 10 days"), Some(("2026-08-27".into(), "2026-09-06".into())));
    }

    #[test]
    fn a_day_named_outright() {
        assert_eq!(w("что мы делали 3 сентября"), Some(("2026-09-03".into(), "2026-09-03".into())));
        assert_eq!(w("what did we do on September 3"), Some(("2026-09-03".into(), "2026-09-03".into())));
        assert_eq!(w("anything from Aug 31?"), Some(("2026-08-31".into(), "2026-08-31".into())));
        assert_eq!(w("что было 5 марта"), Some(("2026-03-05".into(), "2026-03-05".into())));
        assert_eq!(w("что было 5 мая"), Some(("2026-05-05".into(), "2026-05-05".into())));
    }

    /// A named day that has not come round yet this year was last year.
    #[test]
    fn a_named_day_still_ahead_belongs_to_last_year() {
        assert_eq!(w("что было 20 декабря"), Some(("2025-12-20".into(), "2025-12-20".into())));
    }

    #[test]
    fn a_date_written_out() {
        assert_eq!(w("что поменялось 2026-08-31"), Some(("2026-08-31".into(), "2026-08-31".into())));
        assert_eq!(w("what did we do in 2026-08"), Some(("2026-08".into(), "2026-08".into())));
    }

    /// The whole point of the gate: a question about a topic is not a question
    /// about a period, and must be searched exactly as it was before.
    #[test]
    fn a_question_with_no_time_in_it_names_no_period() {
        assert!(window_of("что мы делали по фазе 4", today()).is_none());
        assert!(window_of("why did the cross build pick the wrong architecture", today()).is_none());
        assert!(window_of("как устроена очередь заметок", today()).is_none());
        assert!(window_of("", today()).is_none());
    }

    /// A word that merely contains a time word is not one — the failure a
    /// substring scan would make on every prompt mentioning a weekday column or
    /// a `today()` helper.
    #[test]
    fn a_time_word_inside_another_word_does_not_count() {
        assert!(window_of("rename the todayish helper in scheduler.rs", today()).is_none());
        assert!(window_of("переименуй вчерашний флаг в конфиге", today()).is_none());
    }

    /// The reason [`MONTHS`] holds exact forms. A three-letter prefix turns
    /// every count of markers, separators and declarations into a date.
    #[test]
    fn a_number_beside_an_ordinary_word_is_not_a_date() {
        for p in [
            "rename 3 markers in the timeline",
            "split this into 3 separate modules",
            "there are 2 declarations of the same symbol",
            "перенеси 3 маркера в другой слой",
        ] {
            assert!(window_of(p, today()).is_none(), "{p}");
        }
    }
}
