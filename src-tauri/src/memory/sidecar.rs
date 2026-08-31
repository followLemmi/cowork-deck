//! Talking to the `cowork_memory` sidecar.
//!
//! Phase 1 built and tested the indexer; Phase 2 filled a corpus nothing read.
//! This is where the app starts asking questions of it.
//!
//! # Why a process and not a library
//!
//! ADR-0003, and the reason has not changed: `ort` links ONNX Runtime, which is
//! not something to put in the main binary on three platforms for a feature a
//! person may never switch on. The crate also lives outside any workspace, with
//! its own target directory, so `src-tauri` cannot depend on it even if it wanted
//! to.
//!
//! **The consequence is a duplicated contract**, and it is the standing hazard of
//! this file. The types below mirror the JSON the sidecar prints, and nothing but
//! a test can hold them together: a field renamed in
//! `crates/cowork-memory/src/main.rs` compiles here and fails at runtime. The
//! shapes are asserted against literals copied from that file rather than
//! described in prose.
//!
//! # `update` and `search` are not the same kind of call
//!
//! The CLI's `search` updates the index first, which is right — a search against
//! a stale index answers about a corpus that has moved — but it makes the cost of
//! a search unbounded on a cold cache: the first run embeds everything. So the
//! app treats them differently. `update` runs in the background with a generous
//! deadline; `search` runs interactively with a short one, and is only fast
//! because the update before it left nothing to do.
//!
//! # `status` is the probe, because it needs no model
//!
//! `search` loads the embedder and fails without it. `status` reads the index
//! cache and looks at the model directory, so it answers on a machine that has
//! never downloaded anything — which is exactly the machine that needs to be told
//! what is missing. It is therefore the call that decides what the interface may
//! offer, and never `search` returning nothing.

use crate::which::{output_with_stdin_and_deadline, RunFault};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// Long, and deliberately: a cold index embeds the whole corpus, one note at a
/// time, on the CPU. A person who has just switched memory on has a corpus of
/// however many sessions they have closed, and a deadline that reaped that would
/// leave an index permanently half-built.
const UPDATE_DEADLINE: Duration = Duration::from_secs(20 * 60);

/// Short, because by the time anything searches, `update` has run and there is
/// nothing for the search's own update pass to do. A search that takes longer
/// than this is a search against an index nobody built, and saying so beats
/// waiting.
const SEARCH_DEADLINE: Duration = Duration::from_secs(60);

/// Reading a cache and stat-ing a directory. Anything slower is a fault.
const STATUS_DEADLINE: Duration = Duration::from_secs(30);

fn binary_name() -> &'static str {
    if cfg!(windows) { "cowork_memory.exe" } else { "cowork_memory" }
}

/// One hit, mirroring `index::Hit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub score: f32,
    /// Path relative to the corpus root — `ws-1/Sessions/2026-08/31-topic.md`.
    pub file: String,
    /// The workspace id, or `lessons` for a diary.
    pub scope: String,
    /// The diary room, when this is a diary.
    pub room: Option<String>,
    pub text: String,
}

/// What the model directory holds, mirroring `model::ModelStatus`.
///
/// Three states and not a boolean: `partial` is a resumable `.part`, and
/// reporting it as absent would invite somebody to start 470 MB again with the
/// bytes already on disk (ADR-0005).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelState {
    pub dir: String,
    /// `absent`, `partial` or `present`.
    pub state: String,
    /// Bytes on disk that count towards a finished download.
    pub have: u64,
    /// Bytes when complete.
    pub total: u64,
}

impl ModelState {
    /// #374 is the surface that offers the download; this is what it asks.
    #[allow(dead_code)]
    pub fn is_present(&self) -> bool {
        self.state == "present"
    }
}

/// The index and the model, mirroring the sidecar's `status --json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub root: String,
    pub cache: String,
    /// `absent` (never indexed), `empty` (indexed, nothing in it) or `ready`.
    ///
    /// Three, because counts alone cannot tell the first two apart — both are
    /// zero — and an interface has to say "nothing has been indexed" and "there
    /// is nothing to index" differently.
    pub state: String,
    pub files: usize,
    pub chunks: usize,
    pub dim: usize,
    /// The index can be ready while the model is gone — the cache outlives it —
    /// so neither can be inferred from the other.
    pub model: ModelState,
}

/// What one `update` did, from the line the CLI prints.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Indexed {
    pub files: usize,
    pub chunks: usize,
    pub changed: usize,
}

