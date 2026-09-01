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
    /// What repository this workspace's folder is, remembered rather than
    /// re-derived. Absent until something has looked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<WorkspaceRepo>,
}

/// The remote a workspace's folder points at, and where that was read.
///
/// Identity across machines is the workspace id, and the id is made locally:
/// two machines that each added the same folder before sync was switched on
/// never agreed on one. The remote URL is the one string that *is* the same on
/// both, which is what makes it the thing a duplicate is recognised by
/// (`sync::adopt`).
///
/// Remembered rather than asked for, because the alternative is a subprocess per
/// workspace on a five-minute timer for a value that changes about once in a
/// project's life. Two things keep that safe, and they are the two ways a
/// remembered answer goes stale: `from`, because an answer is only good for the
/// folder it was read in, and `resolver`, because an answer is only good for the
/// question that produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRepo {
    /// The remote, as `sync::git::remote_url` gave it.
    ///
    /// `None` is an answer, not a gap: this folder has no remote, and it is
    /// worth writing down, or every cycle asks the same question again. A
    /// workspace in that state has no cross-machine identity to offer and is
    /// never a duplicate of anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The folder the answer was read in. This machine's disk, so it never
    /// travels — see `sync::projection`.
    pub from: String,
    /// Which version of the question this answers (`sync::identity::RESOLVER`).
    ///
    /// A stored `None` means "asked, and this folder has no remote", and
    /// `identity::refresh` trusts it forever so the folder is not re-probed on
    /// every cycle for the rest of its life. That trust is only earned while the
    /// question stays the same. When `remote_url` learned to look past `origin`
    /// (ADR-0010), every `None` written before it became an answer to a question
    /// nobody is asking any more — and without this field they would have been
    /// trusted anyway, leaving the fix inert on exactly the installs that
    /// reported the bug (#359).
    ///
    /// Absent in a store written before the field existed, which deserialises to
    /// `0` and is below every real version, so those answers are re-asked once.
    #[serde(default)]
    pub resolver: u32,
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

/// A persisted tab in the terminal drawer.
///
/// Deliberately smaller than `SessionEntry`, and the difference is the point: a
/// claude session is *resumed* on the next launch, carrying its conversation
/// with it, and a shell cannot be. What comes back is a new shell in the same
/// directory under the same name — everything else, including the history of
/// what was typed, belongs to the shell itself and to whatever it writes to
/// `~/.zsh_history`. So there is nothing here to resume with, and no field
/// pretending otherwise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    /// What the tab is labelled. Auto ("zsh · api") unless a person renamed it,
    /// and the two are not distinguished: a drawer tab has one name, unlike a
    /// deck tile, whose transcript can propose one.
    pub name: String,
    /// The workspace whose directory and account binding this shell was opened
    /// against. `None` for a shell opened with no workspace active.
    #[serde(rename = "workspaceId", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// The drawer's contents, and it is a drawer **per workspace**.
///
/// Switching workspace changes which terminals exist as far as a person is
/// concerned — the same rule the deck already follows for its tiles, and for the
/// same reason: a workspace is the unit of "what I am working on", and a shell
/// standing in another project's directory under another project's account is
/// not part of it. So the tab in front and whether the drawer is up are both
/// per workspace, not one answer for the app.
///
/// A struct rather than the bare `Vec` the deck layout uses, because neither of
/// those two has anywhere else to live. They could have gone in `UiState` beside
/// the drawer's height, but `UiStatePatch` cannot express "set this back to
/// nothing", and closing a workspace's last tab is exactly that.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TerminalLayout {
    #[serde(default)]
    pub items: Vec<TerminalEntry>,
    /// The tab in front, per workspace id. A terminal opened with no workspace
    /// active is keyed by the empty string — one key rather than an
    /// `Option<String>` key, because JSON object keys are strings and a
    /// `null` one is not expressible.
    #[serde(default, deserialize_with = "active_tabs")]
    pub active: std::collections::BTreeMap<String, String>,
    /// The workspaces whose drawer is up. Absent means shut, which is what a
    /// person who has never opened a terminal gets — the deck should not be
    /// shortened by a strip nobody asked for.
    #[serde(default)]
    pub open: Vec<String>,
}

