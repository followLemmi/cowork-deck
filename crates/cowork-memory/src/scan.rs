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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
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
        let Ok(md) = entry.metadata() else { continue };
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
}