/// Which notes a search may see.
#[derive(Debug, Clone)]
pub enum Scope {
    /// One workspace, plus the global diaries. What a session asks.
    Workspace(String),
    /// The diaries alone. #376's MCP tool is what asks for this — an agent
    /// looking for a lesson rather than for this project's history.
    #[allow(dead_code)]
    Lessons,
    Everything,
}

impl Scope {
    fn as_arg(&self) -> String {
        match self {
            Scope::Workspace(id) => id.clone(),
            Scope::Lessons => "lessons".to_string(),
            Scope::Everything => "all".to_string(),
        }
    }
}

/// The sidecar, over one corpus root.
pub struct Sidecar {
    program: PathBuf,
    root: PathBuf,
}

impl Sidecar {
    /// Resolve the binary and point it at a root.
    ///
    /// Through the same probe the reporter and the task CLI use — next to the
    /// running executable first, then the sibling `release` directory so
    /// `tauri dev` finds a staged binary. One resolution rule for three sidecars,
    /// rather than a third guess at where a bundle puts things.
    pub fn new(root: PathBuf) -> Sidecar {
        let exe = std::env::current_exe().unwrap_or_default();
        let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        Sidecar {
            program: crate::resolve_reporter_path(&dir, binary_name(), |p| p.exists()),
            root,
        }
    }

    /// Where the binary is. #376 needs it: registering an MCP server means
    /// naming the process the CLI should launch.
    #[allow(dead_code)]
    pub fn program(&self) -> &std::path::Path {
        &self.program
    }

    /// Whether the binary is where it should be.
    ///
    /// Worth asking separately: a build that did not stage the sidecar is a
    /// different fault from one whose model is missing, and both would otherwise
    /// surface as a failed search.
    pub fn is_staged(&self) -> bool {
        // Staged as a placeholder before it is declared, and `stage-memory.sh`
        // installs an empty file first — so existence alone is not enough to
        // call it a working sidecar.
        std::fs::metadata(&self.program).map(|m| m.len() > 0).unwrap_or(false)
    }

    /// The index and the model, without needing either.
    pub fn status(&self) -> Result<Status, String> {
        let out = self.run(&["status", "--json"], STATUS_DEADLINE)?;
        serde_json::from_str(out.trim()).map_err(|e| {
            format!("the memory sidecar's status was not the shape this build expects ({e})")
        })
    }

    /// Bring the index up to date with the corpus.
    ///
    /// Generous deadline, and it belongs on a background thread rather than in
    /// front of anybody: the first run after switching memory on embeds every
    /// note there is.
    pub fn update(&self) -> Result<Indexed, String> {
        let out = self.run(&["update"], UPDATE_DEADLINE)?;
        parse_indexed(&out).ok_or_else(|| {
            format!("the memory sidecar did not say what it indexed: {}", first_line(&out))
        })
    }

    /// Search, newest index first.
    ///
    /// `min_score` is left at the CLI's default on purpose: it carries the
    /// reference implementation's threshold, and the golden parity test is what
    /// keeps retrieval where it was measured. Tuning it from up here would be
    /// tuning it on a hunch.
    pub fn search(&self, query: &str, scope: &Scope, top: usize) -> Result<Vec<Hit>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let scope_arg = scope.as_arg();
        let top = top.to_string();
        let out = self.run(
            &["search", query, "--scope", &scope_arg, "--top", &top, "--json"],
            SEARCH_DEADLINE,
        )?;
        // An empty result is a legitimate answer and the CLI says so on stderr
        // while keeping stdout machine-readable, so this parses either way.
        serde_json::from_str(out.trim()).map_err(|e| {
            format!("the memory sidecar's results were not the shape this build expects ({e})")
        })
    }

    fn run(&self, args: &[&str], deadline: Duration) -> Result<String, String> {
        if !self.is_staged() {
            return Err(format!(
                "the memory sidecar is not installed at {}",
                self.program.display()
            ));
        }
        let mut cmd = std::process::Command::new(&self.program);
        cmd.arg("--root").arg(&self.root).args(args);
        // No stdin, and the helper is still the right one: it reads both pipes on
        // threads, and `update --verbose` prints a line per reindexed file, which
        // on a first run is the whole corpus and well past a pipe buffer.
        output_with_stdin_and_deadline(cmd, "", deadline).map_err(|f| match f {
            RunFault::Timeout => {
                format!("the memory sidecar did not answer within {}s", deadline.as_secs())
            }
            other => format!("the memory sidecar failed: {other}"),
        })
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("").trim()
}

