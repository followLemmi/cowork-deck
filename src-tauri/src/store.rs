use crate::model::{ScheduleRun, SessionEntry, Skill, UiState, UiStatePatch, Workspace};
use crate::runs::{fold_events, retain_recent, RunEvent, RunRecord, RUNS_PER_SKILL};
use std::path::PathBuf;

pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        let _ = std::fs::create_dir_all(&dir);
        Store { dir }
    }

    fn ws_path(&self) -> PathBuf { self.dir.join("workspaces.json") }
    fn sk_path(&self) -> PathBuf { self.dir.join("skills.json") }

    /// Reads and parses a JSON array file. A missing file is a normal, expected
    /// case (first run) and yields an empty Vec. Every other outcome — an io
    /// error *or a parse error* — is propagated, so a caller about to overwrite
    /// the file stops instead of proceeding with an empty in-memory list.
    ///
    /// The parse error used to be swallowed here by `unwrap_or_default()`, which
    /// made one unreadable record indistinguishable from an empty store and let
    /// the next `upsert` write that emptiness back over a populated file (#117).
    /// The doc comment below already required the hard stop; it only ever got it
    /// for the io half.
    fn try_read_vec<T: serde::de::DeserializeOwned>(path: &PathBuf) -> std::io::Result<Vec<T>> {
        match std::fs::read_to_string(path) {
            // An empty file is a first run, not a corrupt one: `write_vec`
            // truncates before it writes, so this is what a crash mid-write
            // leaves behind, and refusing it would wedge every save with no
            // recovery inside the app. A *non-empty* file we cannot parse still
            // refuses — half an array is evidence of records a save would
            // destroy, and an empty one is evidence of nothing.
            Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
            Ok(s) => serde_json::from_str(&s).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("{} is not readable as JSON: {e}", path.display()),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// Best-effort read for plain listing (no save follows). On a
    /// non-NotFound error this logs a warning and returns empty rather than
    /// propagating, since there is no destructive save operation downstream
    /// that could be corrupted by it.
    fn read_vec<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Vec<T> {
        match Self::try_read_vec(path) {
            Ok(items) => items,
            Err(e) => {
                eprintln!(
                    "warning: failed to read or parse {} ({e}); treating as empty for this listing",
                    path.display()
                );
                Vec::new()
            }
        }
    }

    fn write_vec<T: serde::Serialize>(path: &PathBuf, items: &[T]) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(items)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(path, json)
    }

    pub fn workspaces(&self) -> Vec<Workspace> { Self::read_vec(&self.ws_path()) }
    pub fn save_workspaces(&self, items: &[Workspace]) -> std::io::Result<()> {
        Self::write_vec(&self.ws_path(), items)
    }
    pub fn skills(&self) -> Vec<Skill> { Self::read_vec(&self.sk_path()) }
    pub fn save_skills(&self, items: &[Skill]) -> std::io::Result<()> {
        Self::write_vec(&self.sk_path(), items)
    }

    fn layout_path(&self) -> PathBuf { self.dir.join("sessions.json") }
    pub fn layout(&self) -> Vec<SessionEntry> { Self::read_vec(&self.layout_path()) }
    pub fn save_layout(&self, items: &[SessionEntry]) -> std::io::Result<()> {
        Self::write_vec(&self.layout_path(), items)
    }

    fn ui_path(&self) -> PathBuf { self.dir.join("ui_state.json") }
    pub fn ui_state(&self) -> UiState {
        match std::fs::read_to_string(self.ui_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => UiState::default(),
        }
    }
    /// Merge a patch into what is on disk rather than replacing the file.
    ///
    /// This took a whole `UiState` and wrote it out, which was safe while there was
    /// exactly one field and exactly one caller sending it. With a second field it
    /// would have meant every workspace switch writing `uiScale` back to whatever
    /// the caller happened to have — in practice the default, since the only caller
    /// sends the active workspace and nothing else.
    pub fn save_ui_state(&self, patch: &UiStatePatch) -> std::io::Result<()> {
        let mut st = self.ui_state();
        if patch.active_workspace_id.is_some() {
            st.active_workspace_id = patch.active_workspace_id.clone();
        }
        if let Some(scale) = patch.ui_scale {
            st.ui_scale = scale;
        }
        if let Some(cols) = patch.pr_diff_cols {
            st.pr_diff_cols = cols;
        }
        if let Some(on) = patch.record_scenario_runs {
            st.record_scenario_runs = on;
        }
        let json = serde_json::to_string_pretty(&st)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(self.ui_path(), json)
    }

    fn schedule_state_path(&self) -> PathBuf { self.dir.join("schedule_state.json") }

    /// Runtime schedule state (skillId -> last-fired epoch millis), written
    /// ONLY by the scheduler. Kept separate from `Skill.schedule` so a user
    /// editing a scenario (which rewrites the whole Skill) can't clobber
    /// `lastRun`. Missing file -> empty map (first run). Any other read or
    /// parse failure is warned about rather than swallowed silently: losing
    /// this map makes the scheduler re-arm every schedule from scratch.
    pub fn schedule_state(&self) -> std::collections::HashMap<String, ScheduleRun> {
        let path = self.schedule_state_path();
        match std::fs::read_to_string(&path) {
            Ok(s) => match crate::model::parse_schedule_state(&s) {
                Ok(map) => map,
                Err(e) => {
                    eprintln!("warning: {} is unparsable ({e}); re-arming schedules", path.display());
                    std::collections::HashMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::collections::HashMap::new(),
            Err(e) => {
                eprintln!("warning: failed to read {} ({e}); re-arming schedules", path.display());
                std::collections::HashMap::new()
            }
        }
    }
    pub fn save_schedule_state(
        &self,
        st: &std::collections::HashMap<String, ScheduleRun>,
    ) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(st)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(self.schedule_state_path(), json)
    }

    /// The scenario run journal, beside `skills.json` and `schedule_state.json`.
    ///
    /// Not in the project's `.cowork/`: tracker cards live there because they are
    /// a shared team artefact, and a run journal is a personal, machine-local
    /// record that would eventually be committed along with the agent's output.
    fn runs_path(&self) -> PathBuf { self.dir.join("runs.jsonl") }

    /// Append one event. **`OpenOptions::append`, never `write_vec`.**
    ///
    /// `write_vec` truncates before it writes, and `try_read_vec`'s own comment
    /// already records what that costs when a crash lands in the middle (#117).
    /// A file written on every launch cannot afford that failure mode; a
    /// half-written appended line is discarded by the reader and everything
    /// before it stands.
    ///
    /// One `write` of one line, so two writers interleaving produce two whole
    /// lines rather than one spliced one — this is the guarantee `O_APPEND`
    /// gives for a single write under the pipe buffer size, and a journal line
    /// is far below it.
    pub fn append_run_event(&self, ev: &RunEvent) -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut line = String::new();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(self.runs_path())?;
        // Heal a file whose last line was cut off mid-write. Without this the
        // next append is glued onto the wreckage and **both** lines are lost —
        // the crash costs the record that was being written *and* the next one,
        // which is exactly the failure append-only is here to avoid. Reads are
        // free to seek in append mode; writes always land at the end.
        let len = f.metadata()?.len();
        if len > 0 {
            f.seek(SeekFrom::Start(len - 1))?;
            let mut last = [0u8; 1];
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                line.push('\n');
            }
        }
        line.push_str(
            &ev.to_line()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
        );
        line.push('\n');
        f.write_all(line.as_bytes())
    }

    /// Every run, **newest first**. A missing file is an empty journal, exactly
    /// as `try_read_vec` treats one.
    pub fn runs(&self) -> Vec<RunRecord> {
        let mut all = fold_events(&self.runs_body());
        all.reverse();
        all
    }

    /// One run by id, or `None`. Folds the whole journal, like [`Self::runs`] —
    /// this is reached on the resume path, once per restored tile, and a
    /// bespoke index would be a second source of truth about the same file.
    pub fn run(&self, run_id: &str) -> Option<RunRecord> {
        fold_events(&self.runs_body())
            .into_iter()
            .find(|r| r.run_id == run_id)
    }

    fn runs_body(&self) -> String {
        match std::fs::read_to_string(self.runs_path()) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                eprintln!(
                    "warning: failed to read {} ({e}); treating the run journal as empty",
                    self.runs_path().display(),
                );
                String::new()
            }
        }
    }

    /// Rewrite the journal from `keep`, atomically.
    ///
    /// Temp file plus rename, so a crash mid-compaction leaves the old journal
    /// intact — the one place this file is *not* append-only is also the one
    /// place it cannot afford to be truncated in.
    fn rewrite_runs(&self, keep: &[RunRecord]) -> std::io::Result<()> {
        let mut body = String::new();
        for rec in keep {
            for ev in rec.to_events() {
                body.push_str(
                    &ev.to_line()
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
                );
                body.push('\n');
            }
        }
        let tmp = self.runs_path().with_extension("jsonl.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, self.runs_path())
    }

    /// Drop everything past the retention limit. Returns how many records went.
    ///
    /// Run once at app start rather than on every append: pruning is about the
    /// file not growing without bound, and doing it on the launch path would put
    /// a full read and rewrite in front of every session.
    pub fn compact_runs(&self) -> std::io::Result<usize> {
        let all = fold_events(&self.runs_body());
        let before = all.len();
        let keep = retain_recent(all, RUNS_PER_SKILL);
        if keep.len() == before {
            return Ok(0);
        }
        self.rewrite_runs(&keep)?;
        Ok(before - keep.len())
    }

    /// Erase one scenario's history, wholesale.
    ///
    /// The only erasure there is. A record is a snapshot of what ran, so there
    /// is no editing or deleting of a single one — a journal whose rows can be
    /// revised answers nothing.
    pub fn delete_skill_history(&self, skill_id: &str) -> std::io::Result<()> {
        let all = fold_events(&self.runs_body());
        let keep: Vec<RunRecord> = all.into_iter().filter(|r| r.skill_id != skill_id).collect();
        self.rewrite_runs(&keep)
    }

    // NOTE: upsert_*/delete_* deliberately use `try_read_vec` (not the
    // best-effort `read_vec`) so that a transient, non-NotFound read error
    // (e.g. permission denied, disk I/O error) aborts before `save_*` is
    // called. Without this, a read failure would be treated as "no existing
    // items", and the subsequent save would overwrite a populated file with
    // a truncated (often single-item) list.
    pub fn upsert_workspace(&self, w: Workspace) -> std::io::Result<Vec<Workspace>> {
        let mut items: Vec<Workspace> = Self::try_read_vec(&self.ws_path())?;
        match items.iter_mut().find(|x| x.id == w.id) {
            Some(existing) => *existing = w,
            None => items.push(w),
        }
        self.save_workspaces(&items)?;
        Ok(items)
    }

    pub fn delete_workspace(&self, id: &str) -> std::io::Result<Vec<Workspace>> {
        let mut items: Vec<Workspace> = Self::try_read_vec(&self.ws_path())?;
        items.retain(|x| x.id != id);
        self.save_workspaces(&items)?;
        Ok(items)
    }

    pub fn upsert_skill(&self, sk: Skill) -> std::io::Result<Vec<Skill>> {
        let mut items: Vec<Skill> = Self::try_read_vec(&self.sk_path())?;
        match items.iter_mut().find(|x| x.id == sk.id) {
            Some(existing) => *existing = sk,
            None => items.push(sk),
        }
        self.save_skills(&items)?;
        Ok(items)
    }

    pub fn delete_skill(&self, id: &str) -> std::io::Result<Vec<Skill>> {
        let mut items: Vec<Skill> = Self::try_read_vec(&self.sk_path())?;
        items.retain(|x| x.id != id);
        self.save_skills(&items)?;
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        NameKind, SessionEntry, TrackerProvider, UiState, UiStatePatch, Workspace,
        SCHEDULE_STATE_VERSION,
    };

    fn tmp() -> std::path::PathBuf {
        // Unique per call, even under parallel test threads: SystemTime alone
        // can collide within a clock tick, so add a monotonic counter.
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let mut d = std::env::temp_dir();
        d.push(format!("coworkdeck-test-{}", std::process::id()));
        d.push(format!(
            "{:?}-{}",
            std::time::SystemTime::now(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn empty_store_reads_empty_then_upserts_and_deletes() {
        let s = Store::new(tmp());
        assert!(s.workspaces().is_empty());
        let w = Workspace { id: "w1".into(), name: "Grosh".into(), path: "/tmp/grosh".into(), color: "#3b82f6".into(), github: None, tracker: None };
        let after = s.upsert_workspace(w.clone()).unwrap();
        assert_eq!(after.len(), 1);
        // reload from disk
        assert_eq!(Store::new(s.dir.clone()).workspaces().len(), 1);
        // update in place (same id)
        let mut w2 = w.clone();
        w2.name = "Grosh 2".into();
        let after = s.upsert_workspace(w2).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "Grosh 2");
        // delete
        let after = s.delete_workspace("w1").unwrap();
        assert!(after.is_empty());
    }

    #[test]
    fn read_vec_returns_empty_for_missing_file_not_found() {
        let dir = tmp();
        let missing = dir.join("does-not-exist.json");
        // Best-effort read_vec: NotFound -> empty, no error.
        let items: Vec<Workspace> = Store::read_vec(&missing);
        assert!(items.is_empty());
        // Same guarantee on the strict helper used by upsert/delete.
        let items: Vec<Workspace> = Store::try_read_vec(&missing).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn upsert_refuses_to_truncate_on_non_not_found_read_error() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let s = Store::new(tmp());
        let w1 = Workspace {
            id: "w1".into(),
            name: "First".into(),
            path: "/tmp/a".into(),
            color: "#111111".into(),
            github: None,
            tracker: None,
        };
        s.upsert_workspace(w1.clone()).unwrap();

        let path = s.ws_path();
        let original_perms = fs::metadata(&path).unwrap().permissions();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        // If the file is still readable (e.g. tests running as root, where
        // permission bits don't block reads), this scenario can't be
        // exercised on this platform/user — skip rather than false-fail.
        let still_readable = fs::read_to_string(&path).is_ok();
        if still_readable {
            fs::set_permissions(&path, original_perms).unwrap();
            return;
        }

        let w2 = Workspace {
            id: "w2".into(),
            name: "Second".into(),
            path: "/tmp/b".into(),
            color: "#222222".into(),
            github: None,
            tracker: None,
        };
        let result = s.upsert_workspace(w2);
        assert!(
            result.is_err(),
            "upsert must refuse to proceed (and must NOT save) on a non-NotFound read error"
        );

        // Restore permissions and verify the original file is untouched,
        // i.e. it was NOT overwritten with an empty/truncated list.
        fs::set_permissions(&path, original_perms).unwrap();
        let items = s.workspaces();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "w1");
    }

    #[test]
    fn layout_round_trips_and_defaults_empty() {
        let s = Store::new(tmp());
        assert!(s.layout().is_empty()); // NotFound -> empty
        let entries = vec![
            SessionEntry {
                session_id: "s1".into(), cwd: "/tmp/a".into(), name: "▶ Fix".into(),
                workspace_id: Some("w1".into()), task_id: Some("01AAA".into()),
                scheduled_skill_id: None, user_name: None,
                name_kind: Some(NameKind::Context), skill_id: None, run_id: None,
            },
            SessionEntry {
                session_id: "s2".into(), cwd: "/tmp/b".into(), name: "terminal · P".into(),
                workspace_id: None, task_id: None, scheduled_skill_id: None,
                // The whole point of the field: this one survives the round trip.
                user_name: Some("the one I must not close".into()),
                name_kind: Some(NameKind::Placeholder), skill_id: None, run_id: None,
            },
        ];
        s.save_layout(&entries).unwrap();
        let reloaded = Store::new(s.dir.clone()).layout();
        assert_eq!(reloaded, entries);
    }

    #[test]
    fn ui_state_round_trips_and_defaults_empty() {
        let s = Store::new(tmp());
        assert_eq!(s.ui_state(), UiState::default()); // NotFound -> default
        // Not 0.0, which derive would give, and not 1.0 — the shipped default is a
        // step above the stylesheet's base. Must match `DEFAULT_SCALE` in `ui-scale.ts`.
        assert_eq!(UiState::default().ui_scale, 1.15);
        // Must match the `width` on `.pr-drawer` in `styles.css`, which is what the
        // drawer is drawn at until JS writes a width to it.
        assert_eq!(UiState::default().pr_diff_cols, 62);
        // On. A journal nobody switched on records nothing, and the first
        // question a history screen would raise is why it is empty.
        assert!(UiState::default().record_scenario_runs);
        let patch = UiStatePatch {
            active_workspace_id: Some("w-1".into()),
            ui_scale: Some(1.3),
            pr_diff_cols: Some(80),
            record_scenario_runs: Some(false),
        };
        s.save_ui_state(&patch).unwrap();
        let reloaded = Store::new(s.dir.clone()).ui_state();
        assert_eq!(reloaded.active_workspace_id, Some("w-1".into()));
        assert_eq!(reloaded.ui_scale, 1.3);
        assert_eq!(reloaded.pr_diff_cols, 80);
        assert!(!reloaded.record_scenario_runs);
    }

    /// The migration case, and the reason `ui_scale` carries `#[serde(default)]`.
    /// Every `ui_state.json` written before the field existed looks like this, and
    /// without the default the whole parse fails — which `ui_state()` swallows with
    /// `unwrap_or_default()`, so the symptom is not an error but the active
    /// workspace being silently forgotten on the first launch after upgrade.
    #[test]
    fn ui_state_reads_a_file_written_before_ui_scale_existed() {
        let s = Store::new(tmp());
        std::fs::write(s.ui_path(), r#"{"activeWorkspaceId":"w-7"}"#).unwrap();
        let st = s.ui_state();
        assert_eq!(st.active_workspace_id, Some("w-7".into()));
        // Such a file migrates *up*: its owner never chose a size, so they get the
        // shipped default rather than the base the field did not exist to record.
        assert_eq!(st.ui_scale, 1.15);
        // And the same again for the field added after *that*. Every file on disk
        // today is missing this key, so it is not a hypothetical migration.
        assert_eq!(st.pr_diff_cols, 62);
        // And once more for the newest field. Every `ui_state.json` on disk
        // today predates it, and the migration has to land on "on" — a journal
        // that silently recorded nothing after an upgrade would look exactly
        // like a feature that does not work.
        assert!(st.record_scenario_runs);
    }

    /// The other half of the same bug. `save_ui_state` used to write the file from a
    /// whole `UiState`, and its only caller sends the active workspace alone — so a
    /// workspace switch would have reset the text size every time.
    #[test]
    fn saving_one_field_leaves_the_other_alone() {
        let s = Store::new(tmp());
        s.save_ui_state(&UiStatePatch { ui_scale: Some(1.45), ..Default::default() }).unwrap();
        // Exactly what the drawer's `pointerup` sends, and nothing else.
        s.save_ui_state(&UiStatePatch { pr_diff_cols: Some(96), ..Default::default() }).unwrap();
        // Exactly what the settings checkbox sends, and nothing else.
        s.save_ui_state(&UiStatePatch {
            record_scenario_runs: Some(false), ..Default::default()
        }).unwrap();
        // Exactly what `workspaces.ts` sends, and nothing else.
        s.save_ui_state(&UiStatePatch {
            active_workspace_id: Some("w-2".into()), ..Default::default()
        }).unwrap();
        let st = Store::new(s.dir.clone()).ui_state();
        assert_eq!(st.active_workspace_id, Some("w-2".into()));
        assert_eq!(st.ui_scale, 1.45, "a workspace switch must not reset the text size");
        assert_eq!(st.pr_diff_cols, 96, "nor the width of the diff drawer");
        assert!(!st.record_scenario_runs, "nor whether runs are being recorded");
    }

    #[test]
    fn schedule_state_round_trips_and_defaults_empty() {
        use std::collections::HashMap;
        let s = Store::new(tmp());
        assert!(s.schedule_state().is_empty()); // NotFound -> empty
        let mut st: HashMap<String, ScheduleRun> = HashMap::new();
        st.insert("skill-1".into(), ScheduleRun {
            last_attempt: 1_700_000_000_000,
            last_run: Some(1_700_000_000_000),
            last_outcome: Some("launched".into()), preset: None, version: SCHEDULE_STATE_VERSION });
        s.save_schedule_state(&st).unwrap();
        assert_eq!(Store::new(s.dir.clone()).schedule_state(), st);
    }

    /// The test that fails today, and the whole of #117 in one assertion: a
    /// populated file with one unreadable record must not be overwritten by the
    /// next save. `try_read_vec` returning `Ok(vec![])` for a parse error is
    /// indistinguishable from "no workspaces yet", so the upsert wrote one record
    /// over ten.
    ///
    /// The unreadable record is one **missing a required field**, not one with an
    /// unknown provider tag: since #117's second half an unknown tag is legal by
    /// design and parses as `TrackerProvider::Unknown`, so a `{"type":"jira"}`
    /// fixture here would assert the exact opposite of
    /// `a_workspace_with_an_unreadable_source_still_appears_in_the_list` below.
    /// `color` has no serde default, so this stays unreadable through every
    /// provider variant still to come.
    #[test]
    fn an_upsert_refuses_rather_than_truncating_a_file_it_could_not_parse() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        let original = r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"},
                            {"id":"w2","name":"B","path":"/b"}]"##;
        std::fs::write(s.ws_path(), original).unwrap();

        let err = s
            .upsert_workspace(Workspace {
                id: "w3".into(), name: "C".into(), path: "/c".into(), color: "#fff".into(),
                github: None, tracker: None,
            })
            .expect_err("a file we could not parse must never be overwritten");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        // The bytes are what matter: not "the list still has two entries" (the
        // read cannot produce them yet), but "nothing was lost".
        assert_eq!(std::fs::read_to_string(s.ws_path()).unwrap(), original);
    }

    /// `delete_workspace` reads through the same function and would truncate the
    /// same way. Both write paths, because a fix applied to one of them is a fix
    /// somebody will assume covers the other.
    #[test]
    fn a_delete_refuses_on_an_unparseable_file_too() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "[{ not json at all }]").unwrap();
        assert!(s.delete_workspace("w1").is_err());
    }

    /// All four write paths, not two. `try_read_vec`'s callers are `store.rs:124`
    /// (upsert workspace), `:134` (delete workspace), `:141` (upsert skill) and
    /// `:151` (delete skill), and a fix applied to some of them is a fix somebody
    /// will assume covers the rest.
    #[test]
    fn the_refusal_covers_both_skill_write_paths_as_well() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.sk_path(), "[{ not json }]").unwrap();
        assert!(s
            .upsert_skill(Skill {
                id: "s1".into(), name: "S".into(), icon: "play".into(),
                prompt: "p".into(), workspace_id: None, schedule: None,
            })
            .is_err());
        assert!(s.delete_skill("s1").is_err());
    }

    /// A listing still degrades to empty — `list_workspaces` returns `Vec`, not
    /// `Result` (`commands.rs:89-92`), so there is no channel to the UI and
    /// inventing one is out of this task's scope. What changes is that it is no
    /// longer *silent*: the warning `read_vec` already prints for an io error now
    /// covers the parse error that was being discarded one level below it.
    #[test]
    fn a_listing_still_degrades_to_empty_but_no_longer_silently() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "[{ not json }]").unwrap();
        assert!(s.workspaces().is_empty());
    }

    /// The four cases that must keep working, or start working: a missing file is
    /// a first run, an empty array is an empty list, a good file parses — and a
    /// **zero-byte** file is a first run too.
    ///
    /// That last one is not pedantry. `read_to_string` gives `Ok("")`,
    /// `from_str::<Vec<_>>("")` errors, and the refusal this task introduces would
    /// then make every write fail permanently with no way back from inside the
    /// app. And a zero-byte `workspaces.json` is exactly what `write_vec`'s bare
    /// `fs::write` leaves behind if the process dies between the truncate and the
    /// write — the crash case this task's own reasoning names.
    ///
    /// **A truncated-but-non-empty file keeps the refusal**, and the difference is
    /// deliberate: empty carries no information, so treating it as "nothing yet"
    /// loses nothing, while half a JSON array is evidence of records that a save
    /// would destroy. Do not "simplify" this into a general parse-failure
    /// fallback; that is the bug this task exists to fix.
    #[test]
    fn a_missing_or_empty_file_is_a_first_run_and_a_good_one_still_parses() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        assert!(s.workspaces().is_empty());
        std::fs::write(s.ws_path(), "").unwrap();
        assert!(s.workspaces().is_empty(), "a zero-byte file must not wedge every write");
        assert!(s.delete_workspace("nobody").is_ok(), "and must not be a hard stop either");
        std::fs::write(s.ws_path(), "   \n").unwrap();
        assert!(s.workspaces().is_empty(), "whitespace only, same thing");
        // The line above cannot fail on its own: `workspaces()` reads through
        // `read_vec`, which returns an empty Vec on *any* `Err`, so it is true
        // whether or not `try_read_vec` trims. The save path is what actually
        // distinguishes the two — change `s.trim().is_empty()` to
        // `s.is_empty()` and only this assertion notices.
        assert!(
            s.delete_workspace("nobody").is_ok(),
            "whitespace only must not wedge the save path either",
        );
        std::fs::write(s.ws_path(), "[]").unwrap();
        assert!(s.workspaces().is_empty());
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"}]"##,
        )
        .unwrap();
        assert_eq!(s.workspaces().len(), 1);
    }

    /// Task 1 stops the truncation; this is the other half of #117 — the record
    /// is not merely safe on disk, it is on screen.
    #[test]
    fn a_workspace_with_an_unreadable_source_still_appears_in_the_list() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff"},
                 {"id":"w2","name":"B","path":"/b","color":"#fff",
                  "tracker":{"providers":[{"type":"jira"}],"v":3}}]"##,
        )
        .unwrap();
        let all = s.workspaces();
        assert_eq!(all.len(), 2, "neither record is dropped");
        assert_eq!(all[1].name, "B");
    }

    /// Decision 2's open question, answered against the fixed store rather than
    /// the broken one. A `{"type":"github"}` record read by a build that has the
    /// tolerance but not the variant costs that workspace its *tracker* and
    /// nothing else — not the workspace, and not the file.
    ///
    /// What remains is not a hole in the fix, it is the reach of it: a build
    /// older than Task 1 empties the list, and its own `upsert_workspace` — not
    /// this one — then writes that emptiness back (#117). The destructive write
    /// always happens in whichever binary is running, which is exactly why the
    /// tolerance works from here on and exactly why it does nothing for a version
    /// already installed. Hence the release order in "Phases and barriers", and
    /// hence the README's warning for the builds behind that line.
    #[test]
    fn a_github_source_read_by_a_build_without_it_costs_one_tracker_not_the_file() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        // What an intermediate build sees: a variant it does not know, through
        // Task 2's tolerance. `jira` stands in for it, because this build *does*
        // know `github` now and cannot play the older one against itself.
        std::fs::write(
            s.ws_path(),
            r##"[{"id":"w1","name":"A","path":"/a","color":"#fff",
                  "tracker":{"providers":[{"type":"jira"}],"v":3}},
                 {"id":"w2","name":"B","path":"/b","color":"#fff"}]"##,
        )
        .unwrap();
        let all = s.workspaces();
        assert_eq!(all.len(), 2, "both records survive");
        assert!(matches!(
            all[0].tracker.as_ref().and_then(|c| c.providers.first()),
            Some(TrackerProvider::Unknown(_)),
        ));
    }

    /// Files written before the record existed hold a bare epoch-millis number
    /// per scenario. Reading one as "attempted and ran at that time" keeps an
    /// upgrade from re-arming (and so silently skipping) every schedule.
    #[test]
    fn schedule_state_reads_legacy_bare_numbers() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.schedule_state_path(), r#"{"skill-1": 1700000000000}"#).unwrap();

        let st = s.schedule_state();
        let run = st.get("skill-1").expect("legacy entry survives");
        assert_eq!(run.last_attempt, 1_700_000_000_000);
        assert_eq!(run.last_run, Some(1_700_000_000_000));
        assert_eq!(run.last_outcome, None);
    }

    /* --- the run journal ------------------------------------------------- */

    fn a_run(run_id: &str, skill: &str, at: i64) -> RunEvent {
        RunEvent::Started(crate::runs::RunStarted {
            version: crate::runs::RUN_JOURNAL_VERSION,
            run_id: run_id.into(),
            at,
            trigger: crate::runs::RunTrigger::Manual,
            skill_id: skill.into(),
            name: "Triage".into(),
            icon: "bolt".into(),
            workspace_id: Some("w1".into()),
            cwd: "/p".into(),
            branch: None,
            session_id: Some(format!("sess-{run_id}")),
            params: std::collections::HashMap::new(),
            prompt: Some("go".into()),
            continues_run_id: None,
        })
    }

    fn a_close(run_id: &str, at: i64) -> RunEvent {
        RunEvent::Closed(crate::runs::RunClosed {
            version: crate::runs::RUN_JOURNAL_VERSION,
            run_id: run_id.into(),
            at,
            status: crate::runs::RunStatus::Ended,
            result: Some("done".into()),
            reason: None,
            tokens: None,
            result_source: crate::runs::ResultSource::Transcript,
        })
    }

    /// A missing journal is a first run, exactly as a missing `workspaces.json`
    /// is — never an error, and never a reason to refuse a write.
    #[test]
    fn a_missing_journal_reads_empty_and_the_first_append_creates_it() {
        let s = Store::new(tmp());
        assert!(s.runs().is_empty());
        s.append_run_event(&a_run("r1", "s1", 10)).unwrap();
        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "r1");
        assert_eq!(runs[0].status, crate::runs::RunStatus::Running);
    }

    /// **Newest first**, because that is the order a history is read in and the
    /// one thing every caller would otherwise re-sort for itself.
    #[test]
    fn runs_come_back_newest_first() {
        let s = Store::new(tmp());
        for (id, at) in [("r1", 10), ("r2", 20), ("r3", 30)] {
            s.append_run_event(&a_run(id, "s1", at)).unwrap();
        }
        let ids: Vec<String> = s.runs().into_iter().map(|r| r.run_id).collect();
        assert_eq!(ids, vec!["r3", "r2", "r1"]);
    }

    /// The whole reason this file is appended to rather than rewritten: a
    /// process that died half-way through a line costs that line, and every
    /// record before it is still there afterwards.
    #[test]
    fn a_half_written_last_line_costs_that_record_and_no_other() {
        use std::io::Write;
        let s = Store::new(tmp());
        s.append_run_event(&a_run("r1", "s1", 10)).unwrap();
        s.append_run_event(&a_close("r1", 20)).unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(s.runs_path()).unwrap();
        f.write_all(br#"{"v":1,"t":"started","runId":"r2","at":3"#).unwrap();
        drop(f);

        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "r1");
        assert_eq!(runs[0].status, crate::runs::RunStatus::Ended);
        // And the next launch's record survives too. The half-written line has
        // no newline of its own, so an append that did not heal the file first
        // would splice the two together and lose **both** — the crash costing
        // the record after it as well as the one it interrupted.
        s.append_run_event(&a_run("r3", "s1", 40)).unwrap();
        let after = s.runs();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].run_id, "r3");
    }

    /// 101 runs of one scenario leave 100 after a restart.
    #[test]
    fn compaction_prunes_to_the_retention_limit_and_keeps_the_newest() {
        let s = Store::new(tmp());
        for i in 0..(RUNS_PER_SKILL + 1) {
            s.append_run_event(&a_run(&format!("r{i}"), "s1", i as i64)).unwrap();
        }
        assert_eq!(s.compact_runs().unwrap(), 1);
        let runs = s.runs();
        assert_eq!(runs.len(), RUNS_PER_SKILL);
        assert_eq!(runs[0].run_id, format!("r{}", RUNS_PER_SKILL));
        assert_eq!(runs.last().unwrap().run_id, "r1", "the oldest is the one that went");
        // Idempotent: a second start must not keep trimming a file already at
        // the limit.
        assert_eq!(s.compact_runs().unwrap(), 0);
    }

    /// Compaction rewrites the file, so it has to preserve what the events
    /// carried — including a close, which a records-only rewrite could drop.
    #[test]
    fn compaction_keeps_every_surviving_record_whole() {
        let s = Store::new(tmp());
        s.append_run_event(&a_run("r1", "s1", 10)).unwrap();
        s.append_run_event(&crate::runs::RunEvent::Transcript(crate::runs::RunTranscript {
            version: 1, run_id: "r1".into(), at: 11, path: "/t/a.jsonl".into(), cleared: true,
        })).unwrap();
        s.append_run_event(&a_close("r1", 20)).unwrap();
        s.compact_runs().unwrap();
        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].transcript_path.as_deref(), Some("/t/a.jsonl"));
        assert!(runs[0].cleared);
        assert_eq!(runs[0].result.as_deref(), Some("done"));
    }

    /// Erasure exists at one granularity only, and it is this one. The other
    /// scenarios' records are untouched — a history that took its neighbours
    /// with it would make the action unusable.
    #[test]
    fn deleting_one_scenarios_history_leaves_the_rest() {
        let s = Store::new(tmp());
        s.append_run_event(&a_run("r1", "gone", 10)).unwrap();
        s.append_run_event(&a_run("r2", "kept", 20)).unwrap();
        s.append_run_event(&a_close("r2", 30)).unwrap();
        s.delete_skill_history("gone").unwrap();
        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].skill_id, "kept");
        assert_eq!(runs[0].status, crate::runs::RunStatus::Ended);
        // Deleting a scenario nobody ran is not an error.
        s.delete_skill_history("never-ran").unwrap();
        assert_eq!(s.runs().len(), 1);
    }

    /// The journal outlives the definitions it names. Deleting the scenario
    /// (and its workspace with it) must leave the records readable under the
    /// name they were launched with — that snapshot is the whole point of
    /// storing a name rather than looking one up through `skillId`.
    #[test]
    fn deleting_the_scenario_itself_leaves_its_history_alone() {
        let s = Store::new(tmp());
        s.upsert_skill(Skill {
            id: "s1".into(), name: "Triage".into(), icon: "bolt".into(),
            prompt: "p".into(), workspace_id: Some("w1".into()), schedule: None,
        }).unwrap();
        s.append_run_event(&a_run("r1", "s1", 10)).unwrap();
        s.delete_skill("s1").unwrap();
        s.delete_workspace("w1").unwrap();
        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].name, "Triage");
        assert_eq!(runs[0].icon, "bolt");
    }

    /// Retention is per scenario, so a nightly job is not evicted by an hourly
    /// one that happens to share the file.
    #[test]
    fn compaction_counts_each_scenario_separately() {
        let s = Store::new(tmp());
        for i in 0..(RUNS_PER_SKILL + 5) {
            s.append_run_event(&a_run(&format!("h{i}"), "hourly", i as i64)).unwrap();
        }
        s.append_run_event(&a_run("n1", "nightly", 1)).unwrap();
        s.compact_runs().unwrap();
        let runs = s.runs();
        assert_eq!(runs.iter().filter(|r| r.skill_id == "hourly").count(), RUNS_PER_SKILL);
        assert_eq!(runs.iter().filter(|r| r.skill_id == "nightly").count(), 1);
    }
}
