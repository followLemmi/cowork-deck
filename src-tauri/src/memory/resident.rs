//! One `cowork_memory serve` process for the whole deck, and what it costs.
//!
//! # The measurement this exists for
//!
//! A search was a fresh process, and a fresh process loads the embedding model
//! from cold. Measured on a real corpus, x86_64, model file warm in the page
//! cache:
//!
//! | | wall | peak RSS |
//! |---|---|---|
//! | everything except the model — spawn, index read, cosine, JSON | 0.02 s | 6.7 MB |
//! | the same search with the model | 2.03 s | 1830 MB |
//!
//! So 99% of a search was ONNX Runtime building the graph, and it is CPU rather
//! than disk — three consecutive searches ran 2.15 / 2.04 / 2.03 s with the file
//! warm throughout, which is what rules out any OS-level prewarming as an answer.
//! The corpus is not the cost and will not become it: the index grows at ~3.5 KB
//! per chunk, so a hundred thousand chunks is 350 MB against the model's
//! gigabyte and a half.
//!
//! Held resident, the same searches take **6 ms**. That is the whole of this
//! module.
//!
//! # It is not started at launch, and that is a decision
//!
//! Warming costs 1.7 s of CPU and holds 1.6 GB. Paying that at launch charges
//! every person who never searches, which is the objection ADR-0003 and #35
//! already made about the launch path — the same one that keeps the search for
//! #388's prompt hook out of the hook itself.
//!
//! So it starts on demand: [`warm`] when somebody opens the memory page, where
//! the 1.7 s overlaps with reading the list and the first search is already
//! instant; and lazily on the first search from anywhere else. The MCP tool and
//! the prompt hook then share the same process.
//!
//! # 1.6 GB is why the idle timeout is real
//!
//! Measured: 1589 MB resident after loading, and it does not fall — the graph
//! stays materialised. A deck open all day would hold that for a search somebody
//! ran once in the morning, so the process is reaped after [`IDLE`] with nothing
//! asked of it, and the next search pays the 1.7 s again. That is the trade, and
//! it is the right way round: memory given back is certain, and a slow first
//! search is one sentence on screen.
//!
//! # A failure is never worse than what it replaces
//!
//! Everything here degrades to the one-shot spawn that came before it. A sidecar
//! that will not start, a pipe that breaks, a reply that does not parse, a
//! request that goes unanswered past [`REQUEST_DEADLINE`]: the caller gets the
//! old path and a slow answer rather than no answer.

use super::sidecar::{Hit, Scope, Sidecar};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long the process may sit unused before it is reaped.
///
/// Five minutes, against 1589 MB measured resident. Long enough that somebody
/// working through their notes never meets a cold start twice; short enough that
/// a window left open over lunch is not holding a gigabyte and a half for a
/// search nobody is going to run.
const IDLE: Duration = Duration::from_secs(5 * 60);

/// How often the reaper looks. Coarse on purpose: the thing it is protecting is
/// measured in minutes, and a timer that wakes every second to check a five
/// minute deadline is a timer that costs more than it saves.
const SWEEP: Duration = Duration::from_secs(30);

/// How long one request may take.
///
/// Generous enough for the first, which loads the model — 1.7 s measured, and a
/// slower machine is the case this bound is for. A request slower than this is a
/// process that is wedged rather than working, and falling back to a one-shot
/// spawn beats waiting for it.
const REQUEST_DEADLINE: Duration = Duration::from_secs(90);

#[derive(Debug, Deserialize)]
struct Reply {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    hits: Option<Vec<Hit>>,
}

struct Live {
    child: Child,
    stdin: ChildStdin,
    /// Lines off the child's stdout, read by a thread of their own.
    ///
    /// A thread rather than a `read_line` on this one, because a read on a pipe
    /// cannot be given a deadline and [`REQUEST_DEADLINE`] has to be a real
    /// bound: `ask` holds the global mutex for the whole round trip, so a
    /// sidecar that takes a request and never answers would otherwise wedge the
    /// reaper, every search, and every prompt hook behind it, with nothing short
    /// of quitting the app to recover.
    replies: Receiver<String>,
    /// When it last answered something. The reaper's whole input.
    used: Instant,
    next_id: u64,
}

impl Live {
    /// Ask, and read one line back.
    ///
    /// A failure here is fatal to the process rather than to the request: a
    /// half-written request or a half-read reply leaves the stream out of step,
    /// and the next caller would read this one's answer. So the caller drops the
    /// process on any error and the request is retried on a one-shot.
    ///
    /// A request that outlives `deadline` is one of these failures too: the
    /// process is wedged rather than working, and the caller is better served by
    /// a slow one-shot than by a wait with no end.
    fn ask(&mut self, req: &serde_json::Value, deadline: Duration) -> Result<Reply, String> {
        let line = format!("{req}\n");
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let answer = self.replies.recv_timeout(deadline).map_err(|e| match e {
            RecvTimeoutError::Timeout => {
                format!("no answer in {}s", deadline.as_secs())
            }
            RecvTimeoutError::Disconnected => {
                "the memory sidecar closed its output".to_string()
            }
        })?;
        self.used = Instant::now();
        serde_json::from_str(answer.trim()).map_err(|e| e.to_string())
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        // Closing stdin is how `serve` is asked to stop; the kill is for a
        // process that ignores it, and 1.6 GB is not something to leave to a
        // polite request alone.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn held() -> &'static Mutex<Option<Live>> {
    static HELD: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(None))
}

