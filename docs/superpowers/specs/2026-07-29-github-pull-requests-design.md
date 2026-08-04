# Design: pull requests as a view of their own

## The problem

A workspace already knows which GitHub account it works under. Sessions are born
with that account's token, and `gh` inside them behaves as that account without
touching any global state. What the deck still cannot answer is the question a
person asks a dozen times a day: **what is waiting on me in this repository right
now, and can it be merged?**

Today that answer lives in a browser tab. Getting it costs a context switch, and
acting on it — checking out the branch to address a review — costs another one,
plus a decision about what to do with the working tree the deck's other sessions
are using.

## Goal

Show the workspace's open pull requests with enough state to decide what to do
next, and support the three actions worth taking from outside a session: start a
session on the PR's branch, merge, and close or reopen. Everything richer — the
conversation, the commits, the diffs, the job logs — is the next spec.

## Scope

**In:**

1. A third view beside the deck and the board, listing open pull requests.
2. Per-PR state: checks, review verdict, draft, mergeability, age.
3. ▶ — a session on the PR's branch, in a git worktree of its own.
4. Merge, with confirmation and a guarantee that what merges is what was shown.
5. Close and reopen.
6. Open in browser.
7. Polling while the view is watched, and an honest data age everywhere.

**Out, and where it goes instead:**

- **The PR itself in full** — conversation, review threads, commits, files and
  diffs, job logs. That is the third spec of this group, and it is the larger
  one. This view is where its card will open from.
- **Approving or requesting changes.** Deliberately left to the session, which
  runs under the right account and shows its output. Consistent with the
  decision recorded in the per-workspace GitHub account spec.
- **Commenting.** Same reason.
- **The issues board.** A separate spec — see "Neighbouring specs" below.
- **Notifications and background polling when the view is not on screen.**
- **PRs from workspaces without a bound GitHub account.** Not a degraded mode:
  without an account there is no token, and guessing one is exactly what the
  account feature exists to prevent.

## Key decisions

**1. A module, not a port.** `gh_pr.rs` sits beside `gh.rs`: pure parsers over
`gh`'s JSON plus thin Tauri commands. `TaskProvider` earns its abstraction
because it has two implementations and expects a third; pull requests have one
source and no prospect of another. A port with a single implementation is a
layer that later has to be worked around the first time something
GitHub-specific is needed.

**2. The view depends on the account binding, not on the task source.** A
workspace may keep a local markdown board and still show pull requests; the two
are unrelated, and coupling them would be arbitrary. Three conditions gate the
view: `gh` is installed, the workspace has a bound account, and its folder is a
git repository with a GitHub remote.

**3. Every unmet condition explains itself and offers the next step** — never an
empty list, from which it is impossible to tell whether something broke or there
is simply nothing open.

**4. The branch goes in a worktree, never in the workspace's working copy.**
`gh pr checkout` would move the branch under the feet of every live session in
that workspace and refuse outright on a dirty tree. A worktree costs a directory
and buys the ability to work several PRs at once while the workspace itself
stays where it was.

**5. The worktree lives outside the workspace folder.** `<parent>/<name>-pr/<number>-<branch>`.
Not aesthetics: BUG-026 is a live record of what nesting costs — `npm test` from
the root globbed test suites out of nested worktrees and ran 880 tests instead
of 183. A nested worktree would likewise land in `git status`, in the task
watcher and in every glob in the repository.

**6. Worktrees are never removed automatically.** Once a PR is merged or closed
and its worktree is clean, the view offers to remove it. A dirty worktree is
refused with the reason named. Deleting a directory that may hold unsaved work
is precisely the class of action issue #24 exists to eliminate.

**7. Confirmation is asymmetric, because the actions are.** Merge and close are
confirmed; reopen is not. Merge is irreversible and close is visible to the
whole team, while reopen restores the state that was there a moment ago.
Confirming everything equally trains people to click through confirmations.

**8. Merge is pinned to the commit that was on screen.** `gh pr merge
--match-head-commit <headRefOid>` fails if the PR's head moved between the
render and the click, and we surface that as "the PR changed, refresh" rather
than merging something the person never read. A browser's merge button offers no
such guarantee.