/// Reads the map, and reads anything else as no map at all.
///
/// This field was one session id — the app's single active tab — before the
/// drawer was scoped per workspace. `#[serde(default)]` does not cover that: a
/// default fills an *absent* key, and a key of the wrong shape fails the whole
/// struct, which `Store::terminals` would swallow into an empty drawer. The
/// consequence would be an upgrade quietly eating every terminal tab a person
/// had, to save one line here.
fn active_tabs<'de, D>(d: D) -> Result<std::collections::BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Shape {
        Current(std::collections::BTreeMap<String, String>),
        /// Anything else, including the old lone session id. `IgnoredAny`
        /// rather than a `Value` nobody reads: it accepts any shape and keeps
        /// none of it, which is exactly the intent and leaves no field for the
        /// compiler to point out as dead.
        Older(serde::de::IgnoredAny),
    }
    Ok(match Shape::deserialize(d)? {
        Shape::Current(map) => map,
        Shape::Older(_) => std::collections::BTreeMap::new(),
    })
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
    /// The name a person typed for this tile. It outranks everything, including
    /// the title read out of the transcript, and is cleared by emptying the field.
    ///
    /// Read the NOTE above before touching either of these two renames: without an
    /// explicit `rename` serde writes `user_name` while TS reads `userName`, and a
    /// hand-typed name silently reverts to a transcript title on the next restart.
    #[serde(rename = "userName", default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    /// What `name` above is: a name the launch context gave the tile (a card, a
    /// scenario, a worktree, a command label) or the generic `session · <workspace>`
    /// placeholder, which is the only string a transcript title may replace.
    ///
    /// Absent → `Context`. Nothing on disk distinguishes the two for an entry
    /// written before this field existed, and the failures are not symmetric: a
    /// name the person recognises silently changing is worse than a generic
    /// placeholder staying generic until that session is closed.
    #[serde(rename = "nameKind", default, skip_serializing_if = "Option::is_none")]
    pub name_kind: Option<NameKind>,
    /// Scenario this session was launched from, by **any** route — a click in
    /// the sidebar, ⏰, or a schedule.
    ///
    /// Deliberately not `scheduled_skill_id` above, which means the narrower
    /// "this tile was raised by a schedule" and is read by the overlap guard;
    /// widening that one to cover every scenario launch would silently make the
    /// guard skip hand-pressed runs. Without this field the backend cannot tell,
    /// after a restart, that a restored tile is a scenario run at all — so the
    /// `resume` record could never be opened.
    ///
    /// Read the NOTE on `task_id` before touching the rename.
    #[serde(rename = "skillId", default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    /// The journal record this tile currently belongs to.
    ///
    /// Needed separately from `skill_id`, or `continuesRunId` degrades into
    /// guessing "the previous run of this scenario" — which is wrong the moment
    /// a scenario ran twice in one day.
    #[serde(rename = "runId", default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The window whose deck this tile belongs to, by window label.
    ///
    /// Absent means the main window. That is what every file written before this
    /// field existed says implicitly, and what a single-window app meant by every
    /// entry in it — so an old layout restores exactly as it did, into the same
    /// window, with nothing to migrate.
    ///
    /// **The frontend never sends this.** `save_layout` stamps it from the label
    /// the runtime attaches to the invoke, which webview code cannot forge, so a
    /// window cannot claim another window's tiles by writing the field. It is
    /// absent from the TypeScript `SessionEntry` for the same reason.
    ///
    /// One word, so unlike every field above it needs no `rename` — serde already
    /// writes the key TS would read. Read the NOTE on `task_id` before adding a
    /// second word to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Which agent CLI this session runs.
    ///
    /// **Absent means `Claude`**, which is every layout written before this
    /// field existed and every session in them: `start_session` resolves
    /// `claude` and nothing else, so a session with no recorded kind is a Claude
    /// session by construction rather than by assumption.
    ///
    /// A `String` rather than the enum, and that is the decision: an entry
    /// naming a CLI this build has never heard of must still restore its tile,
    /// and `#[serde(deny_unknown_variants)]` is not a thing — a `CliKind` here
    /// would fail the whole `SessionEntry` parse on a value from a newer
    /// version, dropping the tile rather than the field. `CliKind::parse` reads
    /// it back and answers `Claude` for anything it does not recognise.
    ///
    /// Read the NOTE on `task_id` before touching the rename: without an
    /// explicit one serde writes `cli_kind` while TS reads `cliKind`, and the
    /// activity reader would dispatch on a field that is never there.
    #[serde(rename = "cliKind", default, skip_serializing_if = "Option::is_none")]
    pub cli_kind: Option<String>,
    /// Which conversation this tile should resume, when it is no longer the one
    /// it was launched with.
    ///
    /// `session_id` above stays the launch id and is not negotiable: it is the
    /// PTY key, the `COWORK_SESSION` in the session's argv, and the key every
    /// hook event is attributed by. What `/clear` changes is the conversation —
    /// Claude Code mints a new id, and `claude --resume <launch-id>` then
    /// succeeds and brings back the conversation the person cleared away, with
    /// the one they were working in orphaned on disk (#199). So: an additional
    /// field, **absent until a clear happens**, and absent for every layout
    /// written before it existed — which is exactly what a session still in its
    /// launch conversation means.
    ///
    /// This is the only copy that survives a restart: `crate::resume_ids` holds
    /// the same fact in memory for the life of the app run, and auto-restore is
    /// the path where that map is empty. Read the NOTE on `task_id` before
    /// touching the rename — without it serde writes `resume_id` while TS reads
    /// `resumeId`, and a restored tile would silently resume the wrong
    /// conversation, which is the whole of #199 back again.
    #[serde(rename = "resumeId", default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
}

