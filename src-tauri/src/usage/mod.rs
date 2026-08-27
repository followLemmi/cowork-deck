//! What each connected AI has left, and where that number came from.
//!
//! The deck runs many sessions at once and they all draw on one budget; when it
//! runs out they stall together. This module is the app's answer to "can I keep
//! working", and its organising decision is that **the source of a number is part
//! of the number** — see ADR-0009 and the note at the top of `model.rs`.
//!
//! Nothing outside `claude.rs` and `gemini.rs` knows the name of a provider, and
//! nothing in `src/` knows one at all: the label, the window names, the caveats
//! and the command that would answer an unknown row all travel with the snapshot.
//! That is not tidiness — it is the property #308 exists to measure.

pub mod banner;
pub mod claude;
pub mod gemini;
pub mod model;
pub mod observed;
pub mod provider;
pub mod registry;
pub mod reported;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Every provider this build knows about.
///
/// The registry line #308 measures: adding an AI is this list, its own file, and
/// a detection entry inside that file. Order is the order the block draws in.
pub fn registry(reported_enabled: Arc<AtomicBool>) -> registry::Registry {
    registry::Registry::with(vec![
        Arc::new(claude::ClaudeUsage::new(reported_enabled)),
        Arc::new(gemini::GeminiUsage),
    ])
}
