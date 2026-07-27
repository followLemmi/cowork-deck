//! Library surface of cowork-deck. Deliberately minimal: it exposes only the
//! self-contained `tasks` module, so both the Tauri binary and the
//! `cowork_task` CLI link one implementation of the card format.
//!
//! `tasks` must not depend on `model`/`store`/`pty` — those stay private to the
//! main binary, which keeps declaring them with `mod`.
pub mod tasks;
