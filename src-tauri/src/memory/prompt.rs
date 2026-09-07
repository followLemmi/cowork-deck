//! What a session is handed with the prompt, rather than told once at startup.
//!
//! #377 gave a session the `search_memory` tool and a sentence in the system
//! prompt saying when to reach for it. #388 is the evidence that this is not
//! enough: an agent with both, asked in plain words what a phase had produced,
//! called neither and reconstructed the answer from `git log` — while a
//! `UserPromptSubmit` hook belonging to somebody's own setup injected search
//! results from a different corpus into the same turn and won.
//!
//! Two properties of that injection decided it, and both are the mechanism
//! rather than the accident: it arrived **with the prompt** rather than in the
//! system prompt — a rule about every question in general loses to context about
//! *this* question — and it was **already shaped like an answer**.
//!
//! # This amends #35, and the amendment is written down
//!
//! The epic ruled out injection on two grounds, and neither covers this. "An
//! agent that asks right before making a change phrases its query better than
//! anything guessable at startup": a hook does not guess — it has the person's
//! own words. "Memory stays off the session launch critical path": it does; this
//! is the path of a *prompt*, not of a launch. What it does add is a search on
//! the path of a prompt, which is a real cost — and the whole reason [`worth_searching`]
//! exists rather than being a refinement to add later.
//!
//! # Where the search runs
//!
//! Not in the hook process. Loading the embedding model per prompt is exactly
//! what #35 was protecting against. The hook is a thin client on the listener the
//! reporter already uses, so the search happens in the app, which owns the corpus
//! and the sidecar.
//!
//! # An empty result reads as empty
//!
//! The injection that beat the system prompt carried "use these results first"
//! above five hits from unrelated projects scoring around 0.5. Nothing in it said
//! *this project has nothing on that*. A confident-looking empty result is worse
//! than no result, because it reads as a closed question — so this block never
//! carries a directive, and says plainly when it found nothing.

use super::sidecar::{Scope, Window};
use chrono::NaiveDate;

/// The fewest words a prompt can have and still be worth a search.
///
/// The whole of the length gate, and the only part of it that ever was
/// language-neutral. Measured against the case the gate exists for: "fix this
/// indent" is three words, and stays refused.
///
/// # There was a character floor here, and it was calibrated on English
///
/// `MIN_CHARS = 24`, under a comment claiming that "a sentence in any language
/// this app expects is longer than this". #462 showed that it is not: Russian
/// says the same thing in fewer characters, and «что мы делали по фазе 4» —
/// six words, a perfectly ordinary question about this project's own history —
/// is twenty-three characters and was refused on the count alone. An English
/// interface does not imply an English question — the same assumption
/// `src/commands.ts` already refuses to make about the keyboard, where hotkeys
/// match on `e.code` because a Cyrillic layout delivers `Cmd+K` as `л`.
///
/// What replaced it is [`MIN_LETTERS`], which counts letters rather than the
/// whole string. That is not a cosmetic difference: it is a floor on how much
/// of the prompt is *words*, which is the property the gate wanted, rather than
/// on how long the prompt is, which is the property a language decides.
const MIN_WORDS: usize = 4;

/// The fewest letters a prompt can hold and still be a question.
///
/// A path, a hash and a URL are all long and all unanswerable from a corpus of
/// prose. Four words of three letters is the floor, which is the smallest thing
/// [`MIN_WORDS`] admits that is made of words at all — the number is derived
/// from the word count rather than from any language's idea of a sentence, and
/// carries over the value the old character floor happened to enforce so the
/// gate loosens in exactly one direction: the one #462 asked for.
const MIN_LETTERS: usize = 12;

/// How many passages are worth putting in front of a prompt.
///
/// Fewer than a person searching gets. This is context somebody did not ask for,
/// competing with their own `CLAUDE.md` and their project's rules, and a screen
/// of it is a screen taken from the work.
pub const TOP: usize = 4;

/// Whether this prompt is worth a search.
///
/// The gate is on the app side, where the corpus's state is known — and it is a
/// requirement rather than a refinement, because a search is a process and this
/// runs on the path of every message.
///
/// Deliberately crude. A cleverer gate would be a second model on the same path,
/// and the failure it would prevent — an occasional wasted search — is cheaper
/// than the one it would cause.
pub fn worth_searching(prompt: &str) -> bool {
    let p = prompt.trim();
    // A slash command is an instruction to the CLI, not a question about the
    // work. `/clear`, `/mcp`, `/resume`.
    if p.starts_with('/') {
        return false;
    }
    // A pasted diff, a stack trace, a block of code. Memory holds prose about
    // what happened, and matching it against a fenced block matches noise.
    if p.starts_with("```") {
        return false;
    }
    if p.split_whitespace().count() < MIN_WORDS {
        return false;
    }
    // Something has to be a word. See [`MIN_LETTERS`].
    p.chars().filter(|c| c.is_alphabetic()).count() >= MIN_LETTERS
}

