use crate::model::{
    ScheduleRun, SessionEntry, Skill, TerminalLayout, UiState, UiStatePatch, Workspace,
};
use crate::runs::{fold_events, retain_recent, RunEvent, RunRecord, RUNS_PER_SKILL};
use crate::windows::MAIN as MAIN_WINDOW;
use std::path::PathBuf;

/// Does this entry belong to `owner`?
///
/// The absent-means-main rule lives here rather than at the two call sites, so
/// reading and writing cannot drift apart — a filter that disagreed with the
/// merge by one case would either restore an entry twice or drop it.
fn is_owned_by(e: &SessionEntry, owner: &str) -> bool {
    match e.owner.as_deref() {
        Some(label) => label == owner,
        None => owner == MAIN_WINDOW,
    }
}

/// The entries `owner` should restore.
///
/// An entry owned by a window that does not currently exist is deliberately
/// restored by **nobody** here, rather than falling back to the main window.
/// Re-homing those is #245 (closing a window returns its workspace) and #246 (a
/// workspace deleted while detached); guessing at it in the loader would put a
/// tile in the main window that a workspace window is about to claim, which is
/// the duplicate-`--resume` this whole issue exists to prevent. Today no entry
/// can name a window other than the main one, so this branch is unreachable
/// until those land.
pub fn owned_by(entries: Vec<SessionEntry>, owner: &str) -> Vec<SessionEntry> {
    entries.into_iter().filter(|e| is_owned_by(e, owner)).collect()
}