**9. Only the strategies the repository allows are offered**, read from
`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`,
with `viewerDefaultMergeMethod` preselected. Offering three and failing after
confirmation would teach people to distrust the dialog.

**10. Polling is paced by the data, not by a blind timer**, and only while the
view is open, the window focused and the workspace active.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| PRs as cards on the task board | A PR is not a card. `TaskProvider::update` takes title/kind/status/body, and merging is none of them; `resolve` means "closed", while for a PR closing and merging are different outcomes. The board would gain capabilities that lie. |
| A PR panel in the sidebar | No room for a title, let alone check state, and the layer-3 card would have nowhere to open. |
| A section inside the board view | The board would serve two masters, and the section would sit empty in every locally-tracked workspace. |
| Own HTTP client to the GitHub API | The auth argument that once rejected it is gone — the token is already resolved. What remains is a second way of talking to GitHub in one codebase, for no capability `gh` lacks here. |
| `gh pr checkout` in the workspace | Moves the branch under live sessions; refuses on a dirty tree, so the common answer becomes an error message instead of a session. |
| Background polling regardless of the view | Network on battery for workspaces nobody is looking at, to power a counter nobody asked for. |
| Merge without pinning the head commit | Silently merges commits that arrived after the screen was drawn. |

## Verified facts about `gh` (2.86.0)

The account spec recorded 2.82.1; the version has moved and the note there
should be refreshed.

- `gh pr list --json` accepts, among others: `number`, `title`, `author`,
  `isDraft`, `headRefName`, `headRefOid`, `baseRefName`, `reviewDecision`,
  `statusCheckRollup`, `mergeable`, `mergeStateStatus`, `updatedAt`, `url`,
  `labels`, `isCrossRepository`.
- **`statusCheckRollup` is available on the list call.** Check state costs no
  extra request per PR — there is no N+1 here.
- `gh pr merge` supports `--match-head-commit SHA`, the strategy flags
  `-m/-s/-r`, `--delete-branch`, `--auto` and `--admin`.
- `gh repo view --json` exposes `mergeCommitAllowed`, `squashMergeAllowed`,
  `rebaseMergeAllowed`, `viewerDefaultMergeMethod` and `deleteBranchOnMerge`.

`deleteBranchOnMerge` matters for honesty: in a repository that deletes merged
branches itself, an unchecked "delete branch" box would misdescribe what is
about to happen. There the dialog states the repository's behaviour instead of
offering a choice.

## Data model

```ts
interface PullRequest {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;      // what merge is pinned to
  baseRefName: string;
  isCrossRepository: boolean;
  reviewDecision: ReviewDecision | null;
  checks: ChecksSummary;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  updatedAt: string;
  url: string;
  labels: string[];
}

/** Four distinct facts, never collapsed into two. "No checks configured" is
 *  not "all checks passed", and a green tick for it would be a lie. */
type ChecksSummary =
  | { kind: "none" }
  | { kind: "running"; done: number; total: number }
  | { kind: "passed"; total: number }
  | { kind: "failed"; failed: number; total: number };

interface MergeOptions {
  strategies: ("merge" | "squash" | "rebase")[];  // only what the repo allows
  default: "merge" | "squash" | "rebase";
  repoDeletesBranch: boolean;
}
```

## Backend — `src-tauri/src/gh_pr.rs`

Pure functions first, commands as thin wrappers, following `gh.rs`:

- `parse_pull_requests(json: &str) -> Result<Vec<PullRequest>, String>`
- `summarise_checks(rollup: &Value) -> ChecksSummary` — the whole truth table
- `parse_merge_options(json: &str) -> MergeOptions`
- `worktree_path(workspace_path, number, branch) -> PathBuf` — pure, and
  asserted to resolve outside the workspace folder

Commands: `pr_list`, `pr_merge_options`, `pr_merge`, `pr_close`, `pr_reopen`,
`pr_worktree_add`, `pr_worktree_remove`. All run `gh`/`git` with the workspace's
`cwd` and its session environment, so what the deck sees and what the agent sees
are the same account by construction. Errors pass through the existing redaction
in `gh.rs` before reaching the frontend — no new mechanism.

