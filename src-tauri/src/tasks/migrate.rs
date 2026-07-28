//! Moving cards between tracker roots.
//!
//! The decision is separated from the doing: `plan` is pure over `&[Task]`, so
//! the rule about which cards belong to this project is testable without a
//! tempdir, and `apply` is the only part that touches the disk.
use crate::tasks::model::Task;
use std::path::PathBuf;

/// One card that would move, and the name it keeps at the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: PathBuf,
    pub file_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationPlan {
    pub moves: Vec<Move>,
    /// Cards belonging to another project. Counted rather than dropped so the
    /// banner can say "7 move, 2 stay" instead of naming a number that
    /// silently disagrees with the folder.
    pub left_foreign: usize,
    /// Damaged cards in a shared root, which we will not claim.
    pub left_damaged: usize,
}

/// Which of `cards` belong to `project` and should follow it to a new root.
///
/// `cards` must be every card at the old root, unfiltered — `list` cannot
/// supply that, because it filters by project before returning, and
/// `left_foreign` is exactly the count `list` throws away.
///
/// `was_project_root` says whether the old root was `<ws.path>/.cowork/tasks`,
/// where every card is ours by construction.
pub fn plan(cards: &[Task], project: &str, was_project_root: bool) -> MigrationPlan {
    let mut out = MigrationPlan::default();
    for c in cards {
        // The project match is checked FIRST, and the order carries meaning: a
        // card with `kind: nonsense` is damaged while its `project:` is fine,
        // and it is ours. Checking `damaged` first would leave it in the vault.
        let ours = if c.project == project {
            true
        } else if c.damaged.is_some() {
            if was_project_root {
                true
            } else {
                out.left_damaged += 1;
                false
            }
        } else {
            out.left_foreign += 1;
            false
        };
        if !ours {
            continue;
        }
        let from = PathBuf::from(&c.path);
        // No file name means nothing to write at the destination. Cannot happen
        // for a card that came out of a directory scan, but this function takes
        // whatever it is given and must not panic on it.
        let Some(file_name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        out.moves.push(Move { from, file_name });
    }
    out
}

/// Why a planned card did not move.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum SkipReason {
    /// A file of this name is already at the destination. Names embed the
    /// card's ULID, so the same name is the same card: the move already
    /// happened, and this is a leftover rather than a failure.
    AlreadyAtDestination,
    /// The card is still at the old root and the person needs to know.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub file_name: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub moved: usize,
    pub skipped: Vec<Skipped>,
}

impl MigrationReport {
    /// Whether no card was left unmigrated at the old root, which is the
    /// condition for forgetting the previous location.
    ///
    /// An `AlreadyAtDestination` skip does not count against this: a copy of
    /// that card is at the destination, so keeping the pointer alive for it
    /// would make the banner nag forever about a move that has happened.
    pub fn is_complete(&self) -> bool {
        self.skipped
            .iter()
            .all(|s| matches!(s.reason, SkipReason::AlreadyAtDestination))
    }
}

/// Carry out `p` into `to`, rewriting `project:` when the workspace was renamed.
///
/// One card failing does not stop the rest — the same posture `scan` takes with
/// an unreadable entry. In every branch the source is removed only after the
/// destination is written, so no card is ever nowhere.
pub fn apply(
    p: &MigrationPlan,
    to: &std::path::Path,
    rename_project_to: Option<&str>,
) -> MigrationReport {
    let mut report = MigrationReport::default();
    for m in &p.moves {
        let dest = to.join(&m.file_name);
        if dest.exists() {
            report.skipped.push(Skipped {
                file_name: m.file_name.clone(),
                reason: SkipReason::AlreadyAtDestination,
            });
            continue;
        }
        match move_one(&m.from, &dest, rename_project_to) {
            Ok(()) => report.moved += 1,
            Err(e) => report.skipped.push(Skipped {
                file_name: m.file_name.clone(),
                reason: SkipReason::Failed(e),
            }),
        }
    }
    report
}

