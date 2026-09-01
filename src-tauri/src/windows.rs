//! The labels this app's windows carry, and the handshake a new one must make
//! before anything is sent to it.
//!
//! Two separate things live here because both are about a window's identity and
//! both are easy to get wrong in a way nothing reports: what a label looks like,
//! and when a window is ready to be spoken to.

use std::collections::HashSet;
use std::sync::Mutex;
use tokio::sync::Notify;

/// The window the app opens with, and the only one that outlives every other.
pub const MAIN: &str = "main";

/// What a workspace window's label begins with.
///
/// A hyphen rather than a colon, and not for taste. `tauri-utils` documents a
/// window label as alphanumeric (`config.rs`, on `WindowConfig::label`), and the
/// capability documentation's own glob example is `admin-*` — so a hyphen is the
/// separator both halves of Tauri are known to accept. Workspace ids come from
/// `crypto.randomUUID()` (`src/workspaces.ts`), which is hex and hyphens, so the
/// whole label stays inside `[a-z0-9-]` and no escaping question ever arises.
///
/// Changing this string alone is not enough: `capabilities/default.json` names
/// the same shape as a glob, and a window whose label matches no capability can
/// `invoke` nothing at all. `the_capability_glob_matches_the_labels_we_mint`
/// below is what stops the two from drifting apart.
const WORKSPACE_PREFIX: &str = "workspace-";

/// The label for the window pinned to `workspace_id`.
pub fn workspace_label(workspace_id: &str) -> String {
    format!("{WORKSPACE_PREFIX}{workspace_id}")
}

/// The workspace a label names, or `None` if it names something else — the main
/// window, or anything added later.
pub fn workspace_id_of(label: &str) -> Option<&str> {
    label.strip_prefix(WORKSPACE_PREFIX).filter(|id| !id.is_empty())
}

/// Shrink a saved size to fit the display the window actually landed on.
///
/// `tauri-plugin-window-state` applies a remembered **position** only when some
/// monitor's rect intersects it, so a disconnected display degrades correctly —
/// but it applies the remembered **size** unconditionally (`lib.rs:211-217` in
/// the plugin). A window last sized on a 4K display therefore reopens 3840px
/// wide on a laptop, most of it past the edge of the screen and the close button
/// with it.
///
/// Clamping rather than rescaling: the person chose a size, and the only part of
/// that choice this can honour on a smaller display is "as much as fits".
pub fn clamp_to_work_area(size: (u32, u32), work_area: (u32, u32)) -> (u32, u32) {
    (size.0.min(work_area.0), size.1.min(work_area.1))
}

/// Which windows have announced themselves, and a way to wait for one.
///
/// Tauri's emit walks the webviews that currently hold a listener for that
/// event, so a target that does not exist yet — or has just gone — is a silent
/// no-op at both ends. **Creating a window is not the same as its JavaScript
/// having called `listen`**, and anything emitted in that gap is lost with no
/// error anywhere. The comment above the `session://waiting` emit in
/// `src/sessions.ts` records learning this the hard way — a window's first
/// report was dropped, and the only way back was to re-send on every render —
/// and it generalises to every window.
///
/// So a new window says when it is listening and the backend does not speak
/// before that. The shape is the one `AppState::scheduler_ready` already uses
/// for `schedule://fire`, whose first catch-up tick had the same problem; this
/// is that idea with more than one thing to wait for.
#[derive(Default)]
pub struct WindowReady {
    ready: Mutex<HashSet<String>>,
    /// Notified whenever the set grows. One for every label rather than one
    /// each: a waiter re-checks the set when it wakes, and what is being counted
    /// here is windows, of which there are a handful.
    changed: Notify,
}

impl WindowReady {
    /// Record that `label` has attached its listeners.
    pub fn mark(&self, label: &str) {
        self.ready.lock().unwrap().insert(label.to_string());
        self.changed.notify_waiters();
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.ready.lock().unwrap().contains(label)
    }

    /// Forget a window that has gone.
    ///
    /// On `Destroyed` rather than `CloseRequested`: the latter is preventable and
    /// also fires while the runtime tears everything down at quit, so a window
    /// that refused to close would be marked gone while still listening. A label
    /// can be reused — the same workspace pulled out twice — and the second
    /// window must not inherit the first one's readiness.
    pub fn forget(&self, label: &str) {
        self.ready.lock().unwrap().remove(label);
    }