/// Which of the two kinds of launch name `SessionEntry::name` holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameKind {
    /// `☑ <card>`, `<icon> <scenario>`, a worktree name, a command label.
    Context,
    /// `session · <workspace>`.
    Placeholder,
}

/// A little UI state that survives a restart: the active workspace and the text
/// size the person chose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiState {
    #[serde(rename = "activeWorkspaceId")]
    pub active_workspace_id: Option<String>,
    /// Not an `Option`, and `#[serde(default)]` is what makes that safe. Every
    /// `ui_state.json` written before this field existed has no key for it, and a
    /// missing field on a non-`Option` fails the *whole* parse — which
    /// `Store::ui_state` swallows with `unwrap_or_default()`, so the symptom would
    /// not be an error but the active workspace being silently forgotten on the
    /// first launch after upgrade.
    #[serde(rename = "uiScale", default = "default_ui_scale")]
    pub ui_scale: f32,
    /// How wide the diff drawer is, in `ch` of the mono face rather than in
    /// pixels — see `UiState.prDiffCols` in `src/ipc.ts` for why the unit is the
    /// decision and not an implementation detail.
    ///
    /// `#[serde(default)]` for exactly the reason spelled out above, and this is
    /// the field that proves the note was worth writing: every `ui_state.json`
    /// on disk predates it.
    #[serde(rename = "prDiffCols", default = "default_pr_diff_cols")]
    pub pr_diff_cols: u32,
    /// Whether the offer to switch memory sync on has been waved away.
    ///
    /// Local by nature, and this is the file for it: `ui_state.json` is not on
    /// the sync allowlist, so the answer stays with the machine that gave it. A
    /// person who declines on the laptop has said nothing about the desktop.
    ///
    /// `#[serde(default)]` for the reason spelled out above `ui_scale` — every
    /// `ui_state.json` on disk predates this field, and a missing key on a
    /// non-`Option` fails the whole parse.
    #[serde(rename = "syncOfferDismissed", default)]
    pub sync_offer_dismissed: bool,
    /// Whether scenario runs are journalled at all. **Default on.**
    ///
    /// Off means: write nothing new, delete nothing already written. Reads keep
    /// working, so turning it off does not hide the history already collected.
    ///
    /// `#[serde(default)]` for the reason spelled out above `ui_scale`, and this
    /// field is the newest proof it was worth writing: every `ui_state.json` on
    /// disk predates it, and a missing key on a non-`Option` fails the *whole*
    /// parse — which `Store::ui_state` swallows, so the symptom would be the
    /// active workspace silently forgotten rather than an error.
    #[serde(rename = "recordScenarioRuns", default = "default_record_runs")]
    pub record_scenario_runs: bool,
    /// Whether closing a session writes a note about it — the remembered answer
    /// to the question #366 asks.
    ///
    /// **Three states, and that is the point.** `None` is "never asked", which is
    /// not the same as "no": a default of `false` would silently decide the
    /// question in the app's favour, and a default of `true` would start spending
    /// the person's money on the first close. Only an answer they gave sets it.
    ///
    /// An `Option` rather than the `default`-with-a-value shape every field above
    /// uses, for the same reason: those have a right answer to fall back on and
    /// this one has a question.
    ///
    /// Local by nature, like `sync_offer_dismissed` and for the same reason:
    /// `ui_state.json` is not on the sync allowlist, so consenting on the laptop
    /// says nothing about the desktop. Consent to spend money is exactly the kind
    /// of answer that should not travel.
    #[serde(rename = "captureOnClose", default, skip_serializing_if = "Option::is_none")]
    pub capture_on_close: Option<bool>,
    /// How tall the drawer is, **in rows of the terminal's own type** rather
    /// than in pixels. One value for the app, unlike whether the drawer is up
    /// (`TerminalLayout::open`): the height is how much of this window a person
    /// wants given to a terminal, and that does not change with the project — the same decision as `pr_diff_cols`, and here it is
    /// even harder to argue with: the thing being sized is a grid of characters,
    /// and a person who sets it to show twenty rows means twenty rows at every
    /// text size, not however many fit in 260 pixels after the next change.
    #[serde(rename = "terminalRows", default = "default_terminal_rows")]
    pub terminal_rows: u32,
    /// Whether the reported source of usage limits may be asked. **Default on.**
    ///
    /// The capability flag #306 asked for. On, because answering spends no quota
    /// and reads no credential — it asks `claude` the way `gh.rs` asks `gh`. Off
    /// is a legitimate answer all the same: it means "do not start a `claude`
    /// process every five minutes on my machine", and the limits block stays on
    /// screen on the observed source, saying so.
    ///
    /// `#[serde(default)]` for the reason spelled out above `ui_scale`.
    #[serde(rename = "usageReported", default = "default_usage_reported")]
    pub usage_reported: bool,
    /// How wide the panel is, in px, and how wide it is when it has taken the
    /// deck's width. Two numbers because they answer two questions: a column of
    /// names and a kanban do not want the same width, and a person who sizes one
    /// has not said anything about the other.
    ///
    /// `Option` rather than a default, and this is the one place in this struct
    /// where that is the right shape: "never dragged" has to be distinguishable
    /// from a number, because until it is dragged the width belongs to the
    /// stylesheet — `clamp(17.5rem, 19vw, 24rem)` tracks the window and the text
    /// size, and baking a pixel default here would freeze both.
    #[serde(rename = "panelPx", default)]
    pub panel_px: Option<u32>,
    /// And how wide the workspace panel is — the board and the pull requests, on
    /// the other side of the deck. Two numbers, because the diff's width and the
    /// page's answer different questions: this was `panelWidePx` while the board
    /// was a page of the LEFT panel, and the rename is the honest record of the
    /// board having moved. Nothing reads the old key, so a stored one is ignored
    /// rather than migrated: the loss is one dragged width, once.
    #[serde(rename = "wspPx", default)]
    pub wsp_px: Option<u32>,
    #[serde(rename = "wspWidePx", default)]
    pub wsp_wide_px: Option<u32>,
    /// And how wide the tool panel inside a zoomed tile is. Same reasoning; its
    /// floor is the 80-column rule, which is enforced where the panel is drawn
    /// rather than here — a stored number cannot know what the terminal is doing.
    #[serde(rename = "toolPx", default)]
    pub tool_px: Option<u32>,
}

