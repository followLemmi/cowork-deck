//! One running app per config directory, and how the second launch says so.
//!
//! Nothing used to stop a second process. Five of them were found alive on one
//! machine, three two days old (#361), and every one of them was running the
//! five-minute sync cycle — `publish`, then `job::sync_once`, which stages,
//! commits, rebases and pushes **the config directory itself** (ADR-0006). Two
//! cycles that overlap contend on `.git/index.lock`, and a rebase one process
//! starts is a rebase the other finds in progress. The fault reached the person
//! as an amber indicator with a git error nobody could place.
//!
//! # The config directory is the thing being claimed, not the machine
//!
//! What is contended is one directory: the git repository, the memory corpus and
//! the store are all inside it, and two processes sharing it is the whole defect.
//! Two processes that do *not* share it are contending over nothing and are
//! nobody's business to prevent — so the claim is a lock **in that directory**
//! rather than a machine-wide name.
//!
//! That is also why `tauri-plugin-single-instance` is not what does this. It
//! keys on the bundle identifier — a DBus name on Linux, a socket on macOS — so
//! its answer to "is this app already running?" is the same for every config
//! directory on the host, and for every user account sharing one. Right question,
//! wrong key.
//!
//! # Two files, because a lock is a poor place to leave a message
//!
//! `instance.lock` is held open for the life of the process and carries an
//! exclusive OS lock. It is empty: what it holds is the lock, not bytes. The
//! lock is owned by the open file itself, so it is released when the process
//! exits **however it exits** — a stale claim after a crash or a `kill -9` is
//! not a case that can arise, which is exactly what a pid file could not
//! promise.
//!
//! `instance.json` is where the holder says how to reach it. It is separate
//! because the Windows form of "exclusive" is a handle opened with no sharing at
//! all, and a file no other process may open cannot also be a message.
//!
//! # Where this runs
//!
//! As a Tauri plugin rather than in `setup`. Plugins are initialised in
//! `Builder::build`, and the windows declared in `tauri.conf.json` are created
//! later, when the event loop reports ready — `RuntimeRunEvent::Ready`, in
//! `tauri::app`. So a second launch that exits from here never puts a window on
//! screen, and never reaches `run_journal::sweep_and_compact`, which would
//! otherwise close the *live* instance's open runs on its way past.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

/// The file whose lock is the claim.
const LOCK: &str = "instance.lock";

/// Where the holder leaves its pid and the port it listens on.
const ADDRESS: &str = "instance.json";

/// How long a second launch will wait to deliver "focus your window" before
/// giving up and exiting anyway. It is about to disappear either way; the point
/// of the timeout is that it disappears promptly.
const REACH: Duration = Duration::from_secs(2);

/// What a claim came to.
pub enum Claim {
    /// This process holds the directory, for as long as it holds the file.
    Held(File),
    /// Another process holds it.
    Taken,
}

/// The lock, parked for the life of the process. Dropping the `File` would
/// release the claim while the app is still running, so it is never dropped.
static HELD: OnceLock<File> = OnceLock::new();

/// The handle a focus request is served with. Set only by the instance that
/// won the claim, which is why a request that arrives at a process holding
/// nothing is a no-op rather than a panic.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// How to reach the instance that holds the directory.
///
/// The port is optional because the claim is made before the listener binds:
/// between those two moments the holder can say who it is but not how to be
/// reached, and "no port" is then read as "cannot be asked to focus", which is
/// the truth rather than a fallback.
#[derive(serde::Serialize, serde::Deserialize)]
struct Address {
    pid: u32,
    #[serde(default)]
    port: Option<u16>,
}

/// Take the lock on `dir`, or report that somebody else has it.
///
/// An `Err` is neither of those: it means the question could not be asked —
/// a directory that cannot be written, a filesystem with no lock to take. See
/// [`plugin`] for what is done about that, and why.
pub fn claim(dir: &Path) -> std::io::Result<Claim> {
    lock(&dir.join(LOCK))
}

