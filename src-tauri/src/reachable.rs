//! Which directories a command taking a path from the frontend may act on.
//!
//! Four commands take a path and run something with it: `git_status`,
//! `git_changes` and `worktree_files` run `git -C <path>`, and `reveal_path`
//! hands a file to the platform's file manager. Each took whatever it was given
//! (#463) — `reveal_path` would open any existing file on the disk, and the three
//! `git` ones would run against any directory.
//!
//! **What this is and is not.** It is not a sandbox: this app launches the
//! person's own `claude` with the person's own permissions, and a session can
//! read anything they can. The capability model is theirs, and narrowing it here
//! would be theatre. What this narrows is the *IPC surface*: the set of paths the
//! webview — which renders a pull request's description, an issue's body and a
//! model's prose — can name and have acted upon. The tray panel is a second
//! window onto the same commands, so the surface is wider than one window's.
//!
//! **The roots need no bookkeeping**, which is why this is derivable rather than
//! a list to keep in step. A session's working directory is a workspace's folder
//! or a worktree beside it, and the worktree paths are deterministic siblings —
//! `<parent>/<name>-pr/…` and `<parent>/<name>-issue/…` (see
//! `gh_pr::worktree_path` and `gh_issues::issue_worktree_path`). So the whole
//! answer comes from the workspace paths already in the store.
//!
//! **Lexical, not canonical.** A path is normalised by resolving `.` and `..`
//! textually, and a relative path is refused outright. Canonicalising would be
//! stronger against a symlink pointing out of a root, and it is not available:
//! `reveal_path` is asked about files that may have been deleted between the
//! render and the click, and refusing those as unreachable rather than as
//! missing would report the wrong fault. A symlink inside a workspace pointing
//! elsewhere is reachable, and so it should be — the person put it there.

use std::path::{Component, Path, PathBuf};

/// The directories a path may be under.
pub struct Roots(Vec<PathBuf>);

impl Roots {
    /// Every workspace folder, plus the `-pr` and `-issue` siblings beside each.
    ///
    /// The siblings are added whether or not they exist: a worktree is created
    /// on demand, and a check that ran before the first one would refuse the
    /// session it had just launched.
    pub fn worktrees<'a>(workspace_paths: impl IntoIterator<Item = &'a str>) -> Self {
        let mut roots = Vec::new();
        for path in workspace_paths {
            let path = path.trim();
            if path.is_empty() {
                continue;
            }
            let ws = Path::new(path);
            if let (Some(name), Some(parent)) = (ws.file_name(), ws.parent()) {
                let name = name.to_string_lossy();
                roots.push(parent.join(format!("{name}-pr")));
                roots.push(parent.join(format!("{name}-issue")));
            }
            roots.push(ws.to_path_buf());
        }
        Self(roots)
    }

    /// The same, plus the two directories a file worth revealing also lives in:
    /// this app's own config directory (a note, a scenario file, the journal)
    /// and Claude Code's project directory, which is where every transcript is.
    ///
    /// `~/.claude/projects` rather than a directory derived from the workspace:
    /// a transcript moves when a session enters a worktree, and `find_transcript`
    /// in `commands.rs` already scans that directory for the same reason.
    pub fn revealable<'a>(
        workspace_paths: impl IntoIterator<Item = &'a str>,
        config_dir: &Path,
    ) -> Self {
        let mut roots = Self::worktrees(workspace_paths);
        roots.0.push(config_dir.to_path_buf());
        if let Some(home) = std::env::var_os("HOME") {
            roots.0.push(PathBuf::from(home).join(".claude").join("projects"));
        }
        roots
    }

    /// Whether `path` is one of the roots or sits under one.
    pub fn contains(&self, path: &str) -> bool {
        let Some(path) = normalise(Path::new(path)) else { return false };
        self.0.iter().filter_map(|r| normalise(r)).any(|root| path.starts_with(&root))
    }
}

