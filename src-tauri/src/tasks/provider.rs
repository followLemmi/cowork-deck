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

pub trait TaskProvider {
    fn capabilities(&self) -> ProviderCapabilities;
    fn list(&self, project: &str) -> Result<Vec<Task>, TaskError>;
    fn create(&self, draft: TaskDraft) -> Result<Task, TaskError>;
    fn resolve(&self, id: &str) -> Result<Task, TaskError>;
}
