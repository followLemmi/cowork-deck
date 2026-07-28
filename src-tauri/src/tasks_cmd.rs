//! IPC surface of the tracker. Resolves a workspace id to a provider and keeps
//! every path/config decision on this side, so the frontend never learns that
//! cards are files.
use crate::commands::AppState;
use crate::model::{
    PreviousLocation, TrackerProvider, TrackerRoot, Workspace, TRACKER_CONFIG_VERSION,
};
use crate::tasks::frontmatter::slugify;
use crate::tasks::fs::{FsTaskProvider, RootCreation};
use crate::tasks::migrate::{apply, plan, MigrationPlan, MigrationReport};
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

/// The one folder cowork-deck creates inside a picked tracker path. Every
/// project's cards live in a subfolder of it, so pointing three workspaces at
/// one vault grows one directory there instead of three interleaved with
/// whatever the person keeps in it.
pub const TRACKER_CONTAINER: &str = "cowork-deck-tasks";

/// Where the cards go inside the folder the human picked.
///
/// Recognition is name-based on purpose. `resolve_root` runs on every list,
/// count and watcher sync, and asking the filesystem "does this folder look
/// like one of ours" would make all of them depend on a directory read that can
/// fail. A folder the person happens to have named `cowork-deck-tasks` is
/// treated as ours, which is the answer we would want anyway.
fn append_layout(picked: &std::path::Path, slug: &str) -> PathBuf {
    let name = picked.file_name().and_then(|s| s.to_str());
    // Already the project folder inside our container: this IS the root.
    if name == Some(slug)
        && picked.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str())
            == Some(TRACKER_CONTAINER)
    {
        return picked.to_path_buf();
    }
    // Already the container: only the project folder is missing.
    if name == Some(TRACKER_CONTAINER) {
        return picked.join(slug);
    }
    picked.join(TRACKER_CONTAINER).join(slug)
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
        TrackerProvider::Fs { root: TrackerRoot::Path { path } } => {
            let base = PathBuf::from(path);
            // Slugified, not joined verbatim: a workspace name is free text,
            // and `join("../..")` would put the cards outside the picked
            // folder entirely. `slugify` yields exactly one component and never
            // returns empty.
            let root = append_layout(&base, &slugify(&ws.name));
            Some((root, RootCreation::InsideExisting { base }))
        }
    }
}

/// Create as much of `root` as `creation` allows. An `InsideExisting` root whose
/// base is missing is left alone here rather than reported:
/// `FsTaskProvider::ensure_root` surfaces the same `RootMissing` loudly the
/// moment a card is actually read or written, and this function's callers
/// (`tasks_watch_sync`, `start_session`) are best-effort by design.
pub fn ensure_root_if_ours(
    root: &std::path::Path,
    creation: &RootCreation,
) -> std::io::Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    match creation {
        RootCreation::Always => std::fs::create_dir_all(root),
        RootCreation::InsideExisting { base } if base.is_dir() => std::fs::create_dir_all(root),
        RootCreation::InsideExisting { .. } => Ok(()),
        RootCreation::Never => Ok(()),
    }
}

/// A workspace's effective root as a string, or `None` with no tracker.
fn effective_root(ws: &Workspace) -> Option<String> {
    resolve_root(ws).map(|(root, _)| root.to_string_lossy().to_string())
}

/// Whether this workspace's cards live in the in-project root, where every card
/// is ours by construction.
fn is_project_root(ws: &Workspace) -> bool {
    matches!(
        ws.tracker.as_ref().and_then(|c| c.providers.first()),
        Some(TrackerProvider::Fs { root: TrackerRoot::Project })
    )
}

