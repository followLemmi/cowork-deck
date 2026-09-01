use crate::model::{event_kind_to_state, ReporterEvent};
use crate::model::SessionState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Next accept-retry backoff: 50ms first, then doubling up to a 1s cap.
fn next_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        Duration::from_millis(50)
    } else {
        std::cmp::min(current * 2, Duration::from_secs(1))
    }
}

/// Start a 127.0.0.1 listener; returns the bound port. For each reporter line
/// that maps to a state, `on_state(session_id, state)` is invoked.
pub async fn start_listener<F>(on_state: F) -> std::io::Result<u16>
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
                // Split before reading: one connection in five hundred wants a
                // reply, and the reader cannot own the stream if the writer is
                // to have it.
                let (rd, mut wr) = stream.into_split();
                let mut lines = BufReader::new(rd).lines();
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

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_backoff(Duration::ZERO), Duration::from_millis(50));
        assert_eq!(next_backoff(Duration::from_millis(50)), Duration::from_millis(100));
        assert_eq!(next_backoff(Duration::from_millis(800)), Duration::from_secs(1));
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(1));
    }
}
