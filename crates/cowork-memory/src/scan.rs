use crate::DIARY_SCOPE;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileStat {
    pub mtime: f64,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub scope: String,
    pub room: Option<String>,
}

/// Scope of a note from its position in the memory layout.
pub fn detect_scope(rel_path: &str) -> Option<Located> {
    let parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    if parts[0] == "Diaries" {
        if parts.len() < 3 {
            return None;
        }
        return Some(Located {
            scope: DIARY_SCOPE.to_string(),
            room: Some(parts[1].to_string()),
        });
    }
    Some(Located {
        scope: parts[0].to_string(),
        room: None,
    })
}

/// Every indexable `.md` file under `root`, keyed by slash-separated relative path.
pub fn scan(root: &Path) -> BTreeMap<String, FileStat> {
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, FileStat>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            // Best-effort: a bad subtree must not fail the whole scan, but it
            // must leave a trace. A silently incomplete index is the worst
            // failure mode — indistinguishable from an empty corpus.
            eprintln!("cowork_memory: skipping {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // DirEntry::file_type does not follow symlinks, unlike Path::is_dir.
        // Skipping links keeps the walk inside the corpus (no escape) and
        // makes a symlink loop impossible (no unbounded recursion).
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                eprintln!("cowork_memory: skipping {}: {e}", path.display());
                continue;
            }
        };
        if ft.is_symlink() {
            eprintln!("cowork_memory: skipping symlink {}", path.display());
            continue;
        }
        if ft.is_dir() {
            walk(root, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if detect_scope(&rel).is_none() {
            continue;
        }
        let md = match entry.metadata() {
            Ok(md) => md,
            Err(e) => {
                eprintln!("cowork_memory: skipping {}: {e}", path.display());
                continue;
            }
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        out.insert(rel, FileStat { mtime, size: md.len() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_scope_from_layout() {
        let d = detect_scope("Diaries/code-reviewer/2026-07.md").unwrap();
        assert_eq!(d.scope, crate::DIARY_SCOPE);
        assert_eq!(d.room.as_deref(), Some("code-reviewer"));

        let s = detect_scope("ws-42/Sessions/2026-07/27-topic.md").unwrap();
        assert_eq!(s.scope, "ws-42");
        assert_eq!(s.room, None);

        let f = detect_scope("ws-42/Facts.md").unwrap();
        assert_eq!(f.scope, "ws-42");

        assert!(detect_scope("Diaries/2026-07.md").is_none(), "diary needs a room");
        assert!(detect_scope("loose.md").is_none(), "top-level files have no scope");
    }

    #[test]
    fn scan_finds_markdown_and_skips_dotdirs_and_json() {
        let root = std::env::temp_dir().join(format!("cwm-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("ws-1/Sessions/2026-07")).unwrap();
        fs::create_dir_all(root.join(".index")).unwrap();
        fs::write(root.join("ws-1/Sessions/2026-07/27-a.md"), "# a\n").unwrap();
        fs::write(root.join("ws-1/Facts.md"), "# f\n").unwrap();
        fs::write(root.join("queue.json"), "[]").unwrap();
        fs::write(root.join(".index/meta.json"), "{}").unwrap();

        let files = scan(&root);
        let mut keys: Vec<_> = files.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["ws-1/Facts.md", "ws-1/Sessions/2026-07/27-a.md"]);
        assert!(files["ws-1/Facts.md"].size > 0);

        fs::remove_dir_all(&root).unwrap();
    }

    /// A symlink loop would recurse forever and a symlink out of the corpus
    /// would index foreign content under a path that looks legitimate. Neither
    /// may happen. Unix-only because creating symlinks on Windows needs
    /// elevation.
    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let tag = std::process::id();
        let root = std::env::temp_dir().join(format!("cwm-scan-link-{tag}"));
        let outside = std::env::temp_dir().join(format!("cwm-scan-outside-{tag}"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(root.join("ws-1")).unwrap();
        fs::create_dir_all(outside.join("ws-9")).unwrap();
        fs::write(root.join("ws-1/Facts.md"), "# inside\n").unwrap();
        fs::write(outside.join("ws-9/Facts.md"), "# outside\n").unwrap();

        symlink(&root, root.join("ws-1/loop")).unwrap();   // loop back to the root
        symlink(&outside, root.join("ws-2")).unwrap();     // escape out of the corpus

        // Terminating at all is half the assertion.
        let files = scan(&root);
        let keys: Vec<_> = files.keys().cloned().collect();
        assert_eq!(keys, vec!["ws-1/Facts.md"], "symlinks must not be followed");

        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
