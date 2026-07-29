//! CLI a Claude Code session uses to file its own ticket:
//!
//!     "$COWORK_TASK_BIN" new --kind bug --title "…"   # body on stdin
//!     "$COWORK_TASK_BIN" done <id>
//!
//! It links the same `tasks` module the app does, so there is exactly one
//! implementation of the card format. It writes the file directly — no TCP, no
//! listener — so filing a ticket works even when the app window is busy.
use cowork_deck::tasks::fs::{FsTaskProvider, RootCreation as FsRootCreation};
use cowork_deck::tasks::board::{KindId, StepId};
use cowork_deck::tasks::model::{Task, TaskDraft, TaskOrigin};
use cowork_deck::tasks::provider::{TaskPatch, TaskProvider};
use std::io::Read;

#[derive(Debug, PartialEq, Eq)]
pub enum Cmd {
    New { kind: String, title: String },
    Done { id: String },
    Status { id: String, step: String },
    Steps,
    Guard,
}

pub fn parse_args(argv: &[String]) -> Result<Cmd, String> {
    let sub = argv.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "new" => {
            let mut kind = "task".to_string();
            let mut title: Option<String> = None;
            let mut i = 2;
            while i < argv.len() {
                match argv[i].as_str() {
                    "--kind" => {
                        kind = argv.get(i + 1).ok_or("--kind needs a value")?.clone();
                        i += 2;
                    }
                    "--title" => {
                        title = Some(argv.get(i + 1).ok_or("--title needs a value")?.clone());
                        i += 2;
                    }
                    other => return Err(format!("unknown argument: {other}")),
                }
            }
            let title = title.ok_or("--title is required")?;
            if title.trim().is_empty() {
                return Err("--title is empty".into());
            }
            Ok(Cmd::New { kind, title })
        }
        "done" => {
            let id = argv.get(2).ok_or("a card id is required")?.clone();
            Ok(Cmd::Done { id })
        }
        "status" => {
            let id = argv.get(2).ok_or("a card id is required")?.clone();
            let step = argv.get(3).ok_or("a step is required")?.clone();
            Ok(Cmd::Status { id, step })
        }
        "steps" => Ok(Cmd::Steps),
        "guard" => Ok(Cmd::Guard),
        "" => Err("a subcommand is required: new | done | status | steps | guard".into()),
        other => Err(format!("unknown subcommand: {other}")),
    }
}

const USAGE: &str = "\
cowork_task — file a card in the cowork-deck tracker.

  cowork_task new --kind <kind> --title \"…\"   (the body is read from stdin)
  cowork_task done <id>                        (moves the card to the first terminal step)
  cowork_task status <id> <step>               (moves the card to a configured step)
  cowork_task steps                            (lists the configured steps, one per line)
  cowork_task guard                            (reads a Claude Code hook payload on stdin;
                                                 wired into the Stop/UserPromptSubmit hooks,
                                                 not meant to be run by hand)

Requires the environment variables the deck sets on a session:
  COWORK_TASKS_DIR  folder the cards live in
  COWORK_PROJECT    project name (written to the project: field)
  COWORK_SESSION    session id (optional)
";

fn env_var(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("environment variable {name} is not set\n\n{USAGE}")),
    }
}