/// `flock`, and deliberately not `fcntl`: an `fcntl` lock is owned by the
/// *process*, so it would be released by any close of any descriptor on the
/// file and would not conflict with a second lock taken by the same process —
/// which would make the tests below pass while the guard did nothing.
#[cfg(unix)]
fn lock(path: &Path) -> std::io::Result<Claim> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    // Safety: `file` owns the descriptor and outlives the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Claim::Held(file));
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(Claim::Taken),
        _ => Err(err),
    }
}

/// Windows has no `flock`. Its form of exclusivity is an open with no sharing:
/// while this handle is alive nobody else can open the file at all, and what a
/// second attempt gets back is a sharing violation.
#[cfg(windows)]
fn lock(path: &Path) -> std::io::Result<Claim> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => Ok(Claim::Held(file)),
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION)
            ) =>
        {
            Ok(Claim::Taken)
        }
        Err(e) => Err(e),
    }
}

/// Say who holds the directory, and — once the listener has a port — how to
/// reach it. Overwritten rather than appended: the last writer is the holder.
fn write_address(dir: &Path, port: Option<u16>) {
    let addr = Address { pid: std::process::id(), port };
    if let Ok(text) = serde_json::to_string(&addr) {
        let _ = std::fs::write(dir.join(ADDRESS), text);
    }
}

/// Record the port a second launch should knock on. Called once the listener is
/// bound, because until then there is nothing to knock on.
pub fn publish_port(dir: &Path, port: u16) {
    if HELD.get().is_none() {
        return;
    }
    write_address(dir, Some(port));
}

/// Ask the instance that holds `dir` to bring its window forward, and report
/// the pid it says it has.
///
/// A best-effort errand on the way out. The address can be missing (the holder
/// claimed the directory a moment ago and has not bound its listener yet) or
/// stale (a crashed instance's file, in the sliver between the new holder taking
/// the lock and overwriting it) — in which case the worst that happens is one
/// JSON line delivered to whatever now owns that port, and a launch that quietly
/// does nothing instead of quietly starting a second app.
fn ask_to_focus(dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(dir.join(ADDRESS)).ok()?;
    let addr: Address = serde_json::from_str(&text).ok()?;
    if let Some(port) = addr.port {
        let target = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(mut sock) = std::net::TcpStream::connect_timeout(&target, REACH) {
            let _ = sock.set_write_timeout(Some(REACH));
            let line = serde_json::json!({ "session": "-", "kind": "focus" }).to_string();
            let _ = sock.write_all(line.as_bytes());
            let _ = sock.write_all(b"\n");
            let _ = sock.flush();
        }
    }
    Some(addr.pid)
}

