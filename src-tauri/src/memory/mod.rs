//! The deck's own memory: what past sessions did and decided, written down
//! where a later session — or a later machine — can find it.
//!
//! Phase 2 of #35 is the write path, and it is the half the feature stands on.
//! Search over an empty corpus is a working search that returns nothing, so
//! nothing here indexes, embeds or spawns the `cowork_memory` sidecar; under
//! ADR-0004 the markdown *is* the memory and the index is a cache built over it
//! afterwards, which is why the write path can be finished and tested with no
//! model on the machine at all.
//!
//! - [`corpus`] — where a note goes and what it looks like when it gets there.
//!
//! The root is the app's config directory, which is also the store's directory
//! and the sync repository root (ADR-0006). This module never resolves it: it
//! is handed one, so every test runs against a temporary directory and nothing
//! here can write into a real corpus by accident.

// Nothing outside the tests calls into here yet: the queue (#364) and capture
// (#365) are what will, and they come after. Without this the build prints a
// dead-code warning for every item in the module, which is a wall of noise that
// hides the next real warning. **Remove this line with #365**, which is the
// point at which everything here has a caller and the warnings would be true.
#![allow(dead_code)]

pub mod corpus;