fn run() -> Result<String, String> {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = parse_args(&argv).map_err(|e| format!("{e}\n\n{USAGE}"))?;

    // Env is read only after the arguments parse, so a usage error never
    // depends on where the command was run from.
    let dir = env_var("COWORK_TASKS_DIR")?;
    let project = env_var("COWORK_PROJECT")?;
    let session = std::env::var("COWORK_SESSION").ok().filter(|s| !s.trim().is_empty());

    // The in-project root is created by the app on first use; the CLI never
    // creates a root, so a stale env var cannot scatter empty folders.
    let provider = FsTaskProvider::new(std::path::PathBuf::from(&dir), FsRootCreation::Never);
    // A corrupt board.json falls back to `default_config()` silently as far as
    // `--kind`/`status`/`steps` are concerned — the UI shows its own error
    // banner for this, but an agent driving this CLI cannot see that banner,
    // and `steps` exists precisely so it does not have to guess.
    if let Some(e) = provider.board_error() {
        eprintln!("cowork_task: warning: board.json could not be used, showing the default board: {e}");
    }

    match cmd {
        Cmd::New { kind, title } => {
            // The configuration decides which kinds exist, so the check has to
            // happen here rather than in `parse_args`: the provider — and with
            // it board.json — is only resolved once the environment is read.
            let kind = KindId(kind);
            if !provider.board().has_kind(&kind) {
                return Err(format!(
                    "unknown --kind: {} (configured: {})",
                    kind.as_str(),
                    provider.board().kinds.iter().map(|k| k.id.as_str()).collect::<Vec<_>>().join(", ")
                ));
            }
            let mut body = String::new();
            // Best effort: a session may pipe a body or may not pipe anything.
            let _ = std::io::stdin().read_to_string(&mut body);
            let card = provider
                .create(TaskDraft {
                    title,
                    kind,
                    body,
                    project,
                    origin: TaskOrigin::Session,
                    session,
                })
                .map_err(|e| e.to_string())?;
            Ok(format!("created card {} — {}", card.id, card.path))
        }
        Cmd::Done { id } => {
            let card = provider.resolve(&id).map_err(|e| e.to_string())?;
            Ok(format!("closed card {}", card.id))
        }
        Cmd::Status { id, step } => {
            // Same reasoning as `New`'s `--kind` check: the configuration is
            // the only authority on which steps exist, and listing them here
            // is what lets an agent correct itself instead of guessing.
            let step = StepId(step);
            if !provider.board().has_step(&step) {
                return Err(format!(
                    "unknown step: {} (configured: {})",
                    step.as_str(),
                    provider.board().step_ids().join(", ")
                ));
            }
            let card = provider
                .update(&id, TaskPatch { status: Some(step), ..Default::default() })
                .map_err(|e| e.to_string())?;
            Ok(format!("card {} is now in {}", card.id, card.status.as_str()))
        }
        Cmd::Steps => Ok(provider
            .board()
            .steps
            .iter()
            .map(|s| if s.terminal { format!("{} (terminal)", s.id.as_str()) } else { s.id.0.clone() })
            .collect::<Vec<_>>()
            .join("\n")),
        // `main` dispatches `guard` before `run` is ever called — see `guard()`
        // and its doc comment for why it cannot share this function's
        // environment contract. This arm exists only so the match stays
        // exhaustive; nothing in `main`'s dispatch can reach it.
        Cmd::Guard => Err("internal error: guard bypasses run()".into()),
    }
}

