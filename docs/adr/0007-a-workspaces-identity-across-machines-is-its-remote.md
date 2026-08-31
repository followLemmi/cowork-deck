---
status: Accepted
date: 2026-08-27
deciders:
  - evgenykharetski
---

# ADR-0007 — A workspace's identity across machines is its remote, and merging two records moves files rather than aliasing them

## Context

A workspace id is `crypto.randomUUID()` on whichever machine first added the
folder. That is fine while one machine is the only one there has ever been, and
wrong the moment a second appears: two machines that each added the same project
before sync was switched on never agreed on an id, so the arriving record matches
nothing local and a second workspace is written for a project that already has
one. The deck shows the project twice, with its sessions and its memory split
across two ids, and nothing says the two are the same (#348).

The path cannot stand in for identity. It is stripped on the way out precisely
because it is one machine's disk (ADR-0006), and two machines rarely put a
project in the same place anyway. The name cannot either: two projects called
`api` are common, and merging them on a name match destroys real history.

So there are two questions. What makes two records one project, and what actually
happens to the losing id's history when somebody says they are.

The second question is the harder one, and it is why `Question::Duplicate` sat in
the codebase unreachable for two releases. Its own doc comment states the
constraint: "merging means one of the two memories stops being findable under the
surviving id, and that is a loss of history rather than a tidy-up".

## Decision

> **Amended by [ADR-0010](0010-where-there-is-no-remote-the-folder-is-the-identity.md)**
> on two points: a remote may be called something other than `origin`, and a
> project with no remote at all is identified by its folder on this machine.

**Identity across machines is the remote URL of the workspace's folder,
normalised.** `git remote get-url origin`, not `gh`: the comparison needs a
string both machines produce, not a pretty `owner/name`, and asking `gh` costs a
network round trip and an authenticated account. Two spellings of one repository
— `git@host:o/r.git` and `https://host/o/r` — normalise to the same key.

**A workspace with no remote has no cross-machine identity, and is never offered
as a duplicate of anything.** Name plus something else is a guess, and guessing
wrong merges two real projects. It is fair for those to stay unrecognised, as
long as the ones that can be recognised are. *(Amended by ADR-0010: two records
on this machine pointing at one folder are recognised, which needs no agreement
between machines and is not a guess.)*

**The answer is remembered on the record, not re-derived.** `Workspace.repo`
holds the URL *and the folder it was read in*. The folder is what makes the cache
safe: a workspace pointed somewhere else re-resolves instead of carrying the old
project's identity to the new one. `None` for the URL is an answer — "asked, and
this folder has no remote" — and is stored as such, or every five-minute cycle
would ask the same question again for the rest of that workspace's life.

The URL travels; the folder does not. It is the one field that is half local and
half not.

**"These are the same project" and "these are not" are both decisions, recorded
in a ledger that travels with the repository** (`identity.json`). Neither can be
re-derived: the first survives the remote being renamed, and the second is the
whole content of "no, those are two different checkouts of the same fork". The
answer is about the projects, not about the machine that happened to be asked, so
the other machine does not ask it again.

A merge in particular *has* to travel. Withdrawing the losing record without
saying why would leave the machine that owns that id republishing it on its next
cycle, forever.

**Merging moves files. It does not alias ids.** The surviving record is the one
with a folder on this machine, because that is exactly what the other one is
missing. Then:

- **Memory** — everything under `{losing_id}/` moves under `{surviving_id}/`.
  The first path segment *is* the search scope (ADR-0004), so moving the files is
  the redirect, with no alias table anywhere to keep in step.
- **The run journal, the deck layout, the terminal drawer, scenarios, and the
  remembered active workspace** — the id is rewritten in place, in this machine's
  own files. The journal is edited line by line rather than folded through
  `RunRecord` and re-emitted, so a line this build cannot parse survives.
- **Tracker cards** — nothing. A board root comes from the workspace's path and
  its name (`tasks_cmd::resolve_root`), never from its id, so the cards are
  already where the surviving workspace will look.
- **`workspace.json`** — withdrawn, not moved. It is the record, not memory.

**Nothing is overwritten.** A note that collides with one already there is kept
beside it under a numbered name, with the extension intact — what may be
published is `*/Facts.md` and `*/Sessions/**/*.md`, so a suffix after the
extension would silently stop the note travelling. `Facts.md` is the exception
and is appended to, because facts are appended and never rewritten (ADR-0004)
and concatenating two machines' lines is what the format means.

**Applying a merge is idempotent**, because it happens twice: once where the
answer was given, and again on every other machine when it pulls the ledger.

## Consequences

The `RepoOf` resolver parameter is gone from `adopt` and `publish`. It existed
only because resolving meant asking `gh`, and every call site in the shipped
build passed a closure that answered `None` — which is why `Question::Duplicate`
could not be raised at all. With the answer on the record there is no resolver to
forget to pass, and the whole class of failure goes with it.

Two machines each raise the duplicate as "fold the other one into mine", because
each is the one with a folder. Whichever is answered first wins, and the other
machine applies it and keeps its own path. Declining is symmetric, so one decline
settles it everywhere.

For one cycle after a merge, the machine that owned the losing id can still
publish it — it had not pulled the answer yet. `adopt` reports such a record for
withdrawal rather than adopting it, so the two machines converge instead of
taking turns republishing it.

The ledger is a file two machines write and git resolves, so a cycle
(`a→b`, `b→a`) is representable even though no person could ask for one.
`canonical` is bounded by the number of merges rather than trusting the data,
because the alternative is an app that hangs on the next pull.

Scenarios still have no equivalent. `merge_skill` is keyed on the id the same
way, and two machines that each wrote the same scenario by hand get two of them.
Unlike a workspace, a scenario has no remote to be recognised by — its identity
would have to come from its prompt, which is a guess — so this record deliberately
does not extend to them.

## Alternatives considered

**Ask `gh` for `owner/name` per workspace on the sync tick.** Rejected, and the
build that shipped with `Duplicate` unreachable was honest about why it had not
done it: a subprocess per workspace every five minutes, for a value only a
machine that has never seen the project needs.

**Alias the losing id on read — keep both directories, and teach search, the
journal and the history screen to follow a redirect.** Rejected: it puts the
merge in every reader forever, and the sidecar's scope rule (ADR-0004) would have
to grow a second source of truth about which notes belong to which workspace.
Moving files makes the merge a one-time event that leaves nothing behind to
remember.

**Merge automatically when the remotes match.** Rejected on the enum's own
grounds. Two checkouts of one repository really can be two workspaces on purpose,
and the cost of being wrong is a memory that stops being findable under the id it
was written against.

**Keep the decline local to the machine that made it.** Rejected: it is a fact
about the projects. Asking the same person the same question again on their other
laptop is how an indicator becomes something people learn to ignore.

**Concatenate every colliding file, not just `Facts.md`.** Rejected: a session
note is prose, and splicing two of them produces a document nobody wrote. Only
the append-only format is appended to.