/// Fold one window's list into the file without disturbing another's.
///
/// `incoming` is the complete list of tiles `owner` currently has, which is what
/// `persistLayout` sends: so the rule is **replace this owner's entries, keep
/// everyone else's**. A tile that was closed is simply absent from `incoming` and
/// drops out, so there is no forget-this-entry command.
///
/// #238 sketched one, beside an upsert keyed on `sessionId`, preferring it to a
/// per-window write because that "needs no bookkeeping about who authored which
/// entry". But `owner` — added by the same issue — *is* that bookkeeping, and it
/// is stamped here from the window label rather than trusted from the caller, so
/// the objection does not survive its own first bullet. A command whose only job
/// is to delete a row the next save would drop anyway is a second way to be
/// wrong about which rows are gone.
///
/// The second filter is the one that is easy to miss. While a session is moving
/// between windows (#241) both windows list it for a moment, so an entry for it
/// can already be in the file under the *other* owner. Dropping any entry whose
/// session the incoming list claims keeps `sessionId` unique across the whole
/// file, and makes the last writer the owner. Without it a move that raced a
/// save would leave two entries for one session — and two `claude --resume` on
/// the next launch, which is exactly the defect this is fixing.
pub fn merge_layout(
    existing: Vec<SessionEntry>,
    incoming: &[SessionEntry],
    owner: &str,
) -> Vec<SessionEntry> {
    let claimed: std::collections::HashSet<&str> =
        incoming.iter().map(|e| e.session_id.as_str()).collect();
    let mut merged: Vec<SessionEntry> = existing
        .into_iter()
        .filter(|e| !is_owned_by(e, owner) && !claimed.contains(e.session_id.as_str()))
        .collect();
    merged.extend(incoming.iter().cloned().map(|mut e| {
        // Stamped here and nowhere else. Whatever the caller sent is discarded:
        // the label comes from the runtime, one layer up.
        e.owner = Some(owner.to_string());
        e
    }));
    merged
}

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
            // An empty file is a first run, not a corrupt one, and refusing it
            // would wedge every save with no recovery inside the app. Our own
            // writes no longer produce one — `write_atomic` renames a complete
            // file into place rather than truncating this one (#145) — but a
            // build older than that fix, a filesystem that lost the bytes on a
            // power cut, or a person with an editor can all still leave one, and
            // the tolerance is what makes those recoverable. A *non-empty* file
            // we cannot parse still refuses: half an array is evidence of records
            // a save would destroy, and an empty one is evidence of nothing.
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

    /// Replace `path`'s contents without ever leaving it truncated.
    ///
    /// `fs::write` opens with `O_TRUNC`: the old records are gone before the new
    /// ones reach the disk, so a crash, a kill or a full disk in between leaves a
    /// **zero-byte file**. `try_read_vec` then reads that as an empty list — on
    /// purpose, because refusing there would wedge every save with no recovery
    /// from inside the app — and the next save writes the emptiness back as the
    /// truth. That was the last open route to #117 (#145). Writing a sibling and
    /// renaming it over the target closes it: `rename` is atomic within a
    /// filesystem, so the target only ever holds a whole file, the old one or the
    /// new one and never a prefix of either.
    ///
    /// The temp name carries a pid and a counter rather than being derived from
    /// the target alone. `sessions.json` is written from more than one window,
    /// and `merge_layout`'s own doc comment describes saves that race; two of
    /// them sharing one temp file would let a rename publish half of the other
    /// writer's bytes — a *non-empty* unparseable file, which since #117 the next
    /// save refuses outright. That wedges the store instead of costing it one
    /// tick, so it is a worse failure than the one being fixed. The leading dot
    /// and the `.tmp` suffix keep whatever a crash leaves behind out of sight.
    ///
    /// `sync_all` before the rename, because the rename can otherwise reach the
    /// disk before the bytes it publishes do — and what that leaves is exactly
    /// the zero-byte file this function exists to make impossible.
    ///
    /// `tasks/fs.rs::write_atomic` is the same manoeuvre for cards. It stays
    /// separate because it speaks `TaskError` and resolves temp files against the
    /// board's root rather than the target's own directory.
    fn write_atomic(path: &PathBuf, body: &str) -> std::io::Result<()> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);

        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let tmp = path.with_file_name(format!(
            ".{name}.{}.{}.tmp",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));

        let spill = || -> std::io::Result<()> {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(body.as_bytes())?;
            f.sync_all()
        };
        match spill().and_then(|()| std::fs::rename(&tmp, path)) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Nobody else will: the name is unique per call, so a temp file
                // left by a failure here would stay for good.
                let _ = std::fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    /// Serialize `value` and put it in `path`, atomically.
    ///
    /// The one place a store file is serialized and written. Every save went
    /// through its own copy of these three lines, which is how `ui_state.json`
    /// came to have the truncation hazard that `write_vec`'s callers had, in a
    /// function nothing pointed at.
    fn write_json<T: serde::Serialize>(path: &PathBuf, value: &T) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(value)
            .map_err(std::io::Error::other)?;
        Self::write_atomic(path, &json)
    }

    fn write_vec<T: serde::Serialize>(path: &PathBuf, items: &[T]) -> std::io::Result<()> {
        Self::write_json(path, &items)
    }

    pub fn workspaces(&self) -> Vec<Workspace> { Self::read_vec(&self.ws_path()) }
    /// The workspace list, or the reason it could not be read.
    ///
    /// `workspaces` above is best-effort, and `read_vec` states the condition
    /// that makes that safe: nothing destructive follows a plain listing. Since
    /// #369 something does. A window pinned to a workspace closes itself when
    /// the list stops containing it, so "this file will not parse" arriving as
    /// "there are no workspaces" would close every detached window over a fault
    /// that deleted nothing. A caller about to act on the *absence* of a record
    /// asks this one, and says nothing when it cannot be answered.
    pub fn try_workspaces(&self) -> std::io::Result<Vec<Workspace>> {
        Self::try_read_vec(&self.ws_path())
    }
    pub fn save_workspaces(&self, items: &[Workspace]) -> std::io::Result<()> {
        Self::write_vec(&self.ws_path(), items)
    }
    pub fn skills(&self) -> Vec<Skill> { Self::read_vec(&self.sk_path()) }
    /// The scenario list, or the reason it could not be read.
    ///
    /// Same argument as `try_workspaces` above, for the other file the
    /// scheduler tick reads. The tick prunes `schedule_state.json` down to the
    /// scenarios that still exist, so "this file will not parse" arriving as
    /// "there are no scenarios" would drop every rule's `lastRun` over a fault
    /// that deleted nothing — and every schedule would then re-arm from
    /// scratch. A caller about to act on the *absence* of a record asks this
    /// one.
    pub fn try_skills(&self) -> std::io::Result<Vec<Skill>> {
        Self::try_read_vec(&self.sk_path())
    }
    pub fn save_skills(&self, items: &[Skill]) -> std::io::Result<()> {
        Self::write_vec(&self.sk_path(), items)
    }

    fn layout_path(&self) -> PathBuf { self.dir.join("sessions.json") }
    /// Every entry in the file, whoever owns it. What a window restores from is
    /// `layout_for`; this is the whole record, for merging and for tests.
    pub fn layout(&self) -> Vec<SessionEntry> { Self::read_vec(&self.layout_path()) }
    /// The entries `owner` should restore.
    pub fn layout_for(&self, owner: &str) -> Vec<SessionEntry> {
        owned_by(self.layout(), owner)
    }
    /// Write `owner`'s tiles, leaving every other window's alone.
    ///
    /// This was a whole-file replace, which was correct only while one window
    /// existed: the last window to save deleted every other window's sessions
    /// from the file, and the next launch restored half the deck. `save_ui_state`
    /// below stopped being a replace for the same reason.
    ///
    /// `try_read_vec`, not `layout()`, and for the reason the NOTE above
    /// `upsert_workspace` gives: this is now a read-before-write, so a read that
    /// fails must abort rather than be taken for "the file was empty". The
    /// best-effort read would turn one unreadable `sessions.json` into the
    /// permanent loss of every other window's sessions on the next save — #117,
    /// in a second place. Refusing costs a layout that is not persisted this
    /// tick, which the caller already tolerates and logs.
    pub fn save_layout(&self, owner: &str, items: &[SessionEntry]) -> std::io::Result<()> {
        let existing: Vec<SessionEntry> = Self::try_read_vec(&self.layout_path())?;
        let merged = merge_layout(existing, items, owner);
        Self::write_vec(&self.layout_path(), &merged)
    }

    /// Write down which conversation each session is in, over whatever the file
    /// already says, for every id in `ids`.
    ///
    /// The fork a `/clear` produces is learned by a hook, kept in
    /// [`crate::resume_ids`] for the life of the app run, and reaches this file
    /// through the frontend's poll. That leaves a window: a `/clear` and then a
    /// quit before the next tick wrote a layout with no `resumeId`, and the next
    /// launch resumed the conversation the person cleared away — #199 again. The
    /// quit path calls this, so the last thing the app does is agree with what it
    /// learned.
    ///
    /// The window is not five seconds wide, either. Since #251 the poll is armed
    /// only while the deck has focus, so a session cleared in a window the person
    /// then tabbed away from is never polled again — and without this, never
    /// written down.
    ///
    /// Every window's entries at once, which is why this is not `save_layout`:
    /// at exit there is no window to attribute a write to, and which conversation
    /// a session is in is a fact about the conversation rather than about who was
    /// showing it. Entries this does not recognise are left exactly as they are.
    ///
    /// `try_read_vec` for the reason `save_layout` gives — a read-before-write
    /// that took an unreadable file for an empty one would replace every other
    /// session in it with nothing.
    pub fn update_resume_ids(
        &self,
        ids: &std::collections::HashMap<String, String>,
    ) -> std::io::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut existing: Vec<SessionEntry> = Self::try_read_vec(&self.layout_path())?;
        let mut touched = false;
        for entry in existing.iter_mut() {
            let Some(id) = ids.get(&entry.session_id) else { continue };
            if entry.resume_id.as_deref() == Some(id.as_str()) {
                continue;
            }
            entry.resume_id = Some(id.clone());
            touched = true;
        }
        // A write that would change nothing is not worth the rename, and at exit
        // it is the common case: the poll tick has usually already been here.
        if !touched {
            return Ok(());
        }
        Self::write_vec(&self.layout_path(), &existing)
    }

    fn terminals_path(&self) -> PathBuf { self.dir.join("terminals.json") }
    /// The drawer's tabs. A missing or damaged file is an empty drawer, the same
    /// forgiveness the deck layout gets: a person who loses their terminal tabs
    /// to a bad write should get an empty drawer, not a launch that fails.
    pub fn terminals(&self) -> TerminalLayout {
        match std::fs::read_to_string(self.terminals_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => TerminalLayout::default(),
        }
    }
    pub fn save_terminals(&self, layout: &TerminalLayout) -> std::io::Result<()> {
        Self::write_json(&self.terminals_path(), layout)
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
        if let Some(dismissed) = patch.sync_offer_dismissed {
            st.sync_offer_dismissed = dismissed;
        }
        // Each of the three is set only when the person has dragged that thing, and
        // a patch that omits one must not clear it — the same rule every field above
        // follows.
        if let Some(px) = patch.panel_px {
            st.panel_px = Some(px);
        }
        if let Some(px) = patch.wsp_px {
            st.wsp_px = Some(px);
        }
        if let Some(px) = patch.wsp_wide_px {
            st.wsp_wide_px = Some(px);
        }
        if let Some(px) = patch.tool_px {
            st.tool_px = Some(px);
        }
        if let Some(on) = patch.record_scenario_runs {
            st.record_scenario_runs = on;
        }
        // An answer given, never one withdrawn: a patch that omits the field
        // leaves it alone, exactly like every field above. Forgetting the answer
        // is `clear_capture_on_close`, because "leave it alone" and "put it back
        // to never-asked" cannot both be spelled `None` here.
        if let Some(on) = patch.capture_on_close {
            st.capture_on_close = Some(on);
        }
        if let Some(rows) = patch.terminal_rows {
            st.terminal_rows = rows;
        }
        if let Some(on) = patch.usage_reported {
            st.usage_reported = on;
        }
        Self::write_json(&self.ui_path(), &st)
    }

    /// Forget the remembered answer to the capture question, so the next close
    /// asks again.
    ///
    /// Its own method rather than a patch field: a patch says "set this" and an
    /// omitted field says "leave it alone", so there is no value of
    /// `Option<bool>` left to mean "back to never asked".
    pub fn clear_capture_on_close(&self) -> std::io::Result<()> {
        let mut st = self.ui_state();
        st.capture_on_close = None;
        Self::write_json(&self.ui_path(), &st)
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
        Self::write_json(&self.schedule_state_path(), st)
    }

    fn usage_state_path(&self) -> PathBuf { self.dir.join("usage_state.json") }

    /// The limits this app has watched a session be refused by (#303).
    ///
    /// A `Vec` rather than a map, and read through `read_vec` like the workspaces
    /// and the skills, because that path already has the rule this file needs: an
    /// unparseable non-empty file refuses the read rather than reporting an
    /// emptiness a save would then write back over it.
    ///
    /// Losing this file costs one fact — that the budget was spent — and the app
    /// carries on saying "unknown" until the next banner goes past. That is why
    /// there is no warning printed here where `schedule_state` prints one: this
    /// degrades to the state the feature was designed to sit in anyway.
    pub fn usage_state(&self) -> Vec<crate::model::UsageExhaustion> {
        Self::read_vec(&self.usage_state_path())
    }

    pub fn save_usage_state(
        &self,
        items: &[crate::model::UsageExhaustion],
    ) -> std::io::Result<()> {
        Self::write_vec(&self.usage_state_path(), items)
    }

    /// The scenario run journal, beside `skills.json` and `schedule_state.json`.
    ///
    /// Not in the project's `.cowork/`: tracker cards live there because they are
    /// a shared team artefact, and a run journal is a personal, machine-local
    /// record that would eventually be committed along with the agent's output.
    fn runs_path(&self) -> PathBuf { self.dir.join("runs.jsonl") }

    /// Append one event. **`OpenOptions::append`, never `write_vec`.**
    ///
    /// Not because the whole-file write is unsafe any more — `write_atomic`
    /// settled that (#145) — but because rewriting a journal that grows all day
    /// in order to add one line to it is the wrong shape: every append would
    /// read, fold and re-render every record before it. A half-written appended
    /// line is discarded by the reader and everything before it stands, which is
    /// the cheaper guarantee and the one this file needs.
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
                .map_err(std::io::Error::other)?,
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
    /// Through `write_atomic`, so a crash mid-compaction leaves the old journal
    /// intact — the one place this file is *not* append-only is also the one
    /// place it cannot afford to be truncated in. This had its own temp-file
    /// copy of that manoeuvre before the store's other writes needed one.
    fn rewrite_runs(&self, keep: &[RunRecord]) -> std::io::Result<()> {
        let mut body = String::new();
        for rec in keep {
            for ev in rec.to_events() {
                body.push_str(
                    &ev.to_line()
                        .map_err(std::io::Error::other)?,
                );
                body.push('\n');
            }
        }
        Self::write_atomic(&self.runs_path(), &body)
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

    /// Erase one scenario's history, wholesale, within one workspace's scope.
    ///
    /// The only erasure there is. A record is a snapshot of what ran, so there
    /// is no editing or deleting of a single one — a journal whose rows can be
    /// revised answers nothing.
    ///
    /// **Scoped**, through the same `in_scope` the screen's `list_runs` used, so
    /// that what is erased is what was on screen. Erasing every workspace's
    /// records of a scenario from a screen showing one workspace's two of them
    /// would silently take the other forty, and this file is the only copy.
    ///
    /// **Refused while one of those runs is still `running`.** The rewrite is
    /// the one place this journal is not append-only, and taking out an open
    /// record loses more than the past: the run's `Closed` event arrives later
    /// with no `Started` left to attach to, `fold_events` drops it, and the run
    /// is never journalled at all — not even when it finishes. The UI disables
    /// the control for the same reason; this covers a run that starts between
    /// the render and the click.
    pub fn delete_skill_history(
        &self,
        skill_id: &str,
        workspace_id: Option<&str>,
    ) -> std::io::Result<()> {
        let all = fold_events(&self.runs_body());
        let doomed = |r: &RunRecord| crate::runs::in_scope(r, workspace_id, Some(skill_id));
        if all
            .iter()
            .any(|r| doomed(r) && r.status == crate::runs::RunStatus::Running)
        {
            return Err(std::io::Error::other(
                "one of this scenario's runs is still going — its record would be erased out \
                 from under it, and the run would never be journalled at all",
            ));
        }
        let keep: Vec<RunRecord> = all.into_iter().filter(|r| !doomed(r)).collect();
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

    /// Write one scenario, because somebody saved it.
    ///
    /// That is what clears `pinned_by_migration`: the #249 migration's guess at
    /// a workspace lasts exactly until a person opens the form and presses OK,
    /// having been shown the pin it keeps. From then on it is an ordinary pin
    /// and travels like one. The migration itself writes through `save_skills`,
    /// the bulk write, and does not come through here.
    pub fn upsert_skill(&self, mut sk: Skill) -> std::io::Result<Vec<Skill>> {
        sk.pinned_by_migration = false;
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
        NameKind, SessionEntry, TerminalEntry, TrackerProvider, UiState, UiStatePatch, Workspace,
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
        let w = Workspace { id: "w1".into(), name: "Grosh".into(), path: "/tmp/grosh".into(), color: "#3b82f6".into(), github: None, tracker: None, repo: None };
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

    /// A layout entry for the resume-id tests: a session, and whatever the file
    /// already says about which conversation it should resume.
    fn entry_for(session_id: &str, resume_id: Option<&str>) -> SessionEntry {
        SessionEntry { resume_id: resume_id.map(Into::into), ..entry(session_id, None) }
    }

    /// The quit path's last word. A `/clear` inside the final five seconds never
    /// reached the file through the poll tick, and resuming what the file said
    /// would bring back the conversation the person cleared away (#199).
    #[test]
    fn update_resume_ids_writes_what_the_tick_did_not() {
        let dir = tmp();
        let s = Store::new(dir);
        s.save_layout(MAIN_WINDOW, &[entry_for("s1", None), entry_for("s2", None)]).unwrap();
        let mut ids = std::collections::HashMap::new();
        ids.insert("s2".to_string(), "after-the-clear".to_string());
        s.update_resume_ids(&ids).unwrap();

        let back = s.layout();
        // The one that was cleared, and only it.
        assert_eq!(back.iter().find(|e| e.session_id == "s2").unwrap().resume_id.as_deref(),
                   Some("after-the-clear"));
        assert_eq!(back.iter().find(|e| e.session_id == "s1").unwrap().resume_id, None);
    }

    /// An id for a session the file has never heard of changes nothing — a tile
    /// closed before the quit, or one another machine's layout owns.
    #[test]
    fn update_resume_ids_leaves_sessions_it_does_not_know() {
        let dir = tmp();
        let s = Store::new(dir);
        s.save_layout(MAIN_WINDOW, &[entry_for("s1", Some("already-here"))]).unwrap();
        let mut ids = std::collections::HashMap::new();
        ids.insert("gone".to_string(), "nowhere".to_string());
        s.update_resume_ids(&ids).unwrap();

        let back = s.layout();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].resume_id.as_deref(), Some("already-here"));
    }

    /// Every other window's sessions survive it: this is the one writer with no
    /// window to attribute itself to, so a whole-file rewrite is what it does and
    /// leaving the rest alone is the whole requirement.
    #[test]
    fn update_resume_ids_does_not_disturb_another_window() {
        let dir = tmp();
        let s = Store::new(dir);
        s.save_layout(MAIN_WINDOW, &[entry_for("s1", None)]).unwrap();
        s.save_layout("w2", &[entry_for("s2", None)]).unwrap();
        let mut ids = std::collections::HashMap::new();
        ids.insert("s1".to_string(), "after-the-clear".to_string());
        s.update_resume_ids(&ids).unwrap();

        assert_eq!(s.layout().len(), 2);
        assert_eq!(s.layout_for("w2").len(), 1, "the other window is still there");
        assert_eq!(s.layout_for(MAIN_WINDOW)[0].resume_id.as_deref(), Some("after-the-clear"));
    }

    /// An unreadable file refuses rather than replacing every session in it with
    /// nothing — `save_layout`'s rule (#117), in a third place.
    #[test]
    fn update_resume_ids_refuses_an_unreadable_layout() {
        let dir = tmp();
        let s = Store::new(dir.clone());
        std::fs::write(dir.join("sessions.json"), "[{\"sessionId\": ").unwrap();
        let mut ids = std::collections::HashMap::new();
        ids.insert("s1".to_string(), "after-the-clear".to_string());
        assert!(s.update_resume_ids(&ids).is_err());
        // And the half-written file is still there to be recovered by hand.
        assert!(std::fs::read_to_string(dir.join("sessions.json")).unwrap().contains("sessionId"));
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
            repo: None,
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
            repo: None,
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
                owner: None, cli_kind: None, resume_id: None,
            },
            SessionEntry {
                session_id: "s2".into(), cwd: "/tmp/b".into(), name: "terminal · P".into(),
                workspace_id: None, task_id: None, scheduled_skill_id: None,
                // The whole point of the field: this one survives the round trip.
                user_name: Some("the one I must not close".into()),
                name_kind: Some(NameKind::Placeholder), skill_id: None, run_id: None,
                // The other field a stale copy of which would lose work: this
                // one says which conversation the next launch resumes.
                owner: None, cli_kind: None, resume_id: Some("after-the-clear".into()),
            },
        ];
        s.save_layout(MAIN_WINDOW, &entries).unwrap();
        let reloaded = Store::new(s.dir.clone()).layout();
        // Everything round trips, and the owner is stamped on the way in: the
        // frontend does not send it, so the save is the only place it can come
        // from.
        let stamped: Vec<SessionEntry> = entries
            .into_iter()
            .map(|mut e| { e.owner = Some(MAIN_WINDOW.into()); e })
            .collect();
        assert_eq!(reloaded, stamped);
    }

    /// A layout entry with only the fields the multi-window tests care about.
    fn entry(session_id: &str, owner: Option<&str>) -> SessionEntry {
        SessionEntry {
            session_id: session_id.into(), cwd: "/tmp".into(), name: session_id.into(),
            workspace_id: None, task_id: None, scheduled_skill_id: None,
            user_name: None, name_kind: None, skill_id: None, run_id: None,
            owner: owner.map(Into::into), cli_kind: None, resume_id: None,
        }
    }

    fn ids_owned_by(s: &Store, owner: &str) -> Vec<String> {
        s.layout_for(owner).into_iter().map(|e| e.session_id).collect()
    }

    /// The defect this issue leads the epic for: whichever window saved last used
    /// to remove every other window's sessions from the file, and the next launch
    /// restored half the deck.
    #[test]
    fn two_windows_saving_in_turn_keep_both_sets() {
        let s = Store::new(tmp());
        s.save_layout(MAIN_WINDOW, &[entry("s1", None), entry("s2", None)]).unwrap();
        s.save_layout("project:w1", &[entry("s3", None)]).unwrap();
        // ...and again from the first, which is the ordering that used to lose s3.
        s.save_layout(MAIN_WINDOW, &[entry("s1", None), entry("s2", None)]).unwrap();

        assert_eq!(ids_owned_by(&s, MAIN_WINDOW), ["s1", "s2"]);
        assert_eq!(ids_owned_by(&s, "project:w1"), ["s3"]);
        assert_eq!(s.layout().len(), 3, "and nothing is duplicated");
    }

    /// Closing a tile is just a save without it, so no forget-this-entry command
    /// is needed — but it must remove that entry and no one else's.
    #[test]
    fn closing_a_tile_removes_exactly_its_own_entry() {
        let s = Store::new(tmp());
        s.save_layout(MAIN_WINDOW, &[entry("s1", None), entry("s2", None)]).unwrap();
        s.save_layout("project:w1", &[entry("s3", None)]).unwrap();

        s.save_layout(MAIN_WINDOW, &[entry("s1", None)]).unwrap();

        assert_eq!(ids_owned_by(&s, MAIN_WINDOW), ["s1"]);
        assert_eq!(ids_owned_by(&s, "project:w1"), ["s3"], "another window's tile is untouched");
    }

    /// Every `sessions.json` on disk today predates the field, and every entry in
    /// one belongs to the main window. So an upgrade restores exactly what it
    /// restored before, into the same window, with nothing to migrate.
    #[test]
    fn a_layout_written_before_the_owner_field_belongs_to_the_main_window() {
        let s = Store::new(tmp());
        std::fs::write(
            s.layout_path(),
            r#"[{"sessionId":"s1","cwd":"/a","name":"session · deck"}]"#,
        ).unwrap();

        assert_eq!(ids_owned_by(&s, MAIN_WINDOW), ["s1"]);
        assert!(
            s.layout_for("project:w1").is_empty(),
            "an ownerless entry is the main window's, not everyone's",
        );
    }

    /// The move race from #241: both windows list the session for a moment, so a
    /// save from each can reach the file. Two entries for one session would mean
    /// two `claude --resume` on the next launch — the very thing being fixed.
    #[test]
    fn a_session_claimed_by_another_window_appears_exactly_once() {
        let s = Store::new(tmp());
        s.save_layout(MAIN_WINDOW, &[entry("s1", None)]).unwrap();
        s.save_layout("project:w1", &[entry("s1", None)]).unwrap();

        assert_eq!(s.layout().len(), 1);
        assert_eq!(ids_owned_by(&s, "project:w1"), ["s1"], "the last writer owns it");
        assert!(s.layout_for(MAIN_WINDOW).is_empty());
    }

    /// #117, in the second place it can now happen: the save reads before it
    /// writes, so a read it cannot trust must abort instead of being taken for an
    /// empty file — which would delete every other window's sessions for good.
    #[test]
    fn an_unreadable_layout_refuses_the_save_rather_than_truncating_it() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.layout_path(), "[{ not json }]").unwrap();

        assert!(s.save_layout(MAIN_WINDOW, &[entry("s1", None)]).is_err());
        assert_eq!(
            std::fs::read_to_string(s.layout_path()).unwrap(),
            "[{ not json }]",
            "and the evidence of what was there is still on disk",
        );
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
        // Must match `DEFAULT_TERMINAL_ROWS` in `src/drawer.ts`, which is the
        // height the drawer opens at before a stored value has been read.
        assert_eq!(UiState::default().terminal_rows, 14);
        // Off: nobody has been asked yet, so nobody has declined.
        assert!(!UiState::default().sync_offer_dismissed);
        // On. Asking spends no quota and reads no credential, and the
        // alternative default is a screen saying "unknown" to somebody who
        // never knew there was a switch.
        assert!(UiState::default().usage_reported);
        // Never asked, which is a third state and not `false`. A default either
        // way would answer a question about spending somebody's money on their
        // behalf — see the field's own note.
        assert_eq!(UiState::default().capture_on_close, None);
        let patch = UiStatePatch {
            active_workspace_id: Some("w-1".into()),
            ui_scale: Some(1.3),
            pr_diff_cols: Some(80),
            sync_offer_dismissed: Some(true),
            record_scenario_runs: Some(false),
            capture_on_close: Some(true),
            terminal_rows: Some(20),
            usage_reported: Some(false),
            panel_px: Some(340),
            wsp_px: Some(720),
            wsp_wide_px: None,
            tool_px: Some(360),
        };
        s.save_ui_state(&patch).unwrap();
        let reloaded = Store::new(s.dir.clone()).ui_state();
        assert_eq!(reloaded.active_workspace_id, Some("w-1".into()));
        assert_eq!(reloaded.ui_scale, 1.3);
        assert_eq!(reloaded.pr_diff_cols, 80);
        // The three that were set come back; the one the patch left out stays unset
        // rather than being cleared to a number nobody chose.
        assert_eq!(reloaded.panel_px, Some(340));
        assert_eq!(reloaded.tool_px, Some(360));
        assert_eq!(reloaded.wsp_px, Some(720));
        assert_eq!(reloaded.wsp_wide_px, None);
        assert!(!reloaded.record_scenario_runs);
        assert_eq!(reloaded.terminal_rows, 20);
        // An offer that comes back after being waved away is not an offer.
        assert!(reloaded.sync_offer_dismissed);
    }

    /// The drawer's own file, and the reason it is a struct rather than the bare
    /// `Vec` the deck layout is: neither the tab in front nor whether the drawer
    /// is up has anywhere else to live — and both are **per workspace**, because
    /// the drawer is.
    #[test]
    fn terminals_round_trip_and_default_to_an_empty_drawer() {
        let s = Store::new(tmp());
        assert_eq!(s.terminals(), TerminalLayout::default());
        assert!(s.terminals().items.is_empty());
        assert!(s.terminals().active.is_empty());
        assert!(s.terminals().open.is_empty(), "a drawer nobody opened is shut");

        let layout = TerminalLayout {
            items: vec![
                TerminalEntry {
                    session_id: "t1".into(),
                    cwd: "/tmp/a".into(),
                    name: "zsh · api".into(),
                    workspace_id: Some("w1".into()),
                },
                TerminalEntry {
                    session_id: "t2".into(),
                    cwd: "/tmp/b".into(),
                    name: "build".into(),
                    workspace_id: Some("w2".into()),
                },
                // Opened with no workspace active. Keyed by "" below, because a
                // JSON object has no null key.
                TerminalEntry {
                    session_id: "t3".into(),
                    cwd: "/tmp/c".into(),
                    name: "zsh".into(),
                    workspace_id: None,
                },
            ],
            active: [("w1".to_string(), "t1".to_string()), (String::new(), "t3".to_string())]
                .into_iter()
                .collect(),
            // Up in one workspace and shut in the other, which is the whole
            // point of the field.
            open: vec!["w1".into()],
        };
        s.save_terminals(&layout).unwrap();
        assert_eq!(Store::new(s.dir.clone()).terminals(), layout);
    }

    /// The shape written before the drawer was scoped per workspace: one active
    /// tab for the app, no `open` list at all. It has to keep loading — the tabs
    /// are the part worth saving, and losing them to a field that moved would be
    /// the upgrade eating a person's terminals.
    #[test]
    fn a_terminals_file_from_before_the_drawer_was_scoped_still_loads() {
        let s = Store::new(tmp());
        std::fs::write(
            s.dir.join("terminals.json"),
            r#"{"items":[{"sessionId":"t1","cwd":"/tmp/a","name":"zsh","workspaceId":"w1"}],"active":"t1"}"#,
        )
        .unwrap();
        let loaded = s.terminals();
        assert_eq!(loaded.items.len(), 1, "the tabs survive the shape change");
        assert_eq!(loaded.items[0].session_id, "t1");
        // The old `active` was a string where a map now is; unreadable rather
        // than wrong, so it falls back to nothing and the drawer picks the first
        // tab. Shut, because the old file could not say otherwise per workspace.
        assert!(loaded.active.is_empty());
        assert!(loaded.open.is_empty());
    }

    /// A drawer whose file is damaged opens empty rather than failing the launch
    /// — the same forgiveness `ui_state` gets, and for the same reason: nobody
    /// should lose the app to a half-written list of terminal tabs.
    #[test]
    fn a_damaged_terminals_file_is_an_empty_drawer() {
        let s = Store::new(tmp());
        std::fs::write(s.dir.join("terminals.json"), "{ not json").unwrap();
        assert_eq!(s.terminals(), TerminalLayout::default());
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
                repo: None,
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
                pinned_by_migration: false,
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
    /// app. A zero-byte `workspaces.json` was exactly what `write_vec`'s bare
    /// `fs::write` left behind if the process died between the truncate and the
    /// write — the crash case this task's own reasoning named, and the one #145
    /// closed by writing through `write_atomic`. The tolerance stays for the
    /// files that fix cannot reach: written by an older build, or by something
    /// that is not this app.
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
        a_run_in(run_id, skill, at, Some("w1"))
    }

    fn a_run_in(run_id: &str, skill: &str, at: i64, workspace: Option<&str>) -> RunEvent {
        RunEvent::Started(crate::runs::RunStarted {
            version: crate::runs::RUN_JOURNAL_VERSION,
            run_id: run_id.into(),
            at,
            trigger: crate::runs::RunTrigger::Manual,
            skill_id: skill.into(),
            name: "Triage".into(),
            icon: "bolt".into(),
            workspace_id: workspace.map(str::to_string),
            cwd: "/p".into(),
            branch: None,
            session_id: Some(format!("sess-{run_id}")),
            params: std::collections::HashMap::new(),
            prompt: Some("go".into()),
            continues_run_id: None,
            cli_kind: Some("claude".into()),
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
        // Closed, because an open record refuses the erase — see
        // `erasing_a_history_is_refused_while_one_of_its_runs_is_still_open`.
        s.append_run_event(&a_close("r1", 15)).unwrap();
        s.append_run_event(&a_run("r2", "kept", 20)).unwrap();
        s.append_run_event(&a_close("r2", 30)).unwrap();
        s.delete_skill_history("gone", None).unwrap();
        let runs = s.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].skill_id, "kept");
        assert_eq!(runs[0].status, crate::runs::RunStatus::Ended);
        // Deleting a scenario nobody ran is not an error.
        s.delete_skill_history("never-ran", None).unwrap();
        assert_eq!(s.runs().len(), 1);
    }

    /// The screen is one workspace's, and so is the erase. Somebody clearing the
    /// two rows in front of them must not also lose the forty this scenario has
    /// in the workspaces they are not looking at — the journal is the only copy
    /// and there is no undo.
    #[test]
    fn erasing_a_history_reaches_only_the_workspace_that_was_on_screen() {
        let s = Store::new(tmp());
        s.append_run_event(&a_run_in("here", "s1", 10, Some("w1"))).unwrap();
        s.append_run_event(&a_close("here", 11)).unwrap();
        s.append_run_event(&a_run_in("elsewhere", "s1", 20, Some("w2"))).unwrap();
        s.append_run_event(&a_close("elsewhere", 21)).unwrap();
        // No workspace of its own: it shows in every workspace's history, so it
        // is also erased from any of them — `in_scope` answers both questions.
        s.append_run_event(&a_run_in("nowhere", "s1", 30, None)).unwrap();
        s.append_run_event(&a_close("nowhere", 31)).unwrap();

        s.delete_skill_history("s1", Some("w1")).unwrap();
        let left: Vec<String> = s.runs().into_iter().map(|r| r.run_id).collect();
        assert_eq!(left, vec!["elsewhere".to_string()]);
    }

    /// Erasing rewrites the journal, and rewriting an open record out of it
    /// loses more than the past: the run's `Closed` event would arrive later
    /// with no `Started` left to attach to, `fold_events` would drop it, and the
    /// run would never be journalled at all.
    #[test]
    fn erasing_a_history_is_refused_while_one_of_its_runs_is_still_open() {
        let s = Store::new(tmp());
        s.append_run_event(&a_run("done", "s1", 10)).unwrap();
        s.append_run_event(&a_close("done", 11)).unwrap();
        s.append_run_event(&a_run("live", "s1", 20)).unwrap();

        let err = s
            .delete_skill_history("s1", Some("w1"))
            .expect_err("an open run must not be erased out from under itself");
        assert!(err.to_string().contains("still going"), "{err}");
        assert_eq!(s.runs().len(), 2, "nothing may have been rewritten");

        // The refusal is scoped too: an open run in another workspace is not a
        // reason to refuse the erase of the one on screen.
        s.append_run_event(&a_run_in("far", "s2", 30, Some("w2"))).unwrap();
        s.delete_skill_history("s2", Some("w1")).unwrap();

        // And once it closes, the erase goes through.
        s.append_run_event(&a_close("live", 40)).unwrap();
        s.delete_skill_history("s1", Some("w1")).unwrap();
        let left: Vec<String> = s.runs().into_iter().map(|r| r.run_id).collect();
        assert_eq!(left, vec!["far".to_string()]);
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
            pinned_by_migration: false,
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

    /// #145, and the mechanism rather than the crash: a save must publish a
    /// *finished* file by renaming it over the target, never empty the target
    /// and fill it back in. Provoking a real torn write is not something a unit
    /// test can do, so what is pinned here is the property that makes one
    /// harmless — there is no moment at which the target holds neither the old
    /// records nor the new ones.
    ///
    /// The inode is the witness. `fs::write` truncates and refills the same
    /// file, so the number is unchanged; a rename puts a different file at the
    /// name. Nothing else distinguishes the two after the fact, which is why the
    /// assertion is this and not a byte comparison.
    ///
    /// **Every write path in this file, not the one the issue was reported
    /// against.** `write_vec`'s three callers were the reported ones, and
    /// `ui_state.json` — named in the same report — never went through it at
    /// all; a fix applied to some of them is a fix somebody will assume covers
    /// the rest.
    #[test]
    fn every_save_replaces_the_file_rather_than_truncating_it() {
        use std::os::unix::fs::MetadataExt;

        let s = Store::new(tmp());
        let ino = |p: &PathBuf| std::fs::metadata(p).unwrap().ino();
        let replaced = |p: &PathBuf, before: u64, what: &str| {
            assert_ne!(
                before,
                ino(p),
                "{what} was written in place: between the truncate and the write \
                 it holds neither the old records nor the new ones",
            );
        };

        let ws = |id: &str| Workspace {
            id: id.into(), name: id.into(), path: "/tmp/a".into(), color: "#fff".into(),
            github: None, tracker: None, repo: None,
        };
        s.save_workspaces(&[ws("w1")]).unwrap();
        let before = ino(&s.ws_path());
        s.save_workspaces(&[ws("w1"), ws("w2")]).unwrap();
        replaced(&s.ws_path(), before, "workspaces.json");
        assert_eq!(s.workspaces().len(), 2, "and the new records are the ones on disk");

        let sk = |id: &str| Skill {
            id: id.into(), name: id.into(), icon: "play".into(), prompt: "p".into(),
            workspace_id: None, schedule: None, pinned_by_migration: false,
        };
        s.save_skills(&[sk("s1")]).unwrap();
        let before = ino(&s.sk_path());
        s.save_skills(&[sk("s1"), sk("s2")]).unwrap();
        replaced(&s.sk_path(), before, "skills.json");
        assert_eq!(s.skills().len(), 2);

        s.save_layout(MAIN_WINDOW, &[entry("t1", None)]).unwrap();
        let before = ino(&s.layout_path());
        s.save_layout(MAIN_WINDOW, &[entry("t1", None), entry("t2", None)]).unwrap();
        replaced(&s.layout_path(), before, "sessions.json");
        assert_eq!(s.layout().len(), 2);

        s.save_ui_state(&UiStatePatch { active_workspace_id: Some("w1".into()), ..Default::default() })
            .unwrap();
        let before = ino(&s.ui_path());
        s.save_ui_state(&UiStatePatch { active_workspace_id: Some("w2".into()), ..Default::default() })
            .unwrap();
        replaced(&s.ui_path(), before, "ui_state.json");
        assert_eq!(s.ui_state().active_workspace_id, Some("w2".into()));

        let drawer = |name: &str| TerminalLayout {
            items: vec![TerminalEntry {
                session_id: "t1".into(), cwd: "/tmp/a".into(), name: name.into(),
                workspace_id: None,
            }],
            ..Default::default()
        };
        s.save_terminals(&drawer("zsh")).unwrap();
        let before = ino(&s.terminals_path());
        s.save_terminals(&drawer("bash")).unwrap();
        replaced(&s.terminals_path(), before, "terminals.json");
        assert_eq!(s.terminals().items[0].name, "bash");

        let fired = |at: i64| {
            let mut m = std::collections::HashMap::new();
            m.insert("s1".to_string(), ScheduleRun {
                last_attempt: at, last_run: Some(at), last_outcome: Some("launched".into()),
                preset: None, version: SCHEDULE_STATE_VERSION,
            });
            m
        };
        s.save_schedule_state(&fired(1)).unwrap();
        let before = ino(&s.schedule_state_path());
        s.save_schedule_state(&fired(2)).unwrap();
        replaced(&s.schedule_state_path(), before, "schedule_state.json");
        assert_eq!(s.schedule_state()["s1"].last_attempt, 2);

        // The journal's compaction, the one place it is not append-only. It had
        // this manoeuvre before the rest of the file did; it now shares the
        // implementation, so it is pinned here with everything else.
        for i in 0..(RUNS_PER_SKILL + 2) {
            s.append_run_event(&a_run(&format!("r{i}"), "s1", i as i64)).unwrap();
        }
        let before = ino(&s.runs_path());
        assert!(s.compact_runs().unwrap() > 0, "the fixture must actually provoke a rewrite");
        replaced(&s.runs_path(), before, "runs.jsonl");
    }

    /// The consequence, stated as the issue states it: a write that fails
    /// cannot leave a zero-byte file where the records were.
    ///
    /// The failure is injected where the app cannot recover from it either — a
    /// store directory that has become unwritable — because that is the one
    /// point a test can reach. What the old code did here is worse than an
    /// error: the target already exists and is writable, so `O_TRUNC` succeeds,
    /// the save reports success, and the records are gone. Refusing is the
    /// improvement, and the file surviving byte for byte is the point.
    #[test]
    fn a_save_that_fails_leaves_the_previous_records_byte_for_byte() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let s = Store::new(tmp());
        let w = Workspace {
            id: "w1".into(), name: "First".into(), path: "/tmp/a".into(), color: "#111111".into(),
            github: None, tracker: None, repo: None,
        };
        s.save_workspaces(std::slice::from_ref(&w)).unwrap();
        let original = fs::read_to_string(s.ws_path()).unwrap();

        let perms = fs::metadata(&s.dir).unwrap().permissions();
        fs::set_permissions(&s.dir, fs::Permissions::from_mode(0o500)).unwrap();
        // As root the mode bits do not stop the write, so the scenario cannot be
        // exercised on this platform/user — skip rather than false-fail, the same
        // way `upsert_refuses_to_truncate_on_non_not_found_read_error` does.
        let still_writable = fs::write(s.dir.join("probe"), "x").is_ok();
        if still_writable {
            let _ = fs::remove_file(s.dir.join("probe"));
            fs::set_permissions(&s.dir, perms).unwrap();
            return;
        }

        let mut w2 = w.clone();
        w2.name = "Renamed".into();
        assert!(
            s.save_workspaces(&[w2]).is_err(),
            "a save that cannot be completed must report so, not half-happen",
        );

        fs::set_permissions(&s.dir, perms).unwrap();
        assert_eq!(
            fs::read_to_string(s.ws_path()).unwrap(),
            original,
            "the records that were there must still be there, in full",
        );
        // And no debris at the name the next save will use.
        let leftovers: Vec<String> = fs::read_dir(&s.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "a failed save left temp files behind: {leftovers:?}");
    }

    /// The difference `try_workspaces` exists for (#369).
    ///
    /// `workspaces` answers an unparseable file with an empty list, which is the
    /// right trade for a plain listing and the wrong one for a decision: a window
    /// pinned to a workspace closes itself when the list stops containing it, so
    /// a fault that deleted nothing would close every detached window. The strict
    /// read is what lets a caller tell the two apart and say nothing.
    #[test]
    fn try_workspaces_refuses_a_list_it_cannot_parse() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "{ not an array").unwrap();

        assert!(
            s.workspaces().is_empty(),
            "the best-effort read still answers empty, as its callers rely on"
        );
        assert!(
            s.try_workspaces().is_err(),
            "a list that will not parse must not read as a list with nothing in it"
        );
    }

    /// The same difference, for the other file the scheduler tick reads.
    ///
    /// The tick prunes `schedule_state.json` down to the scenarios that still
    /// exist. Reading an unparseable `skills.json` as "there are none" would
    /// therefore rewrite that file empty — every rule's `lastRun` gone, every
    /// schedule re-armed from scratch — over a fault that deleted nothing.
    #[test]
    fn try_skills_refuses_a_list_it_cannot_parse() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.sk_path(), "{ not an array").unwrap();

        assert!(s.skills().is_empty(), "the best-effort read still answers empty");
        assert!(
            s.try_skills().is_err(),
            "a list that will not parse must not read as a list with nothing in it"
        );
    }

    /// And an *empty* file is still a first run rather than a fault — the
    /// tolerance `try_read_vec` documents, which a zero-byte file left by an
    /// older build or a power cut depends on.
    #[test]
    fn try_workspaces_accepts_an_empty_file() {
        let s = Store::new(tmp());
        std::fs::create_dir_all(&s.dir).unwrap();
        std::fs::write(s.ws_path(), "").unwrap();
        assert!(s.try_workspaces().unwrap().is_empty());
    }
}