/// Reads a hook payload on stdin and prints what that hook expects.
///
/// Every failure path allows. A tracker problem — unreadable board.json, a
/// missing card, a failing disk — must not hold a session hostage, the same way
/// a failing watcher degrades into a delay rather than a breakage.
///
/// Unlike every other subcommand, `guard` does not go through `run`'s shared
/// environment resolution: `COWORK_TASK_ID` is pushed onto a session
/// unconditionally (Task 10), so a session resumed into a workspace whose
/// tracker directory has since gone missing carries a card id with nothing to
/// resolve it against. Every other subcommand fails when `COWORK_TASKS_DIR` is
/// unset, deliberately, so a session never writes somewhere arbitrary — but a
/// non-zero `Stop` hook blocks the session, so `guard` must not inherit that
/// refusal. It resolves what it can and allows on anything missing.
fn guard() -> i32 {
    let Ok(id) = std::env::var("COWORK_TASK_ID") else { return 0 };
    if id.trim().is_empty() {
        return 0;
    }
    let Ok(dir) = std::env::var("COWORK_TASKS_DIR") else { return 0 };

    let mut payload = String::new();
    let _ = std::io::stdin().read_to_string(&mut payload);
    let event = serde_json::from_str::<serde_json::Value>(&payload).ok();
    let event_name = event
        .as_ref()
        .and_then(|v| v["hook_event_name"].as_str())
        .unwrap_or("")
        .to_string();
    let already_blocked = event
        .as_ref()
        .and_then(|v| v["stop_hook_active"].as_bool())
        .unwrap_or(false);

    // `RootCreation::Never`: a guard must not create a tracker root as a side
    // effect of reading one.
    let provider = FsTaskProvider::new(std::path::PathBuf::from(&dir), FsRootCreation::Never);
    if provider.board_error().is_some() {
        return 0;
    }
    let Ok(cards) = provider.scan() else { return 0 };
    let mine: Vec<&Task> = cards.iter().filter(|c| c.id == id).collect();
    // Not exactly one, or one we would not write into: nothing to demand.
    if mine.len() != 1 {
        return 0;
    }
    let card = mine[0];
    if card.damaged.is_some() {
        return 0;
    }
    // A card sitting in the configured working step is exactly where Task 10's
    // launch put it — it is not evidence the agent forgot to move it, so it
    // must not read as "open" here. Excluding it drops enforcement of a state
    // that is already correct; it does not drop the reminder, which the
    // launch prompt and the `UserPromptSubmit` context below both still give,
    // every turn, without repeating a block the agent can only re-stop past.
    let open = !provider.board().is_terminal(&card.status)
        && provider.board().working_step() != Some(&card.status);

    match event_name.as_str() {
        "UserPromptSubmit" => {
            let ctx = format!(
                "Tracker card {} (\"{}\") is in step \"{}\". Move it with the cowork_task CLI: \
                 \"$COWORK_TASK_BIN\" status {} <step>; \"$COWORK_TASK_BIN\" steps lists them.",
                card.id,
                card.title,
                card.status.as_str(),
                card.id,
            );
            println!(
                "{}",
                serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": ctx,
                    }
                })
            );
            0
        }
        "Stop" if open && !already_blocked => {
            // Claude Code feeds stderr, not stdout, back to the agent on exit
            // 2 — stdout is only surfaced on exit 0. Printing the reason to
            // stdout here would block the session and say nothing.
            eprintln!(
                "Card {} is still in step \"{}\". Move it with the cowork_task CLI before \
                 finishing: \"$COWORK_TASK_BIN\" status {} <step> — or \"$COWORK_TASK_BIN\" done {} \
                 if it is finished. If it should stay where it is, say so and stop again.",
                card.id,
                card.status.as_str(),
                card.id,
                card.id,
            );
            2
        }
        _ => 0,
    }
}

fn main() {
    // `guard` reads its own environment and never fails, so it is dispatched
    // before the ordinary path — see `guard`'s doc comment for why.
    if std::env::args().nth(1).as_deref() == Some("guard") {
        std::process::exit(guard());
    }
    match run() {
        Ok(msg) => println!("{msg}"),
        Err(e) => {
            eprintln!("cowork_task: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_new_with_kind_and_title() {
        let argv = ["cowork_task", "new", "--kind", "bug", "--title", "The pill keeps blinking"]
            .map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::New { kind, title }) => {
                assert_eq!(kind, "bug");
                assert_eq!(title, "The pill keeps blinking");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn kind_defaults_to_task() {
        let argv = ["cowork_task", "new", "--title", "Just a task"].map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::New { kind, .. }) => assert_eq!(kind, "task"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn new_without_title_is_a_usage_error() {
        let argv = ["cowork_task", "new"].map(String::from).to_vec();
        assert!(parse_args(&argv).is_err());
    }

    #[test]
    fn parses_done_with_an_id() {
        let argv = ["cowork_task", "done", "01ABC"].map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::Done { id }) => assert_eq!(id, "01ABC"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn unknown_subcommand_is_an_error_not_a_silent_noop() {
        let argv = ["cowork_task", "frobnicate"].map(String::from).to_vec();
        assert!(parse_args(&argv).is_err());
    }
}