/// Read `indexed 12 files, 340 chunks (2 files changed)`.
///
/// Parsed rather than asked for as JSON because that is what the CLI prints, and
/// a second output mode added here would be a second contract to keep. The
/// numbers are taken by position among the line's integers, so a reworded
/// sentence still reads — and a line with fewer than three numbers in it is a
/// refusal rather than a guess.
fn parse_indexed(out: &str) -> Option<Indexed> {
    let line = out.lines().find(|l| l.trim_start().starts_with("indexed "))?;
    let nums: Vec<usize> = line
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    match nums.as_slice() {
        [files, chunks, changed, ..] => {
            Some(Indexed { files: *files, chunks: *chunks, changed: *changed })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_indexed_line_the_cli_prints_is_read() {
        // Copied from `crates/cowork-memory/src/main.rs`, which is the contract.
        let out = "indexed 12 files, 340 chunks (2 files changed)\n";
        assert_eq!(parse_indexed(out), Some(Indexed { files: 12, chunks: 340, changed: 2 }));
    }

    #[test]
    fn a_verbose_run_puts_its_lines_on_stderr_and_the_count_still_reads() {
        // `--verbose` writes to stderr, so stdout is the one line either way —
        // but a build that changed that must not break the read.
        let out = "reindexed ws-1/Facts.md\nindexed 1 files, 3 chunks (1 files changed)\n";
        assert_eq!(parse_indexed(out), Some(Indexed { files: 1, chunks: 3, changed: 1 }));
    }

    #[test]
    fn a_line_that_is_not_the_count_is_refused_rather_than_guessed_at() {
        assert_eq!(parse_indexed(""), None);
        assert_eq!(parse_indexed("indexed everything\n"), None, "no numbers to take");
        assert_eq!(parse_indexed("indexed 4 files\n"), None, "two of three is not an answer");
        assert_eq!(parse_indexed("nothing changed\n"), None);
    }

    /// The duplicated contract this file opens by admitting. The literal is
    /// copied from the sidecar's `status --json`; if that renames a field, this
    /// is where it is supposed to fail.
    #[test]
    fn the_status_json_the_cli_prints_deserialises() {
        let raw = serde_json::json!({
            "root": "/home/dev/.config/cowork-deck",
            "cache": "/home/dev/.config/cowork-deck/.index",
            "state": "ready",
            "files": 12,
            "chunks": 340,
            "dim": 384,
            "model": {
                "dir": "/home/dev/.config/cowork-deck/.model",
                "state": "present",
                "have": 502_000_000u64,
                "total": 502_000_000u64,
            },
        })
        .to_string();
        let s: Status = serde_json::from_str(&raw).expect("the sidecar's own shape");
        assert_eq!(s.state, "ready");
        assert_eq!(s.chunks, 340);
        assert_eq!(s.dim, 384);
        assert!(s.model.is_present());
    }

    /// The strongest form of the contract test this file's header admits it
    /// needs: not a literal somebody typed to match the struct, but the exact
    /// bytes the staged binary printed. Captured 2026-08-31 from
    /// `cowork_memory --root <tmp> status --json`.
    #[test]
    fn the_bytes_the_real_binary_printed_deserialise() {
        let raw = r#"{"cache":"/tmp/x/.index","chunks":0,"dim":0,"files":0,"model":{"dir":"/tmp/x/.model","have":0,"state":"absent","total":479383128},"root":"/tmp/x","state":"absent"}"#;
        let s: Status = serde_json::from_str(raw).expect("the real binary's own output");
        assert_eq!(s.state, "absent", "never indexed");
        assert_eq!(s.model.state, "absent");
        assert_eq!(s.model.total, 479_383_128, "the 479 MB ADR-0005 is about");

        // And after an indexing pass, with the fake embedder — note `dim` is the
        // embedder's width, so it is 64 here and 384 with the real model.
        let raw = r#"{"cache":"/tmp/x/.index","chunks":2,"dim":64,"files":2,"model":{"dir":"/tmp/x/.model","have":0,"state":"absent","total":479383128},"root":"/tmp/x","state":"ready"}"#;
        let s: Status = serde_json::from_str(raw).unwrap();
        assert_eq!(s.state, "ready");
        assert_eq!(s.files, 2);
        // The index outliving the model is not a contradiction — see `Status`.
        assert!(!s.model.is_present());
    }

    /// Also the real binary's output, from `search --scope ws-1 --json`.
    #[test]
    fn the_hits_the_real_binary_printed_deserialise() {
        // `r##"…"##`, because the JSON holds `"#` — a markdown heading right
        // after a quote — which would close an `r#"…"#` literal early.
        let raw = r##"[{"score":0.06593268,"file":"ws-1/Sessions/2026-08/31-staging.md","scope":"ws-1","room":null,"text":"# a note\n\n## TL;DR\nsomething happened"}]"##;
        let hits: Vec<Hit> = serde_json::from_str(raw).expect("the real binary's own output");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scope, "ws-1");
        assert_eq!(hits[0].room, None);
    }

    /// The three index states, which counts alone cannot distinguish: `absent`
    /// and `empty` are both zero files and zero chunks.
    #[test]
    fn an_unindexed_corpus_and_an_empty_one_are_told_apart() {
        let of = |state: &str| {
            let raw = serde_json::json!({
                "root": "/r", "cache": "/r/.index", "state": state,
                "files": 0, "chunks": 0, "dim": 384,
                "model": { "dir": "/r/.model", "state": "absent", "have": 0, "total": 502_000_000u64 },
            })
            .to_string();
            serde_json::from_str::<Status>(&raw).unwrap()
        };
        assert_eq!(of("absent").state, "absent");
        assert_eq!(of("empty").state, "empty");
        assert!(!of("absent").model.is_present());
    }

    /// A resumable download is not an absent one — see ADR-0005.
    #[test]
    fn a_partly_downloaded_model_is_its_own_state() {
        let m: ModelState = serde_json::from_str(
            &serde_json::json!({
                "dir": "/r/.model", "state": "partial",
                "have": 120_000_000u64, "total": 502_000_000u64,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(m.state, "partial");
        assert!(!m.is_present());
        assert!(m.have > 0 && m.have < m.total, "there are bytes worth resuming from");
    }

    #[test]
    fn the_hits_the_cli_prints_deserialise() {
        let raw = serde_json::json!([
            { "score": 0.71, "file": "ws-1/Sessions/2026-08/31-topic.md",
              "scope": "ws-1", "room": null, "text": "what happened" },
            { "score": 0.44, "file": "Diaries/reviewer/2026-08.md",
              "scope": "lessons", "room": "reviewer", "text": "- a lesson" },
        ])
        .to_string();
        let hits: Vec<Hit> = serde_json::from_str(&raw).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].scope, "ws-1");
        assert_eq!(hits[1].room.as_deref(), Some("reviewer"));
    }

    #[test]
    fn an_empty_result_is_an_answer_and_not_a_parse_failure() {
        assert!(serde_json::from_str::<Vec<Hit>>("[]").unwrap().is_empty());
    }

    #[test]
    fn a_scope_becomes_the_argument_the_cli_expects() {
        assert_eq!(Scope::Workspace("ws-1".into()).as_arg(), "ws-1");
        assert_eq!(Scope::Lessons.as_arg(), "lessons");
        assert_eq!(Scope::Everything.as_arg(), "all");
    }

    /// An empty query costs no process. The CLI would embed it and compare it
    /// against everything, which is a spawn and a model load to answer nothing.
    #[test]
    fn an_empty_query_never_reaches_the_sidecar() {
        let s = Sidecar { program: "/no/such/binary".into(), root: "/r".into() };
        assert_eq!(s.search("   ", &Scope::Everything, 10), Ok(Vec::new()));
    }

    /// A build that did not stage the sidecar is a different fault from a
    /// missing model, and both would otherwise surface as a failed search.
    #[test]
    fn a_missing_binary_says_so_rather_than_reporting_no_results() {
        let s = Sidecar { program: "/no/such/binary".into(), root: "/r".into() };
        assert!(!s.is_staged());
        let e = s.status().expect_err("no binary is not an empty index");
        assert!(e.contains("not installed"), "{e}");
        assert!(e.contains("/no/such/binary"), "and names where it looked: {e}");
    }

    /// `stage-memory.sh` installs an empty placeholder before the sidecar is
    /// declared, so existence alone would report a working sidecar on a build
    /// that has none.
    #[test]
    fn an_empty_placeholder_is_not_a_staged_sidecar() {
        let dir = std::env::temp_dir().join(format!("cd-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(binary_name());
        std::fs::write(&p, b"").unwrap();
        let s = Sidecar { program: p.clone(), root: dir.clone() };
        assert!(!s.is_staged(), "an empty file is a placeholder, not a binary");

        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        assert!(Sidecar { program: p, root: dir }.is_staged());
    }
}
