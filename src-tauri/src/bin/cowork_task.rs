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
                        kind = argv.get(i + 1).ok_or("--kind без значения")?.clone();
                        i += 2;
                    }
                    "--title" => {
                        title = Some(argv.get(i + 1).ok_or("--title без значения")?.clone());
                        i += 2;
                    }
                    other => return Err(format!("неизвестный аргумент: {other}")),
                }
            }
            let title = title.ok_or("нужен --title")?;
            if title.trim().is_empty() {
                return Err("--title пустой".into());
            }
            Ok(Cmd::New { kind, title })
        }
        "done" => {
            let id = argv.get(2).ok_or("нужен id карточки")?.clone();
            Ok(Cmd::Done { id })
        }
        "" => Err("нужна подкоманда: new | done".into()),
        other => Err(format!("неизвестная подкоманда: {other}")),
    }
}

const USAGE: &str = "\
cowork_task — оформить карточку в трекере cowork-deck.

  cowork_task new --kind bug|task|idea --title \"…\"   (тело читается со stdin)
  cowork_task done <id>

Требует переменных окружения, которые дека выставляет сессии:
  COWORK_TASKS_DIR  каталог карточек
  COWORK_PROJECT    имя проекта (пишется в поле project:)
  COWORK_SESSION    id сессии (необязательно)
";

fn env_var(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("не задана переменная окружения {name}\n\n{USAGE}")),
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
                .ok_or_else(|| format!("неизвестный --kind: {kind} (bug|task|idea)"))?;
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
            Ok(format!("создана карточка {} — {}", card.id, card.path))
        }
        Cmd::Done { id } => {
            let card = provider.resolve(&id).map_err(|e| e.to_string())?;
            Ok(format!("закрыта карточка {}", card.id))
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
        let argv = ["cowork_task", "new", "--kind", "bug", "--title", "Пилюля мигает"]
            .map(String::from).to_vec();
        match parse_args(&argv) {
            Ok(Cmd::New { kind, title }) => {
                assert_eq!(kind, "bug");
                assert_eq!(title, "Пилюля мигает");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn kind_defaults_to_task() {
        let argv = ["cowork_task", "new", "--title", "Просто задача"].map(String::from).to_vec();
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
        assert_eq!(kind_from_str("нечто"), None);
    }
}
