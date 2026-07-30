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
    /// Absent for every workspace created before the tracker existed, and for
    /// any workspace the user never configured. `default` is what keeps an old
    /// settings file readable — a failed read would let the next upsert
    /// truncate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<TrackerConfig>,
}

/// Where a workspace's cards were before its effective root last moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviousLocation {
    /// Where to look for the old cards.
    pub root: String,
    /// The project name at that time. When it differs from the current
    /// `ws.name`, `project:` inside the moved cards has to be rewritten.
    pub project: String,
    /// Whether that was the in-project root, which decides whether damaged
    /// cards come along: from `.cowork/tasks` everything is ours by
    /// construction, from a shared vault a damaged card may be someone's note
    /// that merely has an `id:` field.
    #[serde(rename = "wasProjectRoot")]
    pub was_project_root: bool,
}

/// Per-workspace tracker configuration. A list of providers rather than a
/// single one, so GitHub/Jira arrive as an added element instead of a schema
/// rewrite. Tokens never live here — they belong in the system keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerConfig {
    #[serde(default)]
    pub providers: Vec<TrackerProvider>,
    /// Where this workspace's cards were before its effective root last moved.
    #[serde(rename = "previousLocation", default, skip_serializing_if = "Option::is_none")]
    pub previous_location: Option<PreviousLocation>,
    /// Storage format for the layout below a picked path. Version 1 used the
    /// picked folder verbatim; version 2 added a project subfolder; version 3
    /// puts that subfolder inside a `cowork-deck-tasks` container. Records
    /// without the field are version 1 and are seeded on read.
    #[serde(rename = "v", default = "tracker_v1")]
    pub version: u8,
}

fn tracker_v1() -> u8 { 1 }

pub const TRACKER_CONFIG_VERSION: u8 = 3;

#[derive(Debug, Clone)]
pub enum TrackerProvider {
    Fs { root: TrackerRoot },
    /// The workspace's board is the GitHub issues of the repository its folder
    /// *is*. No fields: `owner/name` comes from `gh` itself, once per app run
    /// (decision 11), and storing it here would be a second source of truth.
    ///
    /// A build predating this variant reads it as `Unknown` and keeps the rest of
    /// the workspace (#117, Task 2). A build predating *that* empties the whole
    /// list, and its own next save makes it permanent — the write happens in
    /// whichever binary is running, so the fix is effective from here on and
    /// inert for anything already installed. The README warns about that half.
    GitHub,
    /// A source this build cannot read — written by a newer version, or damaged.
    ///
    /// Carries the original JSON and is serialized back verbatim, so opening an
    /// older build and editing an unrelated field does not destroy a
    /// configuration it merely does not understand (#117). A unit catch-all
    /// variant would round-trip to `{"type":"unknown"}` and do exactly that.
    ///
    /// Every reader treats it as "no usable tracker": `resolve_root` yields
    /// `None`, `is_project_root` is false, and the board says so in words rather
    /// than showing "no tracker configured", which would be a different claim.
    Unknown(serde_json::Value),
}

/// The on-disk shape, accepted tolerantly. The same pattern as
/// `ScheduleRunOnDisk` above: an untagged helper that tries the known shapes and
/// keeps the raw value rather than failing the document.
#[derive(Deserialize)]
#[serde(untagged)]
enum TrackerProviderOnDisk {
    Known(KnownTrackerProvider),
    Raw(serde_json::Value),
}

/// The tag spelling lives here and nowhere else. **Both directions are derived**,
/// so they cannot disagree about it.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum KnownTrackerProvider {
    Fs { root: TrackerRoot },
    GitHub,
}

impl From<TrackerProviderOnDisk> for TrackerProvider {
    fn from(v: TrackerProviderOnDisk) -> Self {
        match v {
            TrackerProviderOnDisk::Known(KnownTrackerProvider::Fs { root }) => {
                TrackerProvider::Fs { root }
            }
            TrackerProviderOnDisk::Known(KnownTrackerProvider::GitHub) => TrackerProvider::GitHub,
            TrackerProviderOnDisk::Raw(v) => TrackerProvider::Unknown(v),
        }
    }
}

