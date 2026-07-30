use crate::tasks::board::{KindId, StepId};
use crate::tasks::model::{Task, TaskDraft, TaskError};
use serde::{Deserialize, Serialize};

/// What a provider can actually do. Declared, never faked: `open → done` does
/// not map one-to-one onto Jira transitions, so the UI hides an action it is
/// told is unavailable instead of failing at call time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub can_create: bool,
    pub can_resolve: bool,
    pub statuses: Vec<String>,
}

/// Which fields of a card to write. Every one optional because Save applies only
/// what the person touched: between opening the modal and pressing it, an agent
/// may have moved the step or a sync may have brought another machine's version,
/// and a patch carrying all four fields would silently undo that.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub kind: Option<KindId>,
    pub status: Option<StepId>,
    pub body: Option<String>,
    /// Why a card is being closed, where closing takes a reason. GitHub's
    /// `gh issue close -r` accepts `completed` or `not planned`, and the close
    /// confirmation offers the choice (decision 10). `FsTaskProvider` ignores
    /// it: a card file has no such field, and inventing one would change the
    /// card format for a value nothing reads back.
    ///
    /// On the patch rather than in a command of its own because decision 3 keeps
    /// the board's four write paths as one: the drag handler, the arrows and the
    /// card modal all go through `tasks_update` and none of them should learn a
    /// provider's name.
    #[serde(default)]
    pub reason: Option<String>,
}

pub trait TaskProvider {
    fn capabilities(&self) -> ProviderCapabilities;
    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError>;
    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError>;
    fn resolve(&self, id: &str) -> Result<Task, TaskError>;
    fn update(&self, id: &str, patch: TaskPatch) -> Result<Task, TaskError>;
}
