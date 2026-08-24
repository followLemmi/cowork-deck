//! Directory watching. Deliberately thin: the logic that can be tested
//! without a real filesystem — deciding whether a path is a card
//! (`is_card_path`) and counting how many paths in a burst are cards
//! (`card_hits`) — is pulled out into pure functions the watcher thread
//! actually calls. The thread's debounce loop itself (a fixed 200ms deadline
//! that coalesces a burst of events into one notification) is not covered by
//! a test: it always terminates because the deadline is fixed rather than
//! sliding, but a real-inotify end-to-end test would be flaky, so that
//! property is verified by reasoning, not by a test. A watcher that fails to
//! start is not an error — the board polls anyway, so the only consequence
//! is latency.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(200);

/// Only `.md` files are cards; our temp files end in `.tmp` and must not wake
/// the UI mid-write.
pub fn is_card_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
}

/// Count of paths in a burst that are cards — the filter the watcher thread
/// applies to every batch of filesystem events it drains.
pub fn card_hits(paths: &[PathBuf]) -> usize {
    paths.iter().filter(|p| is_card_path(p)).count()
}

/// One watcher per watched root, rebuilt whenever the workspace set changes.
pub struct TaskWatchers {
    inner: Mutex<HashMap<String, (PathBuf, RecommendedWatcher)>>,
}

impl TaskWatchers {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }

    /// Make the live watcher set match `wanted` (workspace id -> root). Roots
    /// that vanished are dropped; new ones get a watcher. Failing to watch one
    /// root never affects the others.
    ///
    /// All blocking IO — `is_dir`, watcher creation, `inotify_add_watch` via
    /// `.watch()`, and spawning the drain thread — happens outside the map
    /// lock. The lock is only taken twice, briefly: once to snapshot which
    /// roots are already watched, and once at the end to retain stale entries
    /// and insert the newly built ones. A mutex held across blocking IO is
    /// exactly the bug this repo shipped once already with a stuck session
    /// stalling shutdown; this method must not repeat it.
    pub fn sync<F>(&self, wanted: &[(String, PathBuf)], on_change: F)
    where
        F: Fn(String) + Send + Clone + 'static,
    {
        let already_watched: Vec<(String, PathBuf)> = {
            let Ok(map) = self.inner.lock() else { return };
            map.iter().map(|(id, (root, _))| (id.clone(), root.clone())).collect()
        };

        let mut to_add: Vec<(String, PathBuf, RecommendedWatcher)> = Vec::new();
        for (id, root) in wanted {
            if already_watched.iter().any(|(w, r)| w == id && r == root) { continue; }
            if !root.is_dir() { continue; }
            let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
            let Ok(mut watcher) = RecommendedWatcher::new(tx, notify::Config::default()) else {
                continue;
            };
            if watcher.watch(root, RecursiveMode::NonRecursive).is_err() {
                continue;
            }

            let id_for_thread = id.clone();
            let cb = on_change.clone();
            let spawned = std::thread::Builder::new().spawn(move || {
                // Coalesce a burst into a single notification: an editor save
                // is several events, and the UI only needs to know "reload".
                while let Ok(first) = rx.recv() {
                    let mut hits = match first {
                        Ok(ev) => card_hits(&ev.paths),
                        Err(_) => 0,
                    };
                    let deadline = std::time::Instant::now() + DEBOUNCE;
                    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                        match rx.recv_timeout(left) {
                            Ok(Ok(ev)) => hits += card_hits(&ev.paths),
                            Ok(Err(_)) => {}
                            Err(_) => break,
                        }
                    }
                    if hits > 0 {
                        cb(id_for_thread.clone());
                    }
                }
            });
            if spawned.is_err() {
                // Thread-creation failure joins the same per-root isolation
                // path as every other failure mode here: skip this root,
                // leave the others unaffected.
                continue;
            }

            to_add.push((id.clone(), root.clone(), watcher));
        }

        let Ok(mut map) = self.inner.lock() else { return };
        map.retain(|id, (root, _)| wanted.iter().any(|(w, r)| w == id && r == root));
        for (id, root, watcher) in to_add {
            // If a concurrent sync already inserted this id (only possible if
            // `sync` is ever called concurrently with itself, which today's
            // single synchronous caller does not do), drop the redundant
            // watcher rather than clobber the existing one. Its channel
            // closes and its thread exits on its own.
            map.entry(id).or_insert((root, watcher));
        }
    }
}

impl Default for TaskWatchers {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_temp_and_non_markdown_paths() {
        assert!(!is_card_path(std::path::Path::new("/r/.01ABC.md.tmp")));
        assert!(!is_card_path(std::path::Path::new("/r/readme.txt")));
        assert!(is_card_path(std::path::Path::new("/r/01ABC-slug.md")));
    }

    #[test]
    fn card_hits_of_empty_burst_is_zero() {
        assert_eq!(card_hits(&[]), 0);
    }

    #[test]
    fn card_hits_counts_only_the_markdown_paths_in_a_mixed_burst() {
        let paths = vec![
            PathBuf::from("/r/01ABC-slug.md"),
            PathBuf::from("/r/.01ABC.md.tmp"),
            PathBuf::from("/r/readme.txt"),
        ];
        assert_eq!(card_hits(&paths), 1);
    }

    #[test]
    fn card_hits_counts_every_markdown_path_not_just_whether_any_exist() {
        let paths = vec![
            PathBuf::from("/r/a.md"),
            PathBuf::from("/r/b.md"),
            PathBuf::from("/r/c.md"),
        ];
        assert_eq!(card_hits(&paths), 3);
    }
}
