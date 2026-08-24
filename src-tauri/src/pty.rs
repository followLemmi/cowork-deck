//! Every child process this app starts, and the pty it talks to.
//!
//! # What this layer may assume about its children, written down
//!
//! It was written for `claude`, and `claude` is a well-behaved child: it is one
//! process rather than a tree, it never leaves the directory it was started in,
//! the app decides when it starts and when it stops, and it reports its own
//! state through hooks. Four assumptions, none of them ever stated, and each of
//! them load-bearing somewhere in this file.
//!
//! A process a **person** drives satisfies none of them. `npm run build` started
//! from a shell runs in its own process group and outlives the shell. The person
//! types `exit`, or walks away with a two-minute build running. So the rules
//! below are the ones this file actually keeps, and they hold for `claude` too:
//!
//! - **A session is a process *session*, not a process.** `portable_pty` calls
//!   `setsid()` before exec, so the child's pid is also the session id of
//!   everything it goes on to start. That id — not the pid alone — is what
//!   `kill` works with, because a job in its own process group is reachable no
//!   other way.
//! - **Killing is asked first and enforced afterwards.** SIGTERM to the
//!   foreground group, SIGHUP and SIGTERM to the leader, a grace period, then
//!   SIGKILL to whatever is still standing in that session. Nothing is given an
//!   unbounded wait and nothing is left behind.
//! - **One id, one live process.** `spawn` refuses an id that is already running
//!   unless the caller explicitly asks to replace it, and every callback carries
//!   the generation it was born in — so a process the app has already forgotten
//!   can neither paint into its successor's terminal nor mark it ended.
//! - **Exit is reported as what happened**, not as a boolean. "Exited with code
//!   1" and "we hung it up at shutdown" are different facts and the frontend
//!   gets both.
//!
//! Windows keeps the old shape: `ChildKiller::kill` is `TerminateProcess` on the
//! direct child, and reaching the tree there needs a Job Object per session,
//! which is not built yet.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long the coalescer waits for more output before handing on what it has.
///
/// **This window is the macOS fix.** One call to `on_output` becomes one
/// `WKWebView.evaluateJavaScript` on the webview's main thread, and on Darwin the
/// tty caps a single read at 1024 bytes — four times smaller than the 4096 Linux
/// gives, so the same agent output cost four times the main-thread calls. Under a
/// streaming TUI that was hundreds of evals a second, all queued ahead of the
/// keystrokes the same thread has to deliver: the terminal drew fast and typed
/// slow. Batching cuts the call count by one to two orders of magnitude without
/// changing a byte of what is sent.
///
/// 4ms is chosen to be under a frame at 240Hz: output cannot be shown sooner than
/// the next paint anyway, so the wait is invisible, while a keystroke echo — the
/// one place latency is felt — is delayed by at most this.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);

/// Ceiling on one batch, so a process dumping megabytes (a `cat` of a log) cannot
/// grow an unbounded `Vec` before the window expires. Reached only under a flood,
/// where an extra flush costs nothing next to the bytes themselves.
const MAX_BATCH: usize = 64 * 1024;

/// Read buffer. Bigger than the 4096 it replaces because the syscall returns as
/// soon as *any* byte is available — a larger buffer costs nothing in latency and
/// saves reads whenever the pty has more than 4KB queued. On Darwin the tty caps
/// the return at 1024 regardless, which is exactly why the coalescer above exists.
const READ_BUF: usize = 64 * 1024;

/// How long a killed session is given to go quietly before its survivors are
/// SIGKILLed. Long enough for a build to run its cleanup and for a shell to hup
/// its own jobs; short enough that quitting the app does not feel hung. The
/// wait ends as soon as the session is empty, so the full two seconds are only
/// ever spent on something that is genuinely refusing to leave.
const GRACE: Duration = Duration::from_secs(2);

/// What became of a session's process.
///
/// Three outcomes that were one boolean before, and the app needs all three
/// apart: a command that failed, a process somebody stopped, and a `wait()` that
/// itself failed — which is the app not knowing, and must never be dressed up as
/// either of the other two.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Exit {
    /// The process's own exit code. `None` when it was signalled — there is no
    /// code in that case — or when the wait failed.
    pub code: Option<i32>,
    /// The signal's name as the platform spells it ("Hangup", "Terminated"),
    /// when the process was signalled.
    pub signal: Option<String>,
    /// The wait itself failed: what happened is not known. Never `true`
    /// alongside a code or a signal.
    pub unknown: bool,
}

impl Exit {
    /// The one question the old boolean answered, kept for the callers that only
    /// ever wanted that much. An unknown outcome is not success.
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    /// Whether a signal ended this process, rather than the process ending
    /// itself.
    pub fn signalled(&self) -> bool {
        self.signal.is_some()
    }
}