/// Stamp the config version and, when saving `new` moves the effective root,
/// record where the cards were so the board can offer to bring them along.
///
/// Pure: no filesystem and no store access. Whether any cards are actually at
/// the old root is the banner's question — asking it here would make saving a
/// workspace depend on a directory read that can fail.
pub fn with_previous_location(old: Option<&Workspace>, mut new: Workspace) -> Workspace {
    if let Some(cfg) = new.tracker.as_mut() {
        cfg.version = TRACKER_CONFIG_VERSION;
    }

    // Creating a workspace: there is no old root, and seeding one from a
    // freshly picked folder would offer to move cards nobody has filed yet.
    let Some(old) = old else { return new };

    // Turning the tracker off: nowhere to move cards to, so nothing to record.
    let Some(new_root) = effective_root(&new) else { return new };

    // An un-acted-on pointer wins over the old effective root. A seeded v1
    // config, or an earlier move nobody confirmed, still names where the cards
    // physically are; nothing was ever written to a root that was configured
    // and then left behind.
    let previous = match old.tracker.as_ref().and_then(|c| c.previous_location.clone()) {
        Some(pending) => pending,
        None => match effective_root(old) {
            Some(root) => PreviousLocation {
                root,
                project: old.name.clone(),
                was_project_root: is_project_root(old),
            },
            None => return new,
        },
    };

    // Configured back to where the cards already are: nothing to migrate.
    if previous.root == new_root {
        return new;
    }
    if let Some(cfg) = new.tracker.as_mut() {
        cfg.previous_location = Some(previous);
    }
    new
}

/// A `v: 1` config resolved an external root verbatim, so its cards sit
/// directly in the picked folder rather than in the project subfolder this
/// version resolves to. Seed that as the previous location, or updating the app
/// would empty the board with no explanation.
pub fn seed_previous_location(mut ws: Workspace) -> Workspace {
    let name = ws.name.clone();
    let Some(cfg) = ws.tracker.as_mut() else { return ws };
    if cfg.version >= TRACKER_CONFIG_VERSION || cfg.previous_location.is_some() {
        return ws;
    }
    let picked = match cfg.providers.first() {
        Some(TrackerProvider::Fs { root: TrackerRoot::Path { path } }) => path.clone(),
        // A project root did not move: `<ws.path>/.cowork/tasks` is what
        // version 1 resolved to as well.
        _ => return ws,
    };
    cfg.previous_location = Some(PreviousLocation {
        root: picked,
        project: name,
        was_project_root: false,
    });
    ws
}

/// Workspaces as the tracker sees them: a config written before
/// `TRACKER_CONFIG_VERSION` gets its previous location seeded. Normalizing here
/// rather than in `Store` keeps storage free of tracker semantics — and the
/// seed needs `ws.name`, which is not on `TrackerConfig` at all.
fn tracker_workspaces(state: &State<AppState>) -> Result<Vec<Workspace>, String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    Ok(store.workspaces().into_iter().map(seed_previous_location).collect())
}