## Frontend

- `src/pr.ts` — pure: sorting, "updated N ago", `canMerge(pr) -> {ok} | {reason}`,
  and `pollInterval(prs) -> ms` (short while any check is running, long once
  everything has settled).
- `src/pr-view.ts` — the view: rows, the merge dialog, the empty and
  unavailable states.
- The view switch becomes three-way: deck / board / PR, with a palette entry
  and a hotkey, matching how the board was added.

A row shows: number, title, author, draft marker, `branch → base`, checks,
review verdict, age, labels. The merge button is disabled with the reason named
when `mergeStateStatus` says conflicting or blocked — not an error after the
click.

**What ▶ actually starts.** A normal session, in the worktree's directory,
carrying the workspace's environment exactly as any other session does — the
same account, the same tracker variables. Its opening prompt states the PR
number, title and `branch → base`, and nothing more: the review threads that
would make the prompt genuinely useful are layer-3 data, and inventing a
half-version of them here would have to be undone later. The tile is labelled
with the PR number so it is distinguishable in the deck and in the sidebar.

**A session outlives its worktree.** Sessions persist by `cwd`, so a restored
tile whose worktree has since been removed would restart in a directory that no
longer exists. Removal therefore refuses while a live session sits in that
worktree, and restore treats a missing directory as the existing
launch-failure path rather than a new kind of error.

## Refresh

Polling runs only while the PR view is open, the window is focused and the
workspace is the active one. Leaving for the deck, minimising, or switching
workspace stops it. A new request never starts while the previous one is in
flight, or a slow network accumulates a queue of `gh` processes.

The data age is shown always, not only on failure. An in-memory cache per
workspace serves the last good result, with its age and the error text, when a
request fails, the machine is offline, or the rate limit is hit.

## Errors

| Situation | What the person sees |
|---|---|
| `gh` not installed | The GitHub screen's install command, one click away |
| No account bound | "Bind an account" → the workspace form |
| Not a git repository, or no GitHub remote | "No repository for this workspace" |
| Account lacks the `repo` scope | `gh`'s own error, unguessed |
| Rate limit or offline | Cached list, its age, and the error text |
| Merge rejected by `--match-head-commit` | "The PR changed since you looked — refresh" |
| Merge blocked by branch protection | The reason from `mergeStateStatus`, before the click |
| Worktree exists and is dirty | Removal refused, with the path and the reason |

## Testing

Pure parsers over recorded `gh` output: the check summary across all
combinations (none, running, passed, failed, mixed), `reviewDecision`,
`mergeStateStatus`, and merge options for a repository that allows one strategy
only. Pure frontend functions: sorting, age formatting, `canMerge` and its
reasons, `pollInterval`. `worktree_path` including the assertion that the result
lies outside the workspace.

jsdom over the view: the four check states render distinguishably, a disabled
merge button names its reason, the confirmation shows the head SHA, and the
unavailable states offer their next step.

Not covered by automated tests, and therefore a manual step at the end, as in
task 13 of the account branch: real network calls, and the fork case.

## Open questions for the plan

- **Worktrees for PRs from forks.** `isCrossRepository` marks them; the exact
  git sequence for a head that lives in another repository needs to be worked
  out and verified against a real fork.
- Polling intervals: exact numbers, chosen once the check-state shape is in
  front of us.

## Neighbouring specs

This is the second of three, and the one being written first because it is the
one most wanted.

**The issues board** (its own spec, decisions already taken): GitHub Issues as a
second `TaskProvider` behind the existing port; exactly one task source per
workspace, so a GitHub-backed workspace has no local board and vice versa;
`capabilities.statuses` returns `open`/`closed`, which makes the board
two-column and finally puts that field to work; ✓ closes an issue and
`cowork_task new` files one; all open issues of the repository, with an honest
"showing N of M" rather than silent truncation; switching a workspace that holds
open local cards warns and leaves them on disk.

**The pull request in full** (its own spec, the largest of the three):
conversation, review threads bound to lines, commits, files and diffs, job logs.
It opens from this view.