/// Read a `portable_pty::ExitStatus` as an `Exit`.
///
/// `ExitStatus` keeps its signal name private and offers no accessor for it:
/// `success()` and `exit_code()` are the whole public surface, and both answer
/// the same for `exit 1` and for SIGHUP. `Display` is the only place the
/// distinction survives, so it is read here — and `an_exit_status_still_spells_its_signal_out`
/// below fails loudly if a future portable-pty rewords it, rather than letting
/// every signalled session quietly become "exited with code 1" again.
fn classify(status: &portable_pty::ExitStatus) -> Exit {
    let text = status.to_string();
    match text.strip_prefix("Terminated by ") {
        Some(signal) => {
            Exit { code: None, signal: Some(signal.to_string()), unknown: false }
        }
        None => Exit { code: Some(status.exit_code() as i32), signal: None, unknown: false },
    }
}

/// A session with processes still running inside it, and how many besides the
/// session's own leader. What "there is something to lose here" is measured
/// with — see the app-level exit handler in `main.rs`.
#[derive(Debug, Clone, Serialize)]
pub struct LiveWork {
    pub session: String,
    pub processes: usize,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    /// The direct child's pid, which `setsid()` also makes the session id of
    /// every process it starts. Held because `ChildKiller` reaches exactly one
    /// process and a person's shell is a tree.
    pid: Option<u32>,
    /// This spawn's generation, in the smallest form that is still correct: the
    /// reader and waiter threads hold a clone, and clearing it is what tells
    /// them the session they belong to is gone. A counter compared against the
    /// map would need a lookup on every read; a flag handed to the threads at
    /// birth cannot be looked up wrong, and cannot be confused by an id that is
    /// spawned, killed and spawned again.
    live: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl PtyManager {
    pub fn new() -> PtyManager {
        PtyManager { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Start a process on a new pty under `session`.
    ///
    /// `replace` is the difference between the restart button and a bug. An id
    /// that is already running is **refused** by default, because the two ways
    /// this app spawns — the restart button and any spawn-on-demand — are
    /// unguarded async, so two spawns can be in flight before the first
    /// resolves. Refusing makes the second harmless; the old unconditional kill
    /// made it destructive. The restart button, which means it, passes `true`.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn<F>(
        &self,
        session: &str,
        program: &str,
        args: &[String],
        cwd: &str,
        cols: u16,
        rows: u16,
        env: &[(String, String)],
        replace: bool,
        on_output: F,
        on_exit: impl Fn(Exit) + Send + 'static,
    ) -> std::io::Result<()>
    where
        F: Fn(Vec<u8>) + Send + 'static,
    {
        // The check and the removal happen under one lock, so two concurrent
        // spawns of the same id cannot both find it free.
        let displaced = {
            let mut map = self.sessions.lock().unwrap();
            match map.remove(session) {
                Some(prev) if replace => Some(prev),
                Some(prev) => {
                    map.insert(session.to_string(), prev);
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        format!("session {session} is already running"),
                    ));
                }
                None => None,
            }
        };
        // Outside the lock: tearing a session down signals a process group and
        // may hand a sweep to a helper thread, and none of that may hold the map
        // against every other session's writes.
        if let Some(prev) = displaced {
            let sid = terminate(prev);
            sweep_later(sid);
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(to_io)?;

        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(cwd);

        // What kind of terminal is on the other end of this pty, declared here
        // because here is where the pty is made and xterm.js is the answer for
        // every caller.
        //
        // Nothing set it before, and nothing else would: `CommandBuilder`
        // inherits the app's own environment and adds none of its own, and an
        // .app launched from the Dock inherits launchd's, which has no `TERM` at
        // all. A program with no `TERM` turns colour off — Claude Code decides
        // through `supports-color`, which reports level 0 and paints its whole
        // TUI monochrome. The symptom read as a broken theme and was an empty
        // variable. It is the same launchd-minimal environment that the `PATH`
        // push in `commands.rs` already exists to work around, which is why the
        // colour was there under `tauri dev` (a shell's `TERM`, inherited) and
        // gone in the shipped bundle.
        //
        // Declared, not defaulted: an inherited `TERM` describes whatever
        // terminal launched the *app* — `dumb`, or `eterm-color` under Emacs —
        // and none of them describes the thing actually drawing these bytes. Set
        // before the caller's overrides, so a session can still name its own.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // These variables are given to the CHILD only. Neither the app's own
        // environment nor any other session's is touched — that is what the
        // isolation of GitHub accounts between workspaces stands on.
        for (k, v) in env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(to_io)?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().map_err(to_io)?));

        let live = Arc::new(AtomicBool::new(true));

