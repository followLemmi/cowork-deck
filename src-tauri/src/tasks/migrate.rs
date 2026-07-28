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
}
