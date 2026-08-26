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
