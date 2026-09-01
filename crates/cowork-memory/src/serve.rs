//! One process, one model, many searches — for the app rather than for a session.
//!
//! Every other way into this binary is one search per process, which measured at
//! 2.0 s and a 1.8 GB peak, of which **0.02 s and 6.7 MB is everything that is
//! not the model** (#389). At one search per process that is the price of the
//! feature; at one per keystroke, per prompt and per tool call it is the feature
//! not working.
//!
//! # Why not MCP, which is already here
//!
//! [`crate::mcp`] is also a long-lived stdio loop, and reusing it would mean one
//! mode instead of two. Two things argued against it and both are about the
//! audience rather than the size: MCP is a contract with Claude Code, so every
//! change here would be a change to something a session depends on — and its
//! answers are prose in content blocks, written to be read by a model. The app
//! wants `Hit` records with scores and paths, and parsing them back out of
//! prose it just formatted would be a round trip through a lossy shape.
//!
//! So: line-delimited JSON, one request per line, one reply per line, the same
//! `Hit` the CLI already returns. Small enough that the whole protocol is the
//! two structs below.
//!
//! # stdout is the protocol
//!
//! The same rule `mcp` states, for the same reason: a stray `println!` is a
//! parse error at the other end, and the app then has no search with nothing to
//! say why. Diagnostics go to stderr.
//!
//! # The index is read, never built
//!
//! Also as in `mcp`. A cold index means embedding the whole corpus, which is
//! minutes; keeping it fresh is the app's job (`memory::spawn_reindex`), and a
//! request is answered from what is there.

use crate::embed::Lazy;
use crate::index::{self, Hit, SearchScope};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::PathBuf;

/// One request. `id` is echoed so a caller can match replies to asks without
/// assuming the order, even though this loop answers one at a time.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: u64,
    pub op: String,
    #[serde(default)]
    pub query: String,
    /// A workspace id, `lessons`, or `all`.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub top: Option<usize>,
    #[serde(default)]
    pub min_score: Option<f32>,
}

/// One reply. `ok: false` carries `error` and never a partial result: a caller
/// that got half an answer cannot tell it from a whole one.
#[derive(Debug, Serialize)]
pub struct Reply {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hits: Option<Vec<Hit>>,
    /// Whether the model is in memory. What makes `warm` answerable and what a
    /// caller reads to know whether the next search is 2 s or 20 ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded: Option<bool>,
}

impl Reply {
    fn fail(id: u64, msg: impl Into<String>) -> Reply {
        Reply { id, ok: false, error: Some(msg.into()), hits: None, loaded: None }
    }
}

pub struct Served {
    pub root: PathBuf,
    pub cache: PathBuf,
}

/// Serve until stdin closes.
///
/// Closing stdin is how the app says it is done — a process whose parent has
/// gone is a process holding half a gigabyte for nobody.
pub fn serve(
    served: &Served,
    embedder: &Lazy,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
) -> Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let reply = handle(served, embedder, trimmed);
        writeln!(output, "{}", serde_json::to_string(&reply)?)?;
        // Flushed explicitly: line buffering on a pipe is a platform's choice,
        // and the failure it produces is a caller waiting forever for an answer
        // that is sitting in a buffer.
        output.flush()?;
    }
}

fn handle(served: &Served, embedder: &Lazy, raw: &str) -> Reply {
    let req: Request = match serde_json::from_str(raw) {
        Ok(r) => r,
        // Id zero, because the line that would have carried one did not parse.
        Err(e) => return Reply::fail(0, format!("that is not a request ({e})")),
    };
    match req.op.as_str() {
        "search" => search(served, embedder, &req),
        /* Load the model without asking anything of it. What the app calls when
           somebody opens the memory page: the two seconds then overlap with
           reading the list, and the first real search is instant. */
        "warm" => match embedder.get() {
            Ok(_) => Reply { id: req.id, ok: true, error: None, hits: None, loaded: Some(true) },
            Err(e) => Reply::fail(req.id, e.to_string()),
        },
        /* Whether the model is in memory, without loading it. A caller deciding
           whether to warm must not warm by asking. */
        "ping" => Reply {
            id: req.id,
            ok: true,
            error: None,
            hits: None,
            loaded: Some(embedder.is_loaded()),
        },
        other => Reply::fail(req.id, format!("there is no operation called {other}")),
    }
}

