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

/// Runs `cowork_task guard` with `payload` on stdin and the environment a
/// hook receives. `card` becomes `COWORK_TASK_ID` when given, and is left
/// unset otherwise — the no-card row. Returns `(exit code, stdout, stderr)`
/// regardless of status: a blocking `Stop` is a deliberate non-zero exit, not
/// a failure the way `run`'s callers mean it. Claude Code feeds only stderr
/// back to the agent on exit 2 — stdout is surfaced only on exit 0 — so the
/// blocking reason has to be asserted on stderr, not stdout.
fn guard(dir: &tempfile::TempDir, card: Option<&str>, payload: &str) -> (i32, String, String) {
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut cmd = Command::new(bin);
    cmd.arg("guard")
        .env("COWORK_TASKS_DIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match card {
        Some(id) => {
            cmd.env("COWORK_TASK_ID", id);
        }
        None => {
            cmd.env_remove("COWORK_TASK_ID");
        }
    }
    let mut child = cmd.spawn().unwrap();
    // Best effort: a row with no tracker directory returns before `guard` ever
    // reads stdin, closing the read end before this write lands — same
    // reasoning as `run`'s helper above. A row with no *card* does read it: the
    // announcement is owed to `UserPromptSubmit` only, so the event name has to
    // be parsed before that path can decide anything.
    let _ = child.stdin.take().unwrap().write_all(payload.as_bytes());
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn guard_allows_and_says_nothing_without_a_card_id() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, out, err) = guard(&dir, None, r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), "");
    assert_eq!(err.trim(), "");
}

#[test]
fn guard_blocks_the_first_stop_while_the_card_is_open() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, out, err) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    // Only exit code 2 blocks a Claude Code `Stop` hook; 1 (an ordinary
    // error) and 101 (a panic) both do not, so `assert_ne!(code, 0)` would
    // pass for either and miss a regression that silently stops blocking.
    assert_eq!(code, 2, "only exit code 2 blocks a Stop hook");
    // Exit 2 feeds stderr, not stdout, back to the agent — stdout is dead
    // output here, so the reason must be on stderr, and stdout must be empty.
    assert!(out.trim().is_empty(), "stdout is not read back on exit 2: {out}");
    assert!(err.contains(&id), "the reason must name the card: {err}");
    assert!(err.contains("cowork_task"), "and the command that moves it: {err}");
}

/// Task 10's launch moves the card to the configured working step before the
/// session even starts, so a card sitting there at `Stop` time is exactly
/// where the app put it — not evidence the agent forgot to move it. Paired
/// with `guard_blocks_the_first_stop_while_the_card_is_open` above as the
/// positive control: that board has no working step, so it must keep
/// blocking; this one has one, and must not, on the very same shape of
/// input (a non-terminal, unblocked `Stop`).
#[test]
fn guard_allows_a_stop_while_the_card_is_in_the_working_step() {
    let board = r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"doing","label":"Doing","working":true},
        {"id":"done","label":"Done","terminal":true}],
        "kinds":[{"id":"task","label":"Task"}]}"#;
    let dir = tempdir_with_board(board);
    let id = create_card(&dir, "task", "A title");
    run(&dir, &["status", &id, "doing"]).unwrap();
    let (code, _, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_eq!(code, 0, "the working step must not read as \"still open\"");
}

#[test]
fn guard_allows_the_second_stop() {
    // stop_hook_active means we already blocked once. Blocking again is a loop
    // the session cannot leave.
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, _, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":true}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_a_stop_once_the_card_is_in_a_terminal_step() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    run(&dir, &["done", &id]).unwrap();
    let (code, _, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_the_card_is_gone() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, _, _) = guard(&dir, Some("01NOSUCHCARD"), r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_the_card_is_damaged() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    std::fs::write(dir.path().join("note.md"), "---\nid: 01NOTE\n---\nA note.\n").unwrap();
    let (code, _, _) = guard(&dir, Some("01NOTE"), r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_when_board_json_is_unusable() {
    let dir = tempdir_with_board("{ broken");
    let id = create_card(&dir, "task", "A title");
    // A tracker problem must not take the work hostage — the same principle by
    // which a failing watcher degrades into a delay.
    let (code, _, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    assert_eq!(code, 0);
}

#[test]
fn guard_allows_on_a_malformed_payload() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, _, _) = guard(&dir, Some(&id), "not json at all");
    assert_eq!(code, 0);
}

#[test]
fn guard_prints_the_card_and_its_step_on_a_user_prompt() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let (code, out, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    // `contains("open")` alone would also pass if the message merely said the
    // word "open" as an adjective rather than naming the card's actual step —
    // pin the step name as it would actually appear, `step "open"`.
    assert!(
        ctx.contains(&id) && ctx.contains("step \"open\"") && ctx.contains("cowork_task"),
        "{ctx}"
    );
}

/// `DEFAULT_BOARD`'s only non-terminal step happens to be *named* `open`, so
/// the test above cannot tell "the message reports the card's real step"
/// apart from "the message always says the word open" — a `guard()` that
/// hardcoded the literal text `step "open"` instead of interpolating
/// `card.status.as_str()` would still pass it. This board's non-terminal step
/// is named `todo`, so the assertion can only be satisfied by actually
/// reading the card's status.
#[test]
fn guard_reports_the_cards_real_step_not_a_hardcoded_one() {
    let dir = tempdir_with_board(
        r#"{"steps":[{"id":"todo","label":"To do"},
        {"id":"done","label":"Done","terminal":true}],"kinds":[{"id":"task","label":"Task"}]}"#,
    );
    let id = create_card(&dir, "task", "A title");
    let (code, out, _) = guard(&dir, Some(&id), r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("step \"todo\""), "must name the card's real step: {ctx}");
    assert!(!ctx.contains("\"open\""), "must not name a step this board doesn't have: {ctx}");
}

