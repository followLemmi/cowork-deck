use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

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

    // Best-effort: read optional stdin JSON for the fields below.
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
    let payload = payload_line(session, kind, &buf);

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

/// What this reporter forwards out of a hook payload, and the name the app's
/// `ReporterEvent` knows each field by.
///
/// - `notification_type` is the only one that decides a *state*: a permission
///   prompt blocks and an idle nudge does not, and `event_kind_to_state` cannot
///   tell them apart without it.
/// - `transcript_path` is where this conversation's transcript is *now*. It does
///   not go stale the way the id in argv does: `/clear` mints a new session id
///   and a new file, so the id the deck launched with stops naming the
///   conversation the person is in.
/// - `session_id` is which conversation that is — the other half of the same
///   fact. The app resumes this rather than the launch id, or a restart brings
///   back the conversation the person cleared away (#199).
/// - `cwd` is where Claude Code says this session is working, which is the only
///   answer to that question that comes from the session itself rather than from
///   what the app asked for at launch (#508). Reported on every event, and every
///   one of these is: what to do with them is the app's decision, and a reporter
///   that judged would have to know why.
const FORWARDED: [(&str, &str); 4] = [
    ("notification_type", "notificationType"),
    ("transcript_path", "transcriptPath"),
    ("session_id", "reportedSession"),
    ("cwd", "cwd"),
];