/// On. A journal nobody switched on records nothing, and the first thing anyone
/// would ask of a history screen is why it is empty.
fn default_record_runs() -> bool {
    true
}

/// On. See `UiState::usage_reported`: the cost of asking is a subprocess that
/// spends no quota, and the alternative default is a screen that says "unknown"
/// to somebody who never knew there was a switch.
fn default_usage_reported() -> bool {
    true
}

/// Must agree with the `width` on `.pr-drawer` in `src/styles.css`, which is the
/// fallback the drawer draws at before JS has written a width to it. 62 columns
/// holds a 62-character line plus the gutter without the pane taking over the
/// window on a first run.
fn default_pr_diff_cols() -> u32 {
    62
}

/// Must agree with `DEFAULT_SCALE` in `src/ui-scale.ts` — this is the value a person
/// who has never opened the size chooser gets, and the two sides both claim to own it:
/// the frontend when the read fails, this when the file has no key.
///
/// 1.15, not 1.0 and not zero. Zero is what a `derive`d `Default` would give, and a
/// zero scale is an invisible interface. 1.0 is the 13px base in `styles.css`, which
/// is the size that prompted the typography work in the first place; a file written
/// before this field existed therefore migrates *up*, which is the intent.
fn default_ui_scale() -> f32 {
    1.15
}

