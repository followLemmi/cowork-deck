---
status: Accepted
date: 2026-08-24
deciders:
  - evgenykharetski
---

# ADR-0004 — Markdown is the memory; the index is a cache that may be thrown away

## Context

A semantic index is a derived artefact: an embedding matrix plus the metadata
needed to map rows back to text. It can be corrupted by a crash mid-write, by a
half-copied directory, or by a change in the embedding model's output width.

There are two ways to treat that. The index can be the store — durable,
migrated, repaired — or it can be a cache over something else that is durable.
The choice decides what a corruption costs.

The corpus also has to carry scope: a search from one workspace must see that
workspace's notes and the global diaries, and not another workspace's. The
reference implementation guesses scope from the file's path and frontmatter,
because a vault is a pile of markdown with no application around it. This app is
the application, and it knows which workspace a session belonged to.

## Decision

**Markdown files are the source of truth. The index is a disposable cache.**

Any damage to the index means reindexing, never lost memory. A missing, corrupt
or length-desynchronised cache loads as an *empty* index rather than an error,
and the caller rebuilds it. That is deliberately quiet: the alternative — a
diagnostic the caller has to interpret — puts a decision in front of the user
where the correct action is always the same.

**Scope comes from position in the layout, not from a heuristic.**

```
<corpus root>/
  {workspace_id}/Sessions/YYYY-MM/DD-topic.md
  {workspace_id}/Facts.md
  Diaries/{room}/YYYY-MM.md          # global, cross-project
  .index/                            # meta.json + emb.bin
  .model/
```

The first path segment is the scope; `Diaries` is the reserved global one. The
reference's project-guessing layer is dropped entirely rather than ported.

The root is a parameter, and this record deliberately does not say where the app
puts it. That the layout *within* the root is fixed is the decision here;
choosing the directory is a separate one, and it belongs wherever the app is
wired to launch the sidecar.

> **Answered since.** It is the app's config directory — the store's directory
> and the sync repository root, one and the same. ADR-0006 decided it for sync;
> ADR-0010 says plainly that it is also the corpus root, so this paragraph is no
> longer an open question.



**Facts are appended, never rewritten.** A superseded line is marked, and the
replacement is added below it.

## Consequences

An embedding model of a different width invalidates every stored row, so the
whole corpus is re-embedded rather than the modified files only. Treating that
as an ordinary incremental pass would leave untouched files recorded with no
chunks at all, and the next run — seeing them unchanged — would never re-embed
them. The content would be gone with the length invariant still satisfied and
nothing reported.

The cache can be deleted at any time for any reason, which makes it safe to
exclude from anything that copies the memory directory elsewhere.

Notes are only as good as what writes them. Making the corpus fill itself is a
separate problem, and the one the feature actually stands on.

Scope is exact, and it is also rigid: a note is reachable under the workspace id
it was filed under, and moving it means moving the file.

## Alternatives considered

**A vector database.** Rejected: a corpus of a few thousand chunks is a matrix
that multiplies in microseconds, and a database would be a second durable store
to keep consistent with the first.

**Index raw transcripts instead of summaries.** Rejected as noise — tool calls,
diffs and abandoned reasoning — and it would make the index the only copy of
anything worth reading.

**Port the project-guessing heuristics.** Rejected: they exist because the
reference has no application around it to ask. Guessing what is already known is
a source of wrong answers with no upside.

**Report a corrupt cache as an error.** Rejected: the caller's only sensible
response is to rebuild, so the diagnostic buys a decision nobody needs to make.
