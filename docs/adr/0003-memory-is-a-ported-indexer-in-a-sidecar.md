---
status: Accepted
date: 2026-08-24
deciders:
  - evgenykharetski
---

# ADR-0003 — Memory is a port of a working indexer, and it runs as a sidecar

## Context

The app needs semantic search over what earlier sessions did and decided. The
obvious move is to design an indexer: pick an embedding model, choose a chunking
strategy, tune thresholds, and find out over months of use whether the retrieval
is any good.

There is a shortcut available, and it is unusually strong. The author already
runs `vault-index` — Python plus ONNX, semantic search over an Obsidian vault —
daily, and has done for long enough to know which queries it answers well. Its
chunking rules are not arbitrary: the `## TL;DR` section as a first and
highest-priority chunk, a 2000-character ceiling, a letter-count floor that
keeps markdown skeletons out of the results. Each of those exists because
something was wrong without it.

What does not port is the packaging: a 197 MB virtualenv, a manual setup script,
and a corpus a person fills by hand.

The other question is where the code runs. `ort` links ONNX Runtime, which is
not something to put in the main binary on three platforms for a feature a user
may never switch on.

## Decision

**Port `vault-index` rather than design an indexer.** Same model, same chunking,
same thresholds, same disposable-cache design. Where the two could differ, the
Python implementation wins.

Fidelity is asserted, not assumed. `crates/cowork-memory/tests/golden.rs` runs
every fixture through the port and compares against output recorded from the
reference implementation itself. The fixtures are generated rather than typed,
by a script that lives beside them, because each exists to land on a specific
code path at a specific length.

**Run it as a sidecar binary, `cowork_memory`**, following `cowork_report`:

- `ort` becomes a build dependency of one optional binary rather than of the app.
- An MCP server has to be a separate stdio process that Claude Code launches
  itself. A GUI process cannot be one.
- A CLI can be debugged by hand, which is how the reference is debugged today.

**In a crate of its own, outside any workspace.** `crates/cowork-memory` has its
own target directory. A root `[workspace]` would move `src-tauri`'s target
directory and break `scripts/stage-reporter.sh`, so the crate stays outside one
and its staging script builds from its own manifest.

**Amended by #389: one sidecar process, kept, rather than one per search.**

"Run it as a sidecar binary" was a decision about where ONNX Runtime lives, and
it stands. What it did not say is how many times that binary runs, and the answer
until now was *once per search* — which measured, on a real corpus with the model
file warm in the page cache:

| | wall | peak RSS |
|---|---|---|
| everything except the model — spawn, index read, cosine, JSON out | 0.02 s | 6.7 MB |
| the same search with the model | 2.03 s | 1830 MB |

So 99% of a search was ORT building the graph, and it is CPU rather than disk:
three consecutive searches ran 2.15 / 2.04 / 2.03 s with the file warm
throughout, which is what rules out OS-level prewarming as an answer. The corpus
is not the cost and will not become it — the index grows at ~3.5 KB per chunk, so
a hundred thousand chunks is 350 MB against the model's gigabyte and a half.

Held resident, the same searches take **6 ms**. The sidecar therefore grows a
`serve` mode — line-delimited JSON, one request per line — and the app keeps one
process for the whole deck. Three decisions came with it:

- **Its own mode rather than MCP**, which is also a long-lived stdio loop. MCP is
  a contract with Claude Code, so every change here would be a change to
  something a session depends on; and its answers are prose in content blocks
  written to be read by a model, which the app would have to parse back into the
  `Hit` records it just formatted.
- **It starts on demand, never at launch.** Warming costs 1.7 s and holds
  1.6 GB, and paying that on every start charges every person who never searches
  — the same objection this ADR and #35 already made about the launch path. The
  app warms it when the memory page is opened, where the wait overlaps with
  reading the list; every other caller warms it lazily on first use and then
  shares it.