fn search(served: &Served, embedder: &Lazy, req: &Request) -> Reply {
    let query = req.query.trim();
    if query.is_empty() {
        // The same refusal `Sidecar::search` makes on the other side, and for
        // the same reason: embedding nothing and comparing it against
        // everything is a model load to answer nothing.
        return Reply { id: req.id, ok: true, error: None, hits: Some(Vec::new()), loaded: None };
    }
    let ix = index::load(&served.cache);
    if ix.meta.chunks.is_empty() {
        // Not an error: an index that has not been built is a legitimate state
        // with a sentence of its own, and the app has that sentence already.
        return Reply { id: req.id, ok: true, error: None, hits: Some(Vec::new()), loaded: None };
    }
    let emb = match embedder.get() {
        Ok(e) => e,
        Err(e) => return Reply::fail(req.id, e.to_string()),
    };
    let scope = match req.scope.as_deref().unwrap_or("all") {
        "all" => SearchScope::All,
        "lessons" => SearchScope::Lessons,
        other => SearchScope::Project(other.to_string()),
    };
    match index::search(
        &ix,
        emb,
        query,
        &scope,
        req.top.unwrap_or(10),
        req.min_score.unwrap_or(0.25),
    ) {
        Ok(hits) => Reply {
            id: req.id,
            ok: true,
            error: None,
            hits: Some(hits),
            loaded: Some(true),
        },
        Err(e) => Reply::fail(req.id, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::{Embedder, FakeEmbedder, Lazy};
    use crate::index;
    use serde_json::Value;
    use std::cell::Cell;
    use std::io::Cursor;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cm-serve-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A corpus with something in it, indexed with the fake embedder — no model,
    /// no download, and the same code path a real one takes.
    fn served(name: &str) -> Served {
        let root = tmp(name);
        let dir = root.join("ws-1/Sessions/2026-08");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("31-the-staging-script.md"),
            "# a note\n\n## TL;DR\nthe staging script read the host triple instead of the \
             tauri one, so the sidecar was built for the wrong architecture and the app \
             refused to start it at all.\n",
        )
        .unwrap();
        let cache = root.join(".index");
        let e: Box<dyn Embedder> = Box::new(FakeEmbedder::new());
        index::update(&root, &cache, e.as_ref()).unwrap();
        Served { root, cache }
    }

    fn exchange(s: &Served, lazy: &Lazy, requests: &[Value]) -> Vec<Value> {
        let body = requests.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        let mut input = Cursor::new(body.into_bytes());
        let mut out: Vec<u8> = Vec::new();
        serve(s, lazy, &mut input, &mut out).expect("serve");
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("a reply per line"))
            .collect()
    }

    fn fake() -> Box<dyn Embedder> {
        Box::new(FakeEmbedder::new())
    }

    #[test]
    fn a_search_answers_with_hits_and_echoes_its_id() {
        let s = served("hits");
        let build = || Ok(fake());
        let out = exchange(
            &s,
            &Lazy::new(&build),
            &[serde_json::json!({
                "id": 7, "op": "search", "query": "staging script architecture",
                "scope": "all", "top": 5, "min_score": -1.0
            })],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 7);
        assert_eq!(out[0]["ok"], true);
        let hits = out[0]["hits"].as_array().expect("hits");
        assert!(!hits.is_empty());
        assert!(hits[0]["file"].as_str().unwrap().ends_with("31-the-staging-script.md"));
    }

    /// The whole reason this mode exists: one process, one model, many searches.
    #[test]
    fn the_model_is_built_once_however_many_searches_arrive() {
        let s = served("once");
        let built = Cell::new(0);
        let build = || {
            built.set(built.get() + 1);
            Ok(fake())
        };
        let lazy = Lazy::new(&build);
        let ask = |i: u64| {
            serde_json::json!({
                "id": i, "op": "search", "query": "staging script", "scope": "all",
                "min_score": -1.0
            })
        };
        let out = exchange(&s, &lazy, &[ask(1), ask(2), ask(3)]);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|r| r["ok"] == true));
        assert_eq!(built.get(), 1, "one graph build, not one per request");
    }

    /// And not built at all by a process nobody asks to search — the property
    /// the closure had before it, which must survive being memoised.
    #[test]
    fn a_process_that_is_never_asked_to_search_never_loads_the_model() {
        let s = served("never");
        let built = Cell::new(0);
        let build = || {
            built.set(built.get() + 1);
            Ok(fake())
        };
        let out = exchange(&s, &Lazy::new(&build), &[serde_json::json!({ "id": 1, "op": "ping" })]);
        assert_eq!(out[0]["loaded"], false);
        assert_eq!(built.get(), 0);
    }

    /// What the app calls when the memory page opens, so the seconds overlap
    /// with reading the list.
    #[test]
    fn warm_loads_the_model_and_says_it_is_loaded() {
        let s = served("warm");
        let built = Cell::new(0);
        let build = || {
            built.set(built.get() + 1);
            Ok(fake())
        };
        let lazy = Lazy::new(&build);
        let out = exchange(
            &s,
            &lazy,
            &[
                serde_json::json!({ "id": 1, "op": "warm" }),
                serde_json::json!({ "id": 2, "op": "ping" }),
            ],
        );
        assert_eq!(out[0]["ok"], true);
        assert_eq!(out[0]["loaded"], true);
        assert_eq!(out[1]["loaded"], true, "and it stayed loaded");
        assert_eq!(built.get(), 1);
    }

    /// An empty query costs no model load — the same refusal the CLI makes, for
    /// the same reason.
    #[test]
    fn an_empty_query_never_reaches_the_model() {
        let s = served("empty");
        let built = Cell::new(0);
        let build = || {
            built.set(built.get() + 1);
            Ok(fake())
        };
        let out = exchange(
            &s,
            &Lazy::new(&build),
            &[serde_json::json!({ "id": 1, "op": "search", "query": "   " })],
        );
        assert_eq!(out[0]["ok"], true);
        assert_eq!(out[0]["hits"].as_array().unwrap().len(), 0);
        assert_eq!(built.get(), 0);
    }

    /// A model that will not load is the ordinary failure — it has not been
    /// downloaded — and it must be an answer rather than a dropped connection.
    #[test]
    fn a_model_that_will_not_load_is_reported_and_the_loop_goes_on() {
        let s = served("nomodel");
        let build = || anyhow::bail!("embedding model not found in /r/.model");
        let lazy = Lazy::new(&build);
        let out = exchange(
            &s,
            &lazy,
            &[
                serde_json::json!({ "id": 1, "op": "search", "query": "staging script" }),
                serde_json::json!({ "id": 2, "op": "ping" }),
            ],
        );
        assert_eq!(out[0]["ok"], false);
        assert!(out[0]["error"].as_str().unwrap().contains("model not found"));
        // The second request is answered, which is what "the loop goes on" means.
        assert_eq!(out[1]["ok"], true);
        // And a failure is not cached: the model may finish downloading without
        // this process restarting.
        assert_eq!(out[1]["loaded"], false);
    }

    #[test]
    fn a_line_that_is_not_a_request_is_answered_rather_than_fatal() {
        let s = served("junk");
        let build = || Ok(fake());
        let body = "not json\n{\"id\":2,\"op\":\"ping\"}\n";
        let mut input = Cursor::new(body.as_bytes().to_vec());
        let mut out: Vec<u8> = Vec::new();
        serve(&s, &Lazy::new(&build), &mut input, &mut out).expect("serve");
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["ok"], false);
        assert_eq!(lines[1]["id"], 2);
        assert_eq!(lines[1]["ok"], true);
    }

    #[test]
    fn an_unknown_operation_is_named_rather_than_ignored() {
        let s = served("unknown");
        let build = || Ok(fake());
        let out = exchange(
            &s,
            &Lazy::new(&build),
            &[serde_json::json!({ "id": 1, "op": "reindex-everything" })],
        );
        assert_eq!(out[0]["ok"], false);
        assert!(out[0]["error"].as_str().unwrap().contains("reindex-everything"));
    }
}