/// Resolve `.` and `..` textually. `None` for a relative path, and for one whose
/// `..` climbs above the root — both are answers no caller should turn into a
/// prefix comparison.
fn normalise(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    let mut rooted = false;
    for part in path.components() {
        match part {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => {
                rooted = true;
                out.push(Component::RootDir.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop` on a path that is only a root returns false, which is a
                // `..` above `/`.
                if !out.pop() {
                    return None;
                }
            }
            Component::Normal(c) => out.push(c),
        }
    }
    if rooted {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: [&str; 1] = ["/home/u/projects/cowork-deck"];

    #[test]
    fn a_workspace_and_everything_under_it_is_reachable() {
        let roots = Roots::worktrees(WS);
        assert!(roots.contains("/home/u/projects/cowork-deck"));
        assert!(roots.contains("/home/u/projects/cowork-deck/src/app.ts"));
    }

    /// The two siblings, which is where a session launched from a pull request
    /// or an issue actually runs — beside the workspace, never inside it.
    #[test]
    fn the_worktree_siblings_are_reachable() {
        let roots = Roots::worktrees(WS);
        assert!(roots.contains("/home/u/projects/cowork-deck-pr/42-feat-nice-thing"));
        assert!(roots.contains("/home/u/projects/cowork-deck-issue/7-a-bug"));
    }

    /// A sibling directory whose name merely *starts* with the workspace's.
    /// `starts_with` on a `Path` compares components, not bytes, which is what
    /// makes this false rather than true.
    #[test]
    fn a_neighbour_with_a_longer_name_is_not_reachable() {
        let roots = Roots::worktrees(WS);
        assert!(!roots.contains("/home/u/projects/cowork-deck-private/secrets"));
        assert!(!roots.contains("/home/u/projects/cowork-deck2"));
    }

    #[test]
    fn somewhere_else_entirely_is_not_reachable() {
        let roots = Roots::worktrees(WS);
        assert!(!roots.contains("/etc/passwd"));
        assert!(!roots.contains("/home/u/.ssh/id_ed25519"));
        assert!(!roots.contains("/home/u/projects"));
    }

    /// The whole reason the comparison is on a normalised path: a prefix check
    /// against the raw string would have accepted this.
    #[test]
    fn a_dot_dot_cannot_climb_out_of_a_workspace() {
        let roots = Roots::worktrees(WS);
        assert!(!roots.contains("/home/u/projects/cowork-deck/../../.ssh/id_ed25519"));
        assert!(!roots.contains("/home/u/projects/cowork-deck/../.ssh/id_ed25519"));
        // And one that climbs out and back in is the workspace again.
        assert!(roots.contains("/home/u/projects/cowork-deck/src/../src/app.ts"));
    }

    #[test]
    fn a_relative_path_is_refused_rather_than_resolved() {
        let roots = Roots::worktrees(WS);
        assert!(!roots.contains("src/app.ts"));
        assert!(!roots.contains(""));
        assert!(!roots.contains("../../etc/passwd"));
    }

    /// An empty workspace path contributes no root, rather than a root of `/` or
    /// of the current directory — either would open the whole disk.
    #[test]
    fn an_empty_workspace_path_opens_nothing() {
        let roots = Roots::worktrees(["", "   "]);
        assert!(!roots.contains("/etc/passwd"));
        assert!(!roots.contains("/"));
    }

    #[test]
    fn the_config_directory_and_the_transcripts_are_revealable() {
        let config = PathBuf::from("/home/u/.config/cowork-deck");
        let roots = Roots::revealable(WS, &config);
        assert!(roots.contains("/home/u/.config/cowork-deck/deck/Sessions/2026-08/31-a-note.md"));
        // Still not the neighbour, and still not the workspace's parent.
        assert!(!roots.contains("/home/u/.config/other-app/secrets.json"));
    }

    /// Set on this process rather than assumed, so the test says the same thing
    /// on a machine whose `HOME` is somewhere unusual.
    #[test]
    fn a_transcript_under_claudes_own_directory_is_revealable() {
        // SAFETY: single-threaded within this test, and the value is restored.
        let before = std::env::var_os("HOME");
        std::env::set_var("HOME", "/home/tester");
        let roots = Roots::revealable(WS, Path::new("/home/tester/.config/cowork-deck"));
        assert!(roots.contains("/home/tester/.claude/projects/-home-u-p/55dde7d8.jsonl"));
        assert!(!roots.contains("/home/tester/.claude/settings.json"));
        match before {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