/// Task 10 pushes `COWORK_TASK_ID` unconditionally, so a session can carry a
/// card id into a workspace whose tracker directory has since gone missing
/// from the environment. Every other subcommand resolves `COWORK_TASKS_DIR`
/// first and fails loudly when it is absent, by design — but `guard` must not
/// inherit that refusal, or the one row required never to block would block
/// hardest, on a workspace with no tracker at all. Not part of the brief's
/// listed cases; added because the decision table names this row explicitly
/// and no other test exercises a wholly unset `COWORK_TASKS_DIR`.
#[test]
fn guard_allows_when_the_tracker_directory_is_unset() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let id = create_card(&dir, "task", "A title");
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .arg("guard")
        .env("COWORK_TASK_ID", &id)
        .env_remove("COWORK_TASKS_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Best effort: this row returns before `guard` reads stdin at all, so the
    // child can close its read end before this write lands.
    let _ = child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hook_event_name":"Stop","stop_hook_active":false}"#);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "a missing tracker directory must never block a Stop");
}

/// A session launched without a card gets `COWORK_TASKS_DIR`, `COWORK_PROJECT`
/// and `COWORK_TASK_BIN` in its environment and, before this, no statement
/// anywhere that they exist: the launch prompt is built only on the
/// launch-from-a-card path, and every branch of `guard` returned early on a
/// missing `COWORK_TASK_ID`. An agent does not run `env` on the off chance —
/// it reads its prompt, its hooks and its skills — so the tracker was
/// invisible to exactly the sessions that would file the first card.
#[test]
fn guard_announces_the_tracker_on_a_user_prompt_without_a_card() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, out, err) = guard(&dir, None, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0, "announcing is not blocking");
    assert!(err.trim().is_empty(), "nothing belongs on stderr here: {err}");
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    // The directory, because a card is filed into it and the agent may want to
    // read the backlog with ordinary tools; the subcommand, because knowing a
    // CLI exists is useless without the one call that files a card.
    assert!(ctx.contains(dir.path().to_str().unwrap()), "must name the tracker directory: {ctx}");
    assert!(ctx.contains("cowork_task"), "must name the CLI: {ctx}");
    assert!(ctx.contains("new"), "must name the subcommand that files a card: {ctx}");
    // `--kind` is rejected unless it is one the board configures, and no
    // subcommand lists the kinds — `steps` lists steps. Naming them here is the
    // only way an agent learns them without reading board.json itself.
    assert!(
        ctx.contains("bug") && ctx.contains("task") && ctx.contains("idea"),
        "must name the configured kinds: {ctx}"
    );
}

/// `DEFAULT_BOARD`'s kinds are the ones `default_config()` hands out, so the
/// test above cannot tell "the message reports this board's kinds" apart from
/// "the message hardcodes bug/task/idea". This board configures neither, so the
/// assertion can only be satisfied by actually reading the configuration.
#[test]
fn guard_announces_the_kinds_the_board_actually_configures() {
    let dir = tempdir_with_board(
        r#"{"steps":[{"id":"open","label":"Open"},{"id":"done","label":"Done","terminal":true}],
        "kinds":[{"id":"chore","label":"Chore"},{"id":"spike","label":"Spike"}]}"#,
    );
    let (code, out, _) = guard(&dir, None, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("chore") && ctx.contains("spike"), "must name this board's kinds: {ctx}");
    assert!(!ctx.contains("bug"), "must not name a kind this board does not have: {ctx}");
}

/// An unusable `board.json` already allows on the card path, for the reason
/// given there. The announcement has a second reason to stay silent: its whole
/// content is read off the configuration, and the fallback board's kinds are
/// not this project's — naming them would send the agent to `new --kind bug`
/// on a board that rejects it.
#[test]
fn guard_announces_nothing_without_a_card_when_board_json_is_unusable() {
    let dir = tempdir_with_board("{ broken");
    let (code, out, _) = guard(&dir, None, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), "", "a board we cannot read cannot be described");
}