impl<'de> Deserialize<'de> for TrackerProvider {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(TrackerProviderOnDisk::deserialize(d)?.into())
    }
}

impl Serialize for TrackerProvider {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            // Delegated, never hand-rolled: writing `{"type":"fs", …}` by hand
            // here would put the tag spelling in a second place, and the one
            // failure this whole task exists to prevent is a silent change to the
            // wire format of every user's workspaces.json.
            TrackerProvider::Fs { root } => {
                KnownTrackerProvider::Fs { root: root.clone() }.serialize(s)
            }
            TrackerProvider::GitHub => KnownTrackerProvider::GitHub.serialize(s),
            // Verbatim in *value*, not in bytes: `serde_json::Value`'s object is a
            // BTreeMap, so keys come back alphabetised and whitespace is the
            // writer's. Nothing anywhere compares these bytes, so this is
            // harmless — said out loud because a re-ordered key list looks like a
            // bug to whoever diffs the file next.
            TrackerProvider::Unknown(v) => v.serialize(s),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TrackerRoot {
    /// `<workspace.path>/.cowork/tasks`, tracked in git like any other project file.
    Project,
    /// Any folder the user picked: a dedicated repo, an Obsidian vault, a synced dir.
    Path { path: String },
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
    /// Tracker card this session was launched from.
    ///
    /// NOTE: `SessionEntry` renames fields ONE BY ONE (`rename = "sessionId"`),
    /// not via `rename_all = "camelCase"`. Without an explicit `rename` serde
    /// would write `task_id` while TS reads `taskId`, and the card-to-session
    /// link would silently fail to restore after an app restart.
    #[serde(rename = "taskId", default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
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
    fn workspace_without_tracker_still_deserializes() {
        // Settings written before this feature existed must still read back
        // whole — otherwise the first upsert truncates the workspaces file.
        let old = r##"{"id":"w1","name":"deck","path":"/p","color":"#61afef"}"##;
        let ws: Workspace = serde_json::from_str(old).expect("old workspace must still parse");
        assert_eq!(ws.name, "deck");
        assert!(ws.tracker.is_none());
    }

    #[test]
    fn tracker_config_round_trips_both_root_kinds() {
        let in_project = TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Project }],
            previous_location: None,
            version: TRACKER_CONFIG_VERSION,
        };
        let json = serde_json::to_string(&in_project).unwrap();
        let back: TrackerConfig = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.providers[0], TrackerProvider::Fs { root: TrackerRoot::Project }));

        let external = TrackerConfig {
            providers: vec![TrackerProvider::Fs {
                root: TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
            }],
            previous_location: None,
            version: TRACKER_CONFIG_VERSION,
        };
        let json = serde_json::to_string(&external).unwrap();
        let back: TrackerConfig = serde_json::from_str(&json).unwrap();
        match &back.providers[0] {
            TrackerProvider::Fs { root: TrackerRoot::Path { path } } => assert_eq!(path, "/home/u/vault/Tasks"),
            other => panic!("wrong root: {other:?}"),
        }
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
            task_id: None, scheduled_skill_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("workspaceId"), "None workspaceId must be omitted, got {json}");
        assert!(!json.contains("scheduledSkillId"), "None scheduledSkillId must be omitted, got {json}");

        // A layout written before the field existed still loads.
        let old_entry = r#"{"sessionId":"s4","cwd":"/c","name":"K"}"#;
        let e: SessionEntry = serde_json::from_str(old_entry).unwrap();
        assert_eq!(e.scheduled_skill_id, None);
    }

    /// The record stays visible: one unreadable *provider* must not cost the
    /// workspace its name, its folder or its account.
    #[test]
    fn a_workspace_with_an_unknown_provider_keeps_every_other_field() {
        let json = r##"{"id":"w1","name":"A","path":"/a","color":"#fff",
            "github":{"host":"github.com","login":"me"},
            "tracker":{"providers":[{"type":"jira","site":"acme.atlassian.net"}],"v":3}}"##;
        let w: Workspace = serde_json::from_str(json).expect("the workspace survives");
        assert_eq!(w.name, "A");
        assert_eq!(w.github.unwrap().login, "me");
        assert!(matches!(
            w.tracker.unwrap().providers.first(),
            Some(TrackerProvider::Unknown(_))
        ));
    }

    /// And saving it does not destroy it. A unit catch-all variant would write
    /// `{"type":"unknown"}` here and the configuration would be gone on the first
    /// edit of an unrelated field.
    #[test]
    fn an_unknown_provider_is_written_back_verbatim() {
        let json = r#"{"providers":[{"type":"jira","site":"acme.atlassian.net"}],"v":3}"#;
        let cfg: TrackerConfig = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["providers"][0]["type"], "jira");
        assert_eq!(back["providers"][0]["site"], "acme.atlassian.net");
    }

    /// The known shapes are unaffected, in both directions — this is the test
    /// that would catch an untagged helper enum silently swallowing a *typo* in a
    /// known variant's own fields, which would be the tolerance going too far.
    #[test]
    fn the_known_providers_still_parse_as_themselves() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"fs","root":{"kind":"project"}}],"v":3}"#)
                .unwrap();
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::Fs { .. })));
        let back = serde_json::to_string(&cfg).unwrap();
        assert!(back.contains(r#""type":"fs""#), "{back}");
    }

    /// An `fs` provider missing its `root` is *not* an unknown source, it is a
    /// damaged one — but it must still not cost the workspace. Kept as
    /// `Unknown`, which is the honest reading: this build cannot use it.
    #[test]
    fn a_malformed_known_provider_is_kept_rather_than_fatal() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"fs"}],"v":3}"#).unwrap();
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::Unknown(_))));
    }

    /// `{"type":"github"}` is the whole encoding: the repository is resolved
    /// from the workspace's folder (decision 11), so a field for it here would
    /// be a second source of truth that can disagree with the git remote.
    #[test]
    fn the_github_tracker_provider_carries_no_fields() {
        let cfg: TrackerConfig =
            serde_json::from_str(r#"{"providers":[{"type":"github"}],"v":3}"#).expect("parses");
        // THIS is the line that guards against the variant being added to
        // `TrackerProvider` but not to `KnownTrackerProvider` — the one mistake
        // Task 2's two-enum shape makes possible. Do not trim it as redundant.
        assert!(matches!(cfg.providers.first(), Some(TrackerProvider::GitHub)));
        let back = serde_json::to_string(&cfg).unwrap();
        // And this line guards nothing of the sort, which is worth knowing: with
        // the variant missing from `KnownTrackerProvider` the value deserializes
        // to `Unknown` and is re-emitted verbatim, so this assertion passes in
        // exactly the scenario it looks like it is checking. It is here for the
        // encoding, not for the wiring.
        assert!(back.contains(r#"{"type":"github"}"#), "round trip: {back}");
    }

    /// A card file has no labels, and every record written before this change
    /// has no such key. `#[serde(default)]` is what keeps them all readable.
    #[test]
    fn a_task_without_labels_still_deserializes() {
        let json = r#"{"id":"01A","title":"t","kind":"bug","status":"open","project":"deck",
            "created":"2026-01-01T00:00:00Z","resolved":null,"origin":"human","session":null,
            "body":"","path":"/r/01A.md","damaged":null,"conflict":false}"#;
        let t: crate::tasks::model::Task = serde_json::from_str(json).expect("parses");
        assert!(t.labels.is_empty());
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
            color: "#61afef".into(), github: None, tracker: None,
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
            tracker: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains(r#""gitName":"Evgeny""#), "{json}");
        assert!(!json.contains("sshKey"), "пустые поля не сериализуются: {json}");
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.github, ws.github);
    }
}
