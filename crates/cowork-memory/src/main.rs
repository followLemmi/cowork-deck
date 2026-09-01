use anyhow::Result;
use clap::{Parser, Subcommand};
use cowork_memory::embed::{Embedder, FakeEmbedder};
use cowork_memory::index::{search, update, SearchScope};
use cowork_memory::SNIPPET;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "cowork_memory", about = "Semantic memory for cowork-deck")]
struct Cli {
    /// Corpus root, the memory directory.
    #[arg(long)]
    root: PathBuf,
    /// Index cache. Defaults to <root>/.index
    #[arg(long)]
    cache: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Incrementally reindex the corpus.
    Update {
        #[arg(long)]
        verbose: bool,
    },
    /// Semantic search. Updates the index first.
    Search {
        query: String,
        /// A workspace id, or "lessons", or "all".
        #[arg(long, default_value = "all")]
        scope: String,
        #[arg(long, default_value_t = 10)]
        top: usize,
        // allow_hyphen_values: clap otherwise reads "-1" as an unknown flag
        // rather than a negative value, and tests pass min-score below 0 to
        // disable the threshold entirely.
        #[arg(long, default_value_t = 0.25, allow_hyphen_values = true)]
        min_score: f32,
        #[arg(long)]
        json: bool,
    },
    /// Index statistics.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Serve the corpus over MCP on stdio, for a session to ask questions of.
    ///
    /// **Nothing but the protocol may reach stdout in this mode.** A stray line
    /// is a parse error at the other end and the client drops the connection, so
    /// the session simply has no memory with nothing on screen to say why.
    Mcp {
        /// The workspace this session belongs to. Omitted, the server serves the
        /// global diaries alone — which is what a session with no workspace has.
        #[arg(long)]
        scope: Option<String>,
    },
    /// Answer searches on stdin until it closes, with the model loaded once.
    ///
    /// For the app, not for a session: `mcp` is the contract with Claude Code
    /// and speaks in prose, and this speaks in `Hit` records. One process for
    /// the whole deck is what makes a search 20 ms instead of two seconds
    /// (#389).
    Serve,
    /// Download or inspect the embedding model.
    Model {
        #[arg(long)]
        download: bool,
        #[arg(long)]
        status: bool,
    },
}

