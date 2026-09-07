//! Carrying the deck's portable configuration and its memory between machines
//! through a repository of the person's own. Epic #311.
//!
//! Nothing calls into here yet, and that is the shape of the epic rather than an
//! oversight: this stage settles *what* may leave the machine before any code
//! exists that could send it. The allowance comes off when the projection
//! (#313) starts reading the manifest and the sync job (#317) starts asking
//! which machine this is — a build that warns on every compile is a build whose
//! warnings nobody reads.

pub mod activation;
pub mod adopt;
pub mod git;
pub mod identity;
pub mod job;
pub mod machine;
pub mod manifest;
pub mod projection;
pub mod publish;
