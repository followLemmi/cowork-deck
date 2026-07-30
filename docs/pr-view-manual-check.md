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
