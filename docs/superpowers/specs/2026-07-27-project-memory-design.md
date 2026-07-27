# Project memory — design

Date: 2026-07-27
Status: approved, ready for planning

## Problem

Every cowork-deck session starts blind. Decisions, gotchas and lessons from previous
sessions live only in transcripts nobody reads. The roadmap calls this "Project memory".

A working reference implementation already exists as the author's personal setup
(`vault-index`: Python + ONNX semantic search over an Obsidian vault, fed by a `/wrapup`
slash command). It is tested and it works. It cannot be shipped as-is: it costs the user
a 197 MB Python venv, a 458 MB model and a manual `setup-vault-index.sh`, and its corpus
is hand-written — a fresh user would have an empty index forever.

This design ports the proven mechanics into the app so that every user gets them without
setup and without a writing habit.

## Goals

- Semantic search over past sessions, as a first-class app feature, for the human and for the agent.
- The corpus fills itself. No new user habit is required.
- Lessons learned transfer **across projects** — a mistake made in project A is not repeated in project B.
- No regression to the app's stated non-goals: no cloud, no proxying, and the base bundle stays small.

## Non-goals

- Sharing memory with a team (memory is local and personal; in-repo storage was rejected).
- A vector database. The corpus is thousands of chunks; brute-force cosine over a
  `N x 384` matrix is microseconds. No HNSW, no FAISS, no sqlite-vss.
- Indexing raw transcripts. They are noise: tool payloads, diffs, abandoned reasoning.

## Decisions

| Question | Decision |
|---|---|
| Core value | Semantic search over history |
| Corpus source | Auto-summaries, written by a separate `claude -p` run per session |
| Search engine | Port of `vault-index`: same model, same chunking, same disposable-cache design |
| Model file | `onnx/model.onnx` (fp32, 470 MB) + `tokenizer.json` — exactly what `vault-index` uses |
| Storage | Central: `<app_data_dir>/memory/`, alongside the existing `Store` JSON files |
| Diary scope | **Global**, not per-project — this is what makes lessons transferable |
| Diary rooms | User-configured, seeded with defaults; the model routes lessons by room description |
| Capture consent | Asked at tile close; "yes" enqueues a durable job |
| Agent access | MCP tool, plus a system-prompt instruction to consult lessons before writing code |

## Architecture

A second sidecar binary, `cowork_memory`, mirroring the existing `cowork_report` pattern
(`src-tauri/src/bin/` + `scripts/stage-reporter.sh`).

```
cowork_memory update | search | status     # same shape as vault-index
cowork_memory capture --transcript <p> --project <id>
cowork_memory model --download
cowork_memory mcp                          # stdio MCP server
```

Why a sidecar rather than modules in the main binary:

- `ort` pulls in `libonnxruntime`. As a sidecar it is a build dependency of one optional
  binary instead of the whole app on three platforms.
- An MCP server must be a separate stdio process — Claude Code launches it itself.
  A GUI process cannot be one.
- A CLI is debuggable by hand, exactly the way `vault-index` is debugged today.

The main app changes in four small places:

- `hooks.rs` — additionally emit `--mcp-config` and `--append-system-prompt`.
- `cowork_report` — pass `transcript_path` from the hook payload on `SessionEnd`.
- `listener.rs` — on `ended`, enqueue a wrapup job.
- `commands.rs` + frontend — palette search, settings panel, memory panel.

### Project identity

`vault-index` guesses the project (`detect_project()` on path + `repo:` frontmatter, CWD
substring matching in the SessionStart hook). The app *knows* it: a tile belongs to a
workspace. `project` is the workspace id, stamped at write time, used as a search filter.
The whole guessing layer is dropped.

## Corpus

Markdown is the source of truth. The index is always a disposable cache.

```
<app_data_dir>/memory/
  {workspace_id}/Sessions/YYYY-MM/DD-topic.md   # "## TL;DR" required, priority chunk
  {workspace_id}/Facts.md                       # - YYYY-MM-DD [active] subject — predicate — object
  Diaries/{room}/YYYY-MM.md                     # global, cross-project lessons
  queue.json                                    # durable wrapup jobs
  rooms.json                                    # user-configured diary rooms
  .model/                                       # model.onnx + tokenizer.json
  .index/                                       # meta.json + emb.bin
```

Facts follow the existing convention: never delete a line, mark `[superseded <date>]` and
append the replacement.

### Diary rooms

