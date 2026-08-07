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
pub fn version_runs(r: &Resolution) -> bool {
    r.command()
        .arg("--version")
        .output()
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
/// deadline passes. Stdout is read only after exit, so a child that fills the
/// pipe buffer stalls itself — and then the deadline reaps it. Fail-closed by
/// design; this guards a discovery probe, not a result anyone waits on.
fn output_with_deadline(
    mut cmd: std::process::Command,
    deadline: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::Read;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_end(&mut stdout);
                }
                return Some(std::process::Output { status, stdout, stderr: Vec::new() });
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
