use crate::tasks::board::{KindId, StepId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskOrigin { Human, Session }

/// A card as the UI sees it. `damaged` and `conflict` are presentation flags,
/// never written to disk: a card we cannot fully parse must still be visible,
/// because a silently vanished task is the worst possible tracker bug.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    /// Free-form: `BoardConfig` decides whether it means anything, and a value
    /// it does not know still has to reach the board.
    pub kind: KindId,
    pub status: StepId,
    pub project: String,
    pub created: String,
    pub resolved: Option<String>,
    pub origin: TaskOrigin,
    pub session: Option<String>,
    pub body: String,
    pub path: String,
    pub damaged: Option<String>,
    #[serde(default)]
    pub conflict: bool,
}

/// What a caller supplies to create a card; everything else is derived.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub title: String,
    pub kind: KindId,
    pub body: String,
    pub project: String,
    pub origin: TaskOrigin,
    pub session: Option<String>,
}

#[derive(Debug)]
pub enum TaskError {
    NotConfigured,
    RootMissing(String),
    Io(String),
    NotFound(String),
    Conflict(String),
    /// The card has an `id` but is otherwise incomplete (see
    /// `frontmatter::parse_card`'s `damaged` field) — refused rather than
    /// resolved, because that state also covers an ordinary Obsidian note that
    /// happens to carry an `id:` for unrelated reasons. The string is the
    /// file's path, so the user knows which file to fix by hand.
    Damaged(String),
    /// The caller named a step or kind `board.json` does not define. Refused
    /// rather than written: a card carrying a value nothing defines lands in the
    /// unknown-step column, and we would have put it there ourselves.
    UnknownStep(String),
    UnknownKind(String),
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskError::NotConfigured => write!(f, "no task tracker is configured for this workspace"),
            TaskError::RootMissing(p) => write!(f, "the task folder is unreachable: {p}"),
            TaskError::Io(e) => write!(f, "filesystem error: {e}"),
            TaskError::NotFound(id) => write!(f, "card not found: {id}"),
            TaskError::Conflict(id) => {
                write!(f, "more than one file carries id {id} — fix it by hand")
            }
            // Not "will not be closed automatically": `resolve` is not the only
            // caller that reaches this refusal any more — `rewrite_step` does
            // too, and a renamed step never asked to close anything.
            TaskError::Damaged(path) => write!(
                f,
                "the card is damaged and must be repaired by hand: {path}"
            ),
            TaskError::UnknownStep(s) => write!(f, "no step named {s} in board.json"),
            TaskError::UnknownKind(s) => write!(f, "no kind named {s} in board.json"),
        }
    }
}
