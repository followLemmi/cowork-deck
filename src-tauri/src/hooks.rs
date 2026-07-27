use serde_json::json;

/// Build a Claude Code `--settings` JSON string that reports hook events to the
/// local listener via the companion reporter binary.
pub fn build_settings_json(reporter_path: &str, port: u16, session: &str) -> String {
    let mapping = [
        ("SessionStart", "start"),
        ("UserPromptSubmit", "working"),
        ("PreToolUse", "working"),
        ("Stop", "done"),
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
    }

    /// `Stop` fires when the agent finishes its turn, which is not the same as
    /// being blocked on a permission prompt. Reporting both as `waiting` is
    /// what made a scheduled scenario fire only once per window lifetime.
    #[test]
    fn stop_reports_done_while_permission_reports_waiting() {
        let s = build_settings_json("/opt/cowork_report", 1, "sess-1");
        let v: serde_json::Value = serde_json::from_str(&s).expect("valid json");
        let kind_of = |event: &str| -> String {
            v["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .to_string()
        };
        assert_eq!(kind_of("Stop"), "done");
        assert_eq!(kind_of("PermissionRequest"), "waiting");
    }
}
