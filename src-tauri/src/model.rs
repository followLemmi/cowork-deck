use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Idle,
    Working,
    /// Blocked until a human decides — a tool or MCP server is asking for
    /// permission. The session cannot progress on its own.
    WaitingInput,
    /// The agent finished its turn and the prompt is free again. Looks idle,
    /// but unlike `Idle` it means work was actually done, so it is worth a
    /// notification. Distinct from `WaitingInput`: nothing is blocked.
    Done,
    Ended,
    Error,
}

/// Runtime record of one scenario's scheduled runs, written only by the
/// scheduler loop and the ack command.
///
/// `last_attempt` is the gate: an occurrence is emitted at most once, so a
/// scenario that keeps failing cannot be retried every tick. `last_run` and
/// `last_outcome` are the record of what actually happened — the scheduler no
/// longer pretends a run succeeded just because it emitted the event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleRun {
    /// Occurrence we last emitted a fire for, launched or not (epoch millis).
    #[serde(rename = "lastAttempt")]
    pub last_attempt: i64,
    /// Occurrence of the last run that actually launched a session.
    #[serde(rename = "lastRun", default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<i64>,
    /// How the last attempt ended, as reported by the frontend.
    #[serde(rename = "lastOutcome", default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<String>,
    /// Storage format of the timestamps above.
    ///
    /// Version 1 wrote `naive_local().and_utc().timestamp_millis()` — a local
    /// wall clock labelled as if it were UTC. Self-consistent while the
    /// machine stayed in one timezone, and off by the offset the moment it
    /// did not, which could produce a spurious catch-up or a skipped run
    /// after travel or a DST change. Version 2 stores a true epoch. Records
    /// without the field are version 1 and are converted on read.
    #[serde(rename = "v", default = "v1")]
    pub version: u8,
    /// The rule `last_attempt` belongs to. Cleared while the schedule is off,
    /// so switching it back on — or moving the time earlier in the day — is
    /// treated as a fresh arming rather than a run that is owed right now.
    #[serde(rename = "preset", default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
}

fn v1() -> u8 { 1 }

pub const SCHEDULE_STATE_VERSION: u8 = 2;

/// Accepts both the current record and the bare epoch-millis number written
/// before the record existed, so upgrading does not re-arm every schedule.
#[derive(Deserialize)]
#[serde(untagged)]
enum ScheduleRunOnDisk {
    Record(ScheduleRun),
    Legacy(i64),
}

impl From<ScheduleRunOnDisk> for ScheduleRun {
    fn from(v: ScheduleRunOnDisk) -> Self {
        match v {
            ScheduleRunOnDisk::Record(r) => r,
            ScheduleRunOnDisk::Legacy(ms) => ScheduleRun {
                last_attempt: ms,
                last_run: Some(ms),
                last_outcome: None,
                version: 1,
                preset: None,
            },
        }
    }
}

/// Parse a whole `schedule_state.json` body, tolerating the legacy shape.
pub fn parse_schedule_state(
    s: &str,
) -> serde_json::Result<std::collections::HashMap<String, ScheduleRun>> {
    let raw: std::collections::HashMap<String, ScheduleRunOnDisk> = serde_json::from_str(s)?;
    Ok(raw.into_iter().map(|(k, v)| (k, v.into())).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub prompt: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    /// Optional schedule attached to this scenario. Absent (→ None) in
    /// `skills.json` files written before the feature existed; None is not
    /// serialized so unscheduled scenarios keep their old on-disk shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Schedule>,
}

/// How often a scheduled scenario fires. Presets only — no cron expressions
/// (see the design spec). Weekday is 0=Sunday..6=Saturday, matching both
/// `chrono::Weekday::num_days_from_sunday` and JS `Date.getDay()`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchedulePreset {
    Hourly { minute: u32 },
    Daily { hour: u32, minute: u32 },
    Weekly { weekday: u32, hour: u32, minute: u32 },
}

/// Schedule *definition* — edited by the user, stored on the `Skill`. The
/// runtime `lastRun` lives in a separate `schedule_state.json` so editing a
/// scenario cannot clobber it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    pub preset: SchedulePreset,
    /// Value per `{{placeholder}}` of the prompt — a scheduled run is
    /// unattended, so it cannot ask the user.
    #[serde(default)]
    pub defaults: std::collections::HashMap<String, String>,
    pub enabled: bool,
}

/// A persisted tile in the deck layout — enough to reopen it and resume its
/// claude conversation on next launch. The PTY itself is not persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    pub name: String,
    /// Workspace this session belongs to. Optional + defaulted so that
    /// layout files written before this field existed still load (→ None).
    #[serde(rename = "workspaceId", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Scenario this session was started by, when it came from a schedule.
    /// Restoring it is what keeps the overlap guard from raising a duplicate
    /// run right after auto-restore. Optional + defaulted like the field
    /// above, so older layout files still load.
    #[serde(rename = "scheduledSkillId", default, skip_serializing_if = "Option::is_none")]
    pub scheduled_skill_id: Option<String>,
}

