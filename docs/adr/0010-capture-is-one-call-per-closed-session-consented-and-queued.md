---
status: Accepted
date: 2026-08-31
deciders:
  - evgenykharetski
---

# ADR-0010 — Capture is one model call per closed session, consented at the close and owed to a queue

## Context

ADR-0003 and ADR-0004 settled how memory is indexed and where it lives. Neither
answers the question the feature actually stands on: what puts anything in the
corpus. #35 is explicit that it cannot be the transcripts themselves — indexing
raw logs was rejected as noise, tool calls and diffs and abandoned reasoning —
and equally explicit that it cannot be a person keeping notes, because the
reference implementation's corpus was hand-written and a new user's would stay
empty forever.

So something has to read a session and write prose about it, and three questions
had to be answered before any of it could be built. Each could have gone the
other way, and each has a cost attached that lands on somebody other than us.

**At what granularity.** One summary per session, or one pass over a day's work.

**Who agrees, and when.** Capture reads a whole transcript and sends it to a
model under the person's own Claude Code credentials. Every note is charged to
their subscription or their API budget — a cost they did not incur by closing a
tile and would not otherwise expect from doing so.

**What guarantees the note is written.** By the time a summary job runs, the
session it is about is gone: the tile is closed, the PTY is dead, and
`transcripts::forget` has run. Whatever is lost here cannot be recovered by
trying again, which is a different class of failure from a request that can
simply be repeated.

## Decision

**One `claude -p` per closed session.** A summary of two unrelated sessions is a
summary of neither, and a day's work is usually several unrelated sessions.

The cost that follows is a call per closed tile, and everything economical about
the implementation follows from that rather than from taste: the transcript is
reduced to its prose before anything is sent, what survives is capped in
characters, a session with nothing in it is never sent at all, the default system
prompt is replaced rather than appended to, and the model is the cheap one — the
job is shortening prose that is already in the request, which is the task least
sensitive to model strength.

**Consent is asked at the close, and remembered.** Not configured once in a
settings panel: the close is the moment somebody knows what the session was and
whether it is worth a note, and a switch set months ago is not consent to this
call. Remembered, because being asked on every close is how a question becomes a
reflex click and a reflex click is not consent.

The remembered answer therefore has **three** states, not two. "Never asked" is
its own value: a default of "no" would decide the question in the app's favour,
and a default of "yes" would spend somebody's money on their first close.

**The question says what it costs.** What is sent, whose account it runs on, and
that it spends — in the sentence that asks, above the buttons, not in a hint
below them. A person who finds out from an invoice was not asked. The same
sentence appears in the settings section and in the README, and what a capture
actually cost is kept on its job record because the figure arrives with the reply
and re-running the model is the only other way to get it back.

**Durability lives in a queue that survives a kill, not in the call at close
time.** `wrapup.jsonl`, append-only, recovered at startup, one job at a time.

An attempt is counted by the `started` event rather than by a reported failure,
and that is the load-bearing detail rather than a nicety: a job that takes the app
down with it never reports anything, so counting only reported failures makes
recovery the loop — crash, requeue, crash, on every launch until somebody deletes
a file they have never heard of.

**The memory root and the sync repository root are the same directory.** ADR-0004
deliberately left the corpus root a parameter — "choosing the directory is a
separate one, and it belongs wherever the app is wired to launch the sidecar" —
and ADR-0006 answered it for the sync repository without saying it was also
answering it for memory. It was. The app's config directory is the store's
directory, the sync root and the corpus root, and this record exists partly so
that a reader of ADR-0004 is not left looking for the answer.

## Consequences

**A cost per closed tile, charged to the person, which is why consent is asked
rather than assumed.** It also sets the ceiling on how thorough capture may
reasonably be: any improvement that costs more tokens is an improvement somebody
else pays for, and has to be argued on that basis.

**The transcript path has to be captured before the close, not resolved when the
job runs.** `close_session` calls `transcripts::forget`, so the instant a tile
closes the app can no longer answer "which file was this session writing to". A
job that stored a session id and resolved the path later would work perfectly
every time it was drained promptly and find nothing at all after a restart — a
fault that only appears in the case the queue exists for. The note is therefore
an argument of `close_session` rather than a call the frontend makes before it:
an ordering inside one function cannot be got wrong by a caller.

**A window between the close and the note in which the session is gone and the
job is all that is left of it.** That window is what makes the queue's durability
the part to get right, and it is also the reason the guarantee is stated
precisely: `write_all` is unbuffered, so no signal including `SIGKILL` can take a
queued line back, and nothing calls `fsync`, so a power cut can still lose the
tail. An `fsync` per append would put a disk flush on the path of closing a tile
to buy durability against a failure whose cost is one session's summary.

**Reading a session's log is a per-CLI question, and finding that out cost a
defect.** The first implementation parsed Claude Code's shape only. Handed a
Copilot log — or an opencode one, which is a directory tree rather than a file —
it found no turns, concluded the session was empty, and reported success having
written nothing: silently, permanently, and indistinguishably from a tile opened
by accident. The fix was a digester per CLI with an honest `None`
(`memory::transcript`), answered the way `Unavailable::NoReader` answers it in the
activity epic. **Who summarises** stayed a separate axis: Claude, for every
session, whichever CLI produced the transcript, because shortening prose does not
need the model that wrote the work.

**A diary room's description is the person's own prose inside a model request.**
It is bounded and flattened to one line before it is sent, and — the guard that
actually matters — a lesson's room is checked against the configured names and the
note itself is assembled by `corpus::Note::render` rather than by the model. So
the most a description can influence is which room a lesson lands in, which is
what it is for.

**A note is written by a model, and may be wrong.** Nothing downstream treats the
corpus as authoritative; it is somebody's notes, indexed. Facts are appended and
marked rather than rewritten (ADR-0004) precisely so that a wrong one can be
superseded rather than argued with.

## Alternatives considered

**One summary per day, or per workspace per day.** Rejected: cheaper per note and
worse at the only thing a note is for. Two unrelated sessions summarised together
produce a paragraph that retrieves for neither query.

**Capture by default, with an opt-out.** Rejected outright. It spends money before
anybody agreed to spend it, and the first a person would know is a bill or a
directory of notes they did not ask for. An opt-out is a defensible default for
something free; this is not free.

**Run the call at close time and wait for it.** Rejected: closing a tile would
wait on a model, and a queue that only drains while its tile is on screen loses
exactly the sessions closed on the way out of the app.

**Best effort — call at close, drop it on a crash.** Rejected: the loss is
unrecoverable. The session is gone, so "try again later" has nothing to try.

**Ask the model for markdown and write what it returns.** Rejected: a model asked
for markdown occasionally returns markdown that is *almost* right, and "almost"
here means frontmatter parsed as prose or a `## TL;DR` the indexer does not
recognise — a fault that surfaces months later as a note that never comes back
from a search. The model returns fields; the file's shape is ours.

**A `SessionStart` injection, so a session begins knowing what memory holds.**
Rejected in #35 and not reopened here: an agent that asks right before making a
change phrases its query better than anything guessable at startup, and memory
stays off the session launch critical path. How a session reaches memory at all is
Phase 3's question (#376, #377).