/// Fourteen rows: enough for a build's last output and a prompt under it without
/// the drawer taking the deck's place. Must agree with `DEFAULT_TERMINAL_ROWS`
/// in `src/drawer.ts`, which is what the drawer opens at before a stored value
/// has been read.
fn default_terminal_rows() -> u32 {
    14
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            active_workspace_id: None,
            ui_scale: default_ui_scale(),
            pr_diff_cols: default_pr_diff_cols(),
            sync_offer_dismissed: false,
            record_scenario_runs: default_record_runs(),
            // Never asked. Not `false`, which would decide the question in the
            // app's favour, and not `true`, which would start spending somebody's
            // money on their first close.
            capture_on_close: None,
            terminal_rows: default_terminal_rows(),
            usage_reported: default_usage_reported(),
            // None, and not a pixel figure: until a person drags one, the width
            // belongs to the stylesheet, which tracks the window and the text size.
            panel_px: None,
            wsp_px: None,
            wsp_wide_px: None,
            tool_px: None,
        }
    }
}

/// A change to `UiState`, not a replacement for it.
///
/// `save_ui_state` used to take a whole `UiState` and write the file from it, and
/// its only caller passes the active workspace alone — so the moment a second field
/// existed, every workspace switch would have wiped the text size. `None` here means
/// "leave it alone".
///
/// `active_workspace_id` is `Option<Option<String>>`-shaped in principle, since the
/// stored value is itself optional; it is not, because nothing in the app ever sets
/// it back to null — it is only ever pointed at a real workspace.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct UiStatePatch {
    #[serde(rename = "activeWorkspaceId")]
    pub active_workspace_id: Option<String>,
    #[serde(rename = "uiScale")]
    pub ui_scale: Option<f32>,
    #[serde(rename = "prDiffCols")]
    pub pr_diff_cols: Option<u32>,
    /// `Some(_)` sets the remembered answer; `None` leaves it alone, like every
    /// other field of a patch. Clearing it back to "never asked" therefore needs
    /// its own route — see `clear_capture_on_close`.
    #[serde(rename = "captureOnClose")]
    pub capture_on_close: Option<bool>,
    #[serde(rename = "syncOfferDismissed")]
    pub sync_offer_dismissed: Option<bool>,
    #[serde(rename = "recordScenarioRuns")]
    pub record_scenario_runs: Option<bool>,
    #[serde(rename = "terminalRows")]
    pub terminal_rows: Option<u32>,
    #[serde(rename = "usageReported")]
    pub usage_reported: Option<bool>,
    #[serde(rename = "panelPx")]
    pub panel_px: Option<u32>,
    #[serde(rename = "wspPx")]
    pub wsp_px: Option<u32>,
    #[serde(rename = "wspWidePx")]
    pub wsp_wide_px: Option<u32>,
    #[serde(rename = "toolPx")]
    pub tool_px: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub dirty: bool,
}

