---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0012 — One instance per config directory, claimed with a lock in it

## Context

Nothing stopped a second app process. Five were found alive on one machine,
three of them two days old (#361).

Every one of them ran the five-minute sync cycle, and that cycle stages,
commits, pulls with rebase and pushes the app's config directory — which
ADR-0006 made the sync repository and the memory root both. Two cycles that
overlap contend on `.git/index.lock`, and a rebase one process starts is a
rebase the other finds in progress. The person sees an amber indicator carrying
a git error nobody can place, on a schedule nobody can reproduce.

The store is better defended than it looks — mutations re-read the file
immediately before writing (#117, #145) and `Store::workspaces()` reads from
disk on every call — but the window between that read and its write is spanned
by no lock at all, and it widens with every extra process.

So the question was not whether to have a guard but what the guard is *about*.

## Decision

**One running app per config directory**, claimed by an exclusive OS lock on
`instance.lock` inside that directory, taken before anything else the process
does.

**The claim is made in a Tauri plugin, not in `setup`.** Plugins are initialised
inside `Builder::build`; the window declared in `tauri.conf.json` is created
later, when the event loop reports ready. A launch that exits from the plugin
therefore never puts a window on screen and never reaches
`run_journal::sweep_and_compact`, which would otherwise close the *live*
instance's open runs on its way past.

**The second launch focuses the first, and says so.** The holder writes its pid
and its listener port to `instance.json`; a refused launch reads that file and
sends one `{"kind":"focus"}` line to the port it names — the same 127.0.0.1
listener the reporter hooks already use — then exits 0.

**The guard fails open.** If the claim cannot be made at all — an unwritable
config directory, a filesystem with no lock to give — the app starts anyway.

## Consequences

The lock is owned by the open file, so the OS releases it however the process
dies, `kill -9` included. A stale claim is not a state that can exist, which is
the property a pid file could not have offered.

Two config directories are two apps contending over nothing, and they keep
working. That is the case a machine-wide guard gets wrong, and the reason this
one is keyed where it is.

The dev build and the release build share the identifier `ca.jvl.coworkdeck`
and therefore share a config directory, so they now refuse to run at the same
time. That is not a side effect to work around: they were contending on one git
repository, which is the fault this record is about.

Two files rather than one. `instance.lock` is empty because what it holds is a
lock, not bytes; the address is separate because the Windows form of
"exclusive" is a handle opened with no sharing at all, and a file no other
process may open cannot also carry a message.

The address can be stale for a sliver of time — a crashed instance's file,
between the new holder taking the lock and overwriting it. The cost is one JSON
line delivered to whatever now owns that port, and a launch that quietly does
nothing rather than quietly starting a second app.

Failing open means a machine where the claim cannot be taken is back to the
old behaviour. That is the right trade: an app that refuses to launch because
of its own guard is a worse defect than a git error every five minutes.

## Alternatives considered

**`tauri-plugin-single-instance`.** Rejected as the mechanism, though it is the
obvious one and #361 named it. It keys on the bundle identifier — a DBus name on
Linux, a socket on macOS — so its answer to "is this already running?" is the
same for every config directory on the host, and for every user account sharing
one. Right question, wrong key. What was worth taking from it is its shape: a
plugin, so the refusal happens before a window exists.

**A lock on the sync root only, leaving the cycle guarded and the app not.**
#361 offered this as the smaller change. Rejected because the sync root *is* the
config directory: a lock that makes the git cycle safe leaves two processes
sharing the store, the memory corpus and the run journal, and the second app is
still a second app.

**A pid file.** Rejected: a pid proves nothing about whether that process is
still the app, and every crash leaves a claim somebody has to decide how to
break.

**`fcntl` locks instead of `flock`.** Rejected: an `fcntl` lock is owned by the
process, so any close of any descriptor on the file releases it, and a second
lock taken by the same process is granted rather than refused — which is a guard
whose test can pass while it does nothing.
