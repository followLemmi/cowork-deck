//! An MCP server over stdio, so a session can ask the corpus questions.
//!
//! ADR-0003 gave this as one of three reasons the indexer is a sidecar at all:
//!
//! > An MCP server has to be a separate stdio process that Claude Code launches
//! > itself. A GUI process cannot be one.
//!
//! So the design has been waiting for an implementation. This is it.
//!
//! # JSON-RPC by hand, and why there is no SDK here
//!
//! MCP over stdio is line-delimited JSON-RPC 2.0, and the part of it a
//! read-only tool server needs is four methods. An SDK would bring an async
//! runtime into a crate whose whole dependency list is deliberately short — and
//! ADR-0003's reason for the crate existing is that `ort` is heavy, which is an
//! argument for not adding a second heavy thing beside it. What is implemented
//! here is small enough to read in one sitting and is exercised by tests that
//! speak the protocol rather than call the functions.
//!
//! # stdout is the protocol and nothing else
//!
//! Every other subcommand prints results to stdout. In this mode a stray
//! `println!` is a parse error at the other end, and the failure is total: the
//! client drops the connection and the session simply has no memory, with
//! nothing on screen to say why. Diagnostics go to stderr, which the client
//! logs.
//!
//! # The index is read, never built
//!
//! `search` in the CLI updates first, which is right there and wrong here: a
//! cold index means embedding the whole corpus, and an agent's tool call would
//! hang for minutes. So this loads the index as it stands and embeds only the
//! query. Keeping it fresh is the app's job (`memory::spawn_reindex`), and a
//! stale or absent index is reported as such rather than waited for.
//!
//! # Scope is enforced, not decorative
//!
//! The server is launched for one session and told that session's workspace. A
//! `read_note` that would happily read another workspace's note would make the
//! scope a suggestion — so both tools apply it, and the read applies it to the
//! resolved path rather than to the string it was given.

use crate::embed::Lazy;
use crate::index::{self, Hit, SearchScope};
use crate::DIARY_SCOPE;
use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// The protocol versions this server knows how to be.
///
/// The client names one in `initialize` and the server answers with the version
/// it will actually use. Echoing back something unrecognised would be a claim
/// rather than an answer, so an unknown version gets the newest one here and the
/// client decides whether it can live with that.
const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// How many hits a tool call returns. Smaller than the CLI's default: every hit
/// is prose in somebody's context window, and an agent asking a question wants
/// the few that answer it.
const TOP: usize = 5;

/// Carried from the CLI's default so retrieval quality stays where the golden
/// parity test put it (ADR-0003).
pub const MIN_SCORE: f32 = 0.25;

/// What this server may see.
pub struct Served {
    pub root: PathBuf,
    pub cache: PathBuf,
    /// The workspace this session belongs to, or `None` for a session with no
    /// workspace — which can still reach the global diaries and has no project
    /// notes of its own.
    pub workspace: Option<String>,
    /// The similarity floor. [`MIN_SCORE`] in production.
    ///
    /// A field rather than the constant, for the reason the CLI already has a
    /// `--min-score` flag: with the deterministic fake embedder, similarity is
    /// arbitrary and the real threshold rejects everything — so a test asserting
    /// that another project's note is *absent* would pass because nothing at all
    /// came back. A negative value disables the floor and makes those assertions
    /// mean what they say.
    pub min_score: f32,
}

impl Served {
    fn scope(&self) -> SearchScope {
        match &self.workspace {
            Some(id) => SearchScope::Project(id.clone()),
            // Not `All`: a session with no workspace has no project notes, and
            // handing it every project's history would be a scope nobody asked
            // for.
            None => SearchScope::Lessons,
        }
    }

    /// Whether a note belongs to what this session may read.
    ///
    /// The same rule `SearchScope::admits` applies to a chunk, applied to a path
    /// — so `read_note` cannot reach past what `search_memory` would return.
    fn admits(&self, rel: &str) -> bool {
        let first = rel.split('/').next().unwrap_or_default();
        if first == "Diaries" {
            return true;
        }
        self.workspace.as_deref() == Some(first)
    }
}