/// Serve a focus request: what a second launch asked for instead of starting.
///
/// The main window and not the pill — the pill is deliberately unfocusable
/// (`focusable(false)`, see `main.rs`), and asking it for the keyboard would be
/// asking for nothing. `unminimize` first, because a window in the dock is
/// shown and focused without ever coming back out on its own.
pub fn focus_requested() {
    let Some(app) = APP.get() else { return };
    let Some(win) = app.get_webview_window(crate::windows::MAIN) else { return };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// The guard, as the first plugin the app registers.
///
/// **It fails open.** If the claim cannot be made at all — an unwritable config
/// directory, a filesystem that has no lock to give — the app starts anyway. An
/// app that refuses to launch because of its own guard is a worse defect than
/// the one the guard prevents, and the failure it would replace is a git error
/// on a five-minute schedule rather than lost work.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("single-instance")
        .setup(|app, _api| {
            let Ok(dir) = app.path().app_config_dir() else {
                eprintln!("warning: no config directory, so nothing stops a second instance");
                return Ok(());
            };
            let _ = std::fs::create_dir_all(&dir);
            match claim(&dir) {
                Ok(Claim::Held(file)) => {
                    let _ = HELD.set(file);
                    // Immediately, and before anything can read it: this
                    // overwrites whatever a crashed instance left behind, so the
                    // window in which a third launch could find a stale port is
                    // as short as it can be made.
                    write_address(&dir, None);
                    let _ = APP.set(app.clone());
                }
                Ok(Claim::Taken) => {
                    let who = ask_to_focus(&dir)
                        .map(|pid| format!(" (pid {pid})"))
                        .unwrap_or_default();
                    eprintln!(
                        "cowork-deck is already running for {}{who}; \
                         asking that window to come forward instead of starting a second app.",
                        dir.display()
                    );
                    // Nothing has been built yet — no window, no journal, no
                    // sync loop — so there is nothing to unwind, and the lock
                    // this process never took is not its to release.
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("warning: could not claim {} ({e}); starting anyway", dir.display());
                }
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(c: &Claim) -> bool {
        matches!(c, Claim::Held(_))
    }

    /// The whole point, and the reason the lock is `flock` rather than `fcntl`:
    /// a second claim is refused even when it is made by the same process.
    #[test]
    fn a_second_claim_on_one_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let first = claim(dir.path()).unwrap();
        assert!(held(&first));
        assert!(!held(&claim(dir.path()).unwrap()));
    }

    /// Two config directories are two apps contending over nothing. This is the
    /// case a machine-wide guard gets wrong.
    #[test]
    fn a_claim_on_another_directory_is_granted() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let _first = claim(a.path()).unwrap();
        assert!(held(&claim(b.path()).unwrap()));
    }

    /// What a crash leaves behind. Dropping the file is the only thing that
    /// releases the claim, and the OS does it on exit however the exit happened.
    #[test]
    fn the_claim_is_released_when_the_holder_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let first = claim(dir.path()).unwrap();
        assert!(held(&first));
        drop(first);
        assert!(held(&claim(dir.path()).unwrap()));
    }

    /// The address is what a second launch reads to find the first, so what it
    /// says has to survive the round trip.
    #[test]
    fn the_address_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        write_address(dir.path(), Some(51234));
        let text = std::fs::read_to_string(dir.path().join(ADDRESS)).unwrap();
        let addr: Address = serde_json::from_str(&text).unwrap();
        assert_eq!(addr.pid, std::process::id());
        assert_eq!(addr.port, Some(51234));
    }

    /// The moment between claiming the directory and binding the listener: the
    /// holder can say who it is, but not yet how to be reached.
    #[test]
    fn an_address_without_a_port_is_readable_and_says_nothing_to_knock_on() {
        let dir = tempfile::tempdir().unwrap();
        write_address(dir.path(), None);
        let text = std::fs::read_to_string(dir.path().join(ADDRESS)).unwrap();
        let addr: Address = serde_json::from_str(&text).unwrap();
        assert_eq!(addr.port, None);
    }

    /// A directory nobody has claimed has nobody to ask, and saying so must not
    /// cost a launch anything — it is on the path of every second launch.
    #[test]
    fn asking_an_unclaimed_directory_to_focus_reports_nobody() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(ask_to_focus(dir.path()), None);
    }

    /// Nothing published the port, so nothing is knocked on — the pid is still
    /// worth having, because it is what the message to the person names.
    #[test]
    fn a_holder_with_no_port_yet_is_still_named() {
        let dir = tempfile::tempdir().unwrap();
        write_address(dir.path(), None);
        assert_eq!(ask_to_focus(dir.path()), Some(std::process::id()));
    }

    /// `publish_port` is the holder's to call. A process that lost the claim
    /// must not overwrite the winner's address on its way out.
    #[test]
    fn only_a_holder_publishes_its_port() {
        let dir = tempfile::tempdir().unwrap();
        // `HELD` is unset in the test binary: this is the losing instance.
        publish_port(dir.path(), 1234);
        assert!(!dir.path().join(ADDRESS).exists());
    }
}
