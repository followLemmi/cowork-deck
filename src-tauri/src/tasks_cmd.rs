//! IPC surface of the tracker. Resolves a workspace id to a provider and keeps
//! every path/config decision on this side, so the frontend never learns that
//! cards are files.
use crate::commands::AppState;
use crate::model::{TrackerProvider, TrackerRoot, Workspace};
use crate::tasks::fs::FsTaskProvider;
use crate::tasks::model::{Task, TaskDraft};
use crate::tasks::provider::{ProviderCapabilities, TaskProvider};
use std::path::PathBuf;
use tauri::State;

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
    draft: TaskDraft,
) -> Result<Task, String> {
    let ws = workspace(&state, &workspace_id)?;
    let p = provider_for(&ws)?;
    // The caller does not get to pick the project: it is always this
    // workspace's name, so a shared root stays sortable by project.
    let draft = TaskDraft { project: ws.name.clone(), ..draft };
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
}
