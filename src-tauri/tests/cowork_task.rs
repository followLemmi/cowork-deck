use std::io::Write;
use std::process::{Command, Stdio};

/// The board a project gets before anyone configures it — kept in lockstep
/// with `BoardConfig::default_config()`: steps `open` (not terminal) and
/// `done` (terminal), kinds `bug`, `task`, `idea`.
const DEFAULT_BOARD: &str = r#"{"steps":[{"id":"open","label":"open"},
    {"id":"done","label":"done","terminal":true}],
    "kinds":[{"id":"bug","label":"bug"},{"id":"task","label":"task"},{"id":"idea","label":"idea"}]}"#;

/// A fresh tempdir with `board.json` already written. Returns the `TempDir`
/// guard itself — bind it in the caller (`let dir = tempdir_with_board(…)`),
/// or the directory is deleted before the test ever touches it.
fn tempdir_with_board(json: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(cowork_deck::tasks::board::BOARD_FILE), json).unwrap();
    dir
}

/// `cowork_task new --kind … --title …` in `dir`, with the environment a
/// session gets. Captures both stdout and stderr: `Ok(stdout)` on success,
/// `Err(stderr)` on failure — the only way a caller can assert on the message
/// a refusal prints, not merely on whether it failed.
fn run(dir: &tempfile::TempDir, args: &[&str]) -> Result<String, String> {
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .args(args)
        .env("COWORK_TASKS_DIR", dir.path())
        .env("COWORK_PROJECT", "deck")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Best effort: only `new` reads stdin. For `status`/`steps`/a parse error
    // the child can exit (closing its read end) before this write lands, and
    // that BrokenPipe is not this test's failure to report.
    let _ = child.stdin.take().unwrap().write_all(b"body");
    let out = child.wait_with_output().unwrap();
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// `cowork_task new` a card and hand back its id, parsed from `run`'s own
/// success message (`created card <id> — <path>`) — `run` alone cannot give
/// an id back unless `new` prints one, which it does.
fn create_card(dir: &tempfile::TempDir, kind: &str, title: &str) -> String {
    let out = run(dir, &["new", "--kind", kind, "--title", title]).expect("card creation");
    // `strip_prefix` + `expect`, not `trim_start_matches` + `.split(_).next().unwrap()`:
    // the latter's `unwrap()` can never fire (`split(_).next()` always returns
    // `Some`), so a changed success message would silently no-op the prefix
    // strip and hand back a wrong id, surfacing later as a confusing
    // `card not found: …` somewhere else entirely.
    let rest = out.strip_prefix("created card ").expect("new's message format changed");
    // `split(_).next()` always returns `Some`, so this one is genuinely infallible.
    rest.split(" — ").next().unwrap().to_string()
}

/// The text of the card whose filename carries `id` — cards are named
/// `<id>-<slug>.md`, so the id is a prefix, not the whole name.
fn card_text(dir: &tempfile::TempDir, id: &str) -> String {
    let entry = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().starts_with(id))
        .unwrap_or_else(|| panic!("no card file starts with {id}"));
    std::fs::read_to_string(entry.path()).unwrap()
}

/// Like `run`, but hands back stderr regardless of exit status. Needed for
/// the `board_error()` warning: it is printed on an otherwise *successful*
/// call, and `run` alone cannot see it — `run` discards stderr on success.
fn stderr_of(dir: &tempfile::TempDir, args: &[&str]) -> String {
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .args(args)
        .env("COWORK_TASKS_DIR", dir.path())
        .env("COWORK_PROJECT", "deck")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(b"body");
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stderr).into_owned()
}

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

#[test]
fn status_moves_a_card_to_a_configured_step() {
    let dir = tempdir_with_board(r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"done","label":"Done","terminal":true}],"kinds":[{"id":"task","label":"Task"}]}"#);
    let id = create_card(&dir, "task", "A title");
    let out = run(&dir, &["status", &id, "done"]).expect("moved");
    assert!(out.contains(&id));
    assert!(card_text(&dir, &id).contains("status: done"));
}

#[test]
fn status_refuses_an_unknown_step_and_lists_the_configured_ones() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let err = run(&dir, &["status", &id, "invented"]).unwrap_err();
    // Listing them is what lets the agent correct itself instead of guessing.
    assert!(err.contains("invented"), "{err}");
    assert!(err.contains("open") && err.contains("done"), "{err}");
}

#[test]
fn status_refuses_a_damaged_card() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    std::fs::write(dir.path().join("note.md"), "---\nid: 01NOTE\n---\nA note.\n").unwrap();
    assert!(run(&dir, &["status", "01NOTE", "done"]).is_err());
}

#[test]
fn steps_prints_one_id_per_line_in_board_order_marking_the_terminal_ones() {
    let dir = tempdir_with_board(r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"done","label":"Done","terminal":true},
        {"id":"cancelled","label":"Cancelled","terminal":true}],
        "kinds":[{"id":"task","label":"Task"}]}"#);
    let out = run(&dir, &["steps"]).expect("listed");
    assert_eq!(out.lines().collect::<Vec<_>>(), vec!["todo", "done (terminal)", "cancelled (terminal)"]);
}

#[test]
fn status_needs_both_an_id_and_a_step() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    assert!(run(&dir, &["status"]).is_err());
    assert!(run(&dir, &["status", "01ABC"]).is_err());
}

/// A corrupt `board.json` falls back to `default_config()` — the same
/// fallback the UI shows — but the agent driving this CLI cannot see the
/// UI's error banner. `steps` still lists the fallback (staying coherent with
/// what the app itself would write), but it must say on stderr that this is
/// a fallback, not the project's real configuration.
#[test]
fn steps_warns_on_stderr_when_board_json_is_unusable_but_still_lists_the_fallback() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(cowork_deck::tasks::board::BOARD_FILE), "not json").unwrap();

    let out = run(&dir, &["steps"]).expect("still lists the fallback board");
    assert_eq!(out.lines().collect::<Vec<_>>(), vec!["open", "done (terminal)"]);

    let err = stderr_of(&dir, &["steps"]);
    assert!(err.contains("board.json could not be used"), "{err}");
}