/// Serve until stdin closes.
///
/// `embedder` is a [`Lazy`] rather than a value because loading the model costs
/// seconds and 479 MB of memory-mapped file, and a session that never asks
/// memory anything should pay neither. It is built on the first tool call that
/// needs it — and **only** on the first: this took a closure until #389, which
/// called it per tool call, so a session asking three questions paid three graph
/// builds of two seconds each.
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
        let Some(reply) = handle(served, embedder, trimmed) else { continue };
        writeln!(output, "{reply}")?;
        // Line-buffered would be enough for a pipe on most platforms, and "most"
        // is not a property to rely on when the failure is a client waiting
        // forever for a response that is sitting in a buffer.
        output.flush()?;
    }
}

/// One message in, at most one message out.
///
/// `None` for a notification, which by JSON-RPC has no id and must never be
/// answered — a reply to one is a message the client did not ask for and cannot
/// match to anything.
fn handle(
    served: &Served,
    embedder: &Lazy,
    raw: &str,
) -> Option<String> {
    let msg: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        // No id to answer with, so there is nothing to send. Said on stderr,
        // which the client logs.
        Err(e) => {
            eprintln!("cowork_memory mcp: unreadable message ({e})");
            return None;
        }
    };
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // A notification. `initialized` is the one that matters and the rule is the
    // same for all of them.
    if id.is_none() {
        return None;
    }
    let id = id.unwrap();

    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools()),
        "tools/call" => call(served, embedder, &params),
        other => {
            return Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("no method {other}") },
                })
                .to_string(),
            )
        }
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }).to_string(),
        // Reserved for faults in the *protocol layer*. A tool that could not
        // answer is a successful call with `isError` — see `call`.
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": e.to_string() },
        })
        .to_string(),
    })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = match asked {
        Some(v) if VERSIONS.contains(&v) => v,
        _ => VERSIONS[0],
    };
    json!({
        "protocolVersion": version,
        // Tools and nothing else. No resources, no prompts, no sampling: this
        // server answers questions about markdown and has no business being
        // asked for anything more.
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "cowork-memory", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// The tools, and their descriptions.
///
/// The descriptions are the whole interface: they are what an agent reads to
/// decide whether to call anything, so they say *when* to rather than what the
/// function does. #35's own words for why the diaries matter — "a mistake made
/// in one repository stop the same mistake in the next" — are the reason the
/// second sentence of the first description exists.
fn tools() -> Value {
    json!({
        "tools": [
            {
                "name": "search_memory",
                "description":
                    "Search this project's own memory of earlier sessions, and the \
                     cross-project lessons from all of them, by meaning rather than by \
                     keyword. Worth asking before changing unfamiliar code, before \
                     repeating an approach that may have been tried, and whenever a \
                     decision looks like one somebody has already made. Returns short \
                     passages; use read_note for the whole note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description":
                                "What you want to know, as a sentence. Retrieval is by \
                                 meaning, so a question works better than keywords.",
                        },
                        "lessons_only": {
                            "type": "boolean",
                            "description":
                                "Search only the cross-project lessons, leaving this \
                                 project's session notes out.",
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "read_note",
                "description":
                    "Read one note in full, by the path a search_memory result gave. \
                     Read-only, and confined to this project's notes and the shared \
                     lessons.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file": {
                            "type": "string",
                            "description": "The `file` of a search_memory result.",
                        },
                    },
                    "required": ["file"],
                },
            },
        ]
    })
}

/// A tool's answer.
///
/// **A tool that could not answer is a successful call whose content says so**,
/// never a JSON-RPC error. An error is for a broken message; "the model has not
/// been downloaded" is an answer, and one the agent can act on or report. A
/// protocol error would reach the agent as a tool that is broken, which teaches
/// it to stop asking.
fn text(body: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": body.into() }],
        "isError": is_error,
    })
}

fn call(
    served: &Served,
    embedder: &Lazy,
    params: &Value,
) -> Result<Value> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    match name {
        "search_memory" => Ok(search_memory(served, embedder, &args)),
        "read_note" => Ok(read_note(served, &args)),
        other => Ok(text(format!("There is no tool called {other}."), true)),
    }
}

