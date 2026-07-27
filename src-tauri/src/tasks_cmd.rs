//! IPC surface of the tracker. Resolves a workspace id to a provider and keeps
//! every path/config decision on this side, so the frontend never learns that
//! cards are files.
use crate::commands::AppState;
use crate::model::{TrackerProvider, TrackerRoot, Workspace};
use crate::tasks::fs::FsTaskProvider;
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

/// The provider root for a workspace, plus whether we may create it.
/// `None` means "no tracker configured" — a legal, non-error state.
pub fn resolve_root(ws: &Workspace) -> Option<(PathBuf, bool)> {
    let cfg = ws.tracker.as_ref()?;
    let first = cfg.providers.first()?;
    match first {
        TrackerProvider::Fs { root: TrackerRoot::Project } => {
            Some((PathBuf::from(&ws.path).join(".cowork").join("tasks"), true))
        }
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => {
            Some((PathBuf::from(path), false))
        }
    }
}

/// Create `root` only when `create` is true — the flag `resolve_root` returns
/// for the in-project `.cowork/tasks` path. A user-supplied path (`create:
/// false`) is never created here: an arbitrary typo'd path must surface as an
/// error the first time something tries to read or write a card, not scatter
/// an empty folder into place.
///
/// Called from `tasks_watch_sync` (so a watcher can attach to a fresh
/// project) and from `start_session` (so `cowork_task` has somewhere to write
/// on a workspace's very first ticket) — both call sites that hand out a
/// project-kind root before anything has necessarily created it yet.
pub fn ensure_root_if_ours(root: &std::path::Path, create: bool) -> std::io::Result<()> {
    if create { std::fs::create_dir_all(root) } else { Ok(()) }
}

fn workspace(state: &State<AppState>, id: &str) -> Result<Workspace, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    store
        .workspaces()
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("пространство не найдено: {id}"))
}

fn provider_for(ws: &Workspace) -> Result<FsTaskProvider, String> {
    let (root, create) = resolve_root(ws).ok_or_else(|| "not-configured".to_string())?;
    Ok(FsTaskProvider::new(root, create))
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
            let (root, create) = resolve_root(ws)?;
            // Best-effort: a create failure here does not stop the sync for
            // other workspaces. `FsTaskProvider::ensure_root` surfaces the
            // same failure loudly the moment a card is actually read/written.
            let _ = ensure_root_if_ours(&root, create);
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

    fn ws(tracker: Option<TrackerConfig>) -> Workspace {
        Workspace {
            id: "w1".into(),
            name: "cowork-deck".into(),
            path: "/home/u/proj".into(),
            color: "#61afef".into(),
            tracker,
        }
    }

    #[test]
    fn project_root_lives_inside_the_workspace_and_is_ours_to_create() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Project }],
        }));
        let (root, create) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/proj/.cowork/tasks"));
        assert!(create);
    }

    #[test]
    fn external_root_is_used_verbatim_and_never_created() {
        let w = ws(Some(TrackerConfig {
            providers: vec![TrackerProvider::Fs {
                root: TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
            }],
        }));
        let (root, create) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/Tasks"));
        assert!(!create);
    }

    #[test]
    fn no_tracker_is_a_legal_state_not_an_error() {
        assert!(resolve_root(&ws(None)).is_none());
        assert!(resolve_root(&ws(Some(TrackerConfig { providers: vec![] }))).is_none());
    }

    #[test]
    fn ensure_root_if_ours_creates_a_project_root_but_never_a_path_root() {
        let dir = tempfile::tempdir().unwrap();

        let project_root = dir.path().join("proj").join(".cowork").join("tasks");
        ensure_root_if_ours(&project_root, true).unwrap();
        assert!(project_root.is_dir(), "the in-project root is ours to create");

        let path_root = dir.path().join("vault").join("Tasks");
        ensure_root_if_ours(&path_root, false).unwrap();
        assert!(!path_root.exists(), "a user-supplied path must never be created silently");
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
