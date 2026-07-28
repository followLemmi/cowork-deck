use std::io::Write;
use std::process::{Command, Stdio};

/// `cowork_task new --kind …` in `dir`, with the environment a session gets.
/// Returns whether it succeeded and how many `.md` files it left behind.
fn new_card(dir: &std::path::Path, kind: &str) -> (bool, usize) {
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .args(["new", "--kind", kind, "--title", "a card"])
        .env("COWORK_TASKS_DIR", dir)
        .env("COWORK_PROJECT", "deck")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"body").unwrap();
    let ok = child.wait().unwrap().success();
    let cards = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .count();
    (ok, cards)
}

/// The configuration is the only authority on which kinds exist, and the CLI is
/// a session's only way in — so `--kind` is checked against `board.json`, not
/// against a list compiled into the binary. Both directions, because a check
/// that refuses everything would pass the first half on its own.
#[test]
fn an_unconfigured_kind_is_refused_and_a_configured_one_is_accepted() {
    let default_board = tempfile::tempdir().unwrap();
    let (ok, cards) = new_card(default_board.path(), "chore");
    assert!(!ok, "the default configuration has no `chore` kind");
    assert_eq!(cards, 0, "nothing may be written for a kind the board does not define");

    let listing_chore = tempfile::tempdir().unwrap();
    std::fs::write(
        listing_chore.path().join(cowork_deck::tasks::board::BOARD_FILE),
        r#"{"steps":[{"id":"todo","label":"To do"},{"id":"done","label":"Done","terminal":true}],
            "kinds":[{"id":"chore","label":"Chore"}]}"#,
    )
    .unwrap();
    let (ok, cards) = new_card(listing_chore.path(), "chore");
    assert!(ok, "a board that lists `chore` must accept it");
    assert_eq!(cards, 1);
}

/// `cowork_task` reads `COWORK_TASKS_DIR` and `COWORK_PROJECT` from the
/// environment, not from arguments — a session run outside a configured
/// workspace must fail loudly, not scribble into an arbitrary directory. This
/// test points `COWORK_TASKS_DIR` at a real, empty directory but deliberately
/// leaves `COWORK_PROJECT` unset, so a bug that started writing before
/// validating every required var would be caught by the directory check.
#[test]
fn missing_required_env_var_exits_nonzero_and_writes_no_file() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .args(["new", "--kind", "bug", "--title", "must not be written"])
        .env("COWORK_TASKS_DIR", dir.path())
        .env_remove("COWORK_PROJECT")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all("body".as_bytes()).unwrap();
    let status = child.wait().unwrap();

    assert!(!status.success(), "must exit non-zero when a required env var is missing");
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(), 0,
        "the target directory must be unchanged when the command fails before writing"
    );
}
