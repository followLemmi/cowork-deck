//! Directory watching. Deliberately thin: all logic that can be tested without
//! a real filesystem lives in `debounce_keys`/`is_card_path`. A watcher that
//! fails to start is not an error — the board polls anyway, so the only
//! consequence is latency.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(200);

/// Distinct workspace ids from a burst of events, in first-seen order.
pub fn debounce_keys(burst: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in burst {
        if !out.iter().any(|s| s == k) {
            out.push(k.clone());
        }
    }
    out
}

/// Only `.md` files are cards; our temp files end in `.tmp` and must not wake
/// the UI mid-write.
pub fn is_card_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
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
    pub fn sync<F>(&self, wanted: &[(String, PathBuf)], on_change: F)
    where
        F: Fn(String) + Send + Clone + 'static,
    {
        let Ok(mut map) = self.inner.lock() else { return };
        map.retain(|id, (root, _)| wanted.iter().any(|(w, r)| w == id && r == root));

        for (id, root) in wanted {
            if map.contains_key(id) { continue; }
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
            std::thread::spawn(move || {
                // Coalesce a burst into a single notification: an editor save
                // is several events, and the UI only needs to know "reload".
                while let Ok(first) = rx.recv() {
                    let mut hits = match first {
                        Ok(ev) => ev.paths.iter().filter(|p| is_card_path(p)).count(),
                        Err(_) => 0,
                    };
                    let deadline = std::time::Instant::now() + DEBOUNCE;
                    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                        match rx.recv_timeout(left) {
                            Ok(Ok(ev)) => hits += ev.paths.iter().filter(|p| is_card_path(p)).count(),
                            Ok(Err(_)) => {}
                            Err(_) => break,
                        }
                    }
                    if hits > 0 {
                        cb(id_for_thread.clone());
                    }
                }
            });

            map.insert(id.clone(), (root.clone(), watcher));
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
    fn collapses_repeated_workspace_ids_preserving_first_seen_order() {
        let got = debounce_keys(&["w2".into(), "w1".into(), "w2".into(), "w2".into()]);
        assert_eq!(got, vec!["w2".to_string(), "w1".to_string()]);
    }

    #[test]
    fn empty_burst_yields_nothing() {
        assert!(debounce_keys(&[]).is_empty());
    }

    #[test]
    fn ignores_temp_and_non_markdown_paths() {
        assert!(!is_card_path(std::path::Path::new("/r/.01ABC.md.tmp")));
        assert!(!is_card_path(std::path::Path::new("/r/readme.txt")));
        assert!(is_card_path(std::path::Path::new("/r/01ABC-slug.md")));
    }
}
