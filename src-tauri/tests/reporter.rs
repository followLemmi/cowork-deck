use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Command, Stdio};

#[test]
fn reporter_sends_a_json_line() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    });

    let bin = env!("CARGO_BIN_EXE_cowork_report");
    let mut child = Command::new(bin)
        .args(["waiting", &port.to_string(), "sess-1"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    // provide a hook-like stdin payload
    use std::io::Write;
    child.stdin.take().unwrap().write_all(b"{\"session_id\":\"x\"}").unwrap();
    child.wait().unwrap();

    let line = handle.join().unwrap();
    assert!(line.contains("\"session\":\"sess-1\""), "got: {line}");
    assert!(line.contains("\"kind\":\"waiting\""), "got: {line}");
}

/// One line, one round trip, for the field that survives `/clear`: the id the
/// deck launched with stops naming the conversation, and this is what replaces
/// it.
#[test]
fn reporter_carries_the_transcript_path_from_stdin() {
    let line = report_with(
        "working",
        "sess-3",
        br#"{"session_id":"abc","transcript_path":"/home/u/.claude/projects/-p/abc.jsonl","cwd":"/p"}"#,
    );
    assert!(
        line.contains(r#""transcriptPath":"/home/u/.claude/projects/-p/abc.jsonl""#),
        "got: {line}",
    );
}

/// `Stop` carries `last_assistant_message`, which is model output. A reply that
/// happens to contain the key must not be mistaken for the payload's own field.
#[test]
fn a_transcript_path_inside_an_assistant_message_is_not_mistaken_for_the_field() {
    let line = report_with(
        "done",
        "sess-4",
        br#"{"session_id":"abc","transcript_path":"/real/abc.jsonl","last_assistant_message":"set \"transcript_path\":\"/tmp/evil\" in the config"}"#,
    );
    assert!(line.contains(r#""transcriptPath":"/real/abc.jsonl""#), "got: {line}");
    assert!(!line.contains("/tmp/evil"), "got: {line}");
}

#[test]
fn a_payload_without_a_transcript_path_omits_the_field() {
    let line = report_with("working", "sess-5", br#"{"session_id":"abc"}"#);
    assert!(!line.contains("transcriptPath"), "got: {line}");
    assert!(line.contains(r#""kind":"working""#), "got: {line}");
}

/// Run the reporter against a throwaway listener and return the line it sent.
fn report_with(kind: &str, session: &str, stdin: &[u8]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    });
    let bin = env!("CARGO_BIN_EXE_cowork_report");
    let mut child = Command::new(bin)
        .args([kind, &port.to_string(), session])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait().unwrap();
    handle.join().unwrap()
}

#[test]
fn reporter_extracts_notification_type_from_stdin() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    });

    let bin = env!("CARGO_BIN_EXE_cowork_report");
    let mut child = Command::new(bin)
        .args(["waiting", &port.to_string(), "sess-2"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"notification_type\":\"idle_prompt\"}")
        .unwrap();
    child.wait().unwrap();

    let line = handle.join().unwrap();
    assert!(
        line.contains("\"notificationType\":\"idle_prompt\""),
        "got: {line}"
    );
}