/// The line one hook event becomes: the reporter's own argv, plus whatever of
/// [`FORWARDED`] the payload on stdin turned out to carry.
///
/// **The payload is parsed as JSON, because it is JSON.** This replaced a
/// hand-rolled string scanner that took the first textual occurrence of each key
/// and guarded it only by "a key can appear after `{` or `,`" — which rules out a
/// match inside a string value but not one inside a nested object, so what kept
/// it right was that Claude Code happens to write these fields first. That is an
/// ordering, not a guarantee, and `cwd` raised the stakes of it: the app hands
/// that value to `git -C`. `serde_json` is already a dependency of this crate, so
/// the parse costs the sidecar some bytes and nothing else, and it makes depth,
/// escaping and duplicate keys somebody else's solved problem.
///
/// A payload that does not parse — empty stdin, or a read the 300ms timeout cut
/// in half — yields no fields rather than the early ones a tolerant scanner would
/// still have found. That costs nothing durable: every field above is reported on
/// every hook event and every registry that receives one is last-wins, so a lost
/// event is re-stated by the next. The one payload big enough to plausibly
/// truncate is `Stop`, which carries `last_assistant_message` — and its fields
/// are exactly the three that get re-stated.
fn payload_line(session: &str, kind: &str, stdin: &str) -> String {
    let mut line = json!({ "session": session, "kind": kind });
    let hook: Option<Value> = serde_json::from_str(stdin).ok();
    let obj = line.as_object_mut().expect("built from an object literal");
    for (from, to) in FORWARDED {
        let value = hook.as_ref().and_then(|h| h.get(from)).and_then(Value::as_str);
        if let Some(v) = value.filter(|s| !s.is_empty()) {
            obj.insert(to.to_string(), Value::String(v.to_string()));
        }
    }
    format!("{line}\n")
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
/// newlines and quotes in it, and the app is the side with a reason to look
/// inside it.
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
        "{}\n",
        json!({ "session": session, "kind": "memory", "workspace": workspace }),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn field(line: &str, key: &str) -> Option<String> {
        let v: Value = serde_json::from_str(line.trim()).expect("a line is valid JSON");
        v.get(key)?.as_str().map(str::to_string)
    }

    /// The shape of a real Claude Code hook payload, in the key order Claude
    /// Code writes: the three fields this reporter reads come first, which is
    /// exactly the accident the parse no longer depends on.
    const PAYLOAD: &str = r#"{
        "session_id": "after-a-clear",
        "transcript_path": "/home/u/.claude/projects/-p/new.jsonl",
        "cwd": "/home/u/projects/deck-issue/508-a-bug",
        "hook_event_name": "PreToolUse"
    }"#;

    #[test]
    fn argv_alone_makes_a_line() {
        let line = payload_line("sess-1", "working", "");
        assert_eq!(field(&line, "session").as_deref(), Some("sess-1"));
        assert_eq!(field(&line, "kind").as_deref(), Some("working"));
        // Nothing invented for a payload that said nothing.
        for (_, name) in FORWARDED {
            assert_eq!(field(&line, name), None, "{name} came from nowhere");
        }
    }

    #[test]
    fn every_forwarded_field_reaches_the_line_under_the_apps_name_for_it() {
        let line = payload_line("sess-1", "working", PAYLOAD);
        assert_eq!(field(&line, "reportedSession").as_deref(), Some("after-a-clear"));
        assert_eq!(
            field(&line, "transcriptPath").as_deref(),
            Some("/home/u/.claude/projects/-p/new.jsonl"),
        );
        assert_eq!(
            field(&line, "cwd").as_deref(),
            Some("/home/u/projects/deck-issue/508-a-bug"),
        );
    }

    /// The fault the scanner this replaced was one field order away from: a
    /// `Stop` payload carries the model's own prose, and a model that wrote a
    /// key-shaped string into its reply was read as the payload's own field.
    /// `cwd` is the one that matters, because the app hands it to `git -C`.
    #[test]
    fn a_model_writing_a_field_into_its_reply_is_not_read_as_that_field() {
        let hostile = r#"{
            "last_assistant_message": "I set {\"cwd\":\"/etc\",\"transcript_path\":\"/tmp/evil\"} for you",
            "session_id": "sess-real",
            "cwd": "/home/u/projects/deck"
        }"#;
        let line = payload_line("sess-1", "done", hostile);
        assert_eq!(field(&line, "cwd").as_deref(), Some("/home/u/projects/deck"));
        assert_eq!(field(&line, "transcriptPath"), None);
    }

    /// And the fault it could not have been saved from by ordering: a key of the
    /// same name inside a nested object, ahead of the payload's own.
    #[test]
    fn a_nested_object_of_the_same_name_is_not_the_payloads_field() {
        let nested = r#"{
            "tool_input": { "cwd": "/somewhere/else", "command": "pwd" },
            "cwd": "/home/u/projects/deck"
        }"#;
        assert_eq!(
            field(&payload_line("s", "working", nested), "cwd").as_deref(),
            Some("/home/u/projects/deck"),
        );
    }

    /// A path is the field most likely to carry an escape — a Windows separator,
    /// or a quote in a directory name — and the scanner this replaced returned
    /// the escapes as written.
    #[test]
    fn escapes_in_a_path_are_decoded() {
        let escaped = r#"{"cwd":"C:\\Users\\a b\\deck","transcript_path":"/tmp/say \"hi\"/t.jsonl"}"#;
        let line = payload_line("s", "working", escaped);
        assert_eq!(field(&line, "cwd").as_deref(), Some(r"C:\Users\a b\deck"));
        assert_eq!(field(&line, "transcriptPath").as_deref(), Some("/tmp/say \"hi\"/t.jsonl"));
    }

    /// A field present but empty says nothing, and must not displace the launch
    /// directory the app falls back to.
    #[test]
    fn an_empty_field_is_not_forwarded() {
        let line = payload_line("s", "working", r#"{"cwd":"","session_id":""}"#);
        assert_eq!(field(&line, "cwd"), None);
        assert_eq!(field(&line, "reportedSession"), None);
    }

    /// Payload text that is not JSON at all, and a payload that is JSON but not
    /// an object. Both are "the hook said nothing", never a panic.
    #[test]
    fn a_payload_that_does_not_parse_yields_only_argv() {
        for junk in ["not json at all", "{\"cwd\":", "[1,2,3]", "null"] {
            let line = payload_line("sess-1", "working", junk);
            assert_eq!(field(&line, "session").as_deref(), Some("sess-1"), "on {junk:?}");
            assert_eq!(field(&line, "cwd"), None, "on {junk:?}");
        }
    }

    /// A session id or a kind with a quote in it cannot break the line's framing.
    /// The hand-rolled escaper this replaced got that right too; the test stays,
    /// because it is the property and not the implementation.
    #[test]
    fn argv_is_escaped_into_the_line() {
        let line = payload_line("a\"b\\c", "wo\"rking", "");
        assert_eq!(field(&line, "session").as_deref(), Some("a\"b\\c"));
        assert_eq!(field(&line, "kind").as_deref(), Some("wo\"rking"));
        assert_eq!(line.lines().count(), 1);
    }

    /// The one field whose loss changes what the app *does*: without it a
    /// permission prompt is an idle nudge, and the tile does not say it is
    /// blocked.
    #[test]
    fn a_notification_type_is_forwarded() {
        let line = payload_line("s", "notify", r#"{"notification_type":"permission_prompt"}"#);
        assert_eq!(field(&line, "notificationType").as_deref(), Some("permission_prompt"));
    }
}