/// The prompt out of a Claude Code `UserPromptSubmit` payload.
///
/// Parsed here rather than in the reporter, which has no serde and whose own
/// field scanner is documented as assuming flat, quote-free strings — which a
/// person's prompt is not. The reporter forwards the payload untouched and this
/// is the only thing that reads it.
pub fn prompt_of(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let p = v.get("prompt")?.as_str()?;
    if p.trim().is_empty() { None } else { Some(p.to_string()) }
}

/// What the hook prints, or nothing at all.
///
/// `None` is silence, and silence is the right answer to more cases than a
/// sentence is: a prompt the gate refused, and a memory that cannot search at
/// all. A session cannot act on "download the 479 MB model", and a line about it
/// above every message is the noise this feature is one bad decision away from
/// becoming. The surfaces that CAN act on it — the memory page, the settings
/// block — already say it where somebody is looking.
///
/// # Every passage carries its age
///
/// #462: a note handed over without a date reads as current, and an agent given
/// four August passages in September will describe August as what is happening
/// now. The date is on the hit already — see `cowork_memory::dates` — and this
/// is where a reader sees it, as the date and as how long ago that was, because
/// "2026-08-31" is a fact and "a week ago" is the one that changes an answer.
///
/// `window` is the period the question asked about, if it asked about one. It
/// changes nothing about the hits, which the search has already confined; it
/// changes what an empty result says, because "nothing matches that" and
/// "nothing was written down that week" are different answers and only the
/// second is true.
pub fn context_block(
    scope: &Scope,
    hits: &[super::sidecar::Hit],
    window: &Window,
    today: NaiveDate,
) -> String {
    if hits.is_empty() {
        // No directive, and no hits that did not match. The one sentence that
        // stops an empty result reading as a closed question.
        if !window.is_any() {
            return format!(
                "Memory: nothing was written down in this project between {}. That period \
                 has no notes — which is not the same as nothing having happened in it, \
                 and `git log` covers what the commits say.",
                window.describe(),
            );
        }
        return match scope {
            Scope::Workspace(_) => {
                "Memory: this project's notes have nothing on that, and neither do the \
                 lessons. Nobody has written it down yet — which is not the same as it \
                 not being so."
                    .to_string()
            }
            _ => "Memory: nothing written down matches that.".to_string(),
        };
    }
    let mut out = String::from(if window.is_any() {
        "Memory — what earlier sessions wrote down about this, closest first. These are \
         notes, not a record of truth: they may be out of date, and they are not an \
         answer to the question above.\n"
    } else {
        "Memory — what earlier sessions wrote down in the period this question is about. \
         These are notes, not a record of truth: they may be incomplete, and they are not \
         an answer to the question above.\n"
    });
    for hit in hits {
        out.push_str(&format!(
            "\n- {}{} — {}\n",
            hit.file,
            age(hit.date.as_deref(), today),
            passage(&hit.text),
        ));
    }
    out.push_str(
        "\nThe `search_memory` tool searches the same corpus with a question of your own — \
         it takes `since` and `until` for a question about a period — and \
         `read_memory_note` reads any of the files above whole.",
    );
    out
}

/// When a note was written, and how long ago that is.
///
/// Both, because they answer different questions: the date is what an agent
/// quotes back, and the distance is what tells it whether the passage is a
/// description of the work in hand or of a thing that was true in the spring.
///
/// A note the layout does not date — `Facts.md` — says nothing rather than
/// guessing, and reads as it did before this existed.
fn age(date: Option<&str>, today: NaiveDate) -> String {
    let Some(date) = date else { return String::new() };
    // `2026-08-31`, or `2026-08` for a diary, which is a month and gets no day
    // count: "a month whose distance is 6 to 37 days" is not worth a phrase.
    let Ok(when) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return format!(" ({date})");
    };
    let days = (today - when).num_days();
    let ago = match days {
        d if d < 0 => "dated ahead of today".to_string(),
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        d if d < 14 => format!("{d} days ago"),
        d if d < 60 => format!("{} weeks ago", d / 7),
        d => format!("{} months ago", d / 30),
    };
    format!(" ({date}, {ago})")
}