Rooms are a user-configured entity, a third alongside `workspaces.json` and `skills.json`,
seeded on first run with `code-reviewer`, `architect`, `general`. A room is `id`, name and
**description**. The description is functional, not decorative: it is what the capture
prompt uses to route a lesson. A room with no description will never receive entries.

Routing is semantic — the capture prompt receives the room list and picks one, or none.
Scenarios do not bind to rooms, so a newly created room works immediately.

## Write path

```
tile close → "save a summary of this session?" → yes → job enqueued
                                                 no  → nothing written

worker (1 by default) → claude -p → markdown → index update
```

The question is asked only when there is someone to ask:

| Event | Behaviour |
|---|---|
| User closes a tile | Ask |
| Session ends or fails on its own | Ask, if the window is open |
| Window close (kills all sessions) | Enqueue silently |
| Scheduled scenario firing unattended | Enqueue silently |

An unasked question means "yes, enqueue". Nothing is lost to absence, and the entry can
still be deleted from the memory panel afterwards.

### Queue

`queue.json` holds `{id, session_id, workspace_id, transcript_path, created_at, state, attempts}`.
It is a file, not process state — that is the entire point.

Recovery on launch mirrors the existing scheduler catch-up: `pending` jobs are picked up,
and `running` jobs (the app was killed mid-job) are reset to `pending`. Exhausted jobs
become `failed` and appear in the memory panel, because a silent failure is the worst kind.
A job whose transcript no longer exists (Claude Code's `cleanupPeriodDays`, 30 by default)
is closed as stale, not failed.

Concurrency defaults to one worker. Closing ten tiles is ten model calls; a queue exists so
they need not run at once. It also removes contention on `Facts.md` and the diaries.

### Capture

The job extracts message text from the transcript jsonl — tool calls, diffs and abandoned
branches are dropped — and runs `claude -p` with a fixed prompt plus the room list. It
returns one structure: title and slug, `## TL;DR` lines, project facts, and an array of
lessons (room, severity, category, what happened, how to avoid).

**An empty lesson array is a legal and expected outcome.** Most sessions teach nothing.

Two guards keep the diaries dense, because a diary consulted before every task is only
useful while it stays dense:

- Sessions below the capture floor are never captured — a thirty-second session produces
  no lesson and the call costs money.
- Before appending a lesson, cosine against existing entries in the same room. Above the
  dedup threshold, bump the date and repeat counter on the existing entry instead of adding
  a line. The diary grows with *distinct* lessons, not with sessions; repetition becomes a
  ranking signal.

### Tunables

Every one of these is a setting with the default below. They are named here because
"a few turns" and "above the threshold" are not implementable as prose.

| Setting | Default | Note |
|---|---|---|
| Capture model | Haiku | Distillation, not reasoning |
| Capture floor | 3 user turns | Below this, no job is created |
| Transcript budget | 60 000 chars | Head + tail if exceeded, middle elided |
| Queue concurrency | 1 | Raising it increases lock contention on `Facts.md` |
| Retry attempts | 3 | Then `failed`, visible in the panel |
| Diary dedup threshold | cosine 0.85 | Tune against a real diary before shipping |
| Search result limit | 10 | Per scope |

## Read path

### Index

`meta.json` + `emb.bin`. Chunking is ported with its existing decisions: `## TL;DR` is the
first and priority chunk, 2000-char ceiling, identical chunks deduped, and the noise filter
(120 letters minimum, 40 for TL;DR) that keeps markdown skeletons out of the top results.

Each chunk carries a scope — a workspace id, or "diaries" plus a room. A query from
workspace W searches `W ∪ diaries`, always. That union is what makes lessons transferable.

Search is brute-force cosine over unit vectors.

### Surfaces

**Palette — for the human.** A "Память" entry, a query, results with date, file and snippet.
`palette.ts` and `modal.ts` already exist.

**MCP — for the agent.** The sidecar in `mcp` mode, registered via `--mcp-config` inline
JSON where `--settings` is already built. One tool, `memory_search(query, scope)`, where
scope is project / lessons / all.

There is deliberately **no** SessionStart injection. Telling the session — via
`--append-system-prompt` — to consult lessons before writing code beats injecting them:

- The agent's query is far better. At session start the task is not yet understood; by the
  time it is about to edit, the agent can ask a specific question.
- Lessons arrive when they apply, not thirty minutes earlier.
- Memory stays off the critical path of session startup entirely.

The cost is that the check is advisory. A guaranteed injection of irrelevant lessons is
worse than an optional retrieval of relevant ones.

The instruction text is editable in settings and can be turned off.

### Model acquisition

`cowork_memory model --download` streams progress on stdout; the app spawns it and pipes
progress into the UI. Downloads go to `.part` with HTTP Range resume (the host returns
`206` and `accept-ranges: bytes`) and are renamed atomically, so a file that looks complete
is complete.

Expected sizes are known exactly — 470 301 610 and 9 081 518 bytes — so progress is real
and truncation is detectable. No sha256 is published for these files, so final verification
is stronger and practical: load the model and embed a probe string. A wrong-shaped vector
fails loudly, which a corrupt model otherwise would not.

"Memory is ready" is two conditions, and both are shown, or the user sees a green tick over
an empty search:

```
Model   ▓▓▓▓▓▓▓░░░  312 / 470 MB     absent | downloading | verifying | ready | error
Index   1 622 chunks, 650 files      empty | building | ready
```

Until the model is ready, search reports its status rather than returning nothing — a
silent empty result is indistinguishable from "no matches". Capture works regardless and
accumulates markdown; the index is built once the model arrives.

## Error handling

The rule is the one the README already states: the terminal is never affected. Memory is
an overlay, and any failure of it must be invisible to a running session.

| Failure | Behaviour |
|---|---|
| `claude` not found | Jobs wait in the queue, shown in the panel; nothing is lost |
| `claude -p` fails or returns junk | Bounded retries → `failed`, visible in the panel; tile unaffected |
| Transcript deleted by retention | Job closed as stale, not failed |
| Model not downloaded | Capture writes markdown, index marked dirty, search reports status |
| Download interrupted | `.part` + Range resume |
| Corrupt model | Probe vector fails → error offering re-download |
| Corrupt index, or meta/emb length mismatch | Silent full rebuild, as `vault-index` does |
| Concurrent index / `Facts.md` writes | Lock file, single writer |
| Disk full, permissions | Error in the panel; markdown as source of truth survives |
| MCP server fails to start | Session runs without memory, as it runs without hooks today |

## Testing

The foundation is the existing `FakeEmbedder`: deterministic hash vectors behind an env
var. With it, indexing, search, ranking and diary dedup are all testable with no model and
no network. It is the single most valuable thing to port, and it must be ported first.

- **Port parity.** Chunking is verified by golden tests against the Python implementation's
  output over the same corpus — identical chunk boundaries, identical letter-count filtering,
  identical TL;DR priority. This is the only way to substantiate "we did it the same way".
- **Capture.** The `claude -p` call sits behind a trait; tests inject a canned response.
  Transcript text extraction is tested against a fixture jsonl.
- **Queue.** Enqueue, recovery of interrupted `running` jobs, attempt ceiling, stale
  transcript, concurrency cap — pure logic over a temp dir, in the style of `store.rs` tests.
- **Download.** Source behind a trait; resume, length mismatch, atomic rename.
- **Integration.** Sidecar CLI and stdio MCP, in the style of the existing `tests/reporter.rs`.
- **`hooks.rs`.** Extend the existing test: `--mcp-config` and `--append-system-prompt`
  must have the right shape.

## Phasing

This is too much for one implementation plan. Three phases, each independently valuable and
independently shippable, each getting its own plan:

**Phase 1 — the sidecar, standalone.** `corpus`, `embed` (`Fake` first, then `Onnx`),
`index`, and the `update` / `search` / `status` / `model --download` commands. No app
changes at all. Done when the CLI reproduces `vault-index` behaviour on the same corpus and
the golden parity tests pass. This phase carries all the risk worth retiring early: the port
fidelity and the ONNX dependency.

**Phase 2 — the write path.** `capture`, the queue, the tile-close question, recovery on
launch, and the `transcript_path` change in the reporter. Done when closing tiles fills the
corpus and killing the app mid-job loses nothing. Search is still CLI-only here.

**Phase 3 — the surfaces.** Palette search, MCP registration, the system-prompt
instruction, the settings panel with download progress, and the memory panel with failed and
stale jobs. Done when the agent consults lessons on its own and the human can search from
the palette.

Rooms configuration lands in phase 2 (capture needs the room list) with its UI in phase 3.

## Notes for planning

- A fresh worktree needs `npm run stage:reporter` before `cargo test`, or the backend
  build fails on the missing sidecar resource. A second sidecar makes this staging step
  more load-bearing; it should be part of the build docs.
- `claude --mcp-config` accepts inline JSON, like `--settings` — no config file needed.
- README roadmap: "Project memory" moves out of Later, and the non-goals section stays
  intact (no cloud, no proxying, small bundle — the model is an opt-in download, not bundled).