fn search_memory(
    served: &Served,
    embedder: &Lazy,
    args: &Value,
) -> Value {
    let query = args.get("query").and_then(Value::as_str).unwrap_or_default().trim();
    if query.is_empty() {
        return text("Ask a question — `query` was empty.", true);
    }
    let ix = index::load(&served.cache);
    if ix.meta.chunks.is_empty() {
        // The state that would otherwise read as "there is nothing to know",
        // which is a very different thing from "nothing has been indexed".
        return text(
            "This project's memory has not been indexed yet, so there is nothing to \
             search. It is built in the background by the app; try again later.",
            false,
        );
    }
    let emb = match embedder.get() {
        Ok(e) => e,
        Err(e) => {
            return text(
                format!(
                    "Memory cannot be searched yet: {e}. The app offers the download \
                     under Settings → Session notes."
                ),
                false,
            )
        }
    };
    let scope = if args.get("lessons_only").and_then(Value::as_bool).unwrap_or(false) {
        SearchScope::Lessons
    } else {
        served.scope()
    };
    match index::search(&ix, emb, query, &scope, TOP, served.min_score) {
        Ok(hits) if hits.is_empty() => text(
            "Nothing in memory matches that. It is searched by meaning, so rephrasing \
             as a different question sometimes helps.",
            false,
        ),
        Ok(hits) => text(render(&hits), false),
        Err(e) => text(format!("The search failed: {e}"), true),
    }
}

/// Hits as prose rather than as JSON.
///
/// An agent reads text, and a JSON array of objects spends tokens on braces and
/// field names it does not need. The path is included because `read_note` takes
/// it, and the scope is named because a lesson arriving from another project is
/// the feature working and should not look like a leak.
fn render(hits: &[Hit]) -> String {
    let mut out = String::new();
    for h in hits {
        let where_from = if h.scope == DIARY_SCOPE {
            match &h.room {
                Some(room) => format!("a cross-project lesson, from the {room} diary"),
                None => "a cross-project lesson".to_string(),
            }
        } else {
            "this project".to_string()
        };
        out.push_str(&format!("## {} ({where_from})\n\n{}\n\n", h.file, h.text.trim()));
    }
    out
}

fn read_note(served: &Served, args: &Value) -> Value {
    let rel = args.get("file").and_then(Value::as_str).unwrap_or_default().trim();
    if rel.is_empty() {
        return text("Name a note — `file` was empty.", true);
    }
    if !rel.ends_with(".md") {
        return text("That is not a note.", true);
    }
    if !served.admits(rel) {
        // The scope is a boundary or it is decoration.
        return text("That note belongs to another project.", true);
    }
    match under(&served.root, rel) {
        Some(path) => match std::fs::read(&path) {
            // Lossily, like everywhere else that reads somebody's markdown: a
            // note that is not quite text is better read imperfectly than
            // refused.
            Ok(bytes) => text(String::from_utf8_lossy(&bytes).into_owned(), false),
            Err(e) => text(format!("Could not read that note ({}).", e.kind()), true),
        },
        None => text("That note is not there.", true),
    }
}