- **It is reaped after five minutes idle**, because 1589 MB was measured resident
  after loading and it does not fall — the graph stays materialised. A deck open
  all day would otherwise hold that for a search somebody ran in the morning. The
  trade is the right way round: memory given back is certain, and a slow first
  search afterwards is one sentence on screen.

Everything degrades to the one-shot spawn it replaces. A sidecar that will not
start, a pipe that breaks, a reply that does not parse: the caller gets the old
path and a slow answer rather than no answer.

One defect this found rather than introduced: #376's MCP server took a closure to
build the embedder lazily and called it **per tool call**, so a session asking
three questions paid three graph builds. `embed::Lazy` builds once per process,
which fixes the MCP path as well as this one.

**Amended by #388: a session is told with the prompt, not only at startup.**

The original account of what a session is told was #35's — an MCP tool plus a
sentence in the system prompt saying when to reach for it — and #377 built
exactly that. It is not enough, and the evidence is recorded on #388: an agent
with both, asked in plain words, called neither and reconstructed the answer from
`git log`. What beat the instruction was a `UserPromptSubmit` hook injecting
search results into the same turn as the question.

Two properties decided it, and both are mechanism rather than accident. Context
that arrives **with the prompt** outranks a rule in the system prompt about every
question in general. And a block already shaped like an answer is read as one.

So the deck attaches a third command to `UserPromptSubmit` in
`hooks::build_settings_json`, beside the tracker guard and for the same reason it
is unconditional: the `--resume` path then has no branch to forget. The hook is a
thin client on the listener the reporter already uses — the search runs in the
app, which owns the corpus and the sidecar, because loading the embedding model
per prompt is precisely what #35's "off the launch critical path" was protecting.

Three constraints came with the amendment and are not optional:

- **A gate, on the app side.** This puts a search on the path of every message,
  which is a real cost. `memory::prompt::worth_searching` refuses anything too
  short, a slash command, a fenced block and a string with no words in it.
- **An empty result reads as empty.** The injection that beat the system prompt
  carried "use these results first" above hits from unrelated projects scoring
  around 0.5, and said nothing about this project having nothing. A confident
  empty result is worse than no result, so the block never carries a directive
  and says plainly when it found nothing.
- **Silence where memory cannot search.** No model, nothing indexed, no sidecar:
  the hook prints nothing at all. A session cannot act on "download the model",
  and a line about it above every message is noise. The surfaces that can act on
  it already say it.

The limitation this inherits rather than adds: `--settings` is Claude Code's
flag, and the deck launches Claude Code and nothing else. A session on another
CLI gets an instruction it cannot be given, and when the running half of #330
lands that has to be legible rather than silent.

## Consequences

The port is only as good as its parity test, which makes that test the most
load-bearing thing in the crate — and the reason CI runs the sidecar's suite
separately, since a crate outside the workspace is not reached by the app's
`cargo test`.

Character-versus-byte handling is the port's standing hazard. Every limit in the
reference counts code points except the big-file threshold, which counts bytes.
`str::len()` where `.chars().count()` was meant silently halves the intended
length on Cyrillic text and nothing else complains. Fixtures exist specifically
to make that substitution fail.

Regenerating the golden file needs the reference implementation, which lives on
one machine. The generated file is committed, so the test runs for everyone;
only regeneration is privileged. A golden file produced from the Rust port
instead would assert that the port agrees with itself.

Two binaries to stage and bundle instead of one.

## Alternatives considered

**Design an indexer.** Rejected: it trades a known-good retrieval quality for an
unknown one, and the unknown only resolves after months of real use.

**Modules inside the app binary.** Rejected: ONNX Runtime in the main binary on
every platform, for a feature that is opt-in, and no way to serve MCP.

**Shell out to the Python original.** Rejected: a 197 MB virtualenv and a Python
runtime become install requirements of a desktop app that otherwise has none.

**A member of a root workspace.** Rejected: it relocates `src-tauri/target` and
breaks sidecar staging, which is a working part of the release.
