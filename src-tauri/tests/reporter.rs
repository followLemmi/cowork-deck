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

/// The other half of the same line, and the one that decides which conversation
/// a restart resumes: Claude Code's own `session_id`, which is the deck's launch
/// id until somebody types `/clear` and a different id afterwards (#199).
#[test]
fn reporter_carries_the_reported_session_id_from_stdin() {
    let line = report_with(
        "start",
        "sess-launch",
        br#"{"session_id":"6e0347f3-5ed4-41bc-be96-d314586203a8","transcript_path":"/p/x.jsonl","cwd":"/p","hook_event_name":"SessionStart","source":"clear"}"#,
    );
    // The deck's own id stays what it always was — it is the pty key and the key
    // every event is attributed by — and the conversation rides beside it.
    assert!(line.contains(r#""session":"sess-launch""#), "got: {line}");
    assert!(
        line.contains(r#""reportedSession":"6e0347f3-5ed4-41bc-be96-d314586203a8""#),
        "got: {line}",
    );
}

/// The same guard as the transcript path above, on the field that is worth more
/// to get wrong: a model that writes a session id into its reply must not be
/// able to name the conversation the next restart resumes.
#[test]
fn a_session_id_inside_an_assistant_message_is_not_mistaken_for_the_field() {
    let line = report_with(
        "done",
        "sess-6",
        br#"{"session_id":"real-one","last_assistant_message":"set \"session_id\":\"attacker\" in the config"}"#,
    );
    assert!(line.contains(r#""reportedSession":"real-one""#), "got: {line}");
    assert!(!line.contains("attacker"), "got: {line}");
}

/// The same guard where a model's prose can reach further than a string: a key
/// of the same name inside a nested object, ahead of the payload's own. Field
/// order used to be the only thing that made this come out right; the reporter
/// parses the payload now, so depth does.
#[test]
fn a_nested_object_of_the_same_name_is_not_the_payloads_field() {
    let line = report_with(
        "working",
        "sess-8",
        br#"{"tool_input":{"cwd":"/somewhere/else","session_id":"attacker"},"session_id":"real-one","cwd":"/p/deck"}"#,
    );
    assert!(line.contains(r#""cwd":"/p/deck""#), "got: {line}");
    assert!(line.contains(r#""reportedSession":"real-one""#), "got: {line}");
    assert!(!line.contains("attacker"), "got: {line}");
    assert!(!line.contains("somewhere/else"), "got: {line}");
}

/// Where this session says it is working, which is what every per-session display
/// follows now that none of them reads the launch directory forever (#508).
#[test]
fn reporter_carries_the_cwd_from_stdin() {
    let line = report_with(
        "working",
        "sess-9",
        br#"{"session_id":"abc","transcript_path":"/p/abc.jsonl","cwd":"/home/u/projects/deck-issue/508-a-bug"}"#,
    );
    assert!(line.contains(r#""cwd":"/home/u/projects/deck-issue/508-a-bug""#), "got: {line}");
}

#[test]
fn a_payload_without_a_cwd_omits_the_field() {
    let line = report_with("working", "sess-10", br#"{"session_id":"abc"}"#);
    assert!(!line.contains("cwd"), "got: {line}");
}

/// A payload that is not JSON at all carries no fields — and still carries argv,
/// so the state this event reports arrives regardless.
///
/// This is the one place the parse is less forgiving than the string scanner it
/// replaced, and it is deliberate: nothing Claude Code writes is malformed, and
/// the alternative is a scanner whose answer on a broken payload depends on where
/// it broke. Nothing durable is lost either way — every field the reporter
/// forwards arrives again on the next hook event, and each of them is last-wins
/// in the app.
#[test]
fn a_payload_that_is_not_json_carries_argv_and_nothing_else() {
    let line = report_with("waiting", "sess-11", b"claude wrote something odd here {");
    assert!(line.contains(r#""session":"sess-11""#), "got: {line}");
    assert!(line.contains(r#""kind":"waiting""#), "got: {line}");
    assert!(!line.contains("cwd"), "got: {line}");
    assert!(!line.contains("reportedSession"), "got: {line}");
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

/// A hook payload with no `session_id` at all — nothing the app has seen writes
/// one, but an absent field must leave the line shaped as it was rather than
/// carrying an empty id the listener would have to know to ignore.
#[test]
fn a_payload_without_a_session_id_omits_the_field() {
    let line = report_with("working", "sess-7", br#"{"cwd":"/p"}"#);
    assert!(!line.contains("reportedSession"), "got: {line}");
    assert!(line.contains(r#""session":"sess-7""#), "got: {line}");
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
