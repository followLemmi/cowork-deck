use crate::model::{event_kind_to_state, ReporterEvent};
use crate::model::SessionState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Next accept-retry backoff: 50ms first, then doubling up to a 1s cap.
fn next_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        Duration::from_millis(50)
    } else {
        std::cmp::min(current * 2, Duration::from_secs(1))
    }
}

/// Most a single connection may send, header and payload together.
///
/// There was no bound at all, and the `memory` branch read to end-of-stream into
/// a `String` (#463). The listener is bound to 127.0.0.1, so nothing remote can
/// reach it and this is not a hardening measure against an attacker — it is a
/// bound on what one broken hook can do to the app it is talking to. A hook that
/// pipes a log file into the memory client instead of a prompt would otherwise be
/// answered by an allocation the size of the log.
///
/// 1 MiB against a real payload: a `UserPromptSubmit` hook's JSON is the prompt
/// plus a few fields, and a prompt long enough to be worth a memory search is
/// still prose — the pasted-code case that motivates the size is measured in
/// tens of kilobytes. A reporter event is a few hundred bytes. Enforced on the
/// reader rather than per line, so a single unterminated line cannot get past it
/// either: `lines()` has no cap of its own and would buffer to end-of-stream.
const MAX_CONNECTION_BYTES: u64 = 1024 * 1024;

/// How long one connection may take from accept to close.
///
/// The other half of the same fault: `lines().next_line().await` has no deadline,
/// so a client that connected and then never wrote and never closed held a task —
/// and, in the `memory` branch, a growing `String` — for the life of the process.
/// Nothing about a legitimate connection is slow: every one of them is a
/// short-lived `cowork_report` that writes its line and exits, and the memory
/// client half-closes as soon as it has written the prompt.
///
/// 12 seconds is deliberately longer than the reporter's own 8-second
/// `REPLY_TIMEOUT`, so the client gives up on a slow search before the server
/// drops the connection under it — the failure a person sees stays "a turn
/// without memory", which is where the feature started, rather than a broken
/// pipe. The search itself is what takes the time: it loads a 470 MB embedding
/// model on the first call.
const CONNECTION_DEADLINE: Duration = Duration::from_secs(12);

/// The two bounds above, together, so a test can assert the behaviour rather
/// than the constants.
///
/// Injected rather than read from the constants directly for one reason: a test
/// of the deadline that used the real one would take twelve seconds, and a
/// twelve-second test is a test somebody deletes. The production path passes
/// `Limits::default()` and nothing else ever passes anything else.
#[derive(Clone, Copy)]
pub struct Limits {
    /// Most one connection may send, header and payload together.
    pub max_bytes: u64,
    /// How long one connection may take, from accept to close.
    pub deadline: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_bytes: MAX_CONNECTION_BYTES, deadline: CONNECTION_DEADLINE }
    }
}

/// Start a 127.0.0.1 listener; returns the bound port. For each reporter line
/// that maps to a state, `on_state(session_id, state)` is invoked.
pub async fn start_listener<F>(on_state: F) -> std::io::Result<u16>
where
    F: Fn(String, SessionState) + Send + Sync + 'static,
{
    start_listener_with(on_state, Limits::default()).await
}

