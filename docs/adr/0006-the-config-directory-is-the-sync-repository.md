---
status: Accepted
date: 2026-08-25
deciders:
  - evgenykharetski
---

# ADR-0006 — The config directory is the sync repository, and its ignore is written inside out

## Context

Sync carries the deck's portable configuration and its memory to a second
machine through a private repository. Two questions had to be settled before any
of it could be written: which directory is the repository, and what decides
whether a file in it travels.

The directory is not free to choose. The memory sidecar indexes a corpus root
whose layout it already fixes — `{workspace_id}/Sessions/…`, `Diaries/{room}/…`
— and the app's own store sits in `app_config_dir`. Putting the repository
anywhere else means two copies of the corpus on disk and two roots for the
sidecar to reason about.

The second question is sharper than it looks. That directory already holds
`sessions.json`, `accounts.json` and a `gh-noauth/` directory, and #206 will add
a `0600` secret file to it as the declared fallback where no keyring exists. So
the directory contains, by design, things that must never be published.

## Decision

**The config directory is the repository root, and also the memory root.**

The sidecar needs no change for this. Its walk skips every entry whose name
begins with a dot and checks the `.md` extension *before* calling
`detect_scope`, so `.git`, `.index`, `.model` and every `.json` beside a note
are already invisible to it.

Memory stays at the top level under the workspace id. `detect_scope` reads the
first path segment as the scope, so nesting notes under a `workspaces/` prefix
would give every workspace the same scope and collapse per-project search
(ADR-0004). Configuration therefore sits *beside* the memory it describes, as
`{workspace_id}/workspace.json`, rather than above it.

**The ignore file is written as `*` plus explicit re-inclusions**, generated from
an allowlist held as data in `sync::manifest`, never as a list of exclusions.

**A test asserts that the set of tracked paths equals that allowlist**, against
real git rather than a reimplementation of gitignore's rules. Equality, not
containment.

**Some fields are machine-local by nature** and are named as a category rather
than handled one at a time: the workspace path, the ssh key path, a scenario's
`enabled`, the machine id, `sync_state.json`.

## Consequences

The direction of the ignore is the whole guarantee. Written as exclusions, the
file would be correct on the day it was written and wrong the first time
somebody adds a store file — the default for anything new would be *tracked*.
Inverted, the default is untracked, and adding to the corpus is a line in a diff
a reviewer can see. `sync_state.json` was added after the ignore was written and
needed no exclusion; the fixture asserts exactly that.

`gh-noauth/` is the sharpest illustration. It is hardened to `0500` so that a
`gh auth login` inside a degraded session fails loudly rather than becoming
app-wide state (#233). Git records one permission bit, so a round trip through a
clone would return it writable — inverting the invariant it exists to hold, on a
machine nobody was watching.

Naming machine-local fields as a category is what stops the next one being
projected by reflex. `enabled` is the instance that proves it: defaulting it to
false on arrival looks equivalent and is not, because the next pull would switch
off what the person had just switched on.

The repository is a working tree with a `.git` directory inside the app's config
directory. Anything that copies or backs up that directory now copies a
repository, and moving the memory folder is a different problem from choosing
where a cache lives — which is why relocating it is deliberately a separate,
later task.

## Alternatives considered

**A separate repository directory, with files projected into it.** Rejected: it
duplicates the corpus on disk and gives the sidecar two roots.

**Exclusion-style `.gitignore`.** Rejected: correct only until the next file is
added, and the failure is silent and unbounded.

**Serialising the model straight to the repository.** Rejected for the same
reason, one level up: a field added to `Workspace` would travel by default. The
projection destructures exhaustively instead, so a new field fails to compile
until somebody decides.

**A boolean "sync enabled" setting.** Rejected: a flag can disagree with the
directory, and then the app is confidently wrong about whether a person's memory
is leaving the machine. Sync is on when the directory is a repository with a
remote, which cannot be wrong about itself.
