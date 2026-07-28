//! IPC surface of the tracker. Resolves a workspace id to a provider and keeps
//! every path/config decision on this side, so the frontend never learns that
//! cards are files.
use crate::commands::AppState;
use crate::model::{TrackerProvider, TrackerRoot, Workspace};
use crate::tasks::frontmatter::slugify;
use crate::tasks::fs::{FsTaskProvider, RootCreation};
use crate::tasks::model::{Task, TaskDraft, TaskKind, TaskOrigin};
use crate::tasks::provider::{ProviderCapabilities, TaskProvider};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

/// What the frontend is allowed to supply when creating a card. Deliberately
/// narrower than `tasks::model::TaskDraft`: `project` is always this
/// workspace's name (the caller does not get to pick it), and `origin`/
/// `session` are set by the backend to `Human`/`None` — every card created
/// through IPC is human-created by definition, so this type has no field
/// through which a caller could claim otherwise. `deny_unknown_fields` turns
/// an attempt to smuggle e.g. `"origin":"session"` into a hard deserialize
/// error instead of a silently ignored key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDraftInput {
    pub title: String,
    pub kind: TaskKind,
    pub body: String,
}

/// The provider root for a workspace, plus how much of it we may create.
/// `None` means "no tracker configured" — a legal, non-error state.
pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, RootCreation)> {
    let cfg = ws.tracker.as_ref()?;
    let first = cfg.providers.first()?;
    match first {
        TrackerProvider::Fs { root: TrackerRoot::Project } => Some((
            PathBuf::from(&ws.path).join(".cowork").join("tasks"),
            RootCreation::Always,
        )),
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => Some((
            // One folder per project inside the folder the person picked: they
            // pick one place for every project's backlog, and without this the
            // cards all land in the same directory.
            //
            // Slugified, not joined verbatim: a workspace name is free text, and
            // `join("../..")` would put the cards outside the picked folder
            // entirely. `slugify` yields exactly one component — only
            // alphanumerics survive, so no separators and no `..` — and never
            // returns empty.
            PathBuf::from(path).join(slugify(&ws.name)),
            RootCreation::LeafInsideExistingParent,
        )),
    }
}

/// Create as much of `root` as `creation` allows. A `LeafInsideExistingParent`
/// root whose parent is missing is left alone here rather than reported:
/// `FsTaskProvider::ensure_root` surfaces the same `RootMissing` loudly the
/// moment a card is actually read or written, and this function's callers
/// (`tasks_watch_sync`, `start_session`) are best-effort by design.
pub fn ensure_root_if_ours(
    root: &std::path::Path,
    creation: RootCreation,
) -> std::io::Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    match creation {
        RootCreation::Always => std::fs::create_dir_all(root),
        RootCreation::LeafInsideExistingParent => match root.parent() {
            Some(p) if p.is_dir() => std::fs::create_dir(root),
            _ => Ok(()),
        },
        RootCreation::Never => Ok(()),
    }
}

fn workspace(state: &State<AppState>, id: &str) -> Result<Workspace, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    store
        .workspaces()
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("workspace not found: {id}"))
}

fn provider_for(ws: &Workspace) -> Result<FsTaskProvider, String> {
    let (root, creation) = resolve_root(ws).ok_or_else(|| "not-configured".to_string())?;
    Ok(FsTaskProvider::new(root, creation))
}