fn move_one(
    from: &std::path::Path,
    dest: &std::path::Path,
    rename_project_to: Option<&str>,
) -> Result<(), String> {
    if let Some(project) = rename_project_to {
        // The content changes either way, so `rename` has no part in this
        // branch. Line-level, not `render_card`: that knows nine keys and would
        // drop a vault card's `tags:`, `aliases:` and Dataview fields.
        let text = std::fs::read_to_string(from).map_err(|e| e.to_string())?;
        let updated = crate::tasks::frontmatter::set_project(&text, project)
            // Impossible for a card that came from `parse_card`, which requires
            // a frontmatter block — but an invariant that holds in another
            // module is not grounds for a panic in this one.
            .ok_or_else(|| "the card has no frontmatter block".to_string())?;
        std::fs::write(dest, updated).map_err(|e| e.to_string())?;
        return std::fs::remove_file(from)
            .map_err(|e| format!("copied, but the original could not be removed: {e}"));
    }

    if std::fs::rename(from, dest).is_ok() {
        return Ok(());
    }
    // Any rename failure falls back to copy + remove. `.cowork/tasks` to an
    // external vault is an ordinary EXDEV; enumerating error kinds to gate a
    // fallback that is correct unconditionally buys nothing.
    std::fs::copy(from, dest).map_err(|e| e.to_string())?;
    std::fs::remove_file(from)
        .map_err(|e| format!("copied, but the original could not be removed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::model::{TaskKind, TaskOrigin, TaskStatus};

    fn card(id: &str, project: &str, damaged: Option<&str>) -> Task {
        Task {
            id: id.to_string(),
            title: "t".to_string(),
            kind: TaskKind::Task,
            status: TaskStatus::Open,
            project: project.to_string(),
            created: "2026-07-28T10:00:00Z".to_string(),
            resolved: None,
            origin: TaskOrigin::Human,
            session: None,
            body: String::new(),
            path: format!("/old/{id}-t.md"),
            damaged: damaged.map(str::to_string),
            conflict: false,
        }
    }

    fn moved_ids(p: &MigrationPlan) -> Vec<String> {
        p.moves
            .iter()
            .map(|m| m.file_name.split('-').next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn our_cards_move() {
        let p = plan(&[card("01A", "deck", None)], "deck", false);
        assert_eq!(moved_ids(&p), vec!["01A"]);
        assert_eq!(p.moves[0].from, std::path::Path::new("/old/01A-t.md"));
        assert_eq!(p.moves[0].file_name, "01A-t.md");
        assert_eq!((p.left_foreign, p.left_damaged), (0, 0));
    }

    #[test]
    fn another_projects_cards_stay_and_are_counted() {
        let p = plan(&[card("01B", "other", None)], "deck", false);
        assert!(p.moves.is_empty());
        assert_eq!(p.left_foreign, 1);
    }

    #[test]
    fn a_damaged_card_moves_out_of_our_own_folder() {
        // In `.cowork/tasks` every card is ours by construction, so leaving a
        // damaged one behind would orphan it into a folder the board no longer
        // reads.
        let p = plan(&[card("01C", "", Some("no project field"))], "deck", true);
        assert_eq!(moved_ids(&p), vec!["01C"]);
        assert_eq!(p.left_damaged, 0);
    }

    #[test]
    fn a_damaged_card_stays_in_a_shared_vault() {
        // It may be an unrelated note that merely has an `id:` field — the same
        // reason FsTaskProvider::resolve refuses to write into one.
        let p = plan(&[card("01D", "", Some("no project field"))], "deck", false);
        assert!(p.moves.is_empty());
        assert_eq!(p.left_damaged, 1);
    }

    #[test]
    fn a_damaged_card_whose_project_matches_moves_from_anywhere() {
        // "Damaged" and "someone else's" are different things: a card with an
        // unknown `kind:` is damaged while its `project:` is perfectly fine.
        // Checking `damaged` before the project match would leave it behind.
        let p = plan(&[card("01E", "deck", Some("unknown kind"))], "deck", false);
        assert_eq!(moved_ids(&p), vec!["01E"]);
        assert_eq!(p.left_damaged, 0);
    }

    #[test]
    fn a_duplicate_id_pair_moves_whole() {
        let mut a = card("01F", "deck", None);
        let mut b = card("01F", "deck", None);
        a.conflict = true;
        b.conflict = true;
        a.path = "/old/01F-one.md".to_string();
        b.path = "/old/01F-two.md".to_string();
        let p = plan(&[a, b], "deck", false);
        // Splitting the pair would be worse than moving it: `conflict` is
        // recomputed at the new root, so the flag survives either way.
        assert_eq!(p.moves.len(), 2);
    }

    #[test]
    fn a_card_whose_path_has_no_file_name_is_left_alone() {
        let mut c = card("01G", "deck", None);
        c.path = "/".to_string();
        let p = plan(&[c], "deck", false);
        assert!(p.moves.is_empty(), "nothing to name at the destination");
    }

    use crate::tasks::frontmatter::parse_card;

    const CARD: &str = "---\nid: 01H\ntitle: t\nkind: task\nstatus: open\nproject: old-name\ncreated: c\norigin: human\ntags: [inbox]\n---\nbody\n";

    /// A plan over one real file on disk, built the way the commands do.
    fn one_card_at(dir: &std::path::Path, name: &str, text: &str, project: &str) -> MigrationPlan {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        let card = parse_card(text, &path.to_string_lossy()).expect("a card");
        plan(&[card], project, true)
    }

    #[test]
    fn apply_moves_the_file_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 1);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        assert!(report.is_complete());
        assert!(to.join("01H-t.md").is_file(), "destination must hold the card");
        assert!(!from.join("01H-t.md").exists(), "source must be gone");
    }

    #[test]
    fn apply_skips_a_card_already_at_the_destination_and_keeps_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("01H-t.md"), CARD).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 0);
        assert_eq!(report.skipped.len(), 1);
        assert!(matches!(report.skipped[0].reason, SkipReason::AlreadyAtDestination));
        // File names embed the ULID, so the same name is the same card: the move
        // already happened, and the leftover is not ours to delete.
        assert!(from.join("01H-t.md").is_file(), "source must be left intact");
        assert!(report.is_complete(), "an already-migrated card must not block clearing");
    }

    #[test]
    fn apply_rewrites_project_on_a_rename_and_keeps_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();

        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");
        let report = apply(&p, &to, Some("new-name"));

        assert_eq!(report.moved, 1);
        let text = std::fs::read_to_string(to.join("01H-t.md")).unwrap();
        assert!(text.contains("project: new-name"), "{text}");
        assert!(!text.contains("old-name"), "{text}");
        // Without this the first rename would eat a vault card's own fields.
        assert!(text.contains("tags: [inbox]"), "{text}");
        assert!(!from.join("01H-t.md").exists(), "source must be gone");
    }

    #[test]
    fn apply_reports_a_failure_and_says_the_work_is_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        std::fs::create_dir_all(&from).unwrap();
        let p = one_card_at(&from, "01H-t.md", CARD, "old-name");

        // A destination that is not a directory: every write into it fails.
        let to = dir.path().join("not-a-dir");
        std::fs::write(&to, "file").unwrap();
        let report = apply(&p, &to, None);

        assert_eq!(report.moved, 0);
        assert_eq!(report.skipped.len(), 1);
        assert!(matches!(report.skipped[0].reason, SkipReason::Failed(_)));
        assert!(!report.is_complete(), "a real failure must keep the pointer alive");
        assert!(from.join("01H-t.md").is_file(), "the card must still exist somewhere");
    }

    #[test]
    fn apply_over_an_empty_plan_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let report = apply(&MigrationPlan::default(), dir.path(), None);
        assert_eq!(report.moved, 0);
        assert!(report.is_complete());
    }
}
