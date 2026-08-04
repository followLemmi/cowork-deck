# Pull request view — manual check

None of this is covered by automated tests. It needs a running app, a real
repository and a real GitHub account, so it is a human's to run. Work through
the list and record the result in the pull request description.

- [ ] A workspace with a bound account and a GitHub remote — the view lists its open pull requests.
- [ ] Compare the count and the check badges against the same repository in a browser.
- [ ] A repository with a pull request whose CI is running — the badge updates on its own; switching to the deck stops it (watch the network, or add a temporary log).
- [ ] ▶ on a pull request — a worktree appears at the documented path, the session starts in it, and `git branch --show-current` in that session names the pull request's branch.
- [ ] `git status` in the workspace itself — untouched.
- [ ] Merge a test pull request; push a new commit to it first from elsewhere and confirm the refusal message names the change.
- [ ] Close and reopen a test pull request.
- [ ] Remove the worktree with a dirty file in it — refused, with the path named. Clean it, remove again — gone.
- [ ] A workspace with no bound account, and one that is not a repository — each shows its own screen with its own next step.
- [ ] **A pull request from a fork** (`isCrossRepository: true`) — verify the worktree resolves. This is the known gap from the spec.
- [ ] **"Open in browser"** — confirm it reaches the system browser rather than navigating the app's own webview. The same `<a target="_blank">` is already used on the GitHub screen and has never been verified either; if it turns out not to work, that is one shared fix, not a PR-view fix.

## The expanded row

- [ ] `▸` on a pull request — the description, `N files changed · +A −B`, and the changed files appear. Compare all of it against the same pull request in a browser.
- [ ] Watch the network (or add a temporary log): expanding asks for one `gh pr view`, and a poll tick while it is open asks for none.
- [ ] Push a commit to that branch from elsewhere. Within a poll the row's age changes **and** the panel's numbers follow it — a panel still showing the previous commit's diffstat is the failure this is here to catch.
- [ ] A pull request opened with no description — "No description." rather than an empty panel.
- [ ] A pull request touching several hundred files — the file list says "Listing N of M changed files." if `gh` returns fewer than the count.
- [ ] Break it: expand a row with the network down. The panel says so and offers "Try again"; the row above keeps its buttons, and the list shows no error of its own.

## The issue list and its paging

Needs a repository with **more than 50 open issues** — under that the paging path never runs.

- [ ] The board is one list, with `Open (N)` / `Closed (M)` chips. `N` matches the repository's own open count in a browser, not the number of rows.
- [ ] "Showing 50 of N open issues." under the rows, and "Show more" above it.
- [ ] Press "Show more" — 100 rows, the sentence follows, and the chip counts do not move.
- [ ] Keep pressing to 500. The button stops offering itself there; it must never sit on screen doing nothing.
- [ ] Switch to `Closed`, press "Show more" there, then switch back — the open list is still at the page it was on.
- [ ] Watch the network at a page of 500: each poll is two `gh issue list` calls and no more. This is the cost of the button, and it is worth knowing what it is.
- [ ] Labels — a repository issue with three or more, and one with a very long name. Every chip is readable; nothing overlaps the row below.
- [ ] Click a row anywhere but its buttons — the card opens. Click `▶`, `✓`, `‹`, `›` — each does its own thing and no modal appears over it.
- [ ] A folder-backed workspace still draws columns, and dragging a card between them still moves it.

## Switching to either GitHub screen

- [ ] Switch to Board on a GitHub workspace for the first time in an app run — skeleton rows, then the list. At no point does "No task tracker is configured for this workspace" appear.
- [ ] Same for Pull requests: skeleton rows, never "No open pull requests" before the answer arrives.
- [ ] Leave the tab and come back — the rows that were there stay there while the re-read runs, with the age line saying how old they are. No skeleton.
- [ ] Switch between two GitHub workspaces — the second gets a skeleton rather than the first one's rows.
- [ ] A workspace whose `gh` is missing — the unavailable box and its button, not a skeleton, and it survives every poll tick.

### The window must stay alive while it reads