/// `start_listener` with the bounds named. See `Limits`.
pub async fn start_listener_with<F>(on_state: F, limits: Limits) -> std::io::Result<u16>
where
    F: Fn(String, SessionState) + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let cb = Arc::new(on_state);

    tokio::spawn(async move {
        let mut backoff = Duration::ZERO;
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => {
                    backoff = Duration::ZERO;
                    v
                }
                Err(_) => {
                    backoff = next_backoff(backoff);
                    tokio::time::sleep(backoff).await;
                    continue;
                }
            };
            let cb = cb.clone();
            tokio::spawn(async move {
                // Every connection is served under one deadline. A task that
                // outlives it is dropped mid-read, which is the correct answer
                // to a client that stopped talking without closing: nothing
                // here holds a lock across an await, and a half-read line
                // reports nothing.
                let _ = tokio::time::timeout(limits.deadline, async move {
                    // Split before reading: one connection in five hundred wants a
                    // reply, and the reader cannot own the stream if the writer is
                    // to have it.
                    let (rd, mut wr) = stream.into_split();
                    let mut lines = BufReader::new(rd.take(limits.max_bytes)).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Ok(ev) = serde_json::from_str::<ReporterEvent>(&line) {
                            /* The one kind that asks a question rather than
                               reporting a fact: the `UserPromptSubmit` hook wanting
                               what memory has on this prompt (#388). Its payload is
                               the rest of the connection — a prompt is arbitrary
                               text, and a length in the header would be a length the
                               reporter had to count in bytes of somebody's UTF-8.
                               So: read to end-of-stream, answer, and this connection
                               is done. */
                            if ev.kind == "memory" {
                                let mut payload = String::new();
                                while let Ok(Some(more)) = lines.next_line().await {
                                    if !payload.is_empty() {
                                        payload.push('\n');
                                    }
                                    payload.push_str(&more);
                                }
                                let workspace = ev.workspace.clone();
                                /* Off the runtime: a search spawns the sidecar and
                                   loads the model, and doing that on a worker thread
                                   would stall every other session's events behind
                                   one prompt. */
                                let answer = tokio::task::spawn_blocking(move || {
                                    crate::memory::prompt_context(workspace.as_deref(), &payload)
                                })
                                .await
                                .ok()
                                .flatten();
                                if let Some(text) = answer {
                                    let _ = wr.write_all(text.as_bytes()).await;
                                }
                                // Closed either way: the hook waits for end-of-stream
                                // and nothing printed is a turn without memory, which
                                // is where this feature started rather than a fault.
                                let _ = wr.shutdown().await;
                                return;
                            }
                            /* The other kind that is not a report: a second
                               launch, refused by the guard in `instance`, asking
                               the app that already holds this config directory to
                               come forward (#361). It carries no session and
                               changes no state, so it is answered and dropped
                               before anything below can read a session id out of
                               it. */
                            if ev.kind == "focus" {
                                crate::instance::focus_requested();
                                let _ = wr.shutdown().await;
                                return;
                            }
                            // Recorded here rather than handed to a second callback:
                            // every event carries it, and a caller that forgot to
                            // wire it up would leave a tile reading the transcript
                            // it was launched on for the rest of its life — with
                            // nothing failing. See `transcripts`.
                            if let Some(path) = ev.transcript_path.as_deref() {
                                crate::transcripts::record(&ev.session, path);
                                // And into the journal, where it is the difference
                                // between a run whose result can be read afterwards
                                // and one that can only be counted. A session with
                                // no open record is a no-op there.
                                crate::run_journal::note_transcript(&ev.session, path);
                            }
                            // The other half of the same line, recorded here for the
                            // same reason: it arrives on every event, and a `--resume`
                            // aimed at the launch id does not fail — it brings back
                            // the conversation the person cleared away, with nothing
                            // to notice. See `resume_ids`, which ignores an id equal
                            // to the launch one.
                            //
                            // Every kind but `ended`, and that exclusion is the whole
                            // of a race. `/clear` is one of Claude Code's documented
                            // `SessionEnd` reasons, so a clear fires *two* reporters:
                            // `SessionEnd` naming the conversation being left and
                            // `SessionStart` naming the new one. They are separate
                            // processes on separate connections handled by separate
                            // tasks — nothing orders them, and `record` is last-wins.
                            // The first clear survives that by luck, because the id
                            // being ended is the launch id and `record` drops it; the
                            // second would not, and a lost race would leave the map
                            // naming the conversation just cleared away. An `ended`
                            // event reports where the session *was*, which is never
                            // the answer to what a restart should resume.
                            if ev.kind != "ended" {
                                if let Some(reported) = ev.reported_session.as_deref() {
                                    crate::resume_ids::record(&ev.session, reported);
                                }
                            }
                            if let Some(state) =
                                event_kind_to_state(&ev.kind, ev.notification_type.as_deref())
                            {
                                cb(ev.session, state);
                            }
                        }
                    }
                })
                .await;
            });
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionState;
    use std::sync::mpsc;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test(flavor = "multi_thread")]
    async fn receives_and_maps_a_line() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |sess, state| {
            tx.send((sess, state)).unwrap();
        })
        .await
        .unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"{\"session\":\"sess-1\",\"kind\":\"working\"}\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();

        let (sess, state) = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(sess, "sess-1");
        assert_eq!(state, SessionState::Working);
    }

    /// The line a hook produces after `/clear`: same deck session, a different
    /// transcript. Nothing about the state changes, which is why this cannot be
    /// left to the state callback.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reported_transcript_is_recorded_against_its_session() {
        let port = start_listener(|_, _| {}).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                b"{\"session\":\"sess-clear\",\"kind\":\"working\",\
                  \"transcriptPath\":\"/home/u/.claude/projects/-p/new.jsonl\"}\n",
            )
            .await
            .unwrap();
        stream.flush().await.unwrap();

        for _ in 0..50 {
            if crate::transcripts::get("sess-clear").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            crate::transcripts::get("sess-clear").as_deref(),
            Some("/home/u/.claude/projects/-p/new.jsonl"),
        );
    }

    /// What a second launch sends instead of starting an app (#361). Nothing
    /// is focused in a test binary — no instance claimed anything — so what
    /// this asserts is that the line is *recognised*, reports no state, and is
    /// not mistaken for a session's event.
    ///
    /// Recognition is asserted through the close, and it has to be: "no state
    /// was reported" is equally true of a line that failed to parse and of a
    /// `focus` branch somebody deleted, so on its own it would keep passing
    /// while the guard stopped working. Serving a focus request is the only
    /// path that shuts this connection down and returns — every other line
    /// leaves it open for the next one — so end-of-stream is the one signal
    /// that separates "handled" from "ignored".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_focus_request_is_recognised_served_and_changes_no_session_state() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |sess, state| { let _ = tx.send((sess, state)); })
            .await
            .unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"{\"session\":\"-\",\"kind\":\"focus\"}\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();

        // Handled: the server closed its end rather than waiting for a second
        // line. The timeout is the failure mode being guarded against — an
        // unrecognised line hangs here rather than ending the stream.
        let mut body = Vec::new();
        let closed = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut body),
        )
        .await;
        assert!(
            matches!(closed, Ok(Ok(_))),
            "a focus request is served and the connection closed; a line the listener did not \
             recognise would leave it open",
        );
        // Served, not answered: focus is an errand, and the second launch is
        // reading for end-of-stream rather than for a reply.
        assert!(body.is_empty(), "nothing is written back to a focus request");

        // And it is not a session's event: no state was reported for `-`.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    /// The one kind that asks a question rather than reporting a fact (#388).
    ///
    /// Memory is not wired up in a test binary, so what this asserts is the
    /// framing rather than the answer: the header is one line, the payload is
    /// everything after it, the connection is closed from this end, and nothing
    /// about it changes a session's state or leaves the connection hanging. A
    /// prompt that goes on without memory is where this feature started.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_memory_request_is_answered_and_closed_without_touching_the_state() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |sess, state| { let _ = tx.send((sess, state)); })
            .await
            .unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                b"{\"session\":\"sess-m\",\"kind\":\"memory\",\"workspace\":\"ws-1\"}\n                  {\"prompt\":\"why did the cross build pick the wrong architecture\"}",
            )
            .await
            .unwrap();
        stream.flush().await.unwrap();
        stream.shutdown().await.unwrap();

        // Read to end-of-stream, which is what the reporter waits for.
        let mut reply = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut reply).await.unwrap();

        // No state was reported: asking is not working.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    /// A line from an older reporter has no such field, and must still map to a
    /// state rather than failing to parse.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_line_without_a_transcript_path_still_reports_its_state() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |s, st| { tx.send((s, st)).unwrap(); }).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(b"{\"session\":\"sess-old\",\"kind\":\"done\"}\n").await.unwrap();
        stream.flush().await.unwrap();

        let (sess, state) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(sess, "sess-old");
        assert_eq!(state, SessionState::Done);
        assert_eq!(crate::transcripts::get("sess-old"), None);
        assert_eq!(crate::resume_ids::get("sess-old"), None);
    }

    /// The other half of the `/clear` line: the conversation the session is in
    /// now. Recorded against the launch id, which is what the deck knows it by
    /// and what every event is attributed by — so a restart resumes the
    /// conversation the person is in rather than the one they cleared away
    /// (#199).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reported_session_id_is_recorded_against_the_launch_id() {
        let port = start_listener(|_, _| {}).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                b"{\"session\":\"sess-launch\",\"kind\":\"start\",\
                  \"reportedSession\":\"sess-after-clear\"}\n",
            )
            .await
            .unwrap();
        stream.flush().await.unwrap();

        for _ in 0..50 {
            if crate::resume_ids::get("sess-launch").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            crate::resume_ids::get("sess-launch").as_deref(),
            Some("sess-after-clear"),
        );
        // The deck's own key is untouched: the tile is still this session.
        assert_eq!(crate::resume_ids::get("sess-after-clear"), None);
    }

    /// The conversation a session is *leaving* is not the one a restart should
    /// resume. `/clear` is a documented `SessionEnd` reason, so it fires two
    /// reporters — `SessionEnd` naming the old conversation, `SessionStart`
    /// naming the new — on separate connections with nothing ordering them. From
    /// the second clear onwards the old id is a real fork, so recording it would
    /// make a lost race leave the map one conversation behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_ended_event_does_not_move_the_conversation_backwards() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |s, st| { tx.send((s, st)).unwrap(); }).await.unwrap();
        // Where the session is now, from the `SessionStart` the clear produced.
        crate::resume_ids::record("sess-ends", "conversation-3");
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // And the `SessionEnd` of the conversation it just left, arriving after.
        stream
            .write_all(
                b"{\"session\":\"sess-ends\",\"kind\":\"ended\",\
                  \"reportedSession\":\"conversation-2\"}\n",
            )
            .await
            .unwrap();
        stream.flush().await.unwrap();

        // Waited for through the state, which arrives on the same line.
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap().1, SessionState::Ended);
        assert_eq!(
            crate::resume_ids::get("sess-ends").as_deref(),
            Some("conversation-3"),
            "an ended event must not name what a restart resumes",
        );
        crate::resume_ids::forget("sess-ends");
    }

    /// Every event of an uncleared session reports the id it was launched with,
    /// which is the ordinary case and says nothing new. Recording it would leave
    /// every session looking forked — see `resume_ids::record`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_reporting_its_own_launch_id_records_nothing() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let port = start_listener(move |s, st| { tx.send((s, st)).unwrap(); }).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                b"{\"session\":\"sess-plain\",\"kind\":\"working\",\
                  \"reportedSession\":\"sess-plain\"}\n",
            )
            .await
            .unwrap();
        stream.flush().await.unwrap();

        // Waited for through the state, which arrives on the same line.
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap().1, SessionState::Working);
        assert_eq!(crate::resume_ids::get("sess-plain"), None);
    }

    /// A client that connects, says nothing, and never closes.
    ///
    /// Before the deadline this held a task for the life of the process
    /// (#463) — `lines().next_line().await` has no timeout of its own, and a
    /// half-open TCP connection produces no error to break the loop. The
    /// listener is on 127.0.0.1 so nothing remote can do it, but a hook that
    /// spawns and hangs is an ordinary local accident.
    ///
    /// Asserted through the close rather than through a leak count: the server
    /// dropping its end is the observable consequence, and it is the one a
    /// hung client would not produce.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_that_never_writes_is_dropped_at_the_deadline() {
        let limits = Limits { deadline: Duration::from_millis(200), ..Limits::default() };
        let port = start_listener_with(|_, _| {}, limits).await.unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // Nothing written, nothing shut down: the client is simply gone.
        let mut body = Vec::new();
        let closed = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut body),
        )
        .await;
        assert!(
            matches!(closed, Ok(Ok(_))),
            "the connection must be dropped at its deadline; without one this waits forever",
        );
        assert!(body.is_empty(), "a silent client is answered with nothing");
    }

    /// A payload past the cap ends the connection instead of growing the
    /// allocation.
    ///
    /// The `memory` branch read to end-of-stream into a `String`, so a hook
    /// piping a log file where a prompt belongs was answered with an
    /// allocation the size of the log. `AsyncReadExt::take` on the reader is
    /// what bounds it, and it bounds the header line too — `lines()` has no
    /// cap, so one unterminated line would buffer just as far.
    ///
    /// Sent as a single line with no newline, which is the shape that used to
    /// be unbounded: the reader reaches its cap, reports end-of-stream, and
    /// the loop ends with nothing parsed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_line_past_the_cap_ends_the_connection_instead_of_buffering() {
        let (tx, rx) = mpsc::channel::<(String, SessionState)>();
        let limits = Limits { max_bytes: 4096, deadline: Duration::from_secs(3) };
        let port =
            start_listener_with(move |s, st| { let _ = tx.send((s, st)); }, limits).await.unwrap();

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // Ten times the cap, and never a newline. `write_all` may block once the
        // server stops reading, so the failure being guarded against is a write
        // that never completes as much as a read that never ends.
        let blob = vec![b'x'; 40_960];
        let _ = tokio::time::timeout(Duration::from_secs(3), stream.write_all(&blob)).await;

        // `is_ok()` on the timeout, not on the read: the server stops reading
        // at the cap and drops both halves, so the client — which still has
        // unsent bytes queued — may see end-of-stream or a reset depending on
        // the platform. Either is the connection ending. What is being ruled
        // out is the third outcome, which is what this used to do: neither.
        let mut body = Vec::new();
        let ended = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut body),
        )
        .await;
        assert!(
            ended.is_ok(),
            "the connection must end at the cap; unbounded, this line buffers to \
             end-of-stream and the read here never returns",
        );
        // Nothing parsed out of it, which is the right answer to a line that is
        // not a reporter event.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    /// The reporter gives up before the server drops the connection under it.
    ///
    /// Both numbers are chosen against each other: `cowork_report`'s
    /// `REPLY_TIMEOUT` is 8 seconds, and a server deadline shorter than that
    /// would turn a slow search — the first one loads a 470 MB model — into a
    /// broken pipe in the hook instead of a turn without memory.
    #[test]
    fn the_deadline_outlasts_the_reporters_own_reply_timeout() {
        assert!(
            CONNECTION_DEADLINE > Duration::from_secs(8),
            "the client must time out first; see REPLY_TIMEOUT in bin/cowork_report.rs",
        );
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_backoff(Duration::ZERO), Duration::from_millis(50));
        assert_eq!(next_backoff(Duration::from_millis(50)), Duration::from_millis(100));
        assert_eq!(next_backoff(Duration::from_millis(800)), Duration::from_secs(1));
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(1));
    }
}
