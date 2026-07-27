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
}

fn embedder() -> Result<Box<dyn Embedder>> {
    if std::env::var("COWORK_MEMORY_FAKE_EMBED").is_ok() {
        return Ok(Box::new(FakeEmbedder::new()));
    }
    anyhow::bail!("no embedding model available yet — see `cowork_memory model --download`")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cache = cli.cache.clone().unwrap_or_else(|| cli.root.join(".index"));

    match cli.cmd {
        Cmd::Update { verbose } => {
            let e = embedder()?;
            let (_ix, rep) = update(&cli.root, &cache, e.as_ref())?;
            if verbose {
                eprintln!("root: {}", cli.root.display());
                eprintln!("cache: {}", cache.display());
            }
            println!(
                "indexed {} files, {} chunks ({} files changed)",
                rep.files, rep.chunks, rep.changed
            );
        }
        Cmd::Status { json } => {
            let ix = cowork_memory::index::load(&cache);
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "root": cli.root.display().to_string(),
                        "cache": cache.display().to_string(),
                        "files": ix.meta.files.len(),
                        "chunks": ix.meta.chunks.len(),
                        "dim": ix.meta.dim,
                    })
                );
            } else {
                println!("root:   {}", cli.root.display());
                println!("cache:  {}", cache.display());
                println!("files:  {}", ix.meta.files.len());
                println!("chunks: {} (dim {})", ix.meta.chunks.len(), ix.meta.dim);
            }
        }
        Cmd::Search { query, scope, top, min_score, json } => {
            let e = embedder()?;
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
    }
    Ok(())
}
