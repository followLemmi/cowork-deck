pub mod corpus;
pub mod embed;
pub mod index;
pub mod mcp;
pub mod model;
pub mod onnx;
pub mod scan;
pub mod serve;

/// Bytes. Above this, only the TL;DR plus a head excerpt is indexed.
pub const BIG_FILE: usize = 30_000;
/// Characters per chunk.
pub const CHUNK_MAX: usize = 2000;
/// Characters shown per search hit.
pub const SNIPPET: usize = 300;
/// Minimum letters per chunk — filters markdown skeletons out of the results.
pub const INFO_MIN: usize = 120;
/// Minimum letters for a TL;DR chunk, which is allowed to be terser.
pub const TLDR_MIN: usize = 40;
/// Scope value used for global, cross-project diary chunks.
pub const DIARY_SCOPE: &str = "__diaries__";
