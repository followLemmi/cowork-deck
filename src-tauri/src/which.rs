//! Discovery of executables the app needs but does not bundle (claude, gh).
//!
//! An app launched from Finder, the Dock or a .desktop file inherits the
//! display session's minimal PATH, not the login shell's — so "not on PATH"
//! is not "not installed", and worse, the PATH may hold an *older* copy than
//! the one the user's shell would pick. Discovery therefore tries: the PATH,
//! then the directories installers actually use, then the login shell itself;
//! and a candidate only counts once the caller's validator accepts it, so a
//! too-old copy on the PATH loses to a good one further down the list.

/// How an executable was found. `path_env` is the login shell's `$PATH`,
/// captured when discovery had to go through that shell: a program that is
/// really an `env node` script (npm's claude), or one that spawns helpers,
/// needs that PATH in its own environment too.
///
/// Read it as "the environment this program was *validated* under", nothing
/// wider: it is `None` for every other route, including ones whose spawns
/// still need a real PATH. A caller that wants a PATH regardless of how the
/// program turned up wants `login_path` behind this.
#[derive(Clone)]
pub struct Resolution {
    pub program: String,
    pub path_env: Option<String>,
}

impl Resolution {
    /// A Command for this program, with the captured PATH applied when there
    /// is one. Every spawn of a discovered executable should start here —
    /// a bare `Command::new(&r.program)` quietly loses the environment the
    /// program was validated under.
    pub fn command(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.program);
        if let Some(p) = &self.path_env {
            cmd.env("PATH", p);
        }
        cmd
    }
}

/// The baseline validator: the program executes and `--version` succeeds.
/// Bounded, like every discovery probe: a probe that can hang is a window
/// that can freeze, because discovery may sit on a session-start path.
pub fn version_runs(r: &Resolution) -> bool {
    let mut cmd = r.command();
    cmd.arg("--version");
    output_with_deadline(cmd, std::time::Duration::from_secs(5))
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Candidate paths under the user's home directory, kept only if they exist.
pub fn under_home(rels: &[&str]) -> Vec<String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let Some(home) = home else { return Vec::new() };
    let home = std::path::PathBuf::from(home);
    rels.iter().map(|r| home.join(r).to_string_lossy().into_owned()).collect()
}

/// PATH names first, then explicit candidate paths, then the login shell.
/// `usable` is the gate for every stage.
pub fn discover(
    names: &[&str],
    candidates: &[String],
    usable: &dyn Fn(&Resolution) -> bool,
) -> Option<Resolution> {
    let bare = |p: &str| Resolution { program: p.to_string(), path_env: None };
    for n in names {
        let r = bare(n);
        if usable(&r) {
            return Some(r);
        }
    }
    for p in candidates {
        if !std::path::Path::new(p).exists() {
            continue;
        }
        let r = bare(p);
        if usable(&r) {
            return Some(r);
        }
    }
    login_shell(names.first()?, usable)
}

fn login_shell(name: &str, usable: &dyn Fn(&Resolution) -> bool) -> Option<Resolution> {
    if cfg!(windows) {
        return None;
    }
    // `-l -c` is POSIX-shell syntax; an exotic $SHELL (nushell, tcsh) fails
    // the probe and we report "not found" rather than guess at its flags.
    // `name` is a compile-time literal ("claude", "gh"), never user input.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-c", &format!(r#"command -v {name}; printf '%s\n' "$PATH""#)]);
    // A login shell runs the user's profile, which can do anything, including
    // hang — and this can sit on a session-start path. Bound it.
    let out = output_with_deadline(cmd, std::time::Duration::from_secs(5))?;
    if !out.status.success() {
        return None;
    }
    // Login profiles are free to echo to stdout; our answers are the last two
    // non-empty lines — $PATH, and above it the program's path. If the shell
    // did not find the program its line is simply absent, and validation
    // rejects whatever profile noise took its place.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines().rev().filter(|l| !l.trim().is_empty());
    let path_env = lines.next()?.trim().to_string();
    let program = lines.next()?.trim().to_string();
    let r = Resolution { program, path_env: Some(path_env) };
    usable(&r).then_some(r)
}

/// `Command::output()` with a time limit: polls, and kills the child when the
/// deadline passes. Both pipes are read only after exit, so a child that
/// fills a pipe buffer stalls itself — and then the deadline reaps it.
/// Fail-closed by design; this guards probes, not results anyone waits on.
pub fn output_with_deadline(
    mut cmd: std::process::Command,
    deadline: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::Read;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_end(&mut stdout);
                }
                let mut stderr = Vec::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_end(&mut stderr);
                }
                return Some(std::process::Output { status, stdout, stderr });
            }
            Ok(None) if started.elapsed() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// The login shell's `$PATH`, independent of how anything was discovered.
