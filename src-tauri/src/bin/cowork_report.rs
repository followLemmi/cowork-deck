use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // args: [prog, kind, port, session]
    if args.len() < 4 {
        return;
    }
    // `memory <port> <session> <workspace>`: the same binary, the same port, and
    // a reply. Everything about whether a search is worth running lives in the
    // app — this only carries the prompt there and prints what comes back, so
    // that no embedding model is ever loaded on the path of a message (#388).
    if args[1] == "memory" {
        memory(&args[2], &args[3], args.get(4).map(String::as_str).unwrap_or("-"));
        return;
    }
    let kind = &args[1];
    let port = &args[2];
    let session = &args[3];

    // Best-effort: read optional stdin JSON to extract notification_type.
    // The read happens on a separate thread and is bounded by a timeout so
    // this reporter can never block the host session waiting on stdin that
    // may never arrive or never close.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = std::io::stdin().read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let buf = rx.recv_timeout(Duration::from_millis(300)).unwrap_or_default();
    let notification_type = extract_field(&buf, "notification_type");
    // Where this conversation's transcript is *now*. Claude Code puts it in
    // every hook payload, and it does not go stale the way the id in argv above
    // does: `/clear` mints a new session id and a new file, so the id the deck
    // launched with stops naming the conversation the person is in.
    let transcript_path = extract_field(&buf, "transcript_path");
    // And which conversation that is — the other half of the same fact, carried
    // for the same reason. The app resumes this rather than the launch id, or a
    // restart brings back the conversation the person cleared away (#199).
    // Reported on every event and never filtered here: what to do with it is
    // the app's decision, and a reporter that judged would have to know why.
    let reported_session = extract_field(&buf, "session_id");

    let mut payload = format!("{{\"session\":\"{}\",\"kind\":\"{}\"", esc(session), esc(kind));
    if let Some(nt) = notification_type {
        payload.push_str(&format!(",\"notificationType\":\"{}\"", esc(&nt)));
    }
    if let Some(tp) = transcript_path {
        payload.push_str(&format!(",\"transcriptPath\":\"{}\"", esc(&tp)));
    }
    if let Some(rs) = reported_session {
        payload.push_str(&format!(",\"reportedSession\":\"{}\"", esc(&rs)));
    }
    payload.push_str("}\n");

    let addr = format!("127.0.0.1:{}", port);
    if let Ok(sock) = addr.parse() {
        if let Ok(mut stream) =
            TcpStream::connect_timeout(&sock, Duration::from_millis(300))
        {
            let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
            let _ = stream.write_all(payload.as_bytes());
            let _ = stream.flush();
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Minimal string-field extractor for a flat JSON object. Avoids a serde dep
/// in the reporter to keep it tiny; hook payload fields we need are strings.
/// Assumes flat, quote-free string values (Claude Code's internal
/// notification_type strings, a transcript path, a session uuid), not arbitrary
/// JSON.
///
/// The key is only accepted where a key can appear — directly after `{` or `,`,
/// ignoring whitespace. Without that guard the scanner took the first textual
/// occurrence anywhere, and `Stop` payloads carry `last_assistant_message`: a
/// model that wrote `"transcript_path":"/tmp/evil"` in its reply would have been
/// read as the payload's own field. Field order happens to save it today —
/// `transcript_path` is the second key — which is exactly the kind of accident
/// that stops being true. `session_id` is read the same way and needs the guard
/// for the same reason: it decides which conversation a restart resumes, so a
/// model that wrote one in its reply must not be able to name it.
fn extract_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let mut from = 0usize;
    while let Some(at) = json[from..].find(&needle) {
        let at = from + at;
        let before = json[..at].trim_end().chars().last();
        from = at + needle.len();
        if !matches!(before, Some('{') | Some(',')) {
            continue;
        }
        let rest = &json[from..];
        let colon = match rest.find(':') {
            Some(c) => c,
            None => return None,
        };
        let after = rest[colon + 1..].trim_start();
        let after = match after.strip_prefix('"') {
            Some(a) => a,
            None => continue,
        };
        let end = after.find('"')?;
        return Some(after[..end].to_string());
    }
    None
}

/// How long the app is given to answer before the prompt goes on without it.
///
/// A search spawns the sidecar and loads the model, which is seconds on a cold
/// one. This is generous enough for that and short enough that a wedged app
/// costs a pause rather than a session: nothing printed is a turn without
/// memory, which is exactly where this feature started.
const REPLY_TIMEOUT: Duration = Duration::from_secs(8);

/// Ask the app for what memory has on this prompt, and print it.
///
/// The payload is forwarded **untouched**: a prompt is arbitrary text with
/// newlines and quotes in it, and `extract_field` above is documented as
/// assuming flat, quote-free strings. Parsing it here would be the one place in
/// this binary that had to be right about JSON; the app has serde.
///
/// The framing is one header line and then the payload to end-of-stream, which
/// is what lets the listener keep reading lines for every other kind.
fn memory(port: &str, session: &str, workspace: &str) {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = std::io::stdin().read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let payload = rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
    if payload.trim().is_empty() {
        return;
    }

    let addr = format!("127.0.0.1:{port}");
    let Ok(sock) = addr.parse() else { return };
    let Ok(mut stream) = TcpStream::connect_timeout(&sock, Duration::from_millis(300)) else {
        return;
    };
    let header = format!(
        "{{\"session\":\"{}\",\"kind\":\"memory\",\"workspace\":\"{}\"}}\n",
        esc(session),
        esc(workspace),
    );
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    if stream.write_all(payload.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    // Half-close, so the app knows the payload is complete without needing a
    // length in the header — a length this binary would have to count in bytes
    // of somebody's UTF-8 prompt.
    let _ = stream.shutdown(std::net::Shutdown::Write);

    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT));
    let mut reply = String::new();
    if stream.read_to_string(&mut reply).is_err() {
        return;
    }
    let reply = reply.trim();
    if reply.is_empty() {
        return;
    }
    // Exit 0 with this on stdout is what folds it into the turn's context.
    println!("{reply}");
}