/// The row that runs in every session in every workspace with no tracker
/// configured, on every turn. `COWORK_TASKS_DIR` unset means there is nothing
/// to announce, and announcing anyway would put a sentence about a tracker
/// that does not exist into every prompt the deck ever launches.
#[test]
fn guard_announces_nothing_when_no_tracker_is_configured() {
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut child = Command::new(bin)
        .arg("guard")
        .env_remove("COWORK_TASK_ID")
        .env_remove("COWORK_TASKS_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Best effort, same as the row above: this one returns before reading stdin.
    let _ = child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"UserPromptSubmit"}"#);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "");
}

/// `cowork_task guard` as a session in a GitHub workspace gets it: a repository,
/// optionally an issue, and — deliberately — no tracker directory. Returns
/// `(exit code, stdout, stderr)`.
fn gh_guard(repo: &str, issue: Option<&str>, dir: Option<&std::path::Path>, payload: &str)
    -> (i32, String, String)
{
    let bin = env!("CARGO_BIN_EXE_cowork_task");
    let mut cmd = Command::new(bin);
    cmd.arg("guard")
        .env("COWORK_ISSUE_REPO", repo)
        .env_remove("COWORK_TASK_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match issue {
        Some(n) => { cmd.env("COWORK_ISSUE_NUMBER", n); }
        None => { cmd.env_remove("COWORK_ISSUE_NUMBER"); }
    }
    match dir {
        Some(d) => { cmd.env("COWORK_TASKS_DIR", d); }
        None => { cmd.env_remove("COWORK_TASKS_DIR"); }
    }
    let mut child = cmd.spawn().unwrap();
    let _ = child.stdin.take().unwrap().write_all(payload.as_bytes());
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// The row that keeps the "file a ticket for a side problem" convention alive in
/// a GitHub workspace. `guard_allows_when_the_tracker_directory_is_unset` above
/// is the precedent for allowing when there is no reachable tracker — and it is
/// right for *its* case, an unreachable file tracker where there is nothing true
/// left to say. Here the tracker is perfectly reachable by another route, so
/// allowing *silently* would mean the contract changed under the agent with no
/// announcement.
#[test]
fn github_guard_announces_the_repository_on_a_user_prompt_without_an_issue() {
    let (code, out, err) =
        gh_guard("followLemmi/cowork-deck", None, None, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(code, 0, "announcing is not blocking");
    assert!(err.trim().is_empty(), "nothing belongs on stderr here: {err}");
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("followLemmi/cowork-deck"), "must name the repository: {ctx}");
    assert!(ctx.contains("gh issue create"), "must name the call that files one: {ctx}");
    // The non-leak invariant, on the sidecar side: no folder, no variable name,
    // no sidecar.
    assert!(!ctx.contains("COWORK_"), "must not name an environment variable: {ctx}");
    assert!(!ctx.contains("cowork_task"), "must not name the sidecar: {ctx}");
    // Per line, not over the whole string: `ctx` always names the repository, so
    // any assertion of the form "no slash unless owner/name appears" is vacuously
    // true and would pass with a filesystem path sitting right next to it.
    for line in ctx.lines() {
        assert!(
            !line.contains('/') || line.contains("followLemmi/"),
            "no filesystem path: {line}",
        );
    }
}

#[test]
fn github_guard_names_the_issue_and_how_to_close_it() {
    let (code, out, _) = gh_guard(
        "followLemmi/cowork-deck", Some("42"), None,
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("#42"), "must name the issue: {ctx}");
    assert!(ctx.contains("gh issue close 42"), "must name the close command: {ctx}");
    // The warning is the point of the sentence, not decoration.
    assert!(ctx.contains("visible to everyone"), "must say what closing costs: {ctx}");
    assert!(!ctx.contains("COWORK_"), "{ctx}");
}

/// Decision 5's refusal to block, asserted rather than intended. Closing a
/// GitHub issue is public and undoing it is a second public action; a hook that
/// holds a session hostage until the agent closes one is a hook that pressures
/// an agent into a public write.
#[test]
fn github_guard_never_blocks_a_stop_with_or_without_an_issue() {
    for issue in [None, Some("42")] {
        let (code, out, err) = gh_guard(
            "followLemmi/cowork-deck", issue, None,
            r#"{"hook_event_name":"Stop","stop_hook_active":false}"#,
        );
        assert_eq!(code, 0, "a github workspace must never block a Stop (issue: {issue:?})");
        assert!(out.trim().is_empty(), "a Stop gets no context: {out}");
        assert!(err.trim().is_empty(), "and nothing to feed back: {err}");
    }
}

/// The state that should never occur, resolved one way on purpose rather than by
/// statement order in a future edit: `COWORK_ISSUE_REPO` is dispatched first, so
/// a contradictory environment takes the GitHub branch and no folder is ever
/// named.
#[test]
fn github_guard_wins_when_a_tracker_directory_is_also_set() {
    let dir = tempdir_with_board(DEFAULT_BOARD);
    let (code, out, _) = gh_guard(
        "followLemmi/cowork-deck", Some("42"), Some(dir.path()),
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_str(&out).expect("a hook reply");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().expect("context");
    assert!(ctx.contains("gh issue close 42"), "{ctx}");
    assert!(
        !ctx.contains(dir.path().to_str().unwrap()),
        "the github branch must never name a folder: {ctx}",
    );
}