/// A little UI state that survives a restart (for now: the active workspace).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct UiState {
    #[serde(rename = "activeWorkspaceId")]
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheCreation")]
    pub cache_creation: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReporterEvent {
    pub session: String,
    pub kind: String,
    #[serde(rename = "notificationType")]
    pub notification_type: Option<String>,
}

/// Map a reporter `kind` (+ optional notification type) to a session state.
/// Returns None for kinds that should not change the visible state.
pub fn event_kind_to_state(kind: &str, notification_type: Option<&str>) -> Option<SessionState> {
    match kind {
        "start" => Some(SessionState::Idle),
        "working" => Some(SessionState::Working),
        "waiting" => Some(SessionState::WaitingInput),
        "done" => Some(SessionState::Done),
        "ended" => Some(SessionState::Ended),
        // Only a permission prompt blocks. An idle nudge says nothing new:
        // after `Stop` the state is already `Done`, and while a permission
        // prompt is open, downgrading would let the overlap guard through.
        "notify" => match notification_type {
            Some(t) if t.contains("permission") => Some(SessionState::WaitingInput),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_kinds_to_states() {
        assert_eq!(event_kind_to_state("start", None), Some(SessionState::Idle));
        assert_eq!(event_kind_to_state("working", None), Some(SessionState::Working));
        assert_eq!(event_kind_to_state("waiting", None), Some(SessionState::WaitingInput));
        assert_eq!(event_kind_to_state("ended", None), Some(SessionState::Ended));
        assert_eq!(
            event_kind_to_state("notify", Some("permission_prompt")),
            Some(SessionState::WaitingInput)
        );
        assert_eq!(event_kind_to_state("notify", Some("other")), None);
        assert_eq!(event_kind_to_state("garbage", None), None);
    }

    /// `Stop` means the agent finished its turn and the prompt is free again;
    /// a permission request means it is blocked until a human decides. The
    /// overlap guard, the pill and notifications treat these differently, so
    /// they must not share one state.
    #[test]
    fn finished_turn_is_distinct_from_waiting_for_a_decision() {
        assert_eq!(event_kind_to_state("done", None), Some(SessionState::Done));
        assert_eq!(
            event_kind_to_state("waiting", None),
            Some(SessionState::WaitingInput)
        );
        assert_eq!(
            event_kind_to_state("notify", Some("permission_prompt")),
            Some(SessionState::WaitingInput)
        );
    }

    /// An idle nudge carries no new information: after `Stop` the state is
    /// already `Done`, and while a permission prompt is open it must not be
    /// downgraded to something the guard would let through.
    #[test]
    fn idle_notification_does_not_change_state() {
        assert_eq!(event_kind_to_state("notify", Some("idle_prompt")), None);
    }

    #[test]
    fn old_skill_without_schedule_deserializes_to_none() {
        let old = r#"{"id":"s1","name":"Report","icon":"▶","prompt":"hi","workspaceId":null}"#;
        let sk: Skill = serde_json::from_str(old).unwrap();
        assert!(sk.schedule.is_none());
        // None schedule must be omitted on re-serialize (no "schedule" key).
        let json = serde_json::to_string(&sk).unwrap();
        assert!(!json.contains("schedule"), "None schedule must be omitted, got {json}");
    }

    #[test]
    fn schedule_preset_round_trips_with_kind_tag() {
        let daily = Schedule {
            preset: SchedulePreset::Daily { hour: 9, minute: 30 },
            defaults: std::collections::HashMap::new(),
            enabled: true,
        };
        let json = serde_json::to_string(&daily).unwrap();
        assert!(json.contains(r#""kind":"daily""#), "got {json}");
        let back: Schedule = serde_json::from_str(&json).unwrap();
        assert_eq!(back, daily);

        let weekly: Schedule = serde_json::from_str(
            r#"{"preset":{"kind":"weekly","weekday":1,"hour":8,"minute":0},"defaults":{"name":"Bob"},"enabled":true}"#,
        ).unwrap();
        assert_eq!(weekly.preset, SchedulePreset::Weekly { weekday: 1, hour: 8, minute: 0 });
        assert_eq!(weekly.defaults.get("name").map(String::as_str), Some("Bob"));
    }

    #[test]
    fn session_entry_workspace_id_is_backward_compatible() {
        // Old file (pre-feature) has no workspaceId → deserializes to None.
        let old = r#"[{"sessionId":"s1","cwd":"/a","name":"N"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].workspace_id, None);

        // New file carries workspaceId.
        let new = r#"[{"sessionId":"s2","cwd":"/b","name":"M","workspaceId":"w1"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(new).unwrap();
        assert_eq!(v[0].workspace_id.as_deref(), Some("w1"));

        // None is omitted from output (keeps files clean).
        let entry = SessionEntry {
            session_id: "s3".into(), cwd: "/c".into(), name: "K".into(), workspace_id: None,
            scheduled_skill_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("workspaceId"), "None workspaceId must be omitted, got {json}");
        assert!(!json.contains("scheduledSkillId"), "None scheduledSkillId must be omitted, got {json}");

        // A layout written before the field existed still loads.
        let old_entry = r#"{"sessionId":"s4","cwd":"/c","name":"K"}"#;
        let e: SessionEntry = serde_json::from_str(old_entry).unwrap();
        assert_eq!(e.scheduled_skill_id, None);
    }
}