fn model_dir(root: &std::path::Path) -> PathBuf {
    std::env::var("COWORK_MEMORY_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join(".model"))
}

fn embedder(root: &std::path::Path) -> Result<Box<dyn Embedder>> {
    if std::env::var("COWORK_MEMORY_FAKE_EMBED").is_ok() {
        return Ok(Box::new(FakeEmbedder::new()));
    }
    Ok(Box::new(cowork_memory::onnx::OnnxEmbedder::load(&model_dir(root))?))
}

/// Refuse to let the test embedder rewrite an index the real one built.
///
/// `index::update` rebuilds every file when the embedding width changes, which
/// is right for a model that actually changed and catastrophic for a width that
/// is a test affordance. Setting `COWORK_MEMORY_FAKE_EMBED` and running a search
/// against a real corpus silently replaced 384-dimension vectors with 64, and
/// every search afterwards answered "reindex is required" — the index is a
/// disposable cache (ADR-0004) so nothing was lost that a reindex did not
/// restore, but it cost the model that built it and said nothing while doing it.
///
/// An empty or fake-width index is left alone: that is the case the tests are,
/// and the case a fixture corpus is.
fn refuse_to_clobber(cache: &std::path::Path, emb: &dyn Embedder) -> Result<()> {
    if std::env::var("COWORK_MEMORY_FAKE_EMBED").is_err() {
        return Ok(());
    }
    /* The width recorded on disk, read straight out of `meta.json` rather than
       through `index::load`. The question is what is written down, not whether
       the cache currently loads: a torn `emb.bin` beside an intact `meta.json`
       still names vectors a real model produced, and `load` would answer 0 for
       it and wave the rebuild through. */
    let recorded = std::fs::read_to_string(cache.join("meta.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("dim").and_then(serde_json::Value::as_u64))
        .unwrap_or(0) as usize;
    if recorded != 0 && recorded != emb.dim() {
        anyhow::bail!(
            "refusing to reindex: {} holds {}-dimension vectors and COWORK_MEMORY_FAKE_EMBED \
             would rebuild them at {}. Unset it, or point --cache somewhere else.",
            cache.display(),
            recorded,
            emb.dim(),
        );
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cache = cli.cache.clone().unwrap_or_else(|| cli.root.join(".index"));

    match cli.cmd {
        Cmd::Update { verbose } => {
            let e = embedder(&cli.root)?;
            refuse_to_clobber(&cache, e.as_ref())?;
            let (_ix, rep) = update(&cli.root, &cache, e.as_ref())?;
            if verbose {
                eprintln!("root:  {}", cli.root.display());
                eprintln!("cache: {}", cache.display());
                if rep.rebuilt {
                    eprintln!("the embedder's width changed — rebuilding every file");
                }
                // One line per file, because on an incremental indexer the
                // question a verbose run is asked is which files were
                // re-embedded, and "3 files changed" cannot answer it.
                for f in &rep.reindexed {
                    eprintln!("reindexed {f}");
                }
                if rep.deleted > 0 {
                    eprintln!("{} file(s) left the corpus", rep.deleted);
                }
                if rep.reindexed.is_empty() && rep.deleted == 0 {
                    eprintln!("nothing changed");
                }
            }
            println!(
                "indexed {} files, {} chunks ({} files changed)",
                rep.files, rep.chunks, rep.changed
            );
        }
        Cmd::Status { json } => {
            let ix = cowork_memory::index::load(&cache);
            let md = model_dir(&cli.root);
            let model = cowork_memory::model::status(&md);
            // Counts alone cannot tell "never indexed" from "indexed an empty
            // corpus" — both are zero — and the app's memory panel has to
            // show those as different states.
            let state = if !cache.join("meta.json").exists() {
                "absent"
            } else if ix.meta.chunks.is_empty() {
                "empty"
            } else {
                "ready"
            };
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "root": cli.root.display().to_string(),
                        "cache": cache.display().to_string(),
                        "state": state,
                        "files": ix.meta.files.len(),
                        "chunks": ix.meta.chunks.len(),
                        "dim": ix.meta.dim,
                        // The index can be ready while the model is gone — the
                        // cache outlives it — so the app cannot infer one from
                        // the other and needs both reported.
                        "model": {
                            "dir": md.display().to_string(),
                            "state": model.state,
                            "have": model.have,
                            "total": model.total,
                        },
                    })
                );
            } else {
                println!("root:   {}", cli.root.display());
                println!("cache:  {}", cache.display());
                println!("state:  {state}");
                println!("files:  {}", ix.meta.files.len());
                println!("chunks: {} (dim {})", ix.meta.chunks.len(), ix.meta.dim);
                println!(
                    "model:  {} ({} of {} bytes) at {}",
                    model.state,
                    model.have,
                    model.total,
                    md.display()
                );
            }
        }
        Cmd::Search { query, scope, top, min_score, json } => {
            let e = embedder(&cli.root)?;
            refuse_to_clobber(&cache, e.as_ref())?;
            let (ix, _) = update(&cli.root, &cache, e.as_ref())?;
            let scope = match scope.as_str() {
                "all" => SearchScope::All,
                "lessons" => SearchScope::Lessons,
                other => SearchScope::Project(other.to_string()),
            };
            let hits = search(&ix, e.as_ref(), &query, &scope, top, min_score)?;
            if json {
                println!("{}", serde_json::to_string(&hits)?);
            } else {
                for h in &hits {
                    let room = h.room.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
                    println!("[{:.2}] {}{}", h.score, h.file, room);
                    let flat: String = h.text.split_whitespace().collect::<Vec<_>>().join(" ");
                    println!("    {}", flat.chars().take(SNIPPET).collect::<String>());
                }
            }
            // Both output modes say so, once: an empty result is a legitimate
            // answer, and stdout stays machine-readable either way.
            if hits.is_empty() {
                eprintln!("cowork_memory: no results above threshold");
            }
        }
        Cmd::Mcp { scope } => {
            let served = cowork_memory::mcp::Served {
                root: cli.root.clone(),
                cache: cache.clone(),
                workspace: scope,
                min_score: cowork_memory::mcp::MIN_SCORE,
            };
            // The embedder is built on the first tool call that needs one, not
            // here: loading the model costs seconds and 479 MB of mapped file,
            // and a session that never asks memory anything should pay neither.
            let root = cli.root.clone();
            let build = move || embedder(&root);
            // Once for the process, not once per tool call: a session asking
            // three questions paid three graph builds until #389.
            let lazy = cowork_memory::embed::Lazy::new(&build);
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let stdout = std::io::stdout();
            let mut output = stdout.lock();
            cowork_memory::mcp::serve(&served, &lazy, &mut input, &mut output)?;
        }
        Cmd::Serve => {
            let served = cowork_memory::serve::Served {
                root: cli.root.clone(),
                cache: cache.clone(),
            };
            let root = cli.root.clone();
            let build = move || embedder(&root);
            let lazy = cowork_memory::embed::Lazy::new(&build);
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let stdout = std::io::stdout();
            let mut output = stdout.lock();
            cowork_memory::serve::serve(&served, &lazy, &mut input, &mut output)?;
        }
        Cmd::Model { download, status } => {
            let dir = model_dir(&cli.root);
            if download {
                for f in cowork_memory::model::files() {
                    let mut last = 0u64;
                    cowork_memory::model::download_one(
                        &dir,
                        &f,
                        &cowork_memory::model::HttpFetcher::new(),
                        &mut |got, total| {
                            // One line per megabyte, so callers can parse progress.
                            if got == total || got - last >= 1_000_000 {
                                last = got;
                                println!(
                                    "{}",
                                    serde_json::json!({
                                        "file": f.name, "got": got, "total": total
                                    })
                                );
                            }
                        },
                    )?;
                }
            }
            if status || !download {
                println!(
                    "{}",
                    serde_json::json!({
                        "dir": dir.display().to_string(),
                        "present": cowork_memory::model::is_present(&dir),
                    })
                );
            }
        }
    }
    Ok(())
}