/// One of the files the app keeps for itself, and whether it is there yet.
///
/// `exists: false` is a fact worth reporting rather than a row to omit: the list
/// is what this app WILL write, and "no scenarios have ever been saved" is
/// something a person looking for the file needs told, not hidden.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigFile {
    pub name: String,
    pub exists: bool,
}

/// Where the app keeps its own state, for the Settings window.
///
/// The directory is the answer to "where is my configuration"; the file list is
/// the answer to "which of it is mine" — a person who wants to back one up, diff
/// one, or delete one needs the names, and every one of them is a plain JSON or
/// JSONL file on purpose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigPaths {
    pub dir: String,
    pub files: Vec<ConfigFile>,
}

/// One changed file in a session's own checkout.
///
/// `mark` is git's own letter — M, A, D, R, ? for untracked, U for a conflict —
/// rather than a word of ours. Anyone who has a worktree open has read those
/// letters; translating them would be a second vocabulary for one fact.
///
/// `added` and `removed` are 0 for an untracked file, which is not the same as a
/// file with no changes: `git diff` has nothing to compare it against, and
/// counting its whole length as added would be a number git never states.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GitChange {
    pub mark: String,
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

/// What a session's own checkout has changed, file by file.
///
/// For the tool panel on a zoomed tile: a session launched on an issue runs in a
/// worktree of its own, so "what have I changed here" is a per-session question
/// that the app-level board cannot answer — it does not know which of a dozen
/// sessions is being asked about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GitChanges {
    pub branch: Option<String>,
    pub files: Vec<GitChange>,
}

/// A limit this app watched a session be refused by, and when it lifts.
///
/// Persisted, and that is the whole reason it is a type rather than a field: a
/// reset four hours out has to survive a restart. Without that, quitting the app
/// while the budget is spent loses the one fact the person needs on the way back
/// in — and the app cannot re-derive it, because the banner it read has scrolled
/// off a terminal that no longer exists.
///
/// Written by `usage::observed`, read on boot, and discarded once `resets_at` has
/// passed. See ADR-0009.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageExhaustion {
    /// Which connected AI. `"claude"` today.
    pub provider: String,
    /// Which window, where the text said. `None` is a refusal whose window was
    /// not named — kept as `None` rather than guessed, so the reader can say it
    /// guessed.
    #[serde(default)]
    pub window: Option<String>,
    /// Epoch ms, when it is known. `None` is a legitimate state: the app was
    /// refused and was not told when that ends.
    #[serde(default)]
    pub resets_at: Option<i64>,
    /// Epoch ms when this app saw the refusal. What bounds the record's life when
    /// `resets_at` is `None`.
    pub at: i64,
    /// What the terminal actually said, capped. On screen in the dialog, because
    /// "this is the sentence we read" is the only way a person can check whether
    /// this app understood it.
    #[serde(default)]
    pub text: Option<String>,
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

