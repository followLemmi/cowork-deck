---
status: Accepted
date: 2026-08-28
deciders:
  - evgenykharetski
---

# ADR-0010 — Where a project has no remote, the folder on one machine is identity enough, and `origin` is not the only name a remote may have

Amends ADR-0007 on two of its points.

## Context

ADR-0007 settled that identity across machines is the folder's remote URL, and
that a workspace with no remote is never offered as a duplicate. The machinery it
describes was built, merged, and then run against a real store, where it raised
nothing at all. Both projects it should have recognised were outside what it can
see, for two different reasons (#359).

**`origin` is a convention, not a rule.**
`sync::git::remote_url` ran exactly `git remote get-url origin`. On the machine
that reported the bug:

```
/home/…/workspace/jvl/platform-datacenter
github  git@github.com:JVL-Core/platform-datacenter.git (fetch)
```

The remote is called `github`. The lookup failed, `identity::resolve` cached
"asked, and this folder has no remote", and the record went on the wire with a
null repository — the exact inert state ADR-0007 exists to end. Nothing about
that project is unidentifiable; only the question was too narrow.

**Some projects have no remote and are still provably one project.** Also on that
machine, and still duplicated after the fix:

| id | path | colour |
|---|---|---|
| `349d0b6d…` | `/home/…/.claude/` | `#9a9690` |
| `7042240e…` | `/home/…/.claude` | `#d5eaf3` |

One config folder, added twice, distinguishable in the deck only by colour — and
in the store only by a trailing slash, which is also why a plain string
comparison would miss it. `~/.claude` is not a git repository at all, so no
amount of remote-URL work reaches it.

ADR-0007 rejected the path as identity, and was right about the claim it was
answering: a path is one machine's disk, two machines rarely agree on one, and it
is stripped on the way out (ADR-0006). What it did not separate is a *second*
claim that happens to be made of the same string — two records **this machine
holds** pointing at **one folder on this disk** — which needs no agreement
between machines, because only one machine is involved.

## Decision

**A remote is looked up as `origin`, then `upstream`, then the sole remote when
there is exactly one.** Two or more unconventionally named remotes resolve to
nothing: picking one would be guessing which of several is the project's
identity, and a wrong guess makes two machines disagree about it — worse than
admitting there is no answer. The precedence keeps the convention winning
wherever it is present, so a fork with both `origin` and `upstream` is identified
by the same one on every machine that has it.

**Where a record has no repository, its identity is the canonicalised folder it
points at on this machine.** Symlinks resolved and the trailing slash gone, so
`~/.claude/` and `~/.claude` are one key. A record with no repository *and* no
folder here — which is every record that has arrived and not been located yet —
still has no identity, and is compared to nothing.

**The two kinds of identity are prefixed apart** (`repo:` / `path:`) and never
compared to each other. A repository that reads like a path is not that folder,
and a record that has a repository is identified by it alone — the folder is a
fallback, not a second chance to match.

**The folder never travels.** It is not published, it is not read off the wire,
and it is not compared against another machine's paths. Both sides of a path
comparison are records this machine holds; what the comparison produces is a
question for a person, and what travels is their answer — a pair of ids in the
ledger, exactly as for a repository match. ADR-0006 and the allowlist test stay
true as written.

## Consequences

A project kept without a repository can now be recognised as duplicated, which is
the case a person is least able to fix by hand: there is nothing to compare in
the UI except a colour.

**Two workspaces deliberately sharing one folder now raise a question.** That is
a real configuration — one folder, two GitHub accounts, or a board kept apart
from the code — and the answer is "different projects", recorded once in the
ledger and never asked again on either machine. One question is the whole cost,
and it buys the case above. Nothing is merged without an answer, which is the
constraint ADR-0007 built the ledger for.

Identity now depends on a fact that can change without the record changing: a
folder is renamed, or a remote is added to a project that had none. `Workspace.repo`
already remembers the folder its answer was read in and re-resolves when the
folder moves, so the repository key follows the project. The path key is derived
per comparison and never cached, so it follows by construction.

A machine running an older build publishes a null repository for a project whose
remote is called something else, and the record arrives with no identity. Once it
has been located here, the path fallback recognises it anyway — so the pair is
recognisable from one upgraded machine, without waiting for the other.

## Alternatives considered

**Try every remote and match if any pair of URLs overlaps.** Rejected: it makes
identity a set rather than a value, and two projects that share an upstream —
a fork and its parent, both cloned — would match on it. The single-remote rule
takes the unambiguous case and declines the rest.

**Give every record both a repository key and a path key, and match on either.**
Rejected: a record with a repository would then match a same-folder record whose
repository has not been resolved yet, so the question would appear on one cycle
and vanish on the next when the cache filled in. A record has one identity per
comparison.

**Compare paths as written, without canonicalising.** Rejected by the data: the
pair that motivated this differs only by a trailing slash. Symlinked home
directories are the same problem one level up.

**Ask the person to merge duplicates by hand instead.** Rejected: they already
cannot see which two records are the pair — the deck shows two identical names
and two colours — and deleting the wrong one loses that id's memory.
