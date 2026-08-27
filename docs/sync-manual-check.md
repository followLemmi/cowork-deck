# Memory sync — manual check

None of this is covered by automated tests, and most of it cannot be: every
interesting failure needs **two machines with the same GitHub account**, and no
single-machine suite can reach one. Work through the list and record the result
in the pull request description.

Two machines, one account, one repository. Below, **A** is the machine that sets
it up and **B** is the one that adopts it.

## Before anything reaches GitHub

The one check that has to come first. Every other failure here is recoverable;
publishing a credential is not — a private repository is still GitHub's servers,
and deleting it afterwards does not unsend it.

```bash
npm run sync:preview
```

It reads a *copy* of the real config directory, applies the app's own ignore
rules, and prints two lists.

- [ ] The "would be published" list contains nothing you would not put in a private repository.
- [ ] `sessions.json`, `terminals.json`, `ui_state.json`, `schedule_state.json`, `accounts.json` and `gh-noauth/` are all in the second list.
- [ ] On a host with no keyring, the credential fallback file is in the second list.

## Switching it on

- [ ] With `gh` absent from `PATH` — the offer routes to the existing "Set up gh" path rather than failing.
- [ ] With `gh` present but no account logged in — likewise, to "Bind an account".
- [ ] With two accounts logged in — a picker appears and names both.
- [ ] On **A**, create the repository. Check on github.com that it is **private**.
- [ ] The repository has a `.gitignore` and a `.cowork-sync.json` in its first commit — not added later.

## Upgrading into it, with workspaces you already have

Sync is off after an update, and the deck mentions it once — a banner above the
deck, after the sessions are back, with "Set it up" and "Not now".

- [ ] Update an installation that already has workspaces. The deck comes up as usual, and the banner appears **after** the sessions, not in front of them.
- [ ] "Not now" — it goes, and does not return on the next launch.
- [ ] It does not return on the launch after that either. An offer that comes back is not an offer.
- [ ] A fresh install with no workspaces is not offered anything at all.
- [ ] The palette still has **Memory sync…** after declining.
- [ ] Decline on this machine, then set sync up on the other one. This machine's answer is unchanged — it was a question about this machine.
- [ ] "Set it up" opens the dialog, and the banner goes whether or not you go through with it.
- [ ] Switch sync on. Every existing workspace and scenario appears in the repository without anyone filling anything in.
- [ ] Nothing was asked about workspaces you already had — they are already local, and there is nothing to answer.

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

The one failure that needs both machines to have had the project *first* — each
added the folder before sync was switched on, so each made its own id (#348).
Everything below is in **Memory sync** (the dialog, or Settings → Config
repository), which lists what a pull could not decide.

- [ ] On **B**, *before* connecting, create a workspace for the same repository **A** already has. Put it at a **different path** than on **A**, and give it a **different name** — identity is the remote, not either of those.
- [ ] Connect, and let one cycle run. The panel lists **one** thing to answer, naming the project — not two silent workspaces, and not a bare id.
- [ ] The amber dot beside "Config repository" is up, and the section it points at now names what it is waiting on.
- [ ] Write a fact into the workspace on **A** and another into the one on **B** before answering, so there is history on both sides to lose.

### Answering "same project"

- [ ] Answer **Same project** on **B**. One workspace is left, pointed at **B**'s folder.
- [ ] Its memory search finds **both** facts. Neither machine's history went.
- [ ] Nothing is left to answer on **B**, and it stays that way on the next cycle.
- [ ] Sync **A**. It ends with the same single workspace, still pointed at **A**'s own folder — not **B**'s.
- [ ] **A** is not asked a question that has already been answered.
- [ ] Sync **A** twice more. The workspace count does not oscillate and the two machines do not take turns republishing the record that lost.
- [ ] The run history for that project still lists runs from before the merge, under the surviving workspace.

### Answering "different projects"

Do this on a second pair, or undo the first by hand — the answer is meant to stick.

- [ ] Answer **Different projects**. Both workspaces stay.
- [ ] The question does not come back on the next tick, or the one after.
- [ ] Sync **A**. It is not asked either — the answer was about the projects, not about the machine.

### What is not offered

- [ ] A workspace whose folder has **no** git remote is never offered as a duplicate of anything, even when another workspace has the same name.
- [ ] Two *different* repositories on the same account are never offered as duplicates of each other.

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
