use crate::model::{SessionEntry, Skill, UiState, Workspace};
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

    /// Reads and parses a JSON array file. A missing file is a normal,
    /// expected case (first run) and yields an empty Vec. Any other read
    /// error (permission denied, I/O error, etc.) is transient/abnormal and
    /// is propagated as `Err` rather than silently swallowed — callers that
    /// are about to overwrite the file (upsert/delete) must treat that as a
    /// hard stop instead of proceeding with an empty in-memory list, which
    /// would otherwise truncate an existing, populated file on save.
    fn try_read_vec<T: serde::de::DeserializeOwned>(path: &PathBuf) -> std::io::Result<Vec<T>> {
        match std::fs::read_to_string(path) {
            Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
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
                    "warning: failed to read {} ({e}); treating as empty for this listing",
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
    pub fn save_ui_state(&self, st: &UiState) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(st)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(self.ui_path(), json)
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
    use crate::model::{SessionEntry, UiState, Workspace};

    fn tmp() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("coworkdeck-test-{}", std::process::id()));
        d.push(format!("{:?}", std::time::SystemTime::now()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn empty_store_reads_empty_then_upserts_and_deletes() {
        let s = Store::new(tmp());
        assert!(s.workspaces().is_empty());
        let w = Workspace { id: "w1".into(), name: "Grosh".into(), path: "/tmp/grosh".into(), color: "#3b82f6".into() };
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
            SessionEntry { session_id: "s1".into(), cwd: "/tmp/a".into(), name: "▶ Fix".into() },
            SessionEntry { session_id: "s2".into(), cwd: "/tmp/b".into(), name: "терминал · P".into() },
        ];
        s.save_layout(&entries).unwrap();
        let reloaded = Store::new(s.dir.clone()).layout();
        assert_eq!(reloaded, entries);
    }

    #[test]
    fn ui_state_round_trips_and_defaults_empty() {
        let s = Store::new(tmp());
        assert_eq!(s.ui_state(), UiState::default()); // NotFound -> default (None)
        let st = UiState { active_workspace_id: Some("w-1".into()) };
        s.save_ui_state(&st).unwrap();
        assert_eq!(Store::new(s.dir.clone()).ui_state(), st);
    }
}
