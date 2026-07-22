use crate::model::{event_kind_to_state, ReporterEvent};
use crate::model::SessionState;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;

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
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let cb = cb.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(ev) = serde_json::from_str::<ReporterEvent>(&line) {
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
}
