# The README's screenshots

Seven shots, and each one is in the root `README.md` because it proves something the prose
has to spend a paragraph on. Capture them from the **running app**, not from the mockups
in `docs/design/slate-ember/mockups/`: the point of a repository's front page is that the
thing exists, and a render of a design file is not evidence of that.

Keep this file next to them. A re-shoot six months from now should look like a re-shoot,
not like a different application.

## How the current set was shot

Against `harness/`, which is the app itself with the backend replaced: `src/main.ts` boots
unmodified and every screen renders from the data it would have got over IPC, but the IPC
answers come from `harness/fixtures.ts` instead of from Rust. So the terminals are real
xterm instances holding real bytes, the board really is `BoardView` reading a
`board.json`, and the diff drawer really is parsing a patch — while the accounts, the
repositories, the issue numbers and the paths are all invented.

Two things that buys, and they are the reasons to shoot this way rather than from a live
window:

- **Nothing publishable has to be found first.** The front page shows no real account, no
  customer's repository and no path off anybody's disk, so there is no scrollback to vet.
- **A re-shoot is a re-shoot.** The same fixtures give the same four states, the same
  columns and the same twelve issues, instead of whatever happened to be open that
  afternoon.

What it cannot show is the backend: if `gh` stops answering the way `gh_issues.rs` expects,
these shots will not notice. They are evidence that the interface exists and works, not
that the plumbing behind it does — that is what the tests are for.

```bash
npm run dev                       # serves /harness/
node harness/shoot.mjs            # all seven, into docs/images/
node harness/shoot.mjs deck zoom  # or just the ones you are redoing
```

Vite does not watch this worktree (`vite.config.ts` ignores `.claude/worktrees/**`), so
restart the dev server after editing a fixture or the shot will be of the old data.

## Rules for all seven

| | |
|---|---|
| **Size** | 1600 × 1000 device pixels or larger. GitHub lays the README out at ~1000 px, so anything smaller is resampled and the 13 px type goes to mush. On a 2× display capture the window at 800 × 500 logical. |
| **Text size** | The default — 100 % in Settings. It is the one setting that changes every measurement in the app, so a shot taken at 115 % does not match its neighbours. |
| **Window** | Capture the app window only, with its own corners. No desktop wallpaper, no dock, no menu bar. |
| **Format** | PNG, under ~400 kB each. Above that, quantize (`pngquant --quality 65-85`) rather than dropping resolution. |
| **Content** | Fixtures, from the harness below — the sidebar shows the bound `gh` account and the tiles show absolute paths, and neither belongs on a repository's front page. Shooting a live window instead is allowed, but then every path, branch name and line of scrollback in frame is published with it. |
| **What not to shoot** | A scrollback carrying a token, a customer name, or a path under someone else's project. Start a fresh session for the shot if the live one is not publishable. |

## The six

### `deck.png` — the hero

The Terminals screen, four tiles, **four different states at once**: one working, one
waiting for a decision, one that finished its turn, one exited or errored. That single
frame is the whole product: the state rail down the left edge of each tile, the state
chips, the token counts, the git branch.

The sidebar must be in it, with more than one workspace and at least two scenarios — one
of them scheduled, so its row shows the schedule and its last run in words. One tile
active, so its accent border and blinking caret read.

Sits directly under the badges. It is the only shot most visitors will look at.

### `zoom.png` — the gesture

One terminal zoomed near-full with the filmstrip of the others below it. This is the one
thing in the app that a sentence cannot convey: the strip cards carry the name, the state,
the branch and the token count and no terminal at all, which is the decision worth showing.

### `board.png` — the board is a screen

The Board with a configured `board.json`: four columns, cards in each, a card in the
working step carrying its "session running" line, and — if you can catch it — the ⚙
editor's own dialog is *not* wanted here. Just the columns, so the shot says "this is a
screen, not a panel".

### `issues.png` — the second source

The same Board reading a repository's issues: the `Open`/`Closed` filter, the label filter
with one label pressed, and rows deep enough to show the body excerpt under a title. Pick
a repository with a dozen issues; three rows do not demonstrate a list.

### `issue-dialog.png` — an issue open

The card dialog on a GitHub issue, showing what the 2026-08-05 pass built: a long title
wrapped rather than scrolled out of view, the body **rendered** as Markdown, and the rail
with the step, the labels and the `owner/repo#150` link. Choose an issue whose body has a
heading, a code span and a quote in it, so the rendering is visibly rendering.

### `pull-requests.png` — the third view

The pull request list with one row expanded and the diff drawer open on a file, so the
sticky line-number gutter and the `+`/`−` markers are in frame. A pull request with checks
in more than one state is worth hunting for: "no checks" not reading as success is a
deliberate distinction and this is where it shows.

## Optional seventh

### `pill.png` — the floating pill

Just the pill, on its own, cropped tight — 600 px wide is plenty. It is a separate
always-on-top window, so it cannot appear in any of the six above, and it is the feature
people ask about. Referenced from the Features list only if you shoot it.