/// What a session has in front of it, and what it has burned getting there.
///
/// Two numbers rather than one because they answer different questions and have
/// different scopes, and conflating them is what made the old badge unreadable.
/// `context` is what Claude Code prints in the terminal; `spend` is the bill.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct SessionTokens {
    /// Tokens resident in the context window, main transcript only — a subagent
    /// burns its own window and hands back only its final text, so counting one
    /// here would describe a window that never existed. `None` while the session
    /// has yet to make a request.
    pub context: Option<u64>,
    /// Everything the session has cost, subagents included, counted once per
    /// API request.
    pub spend: TokenUsage,
    /// How many subagent transcripts fed `spend`. Surfaced because a session
    /// whose spend is mostly delegated looks otherwise inexplicable.
    pub subagents: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReporterEvent {
    pub session: String,
    pub kind: String,
    #[serde(rename = "notificationType")]
    pub notification_type: Option<String>,
    /// Where Claude Code says this conversation's transcript is *now*. Present
    /// on every hook payload; absent from a line written by an older reporter,
    /// hence `default`.
    #[serde(rename = "transcriptPath", default)]
    pub transcript_path: Option<String>,
    /// Which conversation Claude Code says this session is in *now* — its own
    /// `session_id`, which is the deck's launch id until somebody types
    /// `/clear` and a different id afterwards. Present on every hook payload;
    /// absent from a line written by an older reporter, hence `default`.
    ///
    /// Recorded, never used as a key: the deck knows a session by the id it
    /// launched it with, and `ReporterEvent::session` above is that id. See
    /// `crate::resume_ids`.
    #[serde(rename = "reportedSession", default)]
    pub reported_session: Option<String>,
    /// Which workspace the session was launched in, on the one kind that asks a
    /// question rather than reporting a fact (`memory`, #388). A dash from the
    /// reporter — a session launched outside a workspace — reads as absent here,
    /// so a scope of "everything" is what it means rather than a fallback.
    #[serde(default, deserialize_with = "dash_is_none")]
    pub workspace: Option<String>,
}