    /// Wait until `label` has announced itself, or give up after `timeout`.
    ///
    /// Returns whether it announced itself. Giving up is not an error to show:
    /// the caller's choice is between speaking to a window that may not be
    /// listening and reporting that it could not open one, and only the caller
    /// knows which is worse.
    pub async fn wait_for(&self, label: &str, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Registered *before* the check, and this order is the whole
            // correctness of the loop: a `mark` landing between a check and a
            // registration wakes nobody, and the wait would then run to the
            // deadline for a window that came up immediately.
            let changed = self.changed.notified();
            if self.is_ready(label) {
                return true;
            }
            tokio::pin!(changed);
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_label_carries_its_workspace_and_gives_it_back() {
        let id = "3f2b1c4e-0a11-4c2d-9f77-1b2c3d4e5f60";
        let label = workspace_label(id);
        assert_eq!(workspace_id_of(&label), Some(id));
    }

    /// The main window must not be mistaken for a workspace window — parsing a
    /// label is what decides whether a window is pinned to one workspace or is
    /// the whole app.
    #[test]
    fn the_windows_that_are_not_workspaces_say_so() {
        assert_eq!(workspace_id_of(MAIN), None);
        // The bare prefix names no workspace, so it is not one either. Otherwise
        // an empty workspace id would mint a label that parses back to "".
        assert_eq!(workspace_id_of(WORKSPACE_PREFIX), None);
    }

    /// A window whose label matches no capability can `invoke` nothing at all —
    /// it renders and is completely inert, with nothing reported at either end.
    /// So the glob in the capability file and the prefix in this one have to be
    /// the same shape, and a test is the only thing that can hold two files to
    /// that.
    #[test]
    fn the_capability_glob_matches_the_labels_we_mint() {
        let capabilities = include_str!("../capabilities/default.json");
        let glob = format!("\"{WORKSPACE_PREFIX}*\"");
        assert!(
            capabilities.contains(&glob),
            "capabilities/default.json must list {glob} among its windows, or every \
             invoke from a workspace window fails silently",
        );
    }

    #[test]
    fn a_size_larger_than_the_display_is_cut_down_to_it() {
        assert_eq!(clamp_to_work_area((3840, 2160), (1512, 916)), (1512, 916));
    }

    /// The common case, and the one a clamp must not touch: a window that
    /// already fits keeps exactly the size the person left it at.
    #[test]
    fn a_size_that_fits_is_left_alone() {
        assert_eq!(clamp_to_work_area((1200, 800), (1512, 916)), (1200, 800));
    }

    /// Each dimension on its own — a tall window on a wide display is clamped in
    /// height and untouched in width.
    #[test]
    fn the_two_dimensions_are_clamped_independently() {
        assert_eq!(clamp_to_work_area((800, 2400), (1512, 916)), (800, 916));
    }

    #[tokio::test]
    async fn a_window_is_not_ready_until_it_says_so() {
        let ready = WindowReady::default();
        let label = workspace_label("w1");
        assert!(!ready.is_ready(&label));
        ready.mark(&label);
        assert!(ready.is_ready(&label));
    }

    #[tokio::test]
    async fn waiting_returns_as_soon_as_the_window_announces_itself() {
        let ready = std::sync::Arc::new(WindowReady::default());
        let label = workspace_label("w1");

        let marker = ready.clone();
        let marked = label.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            marker.mark(&marked);
        });

        assert!(ready.wait_for(&label, Duration::from_secs(5)).await);
    }

    /// A window that is already up is not waited for at all — the check comes
    /// before the first suspend, or opening a workspace that is already open
    /// would pause for the whole timeout.
    #[tokio::test]
    async fn waiting_for_a_window_that_is_already_ready_returns_at_once() {
        let ready = WindowReady::default();
        let label = workspace_label("w1");
        ready.mark(&label);
        assert!(ready.wait_for(&label, Duration::from_millis(0)).await);
    }

    /// The webview may fail to boot, and then nobody ever calls `window_ready`.
    /// Waiting for ever is the one outcome the caller cannot recover from.
    #[tokio::test]
    async fn waiting_gives_up_rather_than_hanging_for_ever() {
        let ready = WindowReady::default();
        assert!(!ready.wait_for("workspace-never", Duration::from_millis(20)).await);
    }

    /// A label is reused when the same workspace is pulled out a second time,
    /// and the new window has its own listeners to attach.
    #[tokio::test]
    async fn a_window_that_has_gone_is_not_ready_again() {
        let ready = WindowReady::default();
        let label = workspace_label("w1");
        ready.mark(&label);
        ready.forget(&label);
        assert!(!ready.is_ready(&label));
        assert!(!ready.wait_for(&label, Duration::from_millis(20)).await);
    }
}
