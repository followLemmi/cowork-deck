use std::io::Write;
use std::process::{Command, Stdio};

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
        .args(["new", "--kind", "bug", "--title", "не должно записаться"])
        .env("COWORK_TASKS_DIR", dir.path())
        .env_remove("COWORK_PROJECT")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all("тело".as_bytes()).unwrap();
    let status = child.wait().unwrap();

    assert!(!status.success(), "must exit non-zero when a required env var is missing");
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(), 0,
        "the target directory must be unchanged when the command fails before writing"
    );
}