///
/// `Resolution::path_env` carries one only when discovery had to consult the
/// login shell, and that is the wrong condition for a session: the PATH is
/// needed less by `claude` itself than by everything it spawns — stdio MCP
/// servers (`npx ...`, `#!/usr/bin/env node` shims), hooks, the Bash tool.
/// They all resolve through PATH, whatever `claude` is.
///
/// The nesting inverts the usual expectation, which is why it went unnoticed:
/// an npm-installed `claude` works, because it fails `version_runs` under
/// launchd's PATH, falls through to the login shell and picks up a PATH on the
/// way. A natively installed one is a self-contained binary, so it passes at
/// the candidate-paths stage and short-circuits the only stage that captures
/// anything — and its sessions then find no `node` (#332).
///
/// One login shell per process, bounded like every probe here. `None` on
/// Windows, and on an exotic `$SHELL` that cannot do `-l -c`.
pub fn login_path() -> Option<String> {
    // Failures are cached too, unlike the discovery caches next door. Those
    // stay retryable because installing the missing program is a thing a user
    // does while the app runs; nothing anyone does mid-session turns a `$SHELL`
    // that cannot do `-l -c` into one that can, and re-probing would spend a
    // login shell per launch to learn the same answer.
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(probe_login_path).clone()
}

/// The marker the probe prints its answer behind. Prefixed rather than printed
/// bare because login profiles echo to stdout, and here — unlike `login_shell`,
/// where a wrong line loses to validation — nothing downstream would catch
/// profile noise handed to a session as its PATH. It also keeps an empty
/// `$PATH` distinguishable from a shell that printed nothing at all.
const PATH_MARKER: &str = "cowork-path=";

fn probe_login_path() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-c", &format!(r#"printf '{PATH_MARKER}%s\n' "$PATH""#)]);
    // A login shell runs the user's profile, which can do anything, including
    // hang. Bound it; this sits on a session-start path.
    let out = output_with_deadline(cmd, std::time::Duration::from_secs(5))?;
    if !out.status.success() {
        return None;
    }
    marked_path(&String::from_utf8_lossy(&out.stdout))
}

/// The last marked line's value, empty rejected — a shell that answered with
/// nothing is a shell that gave us no PATH, not a PATH of nothing.
fn marked_path(stdout: &str) -> Option<String> {
    let path = stdout.lines().rev().find_map(|l| l.trim().strip_prefix(PATH_MARKER))?;
    (!path.is_empty()).then(|| path.to_string())
}

/// Why a bounded run did not produce an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunFault {
    /// The program could not be started at all.
    Spawn(String),
    /// The deadline passed and the child was killed.
    Timeout,
    /// It ran and exited non-zero. `stderr` is the program's own, lossily
    /// decoded.
    Exit { code: Option<i32>, stderr: String },
}

impl std::fmt::Display for RunFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunFault::Spawn(e) => write!(f, "could not start it ({e})"),
            RunFault::Timeout => write!(f, "it did not answer in time"),
            RunFault::Exit { code, stderr } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                let tail = stderr.trim();
                if tail.is_empty() {
                    write!(f, "it exited {code} and said nothing")
                } else {
                    write!(f, "it exited {code}: {tail}")
                }
            }
        }
    }
}