/// Start the reaper, once.
///
/// A thread rather than a timer on the runtime: it sleeps for thirty seconds at
/// a time and touches one mutex, and putting that on an async runtime would be
/// ceremony around a sleep.
fn reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(SWEEP);
            let Ok(mut slot) = held().lock() else { return };
            let idle = slot.as_ref().is_some_and(|l| l.used.elapsed() > IDLE);
            if idle {
                // `Drop` kills it. Said here because the line that gives back a
                // gigabyte and a half should be findable.
                *slot = None;
            }
        });
    });
}

/// Spawn one, or say why not.
fn spawn(sidecar: &Sidecar) -> Result<Live, String> {
    if !sidecar.is_staged() {
        return Err("the memory sidecar is not installed".to_string());
    }
    let child = Command::new(sidecar.program())
        .arg("--root")
        .arg(sidecar.root())
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Inherited on purpose: the sidecar's diagnostics belong in the app's
        // log, and a piped stderr nobody reads is a pipe that fills and blocks.
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("the memory sidecar would not start: {e}"))?;
    adopt(child)
}

/// Wrap a spawned child, putting a reader on its stdout.
///
/// Split out from [`spawn`] so a test can hand this any process at all —
/// including one that never answers, which is the case [`REQUEST_DEADLINE`]
/// exists for and the one a real sidecar cannot be asked to perform.
fn adopt(mut child: Child) -> Result<Live, String> {
    let stdin = child.stdin.take().ok_or("no stdin on the memory sidecar")?;
    let stdout = child.stdout.take().ok_or("no stdout on the memory sidecar")?;
    let (tx, replies) = mpsc::channel();
    // Ends of its own accord: the read returns 0 when the child is killed — which
    // is what dropping `Live` does — and the send fails once nobody is holding
    // the other end.
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            }
        }
    });
    Ok(Live { child, stdin, replies, used: Instant::now(), next_id: 1 })
}

/// Run one request against the resident process, starting it if needed.
///
/// `None` when there is no resident path to take — no sidecar staged, it would
/// not start, or it broke mid-request. The caller then does what it did before
/// this module existed.
fn ask(sidecar: &Sidecar, mut make: impl FnMut(u64) -> serde_json::Value) -> Option<Reply> {
    reaper();
    let mut slot = held().lock().ok()?;
    if slot.is_none() {
        match spawn(sidecar) {
            Ok(live) => *slot = Some(live),
            Err(e) => {
                eprintln!("memory: {e}; falling back to one search per process");
                return None;
            }
        }
    }
    let live = slot.as_mut()?;
    let id = live.next_id;
    live.next_id += 1;
    match live.ask(&make(id), REQUEST_DEADLINE) {
        Ok(r) => Some(r),
        Err(e) => {
            eprintln!("memory: the resident sidecar failed ({e}); restarting it next time");
            // Dropped rather than reused: the stream is out of step, and the
            // next caller would read this request's answer as its own.
            *slot = None;
            None
        }
    }
}

/// Load the model without asking anything of it.
///
/// Returns whether it is loaded now. Called when the memory page is opened, so
/// the 1.7 s overlaps with reading the list rather than landing on the first
/// search — and called on a thread, because it is 1.7 s.
pub fn warm(sidecar: &Sidecar) -> bool {
    ask(sidecar, |id| serde_json::json!({ "id": id, "op": "warm" }))
        .is_some_and(|r| r.ok)
}

/// Search through the resident process, or `None` to fall back.
pub fn search(sidecar: &Sidecar, query: &str, scope: &Scope, top: usize) -> Option<Vec<Hit>> {
    let arg = scope.as_arg();
    let reply = ask(sidecar, |id| {
        serde_json::json!({
            "id": id, "op": "search", "query": query, "scope": arg, "top": top,
        })
    })?;
    if !reply.ok {
        /* A refusal is the sidecar's answer, not a fault in the transport — an
           absent model is the ordinary one. Reported and not retried on a
           one-shot, which would only load the same missing model again. */
        eprintln!(
            "memory: the sidecar refused the search ({})",
            reply.error.unwrap_or_else(|| "no reason given".into()),
        );
        return Some(Vec::new());
    }
    reply.hits
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback is the whole safety property: everything here degrades to
    /// the one search per process that came before it.
    #[test]
    fn a_sidecar_that_is_not_installed_falls_back_rather_than_failing() {
        let s = Sidecar::new(std::path::PathBuf::from("/no/such/root"));
        // No binary staged in a test build, so this is the "not installed" path.
        assert!(!s.is_staged());
        assert_eq!(search(&s, "anything", &Scope::Everything, 5), None);
        assert!(!warm(&s));
    }

    /// The case the deadline is for: a process that takes the request and never
    /// answers. Before it was enforced, `ask` blocked on the read forever while
    /// holding the global mutex — so the reaper, every other search and every
    /// prompt hook queued behind one wedged child until the app was quit.
    #[test]
    fn a_request_that_is_never_answered_gives_up_rather_than_waiting_forever() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep");
        let mut live = adopt(child).expect("adopt the child");

        let began = Instant::now();
        let req = serde_json::json!({ "id": 1, "op": "warm" });
        let answer = live.ask(&req, Duration::from_millis(250));
        let waited = began.elapsed();

        assert!(answer.is_err(), "a silent process is a failure, not a wait");
        assert!(answer.unwrap_err().contains("no answer"));
        assert!(waited < Duration::from_secs(5), "gave up after {waited:?}");
        // Dropping it kills the child, which is what the caller does on any
        // error from `ask`.
        drop(live);
    }
}
