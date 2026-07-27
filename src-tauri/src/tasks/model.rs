use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind { Bug, Task, Idea }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Open, Done }

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
    pub kind: TaskKind,
    pub status: TaskStatus,
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
    pub kind: TaskKind,
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
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskError::NotConfigured => write!(f, "трекер не настроен для этого пространства"),
            TaskError::RootMissing(p) => write!(f, "каталог задач недоступен: {p}"),
            TaskError::Io(e) => write!(f, "ошибка файловой системы: {e}"),
            TaskError::NotFound(id) => write!(f, "карточка не найдена: {id}"),
            TaskError::Conflict(id) => {
                write!(f, "несколько файлов с одним id ({id}) — исправьте вручную")
            }
        }
    }
}