fn dash_is_none<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<String>::deserialize(d)?;
    Ok(v.filter(|s| s != "-" && !s.trim().is_empty()))
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
            task_id: None, scheduled_skill_id: None, user_name: None, name_kind: None,
            skill_id: None, run_id: None, owner: None, cli_kind: None, resume_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("workspaceId"), "None workspaceId must be omitted, got {json}");
        assert!(!json.contains("scheduledSkillId"), "None scheduledSkillId must be omitted, got {json}");

        // A layout written before the field existed still loads.
        let old_entry = r#"{"sessionId":"s4","cwd":"/c","name":"K"}"#;
        let e: SessionEntry = serde_json::from_str(old_entry).unwrap();
        assert_eq!(e.scheduled_skill_id, None);
    }

    /// The same four directions for the two name fields. The rename is the whole
    /// risk: serde would write `user_name` while TS reads `userName`, and a
    /// hand-typed name would revert to a transcript title on the next restart with
    /// nothing reported anywhere.
    #[test]
    fn session_entry_name_fields_are_backward_compatible() {
        // A file written before this feature has neither → both None.
        let old = r#"[{"sessionId":"s1","cwd":"/a","name":"session · deck"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].user_name, None);
        assert_eq!(v[0].name_kind, None, "absent is read as a context name by the frontend");

        // A new file carries both, under the camelCase names TS writes.
        let new = r#"[{"sessionId":"s2","cwd":"/b","name":"session · deck",
            "userName":"the one I must not close","nameKind":"placeholder"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(new).unwrap();
        assert_eq!(v[0].user_name.as_deref(), Some("the one I must not close"));
        assert_eq!(v[0].name_kind, Some(NameKind::Placeholder));

        // The keys serde writes are the keys TS reads.
        let entry = SessionEntry {
            session_id: "s3".into(), cwd: "/c".into(), name: "session · deck".into(),
            workspace_id: None, task_id: None, scheduled_skill_id: None,
            user_name: Some("relay".into()), name_kind: Some(NameKind::Placeholder),
            skill_id: None, run_id: None, owner: None, cli_kind: None, resume_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r#""userName":"relay""#), "got {json}");
        assert!(json.contains(r#""nameKind":"placeholder""#), "got {json}");
        assert!(!json.contains("user_name"), "snake_case would never be read back, got {json}");

        // None is omitted from output.
        let bare = SessionEntry { user_name: None, name_kind: None, ..entry };
        let json = serde_json::to_string(&bare).unwrap();
        assert!(!json.contains("userName"), "None userName must be omitted, got {json}");
        assert!(!json.contains("nameKind"), "None nameKind must be omitted, got {json}");
    }

    /// The four directions again, for the field the activity registry
    /// dispatches on. The rename is the whole risk: serde would write `cli_kind`
    /// while TS reads `cliKind`, and every session would silently dispatch as
    /// the default forever with nothing reported anywhere.
    #[test]
    fn session_entry_cli_kind_is_backward_compatible() {
        // Every layout written before the field exists has no key for it.
        let old = r#"[{"sessionId":"s1","cwd":"/a","name":"session · deck"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].cli_kind, None, "absent is read as Claude by the registry");

        // A new file carries it under the camelCase name TS writes.
        let new = r#"[{"sessionId":"s2","cwd":"/b","name":"n","cliKind":"copilot"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(new).unwrap();
        assert_eq!(v[0].cli_kind.as_deref(), Some("copilot"));

        // **A CLI this build has never heard of does not drop the tile.** This is
        // the reason the field is a `String` and not the enum: a `CliKind` here
        // would fail the whole `SessionEntry` parse on a value from a newer
        // version, costing the tile rather than the field.
        let future = r#"[{"sessionId":"s3","cwd":"/c","name":"n","cliKind":"some-cli-from-2027"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(future).unwrap();
        assert_eq!(v[0].session_id, "s3");
        assert_eq!(v[0].cli_kind.as_deref(), Some("some-cli-from-2027"));

        // The key serde writes is the key TS reads, and `None` is omitted so a
        // layout of Claude sessions stays byte-identical to what it was.
        let entry = SessionEntry {
            session_id: "s4".into(), cwd: "/d".into(), name: "n".into(),
            workspace_id: None, task_id: None, scheduled_skill_id: None,
            user_name: None, name_kind: None, skill_id: None, run_id: None,
            owner: None, cli_kind: Some("copilot".into()), resume_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r#""cliKind":"copilot""#), "got {json}");
        assert!(!json.contains("cli_kind"), "snake_case would never be read back, got {json}");
        let bare = SessionEntry { cli_kind: None, ..entry };
        assert!(!serde_json::to_string(&bare).unwrap().contains("cliKind"));
    }

    /// The four directions once more, for the field that decides which
    /// conversation a restart resumes (#199). The rename is the whole risk here
    /// too, and this one is the worst of the three: serde would write
    /// `resume_id` while TS reads `resumeId`, so a cleared session would restore
    /// into the conversation the person cleared away — silently, because the
    /// launch id still names a real conversation and `--resume` succeeds.
    #[test]
    fn session_entry_resume_id_is_backward_compatible() {
        // Every layout written before the field exists has no key for it, and
        // that is also what an uncleared session means: resume the launch id.
        let old = r#"[{"sessionId":"s1","cwd":"/a","name":"session · deck"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].resume_id, None);

        // A new file carries it under the camelCase name TS writes.
        let new = r#"[{"sessionId":"s2","cwd":"/b","name":"n","resumeId":"after-the-clear"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(new).unwrap();
        // The tile's identity is untouched — it is still the id the deck
        // launched with, and the conversation is the additional fact.
        assert_eq!(v[0].session_id, "s2");
        assert_eq!(v[0].resume_id.as_deref(), Some("after-the-clear"));

        // The key serde writes is the key TS reads.
        let entry = SessionEntry {
            session_id: "s3".into(), cwd: "/c".into(), name: "n".into(),
            workspace_id: None, task_id: None, scheduled_skill_id: None,
            user_name: None, name_kind: None, skill_id: None, run_id: None,
            owner: None, cli_kind: None, resume_id: Some("after-the-clear".into()),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r#""resumeId":"after-the-clear""#), "got {json}");
        assert!(!json.contains("resume_id"), "snake_case would never be read back, got {json}");

        // And `None` is omitted, so a layout of sessions nobody has cleared
        // stays byte-identical to what it was.
        let bare = SessionEntry { resume_id: None, ..entry };
        assert!(!serde_json::to_string(&bare).unwrap().contains("resumeId"));
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
            repo: None,
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
            repo: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains(r#""gitName":"Evgeny""#), "{json}");
        assert!(!json.contains("sshKey"), "пустые поля не сериализуются: {json}");
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.github, ws.github);
    }
}
