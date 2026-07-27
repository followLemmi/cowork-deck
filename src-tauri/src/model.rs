use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Idle,
    Working,
    WaitingInput,
    Ended,
    Error,
}

/// Привязка воркспейса к GitHub-аккаунту.
///
/// Здесь лежит ТОЛЬКО имя аккаунта — публичное значение. Токен не хранится
/// ни тут, ни где-либо ещё в приложении: он читается из keyring `gh` в момент
/// старта сессии и живёт лишь в памяти дочернего процесса.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceGithub {
    /// Хост GitHub. В UI всегда "github.com"; поле существует, чтобы GHES
    /// можно было добавить без миграции файла.
    pub host: String,
    /// Имя аккаунта в gh (как в `gh auth status`).
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitName")]
    pub git_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "gitEmail")]
    pub git_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sshKey")]
    pub ssh_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    /// Привязка к GitHub-аккаунту. Отсутствует в файлах, записанных до
    /// появления фичи; None не сериализуется, поэтому непривязанные
    /// воркспейсы сохраняют прежнюю форму на диске.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<WorkspaceGithub>,
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
}

/// Небольшое UI-состояние, переживающее перезапуск (пока — активное пространство).
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
        "ended" => Some(SessionState::Ended),
        "notify" => match notification_type {
            Some(t) if t.contains("permission") || t.contains("idle") => {
                Some(SessionState::WaitingInput)
            }
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
        assert_eq!(
            event_kind_to_state("notify", Some("idle_prompt")),
            Some(SessionState::WaitingInput)
        );
        assert_eq!(event_kind_to_state("notify", Some("other")), None);
        assert_eq!(event_kind_to_state("garbage", None), None);
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
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("workspaceId"), "None workspaceId must be omitted, got {json}");
    }

    #[test]
    fn old_workspace_without_github_deserializes_to_none() {
        let old = r##"{"id":"w1","name":"proj","path":"/tmp/proj","color":"#61afef"}"##;
        let ws: Workspace = serde_json::from_str(old).unwrap();
        assert!(ws.github.is_none());
    }

    #[test]
    fn workspace_without_github_serializes_without_the_field() {
        let ws = Workspace {
            id: "w1".into(), name: "proj".into(), path: "/tmp/proj".into(),
            color: "#61afef".into(), github: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(!json.contains("github"), "старая форма файла должна остаться байт-в-байт: {json}");
    }

    #[test]
    fn workspace_github_round_trips_with_camel_case_keys() {
        let ws = Workspace {
            id: "w1".into(), name: "proj".into(), path: "/tmp/proj".into(), color: "#61afef".into(),
            github: Some(WorkspaceGithub {
                host: "github.com".into(),
                login: "followLemmi".into(),
                git_name: Some("Evgeny".into()),
                git_email: Some("e@example.com".into()),
                ssh_key: None,
            }),
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains(r#""gitName":"Evgeny""#), "{json}");
        assert!(!json.contains("sshKey"), "пустые поля не сериализуются: {json}");
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.github, ws.github);
    }
}