/// Run a program with a body on stdin and a time limit, and give back its
/// stdout.
///
/// [`output_with_deadline`] cannot do this job, for two reasons rather than one.
/// It nulls stdin, so there is nowhere to put a body; and it reads both pipes
/// only *after* the child exits, which is fine for a probe whose output is a
/// version string and a deadlock for anything that writes more than a pipe
/// buffer before it finishes. Here stdin, stdout and stderr each get a thread,
/// so no combination of who-writes-how-much can wedge either side.
///
/// # Why the body goes on stdin and never in argv
///
/// A prompt built from a session transcript is the person's own work and
/// possibly their secrets. `argv` is world-readable through `ps` for the
/// lifetime of the process; a pipe is not. It is also unbounded where `argv` is
/// capped by `ARG_MAX`, so the same choice removes a size limit that would
/// otherwise have to be guessed at.
pub fn output_with_stdin_and_deadline(
    mut cmd: std::process::Command,
    stdin_body: &str,
    deadline: std::time::Duration,
) -> Result<String, RunFault> {
    use std::io::{Read, Write};
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| RunFault::Spawn(e.to_string()))?;

    // Owned by the thread so the pipe is closed when it finishes: a child
    // waiting for an EOF on stdin that never comes is a child that never exits,
    // and the deadline would be the only thing ending the call.
    let body = stdin_body.to_string();
    let sink = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(mut sink) = sink {
            // Deliberately not fatal. The program may have exited already — a
            // bad argument, no credentials — and a `BrokenPipe` here would
            // report that as a write failure instead of letting its own message
            // through, which is the rule `run_gh_with_stdin` follows.
            let _ = sink.write_all(body.as_bytes());
        }
    });

    let mut out_pipe = child.stdout.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = out_pipe.as_mut() {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let mut err_pipe = child.stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = err_pipe.as_mut() {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunFault::Timeout);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) => return Err(RunFault::Spawn(e.to_string())),
        }
    };

    // The pipes are closed by the child's exit, so these return promptly.
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let _ = writer.join();

    if !status.success() {
        return Err(RunFault::Exit {
            code: status.code(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

#[cfg(test)]
mod stdin_deadline_tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    /// The property the capture prompt depends on: a body of any size goes in
    /// and comes back whole, with no size limit borrowed from `ARG_MAX`.
    #[test]
    #[cfg(unix)]
    fn a_body_goes_in_on_stdin_and_comes_back_on_stdout() {
        let body = "a".repeat(500_000);
        let out =
            output_with_stdin_and_deadline(Command::new("cat"), &body, Duration::from_secs(30))
                .expect("cat");
        assert_eq!(out.len(), body.len(), "half a megabyte round-trips");
    }

    /// The deadlock `output_with_deadline` would hit here: a child that writes
    /// more than a pipe buffer before exiting, while nobody is reading.
    #[test]
    #[cfg(unix)]
    fn a_child_that_writes_more_than_a_pipe_buffer_does_not_wedge() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "yes abcdefghij | head -n 40000"]);
        let out = output_with_stdin_and_deadline(cmd, "", Duration::from_secs(30))
            .expect("it must finish rather than stall until the deadline");
        assert_eq!(out.lines().count(), 40_000);
    }

    #[test]
    #[cfg(unix)]
    fn a_child_that_never_answers_is_reaped_at_the_deadline() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let started = std::time::Instant::now();
        let fault = output_with_stdin_and_deadline(cmd, "", Duration::from_millis(300))
            .expect_err("a hung child must not be waited on forever");
        assert_eq!(fault, RunFault::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5), "and reaped promptly");
    }

    #[test]
    #[cfg(unix)]
    fn a_child_that_exits_non_zero_reports_its_own_message() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo 'it went wrong' >&2; exit 3"]);
        let fault = output_with_stdin_and_deadline(cmd, "", Duration::from_secs(30))
            .expect_err("a non-zero exit is a fault");
        match fault {
            RunFault::Exit { code, ref stderr } => {
                assert_eq!(code, Some(3));
                assert!(stderr.contains("it went wrong"), "{stderr}");
            }
            other => panic!("expected an exit fault, got {other:?}"),
        }
        assert!(fault.to_string().contains("it went wrong"), "{fault}");
    }

    /// A child that exits without draining stdin must not turn its own message
    /// into a write failure — the rule `run_gh_with_stdin` follows.
    #[test]
    #[cfg(unix)]
    fn a_child_that_ignores_stdin_is_not_reported_as_a_broken_pipe() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo done"]);
        let out = output_with_stdin_and_deadline(cmd, &"x".repeat(500_000), Duration::from_secs(30))
            .expect("the child's own success, not a BrokenPipe");
        assert_eq!(out.trim(), "done");
    }

    #[test]
    fn a_program_that_is_not_there_says_so() {
        let cmd = Command::new("cowork-deck-no-such-program-anywhere");
        let fault = output_with_stdin_and_deadline(cmd, "", Duration::from_secs(5))
            .expect_err("a missing program is a fault");
        assert!(matches!(fault, RunFault::Spawn(_)), "{fault:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_path_survives_a_chatty_profile() {
        // Both halves of what a profile does: noise before the answer, and
        // noise after it — the second is why the marker exists at all.
        let out = "nvm: using v22\ncowork-path=/opt/homebrew/bin:/usr/bin\nWelcome!\n";
        assert_eq!(marked_path(out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    }

    #[test]
    fn marked_path_rejects_silence_and_emptiness() {
        // A profile that printed something else entirely, and a `$PATH` that
        // was genuinely empty. Both mean "no PATH to hand on".
        assert_eq!(marked_path("Welcome!\n"), None);
        assert_eq!(marked_path("cowork-path=\n"), None);
    }

    #[test]
    fn marked_path_takes_the_last_answer() {
        // A profile that re-execs the shell prints the marker twice; the
        // innermost run is the one whose PATH the session would see.
        let out = "cowork-path=/first\ncowork-path=/second\n";
        assert_eq!(marked_path(out).as_deref(), Some("/second"));
    }
}
