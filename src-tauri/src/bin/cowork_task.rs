//! CLI a Claude Code session uses to file its own ticket:
//!
//!     "$COWORK_TASK_BIN" new --kind bug --title "…"   # body on stdin
//!     "$COWORK_TASK_BIN" done <id>
//!
//! It links the same `tasks` module the app does, so there is exactly one
//! implementation of the card format. It writes the file directly — no TCP, no
//! listener — so filing a ticket works even when the app window is busy.
use cowork_deck::tasks::fs::FsTaskProvider;
use cowork_deck::tasks::model::{TaskDraft, TaskKind, TaskOrigin};
use cowork_deck::tasks::provider::TaskProvider;
use std::io::Read;

#[derive(Debug, PartialEq, Eq)]
pub enum Cmd {
    New { kind: String, title: String },
    Done { id: String },
}

pub fn kind_from_str(s: &str) -> Option<TaskKind> {
    match s {
        "bug" => Some(TaskKind::Bug),
        "task" => Some(TaskKind::Task),
        "idea" => Some(TaskKind::Idea),
        _ => None,
    }
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
        "" => Err("a subcommand is required: new | done".into()),
        other => Err(format!("unknown subcommand: {other}")),
    }
}

const USAGE: &str = "\
cowork_task — file a card in the cowork-deck tracker.

  cowork_task new --kind bug|task|idea --title \"…\"   (the body is read from stdin)
  cowork_task done <id>

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
    let provider = FsTaskProvider::new(std::path::PathBuf::from(&dir), false);

    match cmd {
        Cmd::New { kind, title } => {
            let kind = kind_from_str(&kind)
                .ok_or_else(|| format!("unknown --kind: {kind} (bug|task|idea)"))?;
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
    }
}

fn main() {
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

    #[test]
    fn kind_strings_map_to_the_model() {
        assert_eq!(kind_from_str("bug"), Some(TaskKind::Bug));
        assert_eq!(kind_from_str("idea"), Some(TaskKind::Idea));
        assert_eq!(kind_from_str("task"), Some(TaskKind::Task));
        assert_eq!(kind_from_str("whatever"), None);
    }
}
