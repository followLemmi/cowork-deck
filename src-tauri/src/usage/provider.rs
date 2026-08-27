//! The trait, and the one rule it exists to enforce: a provider declares what it
//! can do before it is asked to do it.
//!
//! Modelled on `tasks/provider.rs`, which learned it the hard way — `open → done`
//! does not map onto every tracker's transitions, so the board hides an action it
//! is told is unavailable instead of failing at call time. The same shape answers
//! a harder question here: an AI whose limits nobody can read must produce a row
//! that says so, and a row that says so is only possible if the app knows which
//! windows were *supposed* to be there.

use crate::usage::model::{AiUsage, Detection, UsageCapabilities, UsageError};
use std::time::Duration;

pub trait UsageProvider: Send + Sync {
    /// The registry key. Never printed — see `label`.
    fn id(&self) -> &'static str;
    /// What a person calls this AI.
    fn label(&self) -> &'static str;
    fn capabilities(&self) -> UsageCapabilities;
    /// Whether this AI is on the machine. Bounded, like every probe in this
    /// codebase (`which.rs`): detection can sit on a paint path, and a probe
    /// that can hang is a window that can freeze.
    fn detect(&self) -> Detection;
    /// Everything known about this AI's limits right now.
    ///
    /// `now_ms` is passed in rather than read from the clock so that every
    /// provider's "is this window still open" arithmetic is testable without
    /// waiting for real time to pass — the same reason `scheduler.rs` takes its
    /// own now. `deadline` is a courtesy: the registry enforces it from outside
    /// as well, because a provider that ignores it is exactly the case the
    /// enforcement is for.
    fn fetch(&self, now_ms: i64, deadline: Duration) -> Result<AiUsage, UsageError>;
}