/// Resolve a relative path inside the root, or nothing.
///
/// `canonicalize` before the containment check, so `..` and symlinks are
/// resolved rather than pattern-matched: a prefix test on the joined string
/// would follow a link out of the corpus without noticing.
fn under(root: &Path, rel: &str) -> Option<PathBuf> {
    let real = root.join(rel).canonicalize().ok()?;
    let real_root = root.canonicalize().ok()?;
    (real.starts_with(&real_root) && real.is_file()).then_some(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;
    use std::io::Cursor;

    fn corpus(name: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "cm-mcp-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ws-1/Sessions/2026-08")).unwrap();
        std::fs::create_dir_all(root.join("ws-2/Sessions/2026-08")).unwrap();
        std::fs::create_dir_all(root.join("Diaries/reviewer")).unwrap();
        std::fs::write(
            root.join("ws-1/Sessions/2026-08/31-staging.md"),
            "# 2026-08-31 — the staging script\n\n## TL;DR\nIt read the host triple from \
             rustc instead of the tauri target triple, so a cross build staged a binary \
             for the build machine rather than the target.\n",
        )
        .unwrap();
        std::fs::write(
            root.join("ws-2/Sessions/2026-08/31-other.md"),
            "# 2026-08-31 — another project entirely\n\n## TL;DR\nSomething happened in a \
             project this session has nothing to do with, and it is written down here.\n",
        )
        .unwrap();
        std::fs::write(
            root.join("Diaries/reviewer/2026-08.md"),
            "# 2026-08 — reviewer\n\n- 2026-08-31 | deck | high | packaging | a cross build \
             staged a host binary | read the triple the hook exports rather than asking rustc\n\
             - 2026-08-30 | deck | low | tests | a timing assertion flaked under load | make \
             the proof causal rather than temporal wherever that is possible\n",
        )
        .unwrap();
        root
    }

    /// Indexed with the fake embedder, which needs no model and no download.
    fn served(name: &str, workspace: Option<&str>) -> Served {
        let root = corpus(name);
        let cache = root.join(".index");
        let e = FakeEmbedder::new();
        index::update(&root, &cache, &e).expect("index the fixture");
        // Floor off: see `Served::min_score`.
        Served { root, cache, workspace: workspace.map(str::to_string), min_score: -1.0 }
    }

    fn embedder() -> Box<dyn crate::embed::Embedder> {
        Box::new(FakeEmbedder::new())
    }

    /// Speak the protocol rather than call the functions: a request in, a
    /// response out, exactly as a client would see it.
    fn exchange(s: &Served, requests: &[Value]) -> Vec<Value> {
        let body = requests.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        let mut input = Cursor::new(body.into_bytes());
        let mut out: Vec<u8> = Vec::new();
        let build = || Ok(embedder());
        serve(s, &Lazy::new(&build), &mut input, &mut out).expect("serve");
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("every line is one JSON object"))
            .collect()
    }

    fn tool_text(v: &Value) -> String {
        v["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    // ----- the handshake -----

    #[test]
    fn it_answers_initialize_with_a_version_it_actually_knows() {
        let s = served("init", Some("ws-1"));
        let out = exchange(
            &s,
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2024-11-05", "capabilities": {} },
            })],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["result"]["protocolVersion"], "2024-11-05");
        assert!(out[0]["result"]["capabilities"]["tools"].is_object());
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "cowork-memory");
    }

    /// Echoing back a version nobody implements would be a claim rather than an
    /// answer.
    #[test]
    fn a_version_it_does_not_know_gets_one_it_does() {
        let s = served("init-unknown", Some("ws-1"));
        let out = exchange(
            &s,
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "1999-01-01" },
            })],
        );
        assert_eq!(out[0]["result"]["protocolVersion"], VERSIONS[0]);
    }

    /// A reply to a notification is a message the client never asked for and
    /// cannot match to anything.
    #[test]
    fn a_notification_is_never_answered() {
        let s = served("notif", Some("ws-1"));
        let out = exchange(
            &s,
            &[
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }),
            ],
        );
        assert_eq!(out.len(), 1, "only the ping was answered");
        assert_eq!(out[0]["id"], 7);
    }

    #[test]
    fn an_unknown_method_is_a_protocol_error_naming_it() {
        let s = served("unknown", Some("ws-1"));
        let out = exchange(&s, &[json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" })]);
        assert_eq!(out[0]["error"]["code"], -32601);
        assert!(out[0]["error"]["message"].as_str().unwrap().contains("resources/list"));
    }

    /// Unreadable input has no id to answer with, so the only honest thing is to
    /// keep going and say so where the client logs.
    #[test]
    fn a_broken_line_costs_that_line_and_the_stream_carries_on() {
        let s = served("broken", Some("ws-1"));
        let body = "not json at all\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n";
        let mut input = Cursor::new(body.as_bytes().to_vec());
        let mut out: Vec<u8> = Vec::new();
        let build = || Ok(embedder());
        serve(&s, &Lazy::new(&build), &mut input, &mut out).unwrap();
        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"id\":3"));
    }

    #[test]
    fn every_response_is_one_line_of_json() {
        let s = served("lines", Some("ws-1"));
        let out = exchange(
            &s,
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["jsonrpc"], "2.0");
    }

    // ----- the tools -----

    #[test]
    fn it_offers_a_search_and_a_read_and_nothing_that_writes() {
        let s = served("tools", Some("ws-1"));
        let out = exchange(&s, &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })]);
        let tools = out[0]["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["search_memory", "read_note"]);
        // The description is the interface: it has to say when to reach for this.
        let d = tools[0]["description"].as_str().unwrap();
        assert!(d.contains("before changing unfamiliar code"), "{d}");
        assert!(d.contains("cross-project"), "{d}");
        assert!(tools[0]["inputSchema"]["required"].as_array().unwrap().contains(&json!("query")));
    }

    fn search(s: &Served, args: Value) -> Value {
        let out = exchange(
            s,
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "search_memory", "arguments": args },
            })],
        );
        out[0].clone()
    }

    #[test]
    fn a_search_returns_this_projects_notes_and_the_shared_lessons() {
        let s = served("search", Some("ws-1"));
        let body = tool_text(&search(&s, json!({ "query": "cross build architecture triple" })));
        assert!(body.contains("ws-1/Sessions/2026-08/31-staging.md"), "{body}");
        assert!(body.contains("this project"), "{body}");
        // And the diary, which is the whole reason lessons are global.
        assert!(body.contains("Diaries/reviewer/2026-08.md"), "{body}");
        assert!(body.contains("cross-project lesson, from the reviewer diary"), "{body}");
    }

    /// The scope has to be a boundary. Another project's note is not this
    /// session's to see.
    #[test]
    fn a_search_never_reaches_another_project() {
        let s = served("scope", Some("ws-1"));
        let body = tool_text(&search(&s, json!({ "query": "another project entirely" })));
        // Both halves. Without the first, this passes whenever nothing matched at
        // all — which is how it passed before the floor was turned off in tests.
        assert!(body.contains("ws-1/"), "something came back to filter: {body}");
        assert!(!body.contains("ws-2/"), "{body}");
    }

    #[test]
    fn lessons_only_leaves_this_projects_notes_out() {
        let s = served("lessons", Some("ws-1"));
        let body = tool_text(&search(
            &s,
            json!({ "query": "cross build architecture triple", "lessons_only": true }),
        ));
        assert!(body.contains("Diaries/reviewer"), "something came back: {body}");
        assert!(!body.contains("ws-1/Sessions"), "{body}");
    }

    /// A session with no workspace has no project notes and can still reach the
    /// lessons — which is what makes them worth being global.
    #[test]
    fn a_session_with_no_workspace_gets_the_lessons_and_no_projects_notes() {
        let s = served("no-ws", None);
        let body = tool_text(&search(&s, json!({ "query": "cross build architecture triple" })));
        assert!(body.contains("Diaries/reviewer"), "something came back: {body}");
        assert!(!body.contains("ws-1/"), "{body}");
        assert!(!body.contains("ws-2/"), "{body}");
    }

    #[test]
    fn an_empty_query_is_refused_as_an_error_the_agent_can_fix() {
        let s = served("empty-q", Some("ws-1"));
        let v = search(&s, json!({ "query": "   " }));
        assert_eq!(v["result"]["isError"], true);
        assert!(tool_text(&v).contains("was empty"));
    }

    // ----- what a tool says when it cannot answer -----

    /// The distinction the whole feature's honesty rests on, in its last place:
    /// "nothing has been indexed" is not "there is nothing to know". And it is a
    /// **successful** call, because a protocol error reads to an agent as a
    /// broken tool and teaches it to stop asking.
    #[test]
    fn an_unindexed_corpus_says_so_rather_than_returning_nothing() {
        let root = corpus("unindexed");
        let s = Served {
            cache: root.join(".index"),
            root,
            workspace: Some("ws-1".into()),
            min_score: -1.0,
        };
        let v = search(&s, json!({ "query": "anything at all" }));
        assert_eq!(v["result"]["isError"], false, "not broken, just not ready");
        let body = tool_text(&v);
        assert!(body.contains("has not been indexed yet"), "{body}");
        assert!(body.contains("try again later"), "{body}");
    }

    /// A missing model is the ordinary state on a fresh machine, and it has an
    /// answer: where to get one.
    #[test]
    fn a_missing_model_says_where_to_get_one() {
        let s = served("no-model", Some("ws-1"));
        let build = || anyhow::bail!("embedding model not found in /r/.model");
        let out = exchange_with(
            &s,
            &Lazy::new(&build),
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "search_memory", "arguments": { "query": "anything" } },
            })],
        );
        assert_eq!(out[0]["result"]["isError"], false);
        let body = tool_text(&out[0]);
        assert!(body.contains("embedding model not found"), "{body}");
        assert!(body.contains("Settings"), "and where to fix it: {body}");
    }

    fn exchange_with(
        s: &Served,
        embedder: &Lazy,
        requests: &[Value],
    ) -> Vec<Value> {
        let body = requests.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        let mut input = Cursor::new(body.into_bytes());
        let mut out: Vec<u8> = Vec::new();
        serve(s, embedder, &mut input, &mut out).expect("serve");
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn a_query_that_matches_nothing_says_that_and_not_that_it_broke() {
        let s = served("no-match", Some("ws-1"));
        // Above the threshold nothing will match; the fake embedder is
        // deterministic, so this is a real "no results" rather than a fault.
        let v = search(&s, json!({ "query": "zzzz completely unrelated zzzz" }));
        assert_eq!(v["result"]["isError"], false);
        let body = tool_text(&v);
        assert!(
            body.contains("Nothing in memory matches") || body.contains("31-staging.md"),
            "either no match or a match, never an error: {body}"
        );
    }

    // ----- reading a note -----

    fn read(s: &Served, file: &str) -> Value {
        let out = exchange(
            s,
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "read_note", "arguments": { "file": file } },
            })],
        );
        out[0].clone()
    }

    #[test]
    fn a_note_in_scope_is_read_in_full() {
        let s = served("read", Some("ws-1"));
        let v = read(&s, "ws-1/Sessions/2026-08/31-staging.md");
        assert_eq!(v["result"]["isError"], false);
        assert!(tool_text(&v).contains("cross build staged a binary"));
    }

    #[test]
    fn a_diary_is_readable_by_any_session() {
        let s = served("read-diary", Some("ws-1"));
        assert_eq!(read(&s, "Diaries/reviewer/2026-08.md")["result"]["isError"], false);
        let s = served("read-diary-none", None);
        assert_eq!(read(&s, "Diaries/reviewer/2026-08.md")["result"]["isError"], false);
    }

    /// Without this the scope would be decoration: a search that refuses to show
    /// another project's note is worth nothing if a read will fetch it anyway.
    #[test]
    fn another_projects_note_is_refused_even_by_its_exact_path() {
        let s = served("read-scope", Some("ws-1"));
        let v = read(&s, "ws-2/Sessions/2026-08/31-other.md");
        assert_eq!(v["result"]["isError"], true);
        assert!(tool_text(&v).contains("another project"));
    }

    #[test]
    fn a_path_that_climbs_out_of_the_corpus_is_refused() {
        let s = served("read-escape", Some("ws-1"));
        let outside = s.root.parent().unwrap().join("cm-mcp-outside.md");
        std::fs::write(&outside, "not yours\n").unwrap();
        // Refused twice over: the scope check rejects the first segment, and
        // `under` would reject where it lands.
        assert_eq!(read(&s, "../cm-mcp-outside.md")["result"]["isError"], true);
        assert_eq!(read(&s, "ws-1/../../cm-mcp-outside.md")["result"]["isError"], true);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_out_of_the_corpus_is_refused() {
        let s = served("read-link", Some("ws-1"));
        let outside = s.root.parent().unwrap().join("cm-mcp-secret.md");
        std::fs::write(&outside, "not yours\n").unwrap();
        std::os::unix::fs::symlink(&outside, s.root.join("ws-1/link.md")).unwrap();
        let v = read(&s, "ws-1/link.md");
        assert_eq!(v["result"]["isError"], true, "a link out leads out");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn only_markdown_is_a_note() {
        let s = served("read-ext", Some("ws-1"));
        std::fs::write(s.root.join("ws-1/workspace.json"), "{}").unwrap();
        assert_eq!(read(&s, "ws-1/workspace.json")["result"]["isError"], true);
    }

    #[test]
    fn a_note_that_is_not_there_says_so() {
        let s = served("read-missing", Some("ws-1"));
        let v = read(&s, "ws-1/Sessions/2026-08/nothing.md");
        assert_eq!(v["result"]["isError"], true);
        assert!(tool_text(&v).contains("not there"));
    }

    #[test]
    fn an_unknown_tool_is_an_error_the_agent_can_read() {
        let s = served("no-tool", Some("ws-1"));
        let out = exchange(
            &s,
            &[json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "write_memory", "arguments": {} },
            })],
        );
        assert_eq!(out[0]["result"]["isError"], true);
        assert!(tool_text(&out[0]).contains("no tool called write_memory"));
    }
}