        // Reader thread: stream output until EOF, or until this generation is
        // over. It does nothing but read and hand off, so a slow consumer can
        // never stall the pty and make the child block on its own stdout.
        //
        // The handle it reads is a `try_clone_reader()` **dup**, so dropping the
        // master does not close the pty and a `read()` blocked on a surviving
        // orphan never returns 0. What actually ends this thread is `kill`
        // emptying the process session, which closes the last slave and turns
        // the next read into an error. The flag is what stops it painting in the
        // meantime: bytes that arrive after the session was killed or replaced
        // belong to a process the app has already forgotten, and there is
        // exactly one terminal per session id for them to land in.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let live_read = Arc::clone(&live);
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !live_read.load(Ordering::SeqCst) {
                            break;
                        }
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Coalescer thread: collect reads that arrive within `COALESCE_WINDOW` of
        // each other and pass them on as one. Order is preserved and no byte is
        // added, dropped or reframed — a batch is exactly the concatenation of the
        // reads it replaces, which is what lets xterm's stateful UTF-8 decoder keep
        // working across a glyph split by a read boundary.
        //
        // It checks the generation flag too, and it is the one that has to: the
        // reader breaking on a dead generation drops its sender, which is a
        // `Disconnected` here and would otherwise flush a batch belonging to a
        // process the app has already forgotten into its successor's terminal.
        let live_out = Arc::clone(&live);
        std::thread::spawn(move || {
            // `recv` blocks, so nothing is polled while the session is idle, and it
            // ends the loop when the reader thread hits EOF and drops its sender.
            while let Ok(mut batch) = rx.recv() {
                let deadline = Instant::now() + COALESCE_WINDOW;
                let mut closed = false;
                while batch.len() < MAX_BATCH {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(RecvTimeoutError::Timeout) => break,
                        // The reader hit EOF. Flush what is in hand before leaving,
                        // or the last of a short-lived command's output is lost.
                        Err(RecvTimeoutError::Disconnected) => {
                            closed = true;
                            break;
                        }
                    }
                }
                if !live_out.load(Ordering::SeqCst) {
                    break;
                }
                on_output(batch);
                if closed {
                    break;
                }
            }
        });

        // Waiter thread: report what became of the process.
        //
        // Silent for a generation the app has ended itself. A `kill` is not news
        // — the caller that asked for it has already moved the tile on — and an
        // exit arriving after a replacement would otherwise mark the *new*
        // session ended while it is running, which is what the restart button
        // used to do.
        let live_wait = Arc::clone(&live);
        std::thread::spawn(move || {
            let exit = match child.wait() {
                Ok(status) => classify(&status),
                Err(_) => Exit { code: None, signal: None, unknown: true },
            };
            if !live_wait.load(Ordering::SeqCst) {
                return;
            }
            on_exit(exit);
        });

        self.sessions.lock().unwrap().insert(
            session.to_string(),
            Session { master: pair.master, writer, killer, pid, live },
        );
        Ok(())
    }

    /// A session this manager does not hold.
    ///
    /// Both `write` and `resize` used to answer `Ok(())` here, and that silence
    /// is what made a stale window undetectable: it wrote into nothing, was told
    /// nothing, and carried on believing it owned a terminal. `NotFound` is the
    /// kind, so the command layer can tell this apart from a write that reached
    /// the PTY and failed there.
    pub fn write(&self, session: &str, data: &[u8]) -> std::io::Result<()> {
        // Only hold the map lock long enough to clone out this session's writer
        // handle. The blocking IO below runs against the per-session writer
        // mutex, so a wedged write can never stall other sessions, resizes,
        // kill(), or kill_all().
        let writer = {
            let map = self.sessions.lock().unwrap();
            match map.get(session) {
                Some(s) => Arc::clone(&s.writer),
                None => return Err(no_such_session(session)),
            }
        };

        let mut w = writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, session: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let map = self.sessions.lock().unwrap();
        let Some(s) = map.get(session) else { return Err(no_such_session(session)) };
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(to_io)?;
        Ok(())
    }

    /// Sessions running a **job**, and how many processes that job is.
    ///
    /// A job is a process in the session that put itself in a process group of
    /// its own, which is exactly what a shell does with every command it is
    /// given — `npm run build`, in the foreground or behind an `&`. It is the
    /// distinction between something the person asked for and something the
    /// session started for itself: an agent's MCP servers, a language server, a
    /// helper the shell forked — all of those stay in the leader's group and are
    /// not counted. They are always there, and a quit that asked about them
    /// every time would teach the person to click through the question, which
    /// costs more than it saves.
    ///
    /// The blind spot is worth stating: an agent running a long tool call
    /// spawns it in its own group too, so this does not see it. The tile's own
    /// state chip does, and this is the measure for "the person will be angry if
    /// this dies silently", not for "something is happening".
    ///
    /// An entry whose process has already exited reports nothing and is simply
    /// absent from the answer.
    pub fn live_work(&self) -> Vec<LiveWork> {
        let map = self.sessions.lock().unwrap();
        let mut out: Vec<LiveWork> = map
            .iter()
            .filter_map(|(id, s)| {
                let leader = s.pid.map(|p| p as i32)?;
                match jobs_in_session(leader) {
                    0 => None,
                    n => Some(LiveWork { session: id.clone(), processes: n }),
                }
            })
            .collect();
        out.sort_by(|a, b| a.session.cmp(&b.session));
        out
    }

    /// Whether this id is one the manager still holds.
    ///
    /// "Still holds" rather than "still running": an entry outlives its process
    /// on purpose, because the orphans of a build it started are reachable
    /// through it and nothing else. So this answers "has this session been
    /// closed", which is the question the shell cap and the spawn guard both
    /// actually ask.
    pub fn is_live(&self, session: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session)
    }

    /// How many jobs one session is running — `live_work`, for a caller that
    /// already knows which session it is asking about. Zero for an id the
    /// manager does not hold.
    pub fn jobs(&self, session: &str) -> usize {
        let map = self.sessions.lock().unwrap();
        match map.get(session).and_then(|s| s.pid) {
            Some(pid) => jobs_in_session(pid as i32),
            None => 0,
        }
    }

    /// End a session and everything it started.
    ///
    /// Returns as soon as the polite signals are out; the grace period and the
    /// SIGKILL sweep run on a helper thread, because this is called from
    /// `close_session`, which runs on the thread that paints the window.
    pub fn kill(&self, session: &str) {
        // Remove the entry and drop the map guard before killing, so a stuck
        // writer holding only its own per-session lock can never block this.
        let removed = {
            let mut map = self.sessions.lock().unwrap();
            map.remove(session)
        };
        if let Some(s) = removed {
            sweep_later(terminate(s));
        }
    }

    /// End every session. Unlike `kill`, this waits for the sweep: the only
    /// caller is the app on its way out, and a helper thread would die with the
    /// process and leave the survivors behind — which is the orphaned build the
    /// whole exercise is about. Bounded by `GRACE`, and it returns the moment
    /// the last session is empty.
    pub fn kill_all(&self) {
        // Drain into a local Vec and drop the map guard before killing any
        // child, so kill_all can never be blocked by a stuck per-session write.
        let removed: Vec<Session> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().map(|(_, s)| s).collect()
        };
        let sids: Vec<i32> = removed.into_iter().filter_map(terminate).collect();
        sweep(&sids, GRACE);
    }
}

