use crate::model::{event_kind_to_state, ReporterEvent};
use crate::model::SessionState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
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
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(ev) = serde_json::from_str::<ReporterEvent>(&line) {
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
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_backoff(Duration::ZERO), Duration::from_millis(50));
        assert_eq!(next_backoff(Duration::from_millis(50)), Duration::from_millis(100));
        assert_eq!(next_backoff(Duration::from_millis(800)), Duration::from_secs(1));
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(1));
    }
}