fn workspace(state: &State<AppState>, id: &str) -> Result<Workspace, String> {
    tracker_workspaces(state)?
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
    let all = tracker_workspaces(&state)?;
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
    let all = tracker_workspaces(&state)?;
    let wanted: Vec<(String, PathBuf)> = all
        .iter()
        .filter_map(|ws| {
            let (root, creation) = resolve_root(ws)?;
            // Best-effort: a create failure here does not stop the sync for
            // other workspaces. `FsTaskProvider::ensure_root` surfaces the
            // same failure loudly the moment a card is actually read/written.
            let _ = ensure_root_if_ours(&root, &creation);
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

/// What the board needs to describe a pending move.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOffer {
    /// Both paths in full: the person picked them and needs to recognise them.
    pub from: String,
    pub to: String,
    pub moving: usize,
    pub leaving_foreign: usize,
    pub leaving_damaged: usize,
    /// Whether `project:` inside the moved cards will be rewritten, which is
    /// true exactly when the workspace has been renamed since the cards were
    /// written.
    pub renaming_project: bool,
}

/// Read the old root and describe what a move would do, or `None` when there is
/// nothing to offer.
///
/// `None` covers three different situations, and only one of them means the
/// pointer can be forgotten — see `clear_previous_location`'s caller.
pub fn offer_for(ws: &Workspace) -> Result<Option<(MigrationOffer, MigrationPlan)>, String> {
    let Some(previous) = ws.tracker.as_ref().and_then(|c| c.previous_location.clone()) else {
        return Ok(None);
    };
    let Some((to, _)) = resolve_root(ws) else { return Ok(None) };
    let from = PathBuf::from(&previous.root);

    // A missing old root is an unmounted volume as often as a deleted folder,
    // so it is not an error and not a resolved migration either: no offer now,
    // and the caller leaves the pointer alone so the banner returns with the
    // volume.
    if !from.is_dir() {
        return Ok(None);
    }

    // `Never`: reading the old root must not create it, least of all when it is
    // a mount point that happens to be empty right now.
    let old = FsTaskProvider::new(from.clone(), RootCreation::Never);
    let cards = old.scan().map_err(|e| e.to_string())?;
    let p = plan(&cards, &previous.project, previous.was_project_root);
    if p.moves.is_empty() {
        return Ok(None);
    }

    Ok(Some((
        MigrationOffer {
            from: previous.root.clone(),
            to: to.to_string_lossy().to_string(),
            moving: p.moves.len(),
            leaving_foreign: p.left_foreign,
            leaving_damaged: p.left_damaged,
            renaming_project: previous.project != ws.name,
        },
        p,
    )))
}

/// Forget where the cards were. Stamps the version too, or the next read would
/// re-seed a version 1 config and the banner would come back.
fn clear_previous_location(state: &State<AppState>, workspace_id: &str) -> Result<(), String> {
    let store = state.store.lock().map_err(|_| "store lock".to_string())?;
    let mut all = store.workspaces();
    let Some(w) = all.iter_mut().find(|w| w.id == workspace_id) else {
        return Ok(());
    };
    if let Some(cfg) = w.tracker.as_mut() {
        cfg.previous_location = None;
        cfg.version = TRACKER_CONFIG_VERSION;
    }
    store.save_workspaces(&all).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_migration_status(
    state: State<AppState>,
    workspace_id: String,
) -> Result<Option<MigrationOffer>, String> {
    let ws = workspace(&state, &workspace_id)?;
    let Some((offer, _)) = offer_for(&ws)? else {
        // Nothing of ours is at the old root any more, so the pointer has done
        // its job — but only when the folder is actually readable. A missing
        // root keeps its pointer: see `offer_for`.
        let has_pointer = ws
            .tracker
            .as_ref()
            .and_then(|c| c.previous_location.as_ref())
            .map(|p| PathBuf::from(&p.root).is_dir())
            .unwrap_or(false);
        if has_pointer {
            clear_previous_location(&state, &workspace_id)?;
        }
        return Ok(None);
    };
    Ok(Some(offer))
}

#[tauri::command]
pub fn tasks_migrate(
    state: State<AppState>,
    workspace_id: String,
) -> Result<MigrationReport, String> {
    let ws = workspace(&state, &workspace_id)?;
    let (root, creation) = resolve_root(&ws).ok_or_else(|| "not-configured".to_string())?;

    // Before planning anything: moving some cards and then discovering there is
    // nowhere to put the rest is worse than refusing up front.
    ensure_root_if_ours(&root, &creation).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err(crate::tasks::model::TaskError::RootMissing(
            root.to_string_lossy().to_string(),
        )
        .to_string());
    }

    let Some((_, p)) = offer_for(&ws)? else {
        return Ok(MigrationReport::default());
    };
    let previous_project = ws
        .tracker
        .as_ref()
        .and_then(|c| c.previous_location.as_ref())
        .map(|prev| prev.project.clone())
        .unwrap_or_default();
    let rename = (previous_project != ws.name).then_some(ws.name.as_str());

    let report = apply(&p, &root, rename);
    if report.is_complete() {
        clear_previous_location(&state, &workspace_id)?;
    }
    Ok(report)
}

#[tauri::command]
pub fn tasks_migration_dismiss(
    state: State<AppState>,
    workspace_id: String,
) -> Result<(), String> {
    clear_previous_location(&state, &workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{TrackerConfig, TrackerProvider, TrackerRoot, Workspace};
    use crate::tasks::fs::{FsTaskProvider, RootCreation};

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
    fn an_external_root_gets_a_container_and_a_project_folder() {
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let (root, creation) = resolve_root(&w).expect("configured");
        // One folder of ours in the person's space, not one per project.
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
        assert_eq!(creation, RootCreation::InsideExisting { base: "/home/u/vault".into() });
    }

    #[test]
    fn picking_the_container_itself_does_not_nest_a_second_one() {
        // The case that matters in practice: after the first migration the
        // container exists, so it is what the picker shows and what a person
        // naturally chooses. A rule that only appended would hand them
        // cowork-deck-tasks/cowork-deck-tasks/cowork-deck.
        let w = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks".into(),
        })));
        let (root, creation) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
        // The base is still the picked folder, so only the project level is ours.
        assert_eq!(
            creation,
            RootCreation::InsideExisting { base: "/home/u/vault/cowork-deck-tasks".into() },
        );
    }

    #[test]
    fn picking_the_project_folder_itself_resolves_to_it_unchanged() {
        // Re-pointing the tracker at the folder the board already reads must be
        // a no-op, not another doubling.
        let w = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks/cowork-deck".into(),
        })));
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/cowork-deck"));
    }

    #[test]
    fn a_folder_merely_sharing_the_project_name_is_an_ordinary_pick() {
        // Only `<container>/<slug>` counts as already-resolved. Without the
        // parent check, any folder named after the project would be mistaken
        // for one of ours and never get a container.
        let w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/cowork-deck".into() })));
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(
            root,
            std::path::Path::new("/home/u/cowork-deck/cowork-deck-tasks/cowork-deck"),
        );
    }

    #[test]
    fn the_subfolder_is_a_slug_so_a_workspace_name_cannot_escape_the_picked_folder() {
        // A workspace name is free text from a form. Joined verbatim, "../.."
        // would put the cards outside the folder the person picked.
        let mut w = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        w.name = "../../etc".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/etc"));

        w.name = "My Project".into();
        let (root, _) = resolve_root(&w).expect("configured");
        assert_eq!(root, std::path::Path::new("/home/u/vault/cowork-deck-tasks/my-project"));
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
    fn ensure_root_if_ours_creates_a_project_root_and_a_subtree_inside_a_picked_folder() {
        let dir = tempfile::tempdir().unwrap();

        let project_root = dir.path().join("proj").join(".cowork").join("tasks");
        ensure_root_if_ours(&project_root, &RootCreation::Always).unwrap();
        assert!(project_root.is_dir(), "the in-project root is ours to create");

        // The picked folder exists, so everything below it is ours — one level
        // today, two once the container lands, and this must not care which.
        let picked = dir.path().join("vault");
        std::fs::create_dir(&picked).unwrap();
        let deep = picked.join("container").join("deck");
        ensure_root_if_ours(&deep, &RootCreation::InsideExisting { base: picked.clone() }).unwrap();
        assert!(deep.is_dir(), "a subtree inside an existing base is ours to make");
    }

    #[test]
    fn ensure_root_if_ours_creates_nothing_when_the_picked_folder_is_a_typo() {
        let dir = tempfile::tempdir().unwrap();
        // The typo guarantee, now stated once for any depth. If anyone drops the
        // base check and calls create_dir_all unconditionally, this is what
        // fails.
        let base = dir.path().join("vualt");
        let leaf = base.join("cowork-deck-tasks").join("deck");
        ensure_root_if_ours(&leaf, &RootCreation::InsideExisting { base: base.clone() }).unwrap();
        assert!(!leaf.exists(), "a typo'd base must not be created");
        assert!(!base.exists(), "nor the base itself");

        let never = dir.path().join("cli-root");
        ensure_root_if_ours(&never, &RootCreation::Never).unwrap();
        assert!(!never.exists(), "the CLI creates nothing");
    }

    #[test]
    fn a_provider_refuses_to_read_a_root_whose_base_is_missing() {
        // ensure_root_if_ours is best-effort and silent; FsTaskProvider is the
        // half that has to be loud, and it is what the board surfaces.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("vualt");
        let root = base.join("deck");
        let p = FsTaskProvider::new(root, RootCreation::InsideExisting { base });
        assert!(p.scan().is_err(), "a missing base is RootMissing, not an empty list");
    }

    fn v1_external(path: &str) -> TrackerConfig {
        TrackerConfig {
            providers: vec![TrackerProvider::Fs { root: TrackerRoot::Path { path: path.into() } }],
            previous_location: None,
            version: 1,
        }
    }

    #[test]
    fn a_v1_external_config_is_seeded_with_the_picked_folder_itself() {
        // Version 1 resolved the picked folder verbatim, so that is where the
        // cards physically are. Without seeding, the board would silently go
        // empty the first time someone updated the app.
        let out = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        let prev = out.tracker.unwrap().previous_location.expect("seeded");
        assert_eq!(prev.root, "/home/u/vault/Tasks");
        assert_eq!(prev.project, "cowork-deck");
        assert!(!prev.was_project_root);
    }

    #[test]
    fn a_v1_project_config_is_not_seeded_because_its_path_did_not_move() {
        let mut cfg = tracker(TrackerRoot::Project);
        cfg.version = 1;
        let out = seed_previous_location(ws(Some(cfg)));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn a_current_config_is_left_alone_by_seeding() {
        let out = seed_previous_location(ws(Some(tracker(
            TrackerRoot::Path { path: "/home/u/vault/Tasks".into() },
        ))));
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn moving_the_root_records_where_the_cards_were() {
        let old = ws(Some(tracker(TrackerRoot::Project)));
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("recorded");
        assert_eq!(prev.root, "/home/u/proj/.cowork/tasks");
        assert_eq!(prev.project, "cowork-deck");
        assert!(prev.was_project_root, "damaged cards come along from our own folder");
    }

    #[test]
    fn renaming_the_workspace_records_the_old_name_and_the_old_root() {
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let mut new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        new.name = "deck".into();
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("recorded");
        // The folder is named for the project, so a rename moves the root too.
        assert_eq!(prev.root, "/home/u/vault/cowork-deck-tasks/cowork-deck");
        assert_eq!(prev.project, "cowork-deck");
    }

    #[test]
    fn saving_without_moving_the_root_records_nothing() {
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let mut new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        new.color = "#98c379".into();
        let out = with_previous_location(Some(&old), new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn creating_a_workspace_records_nothing() {
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(None, new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn an_unmoved_pending_pointer_wins_over_the_old_effective_root() {
        // The cards are at the seeded location, not at the root the old config
        // resolved to — nothing was ever written to a root that was configured
        // and then left behind. Overwriting the pointer here would send the
        // migration looking in an empty folder.
        let old = seed_previous_location(ws(Some(v1_external("/home/u/vault/Tasks"))));
        let new = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/other".into() })));
        let out = with_previous_location(Some(&old), new);
        let prev = out.tracker.unwrap().previous_location.expect("carried forward");
        assert_eq!(prev.root, "/home/u/vault/Tasks");
    }

    #[test]
    fn moving_back_to_where_the_cards_are_clears_the_pointer() {
        // The cards are at /home/u/vault/cowork-deck-tasks/tasks, and pointing
        // the tracker straight at that folder resolves to it unchanged — the
        // third recognition case. There is nothing to migrate.
        let old = seed_previous_location(ws(Some(v1_external(
            "/home/u/vault/cowork-deck-tasks/tasks",
        ))));
        let mut new = ws(Some(tracker(TrackerRoot::Path {
            path: "/home/u/vault/cowork-deck-tasks/tasks".into(),
        })));
        new.name = "Tasks".into();
        let out = with_previous_location(Some(&old), new);
        assert!(out.tracker.unwrap().previous_location.is_none());
    }

    #[test]
    fn every_save_stamps_the_current_config_version() {
        // A dismissed banner must not come back on the next read, which is only
        // true while every persisting path leaves v at the current value.
        let out = with_previous_location(None, ws(Some(v1_external("/home/u/vault/Tasks"))));
        assert_eq!(out.tracker.unwrap().version, TRACKER_CONFIG_VERSION);
    }

    /// A workspace whose external root is `dir`, with `previous_location`
    /// pointing at `old` as a folder the cards were never moved out of.
    fn ws_with_previous(dir: &std::path::Path, name: &str, old: &std::path::Path) -> Workspace {
        Workspace {
            id: "w1".into(),
            name: name.into(),
            path: "/home/u/proj".into(),
            color: "#61afef".into(),
            tracker: Some(TrackerConfig {
                providers: vec![TrackerProvider::Fs {
                    root: TrackerRoot::Path { path: dir.to_string_lossy().to_string() },
                }],
                previous_location: Some(PreviousLocation {
                    root: old.to_string_lossy().to_string(),
                    project: "cowork-deck".into(),
                    was_project_root: false,
                }),
                version: TRACKER_CONFIG_VERSION,
            }),
        }
    }

    fn write_card(dir: &std::path::Path, id: &str, project: &str) {
        std::fs::write(
            dir.join(format!("{id}-t.md")),
            format!("---\nid: {id}\ntitle: t\nkind: task\nstatus: open\nproject: {project}\ncreated: c\norigin: human\n---\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn offer_counts_what_moves_and_what_stays() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Tasks");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01A", "cowork-deck");
        write_card(&old, "01B", "cowork-deck");
        write_card(&old, "01C", "other-project");

        let ws = ws_with_previous(dir.path(), "cowork-deck", &old);
        let (offer, _) = offer_for(&ws).expect("readable").expect("an offer");

        assert_eq!(offer.moving, 2);
        assert_eq!(offer.leaving_foreign, 1);
        assert_eq!(offer.from, old.to_string_lossy());
        assert_eq!(
            offer.to,
            dir.path().join("cowork-deck-tasks").join("cowork-deck").to_string_lossy(),
        );
        assert!(!offer.renaming_project);
    }

    #[test]
    fn offer_says_project_gets_rewritten_after_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("cowork-deck");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01A", "cowork-deck");

        // previous_location.project is "cowork-deck", the workspace is now "deck".
        let ws = ws_with_previous(dir.path(), "deck", &old);
        let (offer, _) = offer_for(&ws).expect("readable").expect("an offer");

        assert!(offer.renaming_project, "cards still name the old project");
        assert_eq!(offer.moving, 1);
    }

    #[test]
    fn there_is_no_offer_when_the_old_root_holds_nothing_of_ours() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("Tasks");
        std::fs::create_dir_all(&old).unwrap();
        write_card(&old, "01C", "other-project");

        let ws = ws_with_previous(dir.path(), "cowork-deck", &old);
        assert!(offer_for(&ws).expect("readable").is_none());
    }

    #[test]
    fn a_missing_old_root_yields_no_offer_but_is_not_an_error() {
        // An unmounted volume, not a resolved migration. The caller must not
        // clear the pointer on this — the folder can come back.
        let dir = tempfile::tempdir().unwrap();
        let ws = ws_with_previous(dir.path(), "cowork-deck", &dir.path().join("gone"));
        assert!(offer_for(&ws).expect("not an error").is_none());
    }

    #[test]
    fn there_is_no_offer_without_a_previous_location() {
        let ws = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        assert!(offer_for(&ws).expect("readable").is_none());
    }

    #[test]
    fn turning_the_tracker_off_records_nothing() {
        // There is nowhere to move cards to, so a pointer would describe a
        // migration that can never be offered.
        let old = ws(Some(tracker(TrackerRoot::Path { path: "/home/u/vault".into() })));
        let out = with_previous_location(Some(&old), ws(None));
        assert!(out.tracker.is_none());
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