/// Ask a session's processes to stop, and answer with the process session id
/// that has to be swept afterwards.
///
/// Clearing the generation flag is the first thing done and is what makes the
/// rest safe: from here on, nothing this session's threads read or wait for can
/// reach the frontend.
fn terminate(s: Session) -> Option<i32> {
    s.live.store(false, Ordering::SeqCst);
    signal(s)
}

#[cfg(unix)]
fn signal(mut s: Session) -> Option<i32> {
    let pid = match s.pid {
        Some(p) if p > 0 => p as i32,
        // No pid means no group and no session to sweep; a SIGHUP to the direct
        // child is all that is left, and is what this file did before.
        _ => {
            let _ = s.killer.kill();
            return None;
        }
    };
    // Our own session. Everything below kills by session id, and a bug that let
    // one of those match ours would take the app and every process it ever
    // started with it. Nothing proceeds without this comparison.
    let own_sid = unsafe { libc::getsid(0) };
    if pid == own_sid {
        let _ = s.killer.kill();
        return None;
    }

    // The foreground job first. `tcgetpgrp` is the pty's answer to "whose
    // keyboard is this right now", and for a shell running `npm run build` that
    // is npm's group, not the shell's — the one group a single signal can reach
    // that the leader's pid cannot.
    if let Some(fg) = s.master.process_group_leader() {
        if fg > 0 && fg != unsafe { libc::getpgrp() } {
            unsafe { libc::killpg(fg, libc::SIGTERM) };
        }
    }
    // Then the leader. SIGHUP is what a terminal being closed means, and a shell
    // with `huponexit` set passes it on to its own jobs; SIGTERM follows for
    // everything that reads SIGHUP as "reload your configuration".
    unsafe {
        libc::kill(pid, libc::SIGHUP);
        libc::kill(pid, libc::SIGTERM);
    }
    // Dropping `s` here closes the master, which hangs the pty up — the kernel's
    // own SIGHUP to whatever is in the foreground group.
    drop(s);
    Some(pid)
}

#[cfg(not(unix))]
fn signal(mut s: Session) -> Option<i32> {
    // `TerminateProcess` on the direct child. A shell's children survive it;
    // reaching them needs a Job Object created around each spawn, which is not
    // built yet.
    let _ = s.killer.kill();
    None
}

/// Give a session its grace period and then SIGKILL whatever is left of it,
/// without making the caller wait. Does nothing when there is nothing to sweep.
fn sweep_later(sid: Option<i32>) {
    if let Some(sid) = sid {
        std::thread::spawn(move || sweep(&[sid], GRACE));
    }
}

