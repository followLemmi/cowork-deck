use serde_json::json;

/// Build a Claude Code `--settings` JSON string that reports hook events to the
/// local listener via the companion reporter binary, and — on the two events
/// that can act on a tracker card — appends `cowork_task guard`.
///
/// `UserPromptSubmit` carries a third command: the memory client (#388). A hook
/// on that event which exits 0 has its stdout folded into the context of that
/// turn, and that is the lever the system-prompt instruction lost to — a rule
/// about every question in general loses to context about *this* question. The
/// search itself happens in the app, on this same port: loading the embedding
/// model per prompt is what #35 was protecting against.
///
/// `workspace` scopes that search to one project plus the global lessons. `None`
/// searches everything, which is what a session launched outside a workspace
/// means rather than a fallback.
pub fn build_settings_json(
    reporter_path: &str,
    port: u16,
    session: &str,
    task_bin: &str,
    workspace: Option<&str>,
) -> String {
    // **`Stop` does not run when the person interrupts the turn.** Documented
    // behaviour of the hook rather than a gap here, and there is no other event
    // that fires in its place — so the `working` the last `PreToolUse` set would
    // stand for the rest of the session's life, and `working` is what the
    // scheduler's overlap guard and a card's status read (#333). The end of a
    // turn nobody reports is read off the terminal's own screen instead; see
    // `src/interrupt.ts` and ADR-0011. Nothing about this table changes for it:
    // a hook that does run is still the better answer, and this one stays the
    // only source for every turn that ends on its own.
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
        let report = format!("\"{}\" {} {} {}", reporter_path, kind, port, session);
        let mut commands = vec![json!({ "type": "command", "command": report })];
        // The reporter stays first: its job is unchanged, so the guard —
        // the newer, riskier command — is appended after it rather than
        // inserted ahead of it. Hooks in a matcher group run independently and
        // their outcomes are aggregated, not decided by list order: any one
        // of them exiting 2 blocks, regardless of position. Attached
        // unconditionally — the guard reads its own environment and allows on
        // its own when there is no card, so there is no branch to forget on
        // the --resume path.
        if event == "UserPromptSubmit" || event == "Stop" {
            commands.push(json!({ "type": "command", "command": format!("\"{}\" guard", task_bin) }));
        }
        // Attached unconditionally, for the reason the guard above is: the
        // `--resume` path then has no branch to forget. A workspace the session
        // was not launched in is a dash rather than an absent argument, so the
        // reporter's positional parsing cannot silently read the next thing
        // along as a workspace id.
        if event == "UserPromptSubmit" {
            let mem = format!(
                "\"{}\" memory {} {} {}",
                reporter_path,
                port,
                session,
                workspace.filter(|w| !w.trim().is_empty()).unwrap_or("-"),
            );
            commands.push(json!({ "type": "command", "command": mem }));
        }
        hooks.insert(event.to_string(), json!([ { "hooks": commands } ]));
    }

    json!({ "hooks": hooks }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_json_with_all_events() {
        let s = build_settings_json("/opt/cowork_report", 51234, "sess-9", "/opt/cowork_task", Some("ws-1"));
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
        let s = build_settings_json("/opt/cowork_report", 1, "sess-1", "/opt/cowork_task", Some("ws-1"));
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

    #[test]
    fn the_reporter_stays_first_on_every_event() {
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t", Some("ws-1"))).unwrap();
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop",
                   "PermissionRequest", "Notification", "SessionEnd"] {
            let first = v["hooks"][ev][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(first.contains("/r"), "{ev}: {first}");
        }
    }

    #[test]
    fn the_guard_is_added_to_user_prompt_submit_and_stop_and_nowhere_else() {
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t", Some("ws-1"))).unwrap();
        let count = |ev: &str| v["hooks"][ev][0]["hooks"].as_array().unwrap().len();
        // Three on the prompt: the reporter, the guard, and the memory client
        // (#388). Two on `Stop`, which has no prompt to search.
        assert_eq!(count("UserPromptSubmit"), 3);
        assert_eq!(count("Stop"), 2);
        for ev in ["SessionStart", "PreToolUse", "PermissionRequest", "Notification", "SessionEnd"] {
            assert_eq!(count(ev), 1, "{ev}");
        }
    }

    #[test]
    fn the_guard_is_attached_even_without_a_card_because_it_allows_on_its_own() {
        // One branch instead of two when building the settings, and one less
        // thing to forget on the --resume path. Checked on both events the
        // guard is attached to — a prior version of this test asserted only
        // on `Stop`, so a guard command missing from `UserPromptSubmit`
        // specifically would have passed.
        let v: serde_json::Value = serde_json::from_str(&build_settings_json("/r", 1, "s", "/t", Some("ws-1"))).unwrap();
        for ev in ["UserPromptSubmit", "Stop"] {
            let cmd = v["hooks"][ev][0]["hooks"][1]["command"].as_str().unwrap();
            assert!(cmd.contains("/t") && cmd.contains("guard"), "{ev}: {cmd}");
        }
    }

    /// #388. A hook on this event that exits 0 has its stdout folded into the
    /// turn's context, which is the lever the system-prompt instruction lost to.
    #[test]
    fn the_memory_client_is_on_the_prompt_and_nowhere_else() {
        let v: serde_json::Value =
            serde_json::from_str(&build_settings_json("/r", 51234, "s-9", "/t", Some("ws-1")))
                .unwrap();
        let cmd = v["hooks"]["UserPromptSubmit"][0]["hooks"][2]["command"].as_str().unwrap();
        assert_eq!(cmd, "\"/r\" memory 51234 s-9 ws-1");

        for ev in ["SessionStart", "PreToolUse", "Stop", "PermissionRequest",
                   "Notification", "SessionEnd"] {
            let list = v["hooks"][ev][0]["hooks"].as_array().unwrap();
            assert!(
                !list.iter().any(|c| c["command"].as_str().unwrap().contains(" memory ")),
                "{ev} must not search on every event",
            );
        }
    }

    /// A dash rather than an absent argument: the reporter parses positionally,
    /// and a missing one would let it read the next thing along as a workspace.
    #[test]
    fn a_session_outside_a_workspace_still_gets_the_hook() {
        for ws in [None, Some(""), Some("   ")] {
            let v: serde_json::Value =
                serde_json::from_str(&build_settings_json("/r", 1, "s", "/t", ws)).unwrap();
            let cmd = v["hooks"]["UserPromptSubmit"][0]["hooks"][2]["command"].as_str().unwrap();
            assert!(cmd.ends_with(" memory 1 s -"), "{ws:?}: {cmd}");
        }
    }
}
