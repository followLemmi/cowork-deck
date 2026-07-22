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
