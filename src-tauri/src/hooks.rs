use serde_json::json;

/// Build a Claude Code `--settings` JSON string that reports hook events to the
/// local listener via the companion reporter binary.
pub fn build_settings_json(reporter_path: &str, port: u16, session: &str) -> String {
    let mapping = [
        ("SessionStart", "start"),
        ("UserPromptSubmit", "working"),
        ("PreToolUse", "working"),
        ("Stop", "waiting"),
        ("PermissionRequest", "waiting"),
        ("Notification", "notify"),
        ("SessionEnd", "ended"),
    ];

    let mut hooks = serde_json::Map::new();
    for (event, kind) in mapping {
        // Quote the reporter path for shells; args are literal (no shell metachars).
        let command = format!("\"{}\" {} {} {}", reporter_path, kind, port, session);
        hooks.insert(
            event.to_string(),
            json!([ { "hooks": [ { "type": "command", "command": command } ] } ]),
        );
    }

    json!({ "hooks": hooks }).to_string()
}

/// Write `build_settings_json(...)` to a temp file and return its path.
pub fn write_settings_file(
    reporter_path: &str, port: u16, session: &str,
) -> std::io::Result<std::path::PathBuf> {
    let json = build_settings_json(reporter_path, port, session);
    let mut path = std::env::temp_dir();
    path.push(format!("coworkdeck-{}.json", session));
    std::fs::write(&path, json)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_json_with_all_events() {
        let s = build_settings_json("/opt/cowork_report", 51234, "sess-9");
        let v: serde_json::Value = serde_json::from_str(&s).expect("valid json");
        let hooks = &v["hooks"];
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "PermissionRequest", "Notification", "SessionEnd"] {
            assert!(hooks.get(ev).is_some(), "missing event {ev}");
        }
        // command must carry port + session
        let cmd = hooks["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("51234"), "cmd: {cmd}");
        assert!(cmd.contains("sess-9"), "cmd: {cmd}");
        assert!(cmd.contains("waiting"), "cmd: {cmd}");
    }

    #[test]
    fn writes_settings_file_with_session_command() {
        let p = write_settings_file("/opt/cowork_report", 7777, "sess-file").unwrap();
        let body = std::fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().contains("sess-file"));
        let _ = std::fs::remove_file(p);
    }
}
