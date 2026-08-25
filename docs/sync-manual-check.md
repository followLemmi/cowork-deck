# Memory sync — manual check

None of this is covered by automated tests, and most of it cannot be: every
interesting failure needs **two machines with the same GitHub account**, and no
single-machine suite can reach one. Work through the list and record the result
in the pull request description.

Two machines, one account, one repository. Below, **A** is the machine that sets
it up and **B** is the one that adopts it.

## Switching it on

- [ ] With `gh` absent from `PATH` — the offer routes to the existing "Set up gh" path rather than failing.
- [ ] With `gh` present but no account logged in — likewise, to "Bind an account".
- [ ] With two accounts logged in — a picker appears and names both.
- [ ] On **A**, create the repository. Check on github.com that it is **private**.
- [ ] The repository has a `.gitignore` and a `.cowork-sync.json` in its first commit — not added later.

## What is in the repository, and what is not

Look at the repository on github.com, not only at the local directory.

- [ ] Present: `{workspace_id}/workspace.json`, `Facts.md`, `Sessions/`, `Diaries/`, `scenarios/`, `runs/{machine}/`.
- [ ] **Absent: `sessions.json`, `terminals.json`, `ui_state.json`, `schedule_state.json`, `accounts.json`, `machine.json`, `sync_state.json`, `gh-noauth/`.**
- [ ] Absent: `.index/` and `.model/`. The model is 470 MB; if it is there, stop and fix that first.
- [ ] Open a `workspace.json` and read it. **No absolute path anywhere** — not the workspace folder, not an ssh key, not a tracker root.
- [ ] On a host with no keyring, where the credential fallback file exists in the config directory: it is **not** in the repository.

## Adopting it on the second machine

- [ ] On **B**, connect to the existing repository. Every workspace from **A** appears.
- [ ] Each arrived workspace shows as having no folder here.
- [ ] Memory search finds notes from **A** *before* any path is set.
- [ ] Open one — the question is asked once, with "point at a folder", "clone it" and "later".
- [ ] Choose "later" — the workspace stays usable, and the question is not asked again until the next launch.
- [ ] Try to start a session in a workspace with no folder — refused, with a sentence saying to point it at one. Not a crash, and not a shell in the wrong directory.
- [ ] Point one at a folder. Restart **B** — the path is still there and nothing asks again.

## The collision

- [ ] On **B**, *before* connecting, create a workspace for a project that **A** also has.
- [ ] Connect. The deck asks whether they are the same project rather than deciding.
- [ ] Neither answer loses a note without saying so.

## Schedules

- [ ] A scenario on **A** with a schedule switched **on**.
- [ ] It arrives on **B** switched **off**.
- [ ] Switch it on at **B**. Sync again from **A**. **It stays on at B.** This is the one that "arrives disabled" alone would not catch.

## Two machines at once

- [ ] Edit different files on **A** and **B**, sync both — both survive, and the history is a line rather than a lattice of merges.
- [ ] Edit **the same line** of one note on both, sync both — the second one stops, names the file, and offers no automatic resolution.
- [ ] While conflicted, wait for the next tick — the same fault is shown, not a second one stacked on it.
- [ ] Resolve by hand, sync — it recovers, and the fault clears itself.

## Failing well

- [ ] Turn off the network. Sync says there is no connection, does not call it a failure, and offers no button.
- [ ] Turn it back on — the fault clears on the next cycle without anyone pressing anything.
- [ ] Revoke the token (`gh auth logout` for that account). The message says the account is no longer accepted — **not** that no account is bound (#150).
- [ ] Quit the app mid-sync. Reopen: nothing is lost and the tree is valid.
- [ ] Start the app with the network unplugged — the window opens and sessions restore at the usual speed. Sync must never be on that path.
- [ ] Leave it a week offline, then reconnect — one sync, not a queue of them.

## Stopping

- [ ] "Stop syncing" — the repository and everything in it are untouched; only this machine stops sending.
- [ ] Sync again from **A** — **B** does not receive it.
- [ ] Reconnect **B** to the same repository — it picks up where it left off.

## The thing to check last

- [ ] Open the dialog after a few days of ordinary use. Does the "last sent" line tell you the truth at a glance? That number is the only thing standing between a sync that quietly stopped and a person finding out when their disk dies.