/// A passage, flattened and bounded.
///
/// A chunk carries its markdown and can be most of a note. What belongs in front
/// of a prompt is enough to decide whether to read the note, which is a few
/// lines rather than the file.
fn passage(text: &str) -> String {
    const MAX: usize = 320;
    let flat: String = text
        .lines()
        .map(|l| l.trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= MAX {
        return flat;
    }
    let cut: String = flat.chars().take(MAX).collect();
    match cut.rfind(' ') {
        Some(at) if at > MAX / 2 => format!("{}…", &cut[..at]),
        _ => format!("{cut}…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sidecar::Hit;

    fn hit(file: &str, text: &str) -> Hit {
        Hit {
            score: 0.6,
            file: file.to_string(),
            scope: "ws-1".to_string(),
            room: None,
            text: text.to_string(),
            date: None,
        }
    }

    /// The same, with the date the sidecar derives from the path.
    fn dated(file: &str, date: &str, text: &str) -> Hit {
        Hit { date: Some(date.to_string()), ..hit(file, text) }
    }

    /// Every date below is arithmetic from this day.
    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 6).unwrap()
    }

    /// The case the gate exists for, named in #388: "Fix this indent" should not
    /// pay for a process and a model load. It is refused on its word count, which
    /// is what #462 established the character floor was never needed for.
    #[test]
    fn a_short_instruction_is_not_worth_a_search() {
        assert!(!worth_searching("fix this indent"));
        assert!(!worth_searching("ok"));
        assert!(!worth_searching("продолжай"));
        assert!(!worth_searching("   "));
    }

    /// #462. Twenty-three characters, six words, and a question about this
    /// project's own history — refused by the old character floor on the count
    /// alone, which is how the hook came to be silent on the question that
    /// worked and loud on the one that did not.
    #[test]
    fn a_short_russian_question_is_worth_a_search() {
        assert!(worth_searching("что мы делали по фазе 4"));
        assert!(worth_searching("что мы вчера делали по проекту"));
        assert!(worth_searching("где мы остановились вчера"));
    }

    #[test]
    fn a_question_about_the_work_is() {
        assert!(worth_searching(
            "why did the cross build pick the wrong architecture last time"
        ));
        assert!(worth_searching(
            "почему сборка выбрала не ту архитектуру в прошлый раз"
        ));
    }

    /// A slash command is an instruction to the CLI, and a fenced block is code.
    #[test]
    fn neither_a_command_nor_a_pasted_block_is_a_question() {
        assert!(!worth_searching("/resume the session from yesterday please"));
        assert!(!worth_searching("```\nfn main() { println!(\"a long enough block\") }\n```"));
    }

    /// Long and unanswerable: a path, a hash, a URL.
    #[test]
    fn a_long_string_with_no_words_is_not_a_question() {
        assert!(!worth_searching("/Users/a/b/c/d/e/f/g/h/i.rs 3f21a9c8d4e5f60718293a4b5c6d7e8f"));
    }

    #[test]
    fn the_prompt_is_read_out_of_the_payload_whatever_is_in_it() {
        let payload = r#"{"session_id":"s","prompt":"why did \"it\" fail?\nsecond line","cwd":"/p"}"#;
        assert_eq!(
            prompt_of(payload).as_deref(),
            Some("why did \"it\" fail?\nsecond line"),
        );
        assert_eq!(prompt_of(r#"{"prompt":"   "}"#), None);
        assert_eq!(prompt_of("not json"), None);
    }

    /// The finding folded into #388: a confident-looking empty result is worse
    /// than no result, because it reads as a closed question.
    #[test]
    fn an_empty_result_says_so_and_carries_no_directive() {
        let out = context_block(&Scope::Workspace("ws-1".into()), &[], &Window::any(), today());
        assert!(out.contains("nothing on that"), "{out}");
        assert!(!out.to_lowercase().contains("use these"), "{out}");
        assert!(out.contains("not the same as it not being so"), "{out}");
    }

    /// A period with no notes in it is a different answer from a question with
    /// no match, and saying the first as the second closes a question that is
    /// open (#462).
    #[test]
    fn an_empty_period_names_the_period_and_leaves_git_log_standing() {
        let window =
            Window { since: Some("2026-09-05".into()), until: Some("2026-09-05".into()) };
        let out = context_block(&Scope::Workspace("ws-1".into()), &[], &window, today());
        assert!(out.contains("2026-09-05"), "{out}");
        assert!(out.contains("not the same as nothing having happened"), "{out}");
        // The fallback stays available: this is about memory being consulted
        // first, not about forbidding the commits.
        assert!(out.contains("git log"), "{out}");
    }

    #[test]
    fn hits_are_named_by_their_file_and_carry_a_bounded_passage() {
        let long = "word ".repeat(200);
        let out = context_block(
            &Scope::Workspace("ws-1".into()),
            &[hit("ws-1/Sessions/2026-08/31-a.md", &long)],
            &Window::any(),
            today(),
        );
        assert!(out.contains("ws-1/Sessions/2026-08/31-a.md"));
        assert!(out.contains('…'), "a long passage is trimmed: {out}");
        assert!(out.len() < 900, "and bounded: {}", out.len());
        // Notes, not truth, and not an answer — the two sentences that keep an
        // agent from treating this block as the question being closed.
        assert!(out.contains("may be out of date"));
        assert!(out.contains("not an answer"));
    }

    /// #462: a passage handed over without its age reads as current, which is
    /// how an August note came back as an account of what is happening now.
    #[test]
    fn every_passage_carries_its_date_and_how_old_that_is() {
        let out = context_block(
            &Scope::Workspace("ws-1".into()),
            &[
                dated("ws-1/Sessions/2026-09/05-a.md", "2026-09-05", "вчерашняя работа"),
                dated("ws-1/Sessions/2026-08/31-b.md", "2026-08-31", "прошлая неделя"),
                dated("Diaries/reviewer/2026-05.md", "2026-05", "давний урок"),
                hit("ws-1/Facts.md", "факт без даты"),
            ],
            &Window::any(),
            today(),
        );
        assert!(out.contains("(2026-09-05, yesterday)"), "{out}");
        assert!(out.contains("(2026-08-31, 6 days ago)"), "{out}");
        // A diary is a month; its distance is not worth a phrase.
        assert!(out.contains("(2026-05)"), "{out}");
        // And a note the layout does not date says nothing rather than guessing.
        assert!(out.contains("ws-1/Facts.md — факт"), "{out}");
    }

    #[test]
    fn how_old_a_note_is_reads_in_the_units_that_matter() {
        assert_eq!(age(Some("2026-09-06"), today()), " (2026-09-06, today)");
        assert_eq!(age(Some("2026-09-05"), today()), " (2026-09-05, yesterday)");
        assert_eq!(age(Some("2026-08-30"), today()), " (2026-08-30, 7 days ago)");
        assert_eq!(age(Some("2026-08-01"), today()), " (2026-08-01, 5 weeks ago)");
        assert_eq!(age(Some("2026-03-01"), today()), " (2026-03-01, 6 months ago)");
        assert_eq!(age(None, today()), "");
    }

    /// A block answering a question about a period says so, and points at the
    /// arguments an agent can use to ask its own.
    #[test]
    fn a_windowed_block_says_it_is_about_the_period() {
        let window =
            Window { since: Some("2026-09-05".into()), until: Some("2026-09-05".into()) };
        let out = context_block(
            &Scope::Workspace("ws-1".into()),
            &[dated("ws-1/Sessions/2026-09/05-a.md", "2026-09-05", "что делали")],
            &window,
            today(),
        );
        assert!(out.contains("in the period this question is about"), "{out}");
        assert!(out.contains("`since` and `until`"), "{out}");
    }

    /// The two prompts #462 was reported with, taken through the decisions the
    /// hook makes about them — the gate, then the period.
    ///
    /// The report's finding was that these two came out backwards: the hook fired
    /// on the *yesterday* question and returned passages nobody could use, and
    /// was refused outright on the *phase 4* one, where the useful answer came
    /// from the agent calling `search_memory` itself. Both are searched now, and
    /// only the one that names a period gets one.
    #[test]
    fn the_two_prompts_from_the_report_are_decided_the_right_way_round() {
        let yesterday = "что мы вчера делали по проекту";
        assert!(worth_searching(yesterday));
        assert_eq!(
            crate::memory::when::window_of(yesterday, today()),
            Some(Window { since: Some("2026-09-05".into()), until: Some("2026-09-05".into()) }),
            "the selector is *when*, and it is read off the question",
        );

        let phase = "что мы делали по фазе 4";
        assert!(worth_searching(phase), "twenty-three characters, and a real question");
        assert_eq!(
            crate::memory::when::window_of(phase, today()),
            None,
            "a lexical handle is not a period, and must be searched as before",
        );
    }

    /// Markdown in a chunk is flattened: what goes in front of a prompt is prose,
    /// not a heading tree.
    #[test]
    fn a_passage_is_flattened_into_one_line() {
        let out = passage("# a note\n\n## TL;DR\nit read the host triple\n");
        assert_eq!(out, "a note TL;DR it read the host triple");
    }
}
