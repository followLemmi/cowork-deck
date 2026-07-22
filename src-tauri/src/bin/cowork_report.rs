use std::io::{Read, Write};
use std::net::TcpStream;
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
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    let notification_type = extract_field(&buf, "notification_type");

    let payload = match notification_type {
        Some(nt) => format!(
            "{{\"session\":\"{}\",\"kind\":\"{}\",\"notificationType\":\"{}\"}}\n",
            esc(session), esc(kind), esc(&nt)
        ),
        None => format!(
            "{{\"session\":\"{}\",\"kind\":\"{}\"}}\n",
            esc(session), esc(kind)
        ),
    };

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
fn extract_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let start = json.find(&needle)? + needle.len();
    let rest = &json[start..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(after[..end].to_string())
}
