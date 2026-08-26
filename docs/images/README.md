# The README's screenshots

Eight shots and one recording, each in the root `README.md` because it proves something the
prose has to spend a paragraph on. Capture them from the **running app**, not from the mockups
in `docs/design/true-ink/mockups/`: the point of a repository's front page is that the
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
node harness/shoot.mjs            # all eight, into docs/images/
node harness/shoot.mjs deck zoom  # or just the ones you are redoing
```

If the dev server answers on `localhost` but not on `127.0.0.1` — which is what a
default Vite bind does on some machines — point the script at it:
`HARNESS_URL=http://localhost:1420 node harness/shoot.mjs`.

## Two things the script does that are worth knowing

**It runs Chromium with WebGL off.** xterm draws through a WebGL canvas when it can, and a
screenshot of one comes back wrong in headless Chromium: the capture takes the backing
store, which at `deviceScaleFactor: 2` is twice the canvas's CSS box, so every glyph in the
terminals lands at double size beside chrome that is correctly sized. With no context to
take, the app falls to its DOM renderer — a path it supports and states it supports — and
that screenshots as what it is. Nothing else runs with the flag; a real window keeps its GPU
renderer.

**ImageMagick is used when it is there and stood in for when it is not.** `magick` does the
downscale, the rounded corners and the 256-colour quantization. Without it the corners are
cut in the page instead, `sips` does the downscale, and the shots come out at 1600px rather
than 2000 — there is no quantizer to bring a 2000px file back under the size rule below.

Vite does not watch this worktree (`vite.config.ts` ignores `.claude/worktrees/**`), so
restart the dev server after editing a fixture or the shot will be of the old data.

## Rules for all eight

| | |
|---|---|
| **Size** | 1600 × 1000 device pixels or larger. GitHub lays the README out at ~1000 px, so anything smaller is resampled and the 13 px type goes to mush. On a 2× display capture the window at 800 × 500 logical. |
| **Text size** | The default — 100 % in Settings. It is the one setting that changes every measurement in the app, so a shot taken at 115 % does not match its neighbours. |
| **Window** | Capture the app window only, with its own corners. No desktop wallpaper, no dock, no menu bar. |
| **Format** | PNG, under ~400 kB each. Above that, quantize (`pngquant --quality 65-85`) rather than dropping resolution. |
| **Content** | Fixtures, from the harness below — the sidebar shows the bound `gh` account and the tiles show absolute paths, and neither belongs on a repository's front page. Shooting a live window instead is allowed, but then every path, branch name and line of scrollback in frame is published with it. |
| **What not to shoot** | A scrollback carrying a token, a customer name, or a path under someone else's project. Start a fresh session for the shot if the live one is not publishable. |

## The eight, and the take

### `deck.png` — the hero

The deck, **every state at once**: one working, one waiting for a decision, one that
finished its turn, one stopped on an error, one idle. That single frame is the whole
product: the state rail down the left edge of each tile, the chips, the token counts, the
branch.

The panel must be in it, with more than one workspace, so the tree reads as a tree — a
workspace, its sessions indented under it, and the create row at the foot of the group. One
tile active, so its accent border and caret read. The ledger in the top bar must have both
readings in it.

Sits directly under the badges. It is the only shot most visitors will look at.

### `zoom.png` — the gesture

One terminal zoomed near-full with the filmstrip of the others below it. This is the one
thing in the app that a sentence cannot convey: the strip cards carry the name, the state,
the branch and the token count and no terminal at all, which is the decision worth showing.

### `board.png` — the board belongs to a repository

The board with a configured `board.json`, in the workspace panel where it now lives: the
deck still on the left, three or four columns of cards, and a card in the working step
carrying its "session running" line. The panel is widened first, the way a person would drag
it — four columns clipped at two says nothing about a board. The ⚙ editor's dialog is *not*
wanted here.

### `issues.png` — the second source

The same board reading a repository's issues: the `Open`/`Closed` filter, the label filter
with one label pressed, and rows deep enough to show the body excerpt under a title. Pick
a repository with a dozen issues; three rows do not demonstrate a list.

### `issue-dialog.png` — an issue open

The card dialog on a GitHub issue, showing what the 2026-08-05 pass built: a long title
wrapped rather than scrolled out of view, the body **rendered** as Markdown, and the rail
with the step, the labels and the `owner/repo#150` link. Choose an issue whose body has a
heading, a code span and a quote in it, so the rendering is visibly rendering.

### `pull-requests.png` — the diff

A pull request open on one of its files, so the sticky line-number gutter and the `+`/`−`
markers are in frame. This is the one page the panel's widen control exists for, so the shot
takes that width: two columns of code and a gutter do not fit in a column sized for a list
of names.

### `workspace-window.png` — a workspace of its own

A workspace pulled out into its own window, which is a different window rather than a state
of this one: one workspace in the panel, no rail at all, and the board and pull requests
still there. What it has to show is the absence — nothing app-wide in a window that is one
project's.

### `demo.gif` — the take

Half a minute of one continuous take, driven the same way the stills are and by the same
fixtures: a session finishes its turn, zoom and juggle, a workspace's board on its
repository's issues, a pull request and its diff, and back to the deck. A visible pointer
is drawn into the page — a recording where things happen with no cause reads as a
slideshow.

`harness/record.mjs` writes a `.webm` and prints where the take actually begins; the
conversion is ffmpeg's job, and these are the numbers that land it beside the old file's
size rather than at twice it:

```bash
node harness/record.mjs                       # → docs/images/demo.webm + a trim offset
ffmpeg -ss <trim> -t <len> -i docs/images/demo.webm \
  -vf "fps=9,scale=880:-1:flags=lanczos,split[a][b];\
       [a]palettegen=max_colors=96:stats_mode=diff[p];\
       [b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 docs/images/demo.gif
rm docs/images/demo.webm                      # the intermediate is not committed
```

`dither=none` is a judgement about this UI rather than a general setting: the surfaces are
flat, so there is nothing for a dither to smooth and every pixel it changes is a pixel that
cannot be run-length encoded. It is most of the difference between 5 MB and 9.

### `pill.png` — the floating pill

Just the pill, on its own, cropped tight — 600 px wide is plenty. It is a separate
always-on-top window, so it cannot appear in any of the shots above, and it is the feature
people ask about.