#[tauri::command]
pub fn tasks_capabilities(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Option<ProviderCapabilities>, String> {
    let ws = workspace(&state, &workspace_id)?;
    match provider_for(&ws) {
        Ok(p) => Ok(Some(p.capabilities())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn tasks_list(state: State<AppState>, workspace_id: String) -> Result<Vec<Task>, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    p.list(&ws.name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_create(
    state: State<AppState>,
    workspace_id: String,
    draft: TaskDraftInput,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    // project/origin/session are never taken from the caller: project is
    // always this workspace's name, and every card created through IPC is
    // human-created by definition (the `cowork_task` CLI is the only path
    // that produces `origin: Session`, and it writes files directly).
    let draft = TaskDraft {
        title: draft.title,
        kind: draft.kind,
        body: draft.body,
        project: ws.name.clone(),
        origin: TaskOrigin::Human,
        session: None,
    };
    p.create(draft).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_resolve(
    state: State<AppState>,
    workspace_id: String,
    id: String,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    p.resolve(&id).map_err(|e| e.to_string())
}

/// Open-card count per workspace id, for the sidebar badges. One call instead of
/// one per workspace, and a workspace whose root is broken contributes 0 rather
/// than failing the whole map.
#[tauri::command]
pub fn tasks_open_counts(state: State<AppState>) -> Result<std::collections::HashMap<String, usize>, String> {
    let all = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces()
    };
    let mut out = std::collections::HashMap::new();
    for ws in all {
        let Ok(p) = provider_for(&ws) else { continue };
        let n = match p.list(&ws.name) {
            Ok(cards) => cards
                .iter()
                .filter(|c| matches!(c.status, crate::tasks::model::TaskStatus::Open))
                .count(),
            Err(_) => continue,
        };
        out.insert(ws.id.clone(), n);
    }
    Ok(out)
}

/// Point the watcher set at every configured tracker root. Called by the
/// frontend at boot and after any workspace change, because a root can appear,
/// move, or disappear at runtime.
#[tauri::command]
pub fn tasks_watch_sync(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let all = {
        let store = state.store.lock().map_err(|_| "store lock".to_string())?;
        store.workspaces()
    };
    let wanted: Vec<(String, PathBuf)> = all
        .iter()
        .filter_map(|ws| {
            let (root, creation) = resolve_root(ws)?;
            // Best-effort: a create failure here does not stop the sync for
            // other workspaces. `FsTaskProvider::ensure_root` surfaces the
            // same failure loudly the moment a card is actually read/written.
            let _ = ensure_root_if_ours(&root, creation);
            Some((ws.id.clone(), root))
        })
        .collect();

    let handle = app.clone();
    state.watchers.sync(&wanted, move |workspace_id| {
        use tauri::Emitter;
        let _ = handle.emit("tasks://changed", TasksChanged { workspace_id });
    });
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TasksChanged {
    workspace_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{TrackerConfig, TrackerProvider, TrackerRoot, Workspace};
    use crate::tasks::fs::RootCreation;

    fn ws(tracker: Option<TrackerConfig>) -> Workspace {
        Workspace {
            id: "w1".into(),
            name: "cowork-deck".into(),
            path: "/home/u/proj".into(),
            color: "#61afef".into(),
            tracker,
        }
    }

    fn tracker(root: TrackerRoot) -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::Fs { root }],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        }
    }

    #[test]
    fn project_root_lives_inside_the_workspace_and_is_ours_to_create() {
        let w = ws(Some(tracker(TrackerRoot::Project)));
        let (root, creation) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/proj/.cowork/tasks"));
        assert_eq!(creation, RootCreation::Always);
    }

    #[test]
    fn an_external_root_gets_a_per_project_subfolder() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault/Tasks".into() })));
        let (root, creation) = resolve_root(&w).expect("configured");
        // One shared folder holding several projects is the whole reason this
        // exists: the cards go one level down, named for the project.
        assert_eq!(root, std::path::Path::new("/home/u/vault/Tasks/cowork-deck"));
        assert_eq!(creation, RootCreation::LeafInsideExistingParent);
    }

    #[test]
    fn the_subfolder_is_a_slug_so_a_workspace_name_cannot_escape_the_picked_folder() {
        // A workspace name is free text from a form. Joined verbatim, "../.."
        // would put the cards outside the folder the person picked.
        let mut w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        w.name = "../../etc".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/etc"));

        w.name = "My Project".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/my-project"));
    }

    #[test]
    fn no_tracker_is_a_legal_state_not_an_error() {
        assert!(resolve_root(&ws(None)).is_none());
        assert!(resolve_root(&ws(Some(TrackerConfig {
            providers: vec![],
            previous_location: None,
            version: crate::model::TRACKER_CONFIG_VERSION,
        })))
        .is_none());
    }

    #[test]
    fn ensure_root_if_ours_creates_a_project_root_but_never_a_path_root() {
        let dir = tempfile::tempdir().unwrap();

        let project_root = dir.path().join("proj").join(".cowork").join("tasks");
        ensure_root_if_ours(&project_root, RootCreation::Always).unwrap();
        assert!(project_root.is_dir(), "the in-project root is ours to create");

        // The picked folder exists, so its project subfolder is ours to make.
        let picked = dir.path().join("vault");
        std::fs::create_dir(&picked).unwrap();
        let leaf = picked.join("deck");
        ensure_root_if_ours(&leaf, RootCreation::LeafInsideExistingParent).unwrap();
        assert!(leaf.is_dir(), "a subfolder inside an existing parent is ours to make");
    }

    #[test]
    fn ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo() {
        let dir = tempfile::tempdir().unwrap();
        // This is the typo guarantee. If anyone "simplifies" the branch to
        // create_dir_all, this test is what fails.
        let leaf = dir.path().join("vualt").join("deck");
        ensure_root_if_ours(&leaf, RootCreation::LeafInsideExistingParent).unwrap();
        assert!(!leaf.exists(), "a typo'd parent must not be created");
        assert!(!dir.path().join("vualt").exists(), "nor its parent");

        let never = dir.path().join("cli-root");
        ensure_root_if_ours(&never, RootCreation::Never).unwrap();
        assert!(!never.exists(), "the CLI creates nothing");
    }

    #[test]
    fn task_draft_input_deserializes_from_exactly_what_the_frontend_sends() {
        let json = r#"{"title":"Fix the thing","kind":"bug","body":"details here"}"#;
        let draft: TaskDraftInput = serde_json::from_str(json).expect("must deserialize");
        assert_eq!(draft.title, "Fix the thing");
        assert!(matches!(draft.kind, crate::tasks::model::TaskKind::Bug));
        assert_eq!(draft.body, "details here");
    }

    #[test]
    fn task_draft_input_rejects_a_smuggled_origin_field() {
        // deny_unknown_fields: a payload that tries to claim `origin: session`
        // must fail to deserialize rather than silently drop the key — the
        // guarantee is that IPC cannot forge a card's origin at all.
        let json = r#"{"title":"t","kind":"bug","body":"b","origin":"session"}"#;
        let result: Result<TaskDraftInput, _> = serde_json::from_str(json);
        assert!(result.is_err(), "smuggled `origin` must be rejected, got {result:?}");
    }
}