The skeletons were not enough on their own: a synchronous `#[tauri::command]` runs
on the thread that paints the WebView, so every `gh` call froze the window and the
skeleton was in the DOM but never drawn. The fix is `(async)` on those commands,
and a Rust test pins it — but "the window is responsive" is not something a test
can see.

- [ ] Switch to Board on a GitHub workspace and, while it is still loading, **drag the window and hover the sidebar buttons**. Both must respond. This is the check the whole of task 5 rests on.
- [ ] The same on Pull requests, and again while expanding a row.
- [ ] Press ✓ on an issue and, while the close is in flight, click something else. No freeze.
- [ ] Slow it down on purpose if the network is too fast to see it — point the workspace at a repository over a throttled connection, or add a temporary `sleep` to the `gh` shim.
- [ ] Type into a terminal tile while a board poll is running. Keystrokes arrive in order — the session commands stay on the main thread deliberately, and this is what that buys.

### The poll must not take the reader's place away

`render` empties the mount and rebuilds every node, and the poll calls it every 15 s
while the window has focus — precisely while somebody is reading. Focus restore is
covered by unit tests; **scroll position is not, and cannot be**: jsdom has no layout,
so `scrollTop` there is a stored number that `replaceChildren` leaves alone (measured).
The test that exists only proves the redraw does not write a zero. The real behaviour
is only visible in the app.

- [ ] On a repository with enough open pull requests to scroll, scroll halfway down and wait out two poll ticks (30 s, window focused). The list must not jump to the top.
- [ ] Tab to a `Merge` button on the second or third row and wait out a tick. Focus stays on *that* row's button — not on the first row's, and not lost to the page.
- [ ] Expand a row whose detail fails to load, focus `Try again`, wait a tick. Focus is still on `Try again`.
- [ ] Select some text in a description and wait a tick. **Expected to fail today** — the rebuild destroys the selection, and the fix is the diff drawer's own mount living outside `PrView`. Note it here rather than being surprised by it later.

## The diff drawer

Everything below was either measured in a headless browser against the real stylesheet
or is impossible to measure there. The first group is regression cover; the second is
the only place these can be checked at all.

- [ ] A file with a line longer than the drawer. Scroll it sideways: the line numbers and the `+`/`−` markers stay pinned and the code slides underneath them, with nothing showing through. **The page itself must never scroll sideways** — only the file.
- [ ] The same file at the largest text size. The gutter is sized from `--dv-digits`, which the module sets per file; a five-digit line number must not overlap its neighbour column.
- [ ] Shrink the window until the list collapses. It must go away entirely, not sit behind the drawer — a covered list that can still be tabbed into fails SC 2.4.11.
- [ ] Drag the resize grip, then reopen the app. The width is remembered. Drag it to its floor: the marker and both number columns stay legible.
- [ ] Tab to the grip and use the arrow keys. The width changes, and the focus ring is visible along the whole grip rather than clipped to a sliver at its edge.

### Only checkable by hand

- [ ] **Windows high contrast** (`forced-colors: active`). Every tint collapses to a system colour, so added and removed become identical bands — the `+`/`−` characters are the only thing left telling them apart. The `forced-colors` block is the first in this stylesheet and **nobody has looked at it**: it was confirmed to parse and reach the CSSOM, not to look right.
- [ ] **WebKitGTK render cost.** The 33 ms figure for the largest real file is Chromium via Playwright. Tauri on Linux is WebKitGTK, plausibly 2–3× slower. Open the biggest file in a large pull request and confirm there is no perceptible hitch.

### Recorded as impossible, so nobody re-attempts it

**Sticky file and hunk headers down the vertical scroll cannot be done with this
structure.** `overflow-x: auto` on `.dv-file` computes `overflow-y` to `auto` as well,
which makes the file its own scroll container — so a `top` offset inside it resolves
against a box that never scrolls vertically. Getting them would mean moving the
horizontal scroll somewhere else, which would cost the pinned gutter. The pinned line
numbers answer "where am I" continuously, which is the better half of the trade.
