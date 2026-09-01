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

use super::sidecar::Scope;

/// The shortest a prompt can be and still be worth a search, in characters.
///
/// Measured against the case the gate exists for: "fix this indent" is fifteen.
/// A question that memory could answer is a sentence, and a sentence in any
/// language this app expects is longer than this.
const MIN_CHARS: usize = 24;

/// And in words, because a long pasted path is not a question.
const MIN_WORDS: usize = 4;

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
    if p.chars().count() < MIN_CHARS {
        return false;
    }
    if p.split_whitespace().count() < MIN_WORDS {
        return false;
    }
    // Something has to be a word. A path, a hash and a URL are all long and all
    // unanswerable from a corpus of prose.
    p.chars().filter(|c| c.is_alphabetic()).count() >= MIN_CHARS / 2
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
pub fn context_block(scope: &Scope, hits: &[super::sidecar::Hit]) -> String {
    if hits.is_empty() {
        // No directive, and no hits that did not match. The one sentence that
        // stops an empty result reading as a closed question.
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
    let mut out = String::from(
        "Memory — what earlier sessions wrote down about this, closest first. These are \
         notes, not a record of truth: they may be out of date, and they are not an \
         answer to the question above.\n",
    );
    for hit in hits {
        out.push_str(&format!("\n- {} — {}\n", hit.file, passage(&hit.text)));
    }
    out.push_str(
        "\nThe `search_memory` tool searches the same corpus with a question of your own, \
         and `read_memory_note` reads any of the files above whole.",
    );
    out
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
        }
    }

    /// The case the gate exists for, named in #388: "Fix this indent" should not
    /// pay for a process and a model load.
    #[test]
    fn a_short_instruction_is_not_worth_a_search() {
        assert!(!worth_searching("fix this indent"));
        assert!(!worth_searching("ok"));
        assert!(!worth_searching("продолжай"));
        assert!(!worth_searching("   "));
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
        let out = context_block(&Scope::Workspace("ws-1".into()), &[]);
        assert!(out.contains("nothing on that"), "{out}");
        assert!(!out.to_lowercase().contains("use these"), "{out}");
        assert!(out.contains("not the same as it not being so"), "{out}");
    }

    #[test]
    fn hits_are_named_by_their_file_and_carry_a_bounded_passage() {
        let long = "word ".repeat(200);
        let out = context_block(
            &Scope::Workspace("ws-1".into()),
            &[hit("ws-1/Sessions/2026-08/31-a.md", &long)],
        );
        assert!(out.contains("ws-1/Sessions/2026-08/31-a.md"));
        assert!(out.contains('…'), "a long passage is trimmed: {out}");
        assert!(out.len() < 900, "and bounded: {}", out.len());
        // Notes, not truth, and not an answer — the two sentences that keep an
        // agent from treating this block as the question being closed.
        assert!(out.contains("may be out of date"));
        assert!(out.contains("not an answer"));
    }

    /// Markdown in a chunk is flattened: what goes in front of a prompt is prose,
    /// not a heading tree.
    #[test]
    fn a_passage_is_flattened_into_one_line() {
        let out = passage("# a note\n\n## TL;DR\nit read the host triple\n");
        assert_eq!(out, "a note TL;DR it read the host triple");
    }
}