/// Wait for these process sessions to empty, then SIGKILL whoever is still in
/// them. Returns early — usually within a tick — as soon as they are all empty.
fn sweep(sids: &[i32], grace: Duration) {
    if sids.is_empty() {
        return;
    }
    let deadline = Instant::now() + grace;
    loop {
        if sids.iter().all(|&sid| session_members(sid).is_empty()) {
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    for &sid in sids {
        for pid in session_members(sid) {
            kill_hard(pid);
        }
    }
}

#[cfg(unix)]
fn kill_hard(pid: i32) {
    unsafe { libc::kill(pid, libc::SIGKILL) };
}

#[cfg(not(unix))]
fn kill_hard(_pid: i32) {}

/// Every process in the given process session.
///
/// The only way to find a job that put itself in its own process group: there is
/// no syscall that names them, and a background or stopped job is in no group a
/// signal can reach from the outside. So the process table is read and each
/// entry asked which session it belongs to.
///
/// Answers empty for our own session and for anything nonsensical — the guard
/// that keeps a sweep from reaching the app itself, repeated here so that it
/// holds no matter who calls.
#[cfg(unix)]
fn session_members(sid: i32) -> Vec<i32> {
    if sid <= 0 || sid == unsafe { libc::getsid(0) } {
        return Vec::new();
    }
    all_pids()
        .into_iter()
        .filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == sid)
        .collect()
}

#[cfg(not(unix))]
fn session_members(_sid: i32) -> Vec<i32> {
    Vec::new()
}

/// How many processes of this session belong to a process group other than the
/// leader's own — see `live_work` for why that is the line between a job and a
/// helper. The leader is a group leader itself (`setsid` makes it one), so its
/// own group is its pid.
#[cfg(unix)]
fn jobs_in_session(leader: i32) -> usize {
    session_members(leader)
        .into_iter()
        .filter(|&pid| pid != leader && unsafe { libc::getpgid(pid) } != leader)
        .count()
}

#[cfg(not(unix))]
fn jobs_in_session(_leader: i32) -> usize {
    0
}

#[cfg(target_os = "linux")]
fn all_pids() -> Vec<i32> {
    let dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    dir.flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse::<i32>().ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<i32> {
    // Two calls rather than a guessed size: the first with a null buffer asks
    // how many bytes the table needs, and the slack allows for processes
    // starting between the two.
    let needed = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    let mut buf = vec![0i32; needed as usize + 64];
    let size = (buf.len() * std::mem::size_of::<i32>()) as libc::c_int;
    let written =
        unsafe { libc::proc_listallpids(buf.as_mut_ptr() as *mut libc::c_void, size) };
    if written <= 0 {
        return Vec::new();
    }
    buf.truncate(written as usize);
    buf.into_iter().filter(|&p| p > 0).collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn all_pids() -> Vec<i32> {
    // No portable process-table read. The polite signals still go out; only the
    // sweep for jobs in their own process group is missing.
    Vec::new()
}

/// The error a session this manager does not hold produces.
///
/// `NotFound` and nothing else in the kind, because the command layer reads the
/// kind to tell "there is no such session" from "the write reached the PTY and
/// failed" — and only the first of those is ordinary enough to swallow.
fn no_such_session(session: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, format!("no such session: {session}"))
}

fn to_io<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Spawning is 10 arguments, of which the tests below vary three. The
    /// helper carries the rest so a test reads as what it is testing.
    fn spawn_sh(
        mgr: &PtyManager,
        session: &str,
        script: &str,
        replace: bool,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl Fn(Exit) + Send + 'static,
    ) -> std::io::Result<()> {
        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), script.to_string()]);
        #[cfg(not(windows))]
        let (prog, args) = ("/bin/sh", vec!["-c".to_string(), script.to_string()]);
        mgr.spawn(session, prog, &args, ".", 80, 24, &[], replace, on_output, on_exit)
    }

    /// Read from `rx` until `needle` shows up or the deadline passes.
    fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
        let mut got = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                if String::from_utf8_lossy(&got).contains(needle) {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&got).to_string()
    }

    #[test]
    fn spawns_streams_output_and_exits() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Exit>();

        spawn_sh(
            &mgr, "s1", "printf COWORK_OK", false,
            move |bytes| { let _ = tx.send(bytes); },
            move |e| { let _ = etx.send(e); },
        ).unwrap();

        let got = wait_for(&rx, "COWORK_OK");
        assert!(got.contains("COWORK_OK"), "got: {got:?}");
        let exit = erx.recv_timeout(Duration::from_secs(5)).expect("exit not reported");
        assert_eq!(exit.code, Some(0), "a clean exit is code 0: {exit:?}");
    }

    /// The coalescer is a batching layer, and a batching layer that is not
    /// byte-transparent silently corrupts every multi-byte glyph it cuts. What is
    /// pinned here is that a batch is the concatenation of the reads it replaced —
    /// same bytes, same order — including the tail written just before EOF, which
    /// is the one a naive "flush on timeout" loop drops on the floor.
    #[test]
    fn coalescing_is_byte_transparent_including_the_tail_before_eof() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Exit>();

        // Enough to cross many read boundaries — on Darwin the tty hands back at
        // most 1024 bytes a read, so this is 256+ of them — and multi-byte
        // throughout, so any cut mishandled by the batcher shows up as mojibake
        // rather than as a length that still matches.
        let unit = "─┤абв┃";
        let reps = 4096;
        let expected: String = unit.repeat(reps);

        #[cfg(windows)]
        let (prog, args) = (
            "cmd",
            vec!["/C".to_string(), format!("for /L %i in (1,1,{reps}) do @<nul set /p={unit}")],
        );
        #[cfg(not(windows))]
        let (prog, args) = (
            "/bin/sh",
            vec!["-c".to_string(), format!("i=0; while [ $i -lt {reps} ]; do printf %s '{unit}'; i=$((i+1)); done")],
        );

        mgr.spawn(
            "coalesce", prog, &args, ".", 80, 24, &[], false,
            move |bytes| { let _ = tx.send(bytes); },
            move |exit| { let _ = etx.send(exit); },
        )
        .unwrap();

        // Collect until the child has exited AND the stream has gone quiet, so the
        // final batch — the one flushed on Disconnected — is counted.
        let mut got: Vec<u8> = Vec::new();
        let mut batches = 0usize;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(400)) {
                Ok(b) => { batches += 1; got.extend_from_slice(&b); }
                Err(_) => if got.len() >= expected.len() { break },
            }
        }
        let _ = erx.recv_timeout(Duration::from_secs(5));

        // A pty echoes and may translate \n; this payload contains neither, so the
        // comparison is exact rather than "contains".
        assert_eq!(
            String::from_utf8_lossy(&got),
            expected,
            "coalescing changed the byte stream (got {} bytes, wanted {})",
            got.len(),
            expected.len()
        );

        // And it actually batched. Uncoalesced, Darwin's 1024-byte read cap alone
        // would make this at least `expected.len() / 1024` callbacks — each one a
        // main-thread `evaluateJavaScript`. The bound is loose on purpose: under
        // load the windows only grow, so this can fail from too little batching
        // but never from too much.
        let uncoalesced_floor = expected.len() / 1024;
        assert!(
            batches < uncoalesced_floor / 2,
            "expected far fewer than {uncoalesced_floor} callbacks, got {batches}"
        );
    }

    #[test]
    fn injected_env_reaches_the_child_process() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Exit>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo %COWORK_TEST_VAR%".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) =
            ("/bin/sh", vec!["-c".to_string(), "printf %s \"$COWORK_TEST_VAR\"".to_string()]);

        mgr.spawn(
            "envtest",
            prog,
            &args,
            ".",
            80,
            24,
            &[("COWORK_TEST_VAR".to_string(), "injected-value".to_string())],
            false,
            move |bytes| { let _ = tx.send(bytes); },
            move |e| { let _ = etx.send(e); },
        )
        .unwrap();

        let got = wait_for(&rx, "injected-value");
        assert!(
            got.contains("injected-value"),
            "the child process did not see the injected variable: {got:?}"
        );
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok(), "exit not reported");
    }

    /// Spawn a shell that prints `TERM` and `COLORTERM`, and return what it printed.
    fn echo_terminal_env(session: &str, env: &[(String, String)]) -> String {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        #[cfg(windows)]
        let (prog, args) = ("cmd", vec!["/C".to_string(), "echo %TERM% %COLORTERM%".to_string()]);
        #[cfg(not(windows))]
        let (prog, args) = (
            "/bin/sh",
            vec!["-c".to_string(), r#"printf '%s %s' "$TERM" "$COLORTERM""#.to_string()],
        );

        mgr.spawn(session, prog, &args, ".", 80, 24, env, false, move |b| { let _ = tx.send(b); }, |_| {})
            .unwrap();

        let mut got = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend_from_slice(&b);
                // Both values are on one line, so the newline that ends it ends the read.
                if got.contains(&b'\n') || String::from_utf8_lossy(&got).contains("truecolor") {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&got).to_string()
    }

    /// Run `f` with the test process itself carrying a `TERM` the child must not
    /// inherit. Without this the terminal-type tests pass in any shell that has a
    /// `TERM` of its own — the child would inherit it and the assertion would hold
    /// with the declaration removed, which is a green test for a broken app. The
    /// lock keeps the two of them from editing one process's environment at once;
    /// the other tests here spawn shells that never read `TERM`, so a sentinel
    /// leaking into one of those costs nothing.
    fn with_parent_term<T>(sentinel: &str, f: impl FnOnce() -> T) -> T {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = std::env::var_os("TERM");
        std::env::set_var("TERM", sentinel);
        let out = f();
        match restore {
            Some(v) => std::env::set_var("TERM", v),
            None => std::env::remove_var("TERM"),
        }
        out
    }

    /// Without this the child inherits the app's environment, and an .app launched
    /// from the Dock has no `TERM` — which is a monochrome agent, because
    /// `supports-color` reads exactly this variable to decide whether colour exists.
    #[test]
    fn the_child_is_told_which_terminal_it_is_talking_to() {
        let out = with_parent_term("cowork-parent-sentinel", || echo_terminal_env("termtest", &[]));
        assert!(out.contains("xterm-256color"), "TERM not set for the session: {out:?}");
        assert!(out.contains("truecolor"), "COLORTERM not set for the session: {out:?}");
        assert!(
            !out.contains("cowork-parent-sentinel"),
            "the session inherited the app's own TERM instead of being told one: {out:?}"
        );
    }

    /// The declaration is a default, not a decree: it is written before the
    /// caller's environment is applied, so a session that has reason to claim a
    /// different terminal still can.
    #[test]
    fn a_caller_may_override_the_terminal_type() {
        let out = with_parent_term("cowork-parent-sentinel", || {
            echo_terminal_env("termoverride", &[("TERM".to_string(), "xterm-mono".to_string())])
        });
        assert!(out.contains("xterm-mono"), "caller's TERM did not win: {out:?}");
        assert!(!out.contains("xterm-256color"), "default TERM survived the override: {out:?}");
    }

    // ---- exit outcomes -----------------------------------------------------

    /// The guard on `classify`. `portable_pty::ExitStatus` exposes no signal
    /// accessor, so the wording of its `Display` is load-bearing: if this test
    /// fails after a dependency bump, every signalled session has silently
    /// started reporting itself as "exited with code 1" and `classify` needs a
    /// new way to read it.
    #[test]
    fn an_exit_status_still_spells_its_signal_out() {
        let signalled = classify(&portable_pty::ExitStatus::with_signal("Hangup"));
        assert_eq!(signalled.signal.as_deref(), Some("Hangup"));
        assert_eq!(signalled.code, None, "a signalled process has no exit code of its own");
        assert!(signalled.signalled());
        assert!(!signalled.ok());

        let failed = classify(&portable_pty::ExitStatus::with_exit_code(1));
        assert_eq!(failed.code, Some(1));
        assert_eq!(failed.signal, None, "exit 1 is not a signal");
        assert!(!failed.ok());

        let fine = classify(&portable_pty::ExitStatus::with_exit_code(0));
        assert_eq!(fine.code, Some(0));
        assert!(fine.ok());
    }

    /// The distinction the old boolean could not carry: a command that failed
    /// reports the code it failed with.
    #[test]
    fn a_failing_command_reports_its_own_exit_code() {
        let mgr = PtyManager::new();
        let (etx, erx) = mpsc::channel::<Exit>();
        spawn_sh(&mgr, "code3", "exit 3", false, |_| {}, move |e| { let _ = etx.send(e); }).unwrap();
        let exit = erx.recv_timeout(Duration::from_secs(5)).expect("exit not reported");
        assert_eq!(exit.code, Some(3), "{exit:?}");
        assert!(!exit.signalled(), "nothing signalled it: {exit:?}");
        assert!(!exit.unknown);
    }

    /// The other half of the same distinction: a process somebody stopped says
    /// so, instead of being indistinguishable from `exit 1`.
    #[cfg(unix)]
    #[test]
    fn a_signalled_process_is_not_reported_as_a_failed_one() {
        let mgr = PtyManager::new();
        let (etx, erx) = mpsc::channel::<Exit>();
        spawn_sh(&mgr, "sig", "kill -TERM $$", false, |_| {}, move |e| { let _ = etx.send(e); })
            .unwrap();
        let exit = erx.recv_timeout(Duration::from_secs(5)).expect("exit not reported");
        assert!(exit.signalled(), "a SIGTERMed shell must report a signal: {exit:?}");
        assert_eq!(exit.code, None, "{exit:?}");
    }

    // ---- generations -------------------------------------------------------

    // The scripts below need a POSIX shell's `sleep` and `while`.
    #[cfg(unix)]
    #[test]
    fn a_live_session_id_is_refused_rather_than_replaced() {
        let mgr = PtyManager::new();
        spawn_sh(&mgr, "dup", "sleep 30", false, |_| {}, |_| {}).unwrap();
        let second = spawn_sh(&mgr, "dup", "printf SECOND", false, |_| {}, |_| {});
        assert!(second.is_err(), "a second spawn under a live id must be refused");
        assert_eq!(second.unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        // And the refusal left the first one alone.
        spawn_sh(&mgr, "dup", "printf THIRD", true, |_| {}, |_| {})
            .expect("an explicit replacement is still allowed");
        mgr.kill("dup");
    }

    /// The respawn race, from the reader's side: a process the app has replaced
    /// keeps writing, and there is exactly one terminal per session id for its
    /// bytes to land in. Nothing from the old generation may be delivered after
    /// the new one exists.
    // The scripts below need a POSIX shell's `sleep` and `while`.
    #[cfg(unix)]
    #[test]
    fn a_replaced_generation_stops_being_delivered() {
        let mgr = PtyManager::new();
        let (old_tx, old_rx) = mpsc::channel::<Vec<u8>>();
        spawn_sh(
            &mgr, "gen", "while true; do printf OLD; sleep 0.05; done", false,
            move |b| { let _ = old_tx.send(b); }, |_| {},
        ).unwrap();
        // Make sure the first generation really is running and painting.
        let seen = wait_for(&old_rx, "OLD");
        assert!(seen.contains("OLD"), "the first generation never produced output: {seen:?}");

        spawn_sh(&mgr, "gen", "sleep 30", true, |_| {}, |_| {}).unwrap();

        // Drain whatever was already in flight when the replacement happened,
        // then require silence: the old process may still be alive for a moment,
        // but nothing it writes may reach the callback any more.
        while old_rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
        assert!(
            old_rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "output from a replaced generation is still being delivered",
        );
        mgr.kill("gen");
    }

    /// The same race from the waiter's side: the replaced process exits, and its
    /// `on_exit` must not mark the running session that took its id as ended.
    // The scripts below need a POSIX shell's `sleep` and `while`.
    #[cfg(unix)]
    #[test]
    fn a_replaced_generation_does_not_report_its_exit() {
        let mgr = PtyManager::new();
        let (etx, erx) = mpsc::channel::<Exit>();
        spawn_sh(&mgr, "genexit", "sleep 30", false, |_| {}, move |e| { let _ = etx.send(e); })
            .unwrap();
        spawn_sh(&mgr, "genexit", "sleep 30", true, |_| {}, |_| {}).unwrap();
        assert!(
            erx.recv_timeout(Duration::from_secs(3)).is_err(),
            "the replaced session reported an exit for the id its successor now holds",
        );
        mgr.kill("genexit");
    }

    // ---- killing what the session started ----------------------------------

    /// A job in its **own process group** is what an interactive shell makes of
    /// every command, and it is exactly what one signal to one pid cannot reach.
    /// `set -m` turns job control on in a non-interactive shell, which is the
    /// smallest faithful stand-in for a person typing `npm run build &`.
    ///
    /// The second assertion is the leak: the reader holds a dup of the master,
    /// so as long as anything still holds the pty slave open the thread never
    /// sees EOF and never ends. It is observed by the callback being dropped —
    /// which happens only when the thread returns, taking the sender with it.
    #[cfg(unix)]
    #[test]
    fn killing_a_session_takes_its_own_process_group_jobs_with_it() {
        if !std::path::Path::new("/bin/bash").exists() {
            eprintln!("skipped: needs bash for `set -m`");
            return;
        }
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let args = vec![
            "-c".to_string(),
            "set -m; sleep 300 & printf 'JOB=%s\\n' $!; wait".to_string(),
        ];
        mgr.spawn(
            "grp", "/bin/bash", &args, ".", 80, 24, &[], false,
            move |b| { let _ = tx.send(b); }, |_| {},
        )
        .unwrap();

        let out = wait_for(&rx, "JOB=");
        let job: i32 = out
            .split("JOB=")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or_else(|| panic!("no background job pid in: {out:?}"));
        assert_eq!(unsafe { libc::kill(job, 0) }, 0, "the background job never started");

        mgr.kill("grp");

        // `kill` hands the sweep to a helper thread, so the wait here is for the
        // grace period plus the sweep, not for the signals.
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && unsafe { libc::kill(job, 0) } == 0 {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_ne!(
            unsafe { libc::kill(job, 0) },
            0,
            "the shell's background job survived the session that started it",
        );

        // The reader thread's own end: with every holder of the pty slave gone,
        // the read finally fails and the closure — and its sender with it — is
        // dropped.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ if Instant::now() > deadline => {
                    panic!("the reader thread outlived its session")
                }
                _ => {}
            }
        }
    }

    /// What the app-level exit handler asks before tearing anything down: a job
    /// — a command the person gave the shell, which job control puts in a group
    /// of its own — is live work.
    #[cfg(unix)]
    #[test]
    fn live_work_sees_a_job_the_session_was_told_to_run() {
        if !std::path::Path::new("/bin/bash").exists() {
            eprintln!("skipped: needs bash for `set -m`");
            return;
        }
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let args = vec!["-c".to_string(), "set -m; sleep 300 & printf READY\\n; wait".to_string()];
        mgr.spawn("busy", "/bin/bash", &args, ".", 80, 24, &[], false,
            move |b| { let _ = tx.send(b); }, |_| {})
            .unwrap();
        assert!(wait_for(&rx, "READY").contains("READY"), "the session never started");

        let work = mgr.live_work();
        let found = work.iter().find(|w| w.session == "busy");
        assert!(found.is_some(), "a session running a job reports no live work: {work:?}");
        assert_eq!(found.unwrap().processes, 1, "{work:?}");

        mgr.kill("busy");
    }

    /// And the other half, which is what keeps the quit question worth reading:
    /// a process the session started **for itself** — an agent's MCP server, a
    /// helper the shell forked — stays in the leader's own process group and is
    /// not a job. Without this distinction every quit would ask about every
    /// session that has ever forked anything, which is a question people learn
    /// to click through.
    #[cfg(unix)]
    #[test]
    fn live_work_ignores_a_helper_in_the_leaders_own_group() {
        let mgr = PtyManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        // No `set -m`: `sh` runs the background command in its own process
        // group only when job control is on, and it is off here — so this child
        // is in the shell's group, exactly like a helper process.
        spawn_sh(
            &mgr, "helper", "sleep 300 & printf READY\\n; wait", false,
            move |b| { let _ = tx.send(b); }, |_| {},
        ).unwrap();
        assert!(wait_for(&rx, "READY").contains("READY"), "the session never started");

        let work = mgr.live_work();
        assert!(
            !work.iter().any(|w| w.session == "helper"),
            "a process in the leader's own group was reported as a job: {work:?}",
        );
        mgr.kill("helper");
    }

    /// The safety rail on the sweep, asserted rather than assumed: the app runs
    /// in a process session of its own, and a sweep that ever matched it would
    /// kill the app and everything it has ever started.
    #[cfg(unix)]
    #[test]
    fn the_sweep_never_matches_the_apps_own_session() {
        let own = unsafe { libc::getsid(0) };
        assert!(session_members(own).is_empty(), "the sweep can see our own session");
        assert!(session_members(0).is_empty());
        assert!(session_members(-1).is_empty());
    }
}
