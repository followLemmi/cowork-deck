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
    // every hook payload, and it is the only thing that survives `/clear`:
    // clearing mints a new session id and a new file, so the id the deck
    // launched with stops naming the conversation the person is in.
    let transcript_path = extract_field(&buf, "transcript_path");

    let mut payload = format!("{{\"session\":\"{}\",\"kind\":\"{}\"", esc(session), esc(kind));
    if let Some(nt) = notification_type {
        payload.push_str(&format!(",\"notificationType\":\"{}\"", esc(&nt)));
    }
    if let Some(tp) = transcript_path {
        payload.push_str(&format!(",\"transcriptPath\":\"{}\"", esc(&tp)));
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
/// notification_type strings and a transcript path), not arbitrary JSON.
///
/// The key is only accepted where a key can appear — directly after `{` or `,`,
/// ignoring whitespace. Without that guard the scanner took the first textual
/// occurrence anywhere, and `Stop` payloads carry `last_assistant_message`: a
/// model that wrote `"transcript_path":"/tmp/evil"` in its reply would have been
/// read as the payload's own field. Field order happens to save it today —
/// `transcript_path` is the second key — which is exactly the kind of accident
/// that stops being true.
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
