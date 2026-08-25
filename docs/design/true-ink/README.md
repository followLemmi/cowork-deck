# True Ink — the 2026-08-25 pass

The second pass over the visual language `src/styles.css` implements, and over the
information architecture around it. Everything under "The four decisions" and "The shell"
is in the app; "What is not ported" says what is not, and why.

Written in English per `CLAUDE.md`. The working sessions were held in Russian and their
running narrative stays in the Open Design project; nothing load-bearing lives only
there.

## Restoring the work

```
tools/palette.mjs --app     the block that stands in src/styles.css
tools/palette.mjs --base    the same values under the mockups' own token names
tools/palette.mjs           all five directions, as a table
mockups/index.html               the overview: every decision, with the argument for it
mockups/workspace-shell.html     the shell as designed — rail, one panel, permanent deck
mockups/workspace-layouts.html   the four window schemes, with the cost of each
mockups/palette-directions.html  the five directions on identical fragments
mockups/overlays.html            dialogs, banners, empty states, both themes
```

Open any of them in a browser; there is nothing to build. They are the record of the
design as authored, which is not the same file as the app — `mockups/assets/deck-ui.css`
carries the system with its own class names, `src/styles.css` carries it applied to the
class names the app already had, and where the two disagree `src/styles.css` is what
ships. The mapping table below covers the palette; the shell's own differences are in
"The shell" and in "What is not ported".

The mockups load three webfonts from Google Fonts, which is one way they differ from the
app — the app bundles its faces as variable TTFs under
`src/assets/fonts/`, because a Tauri window has no network guarantee and a CSP. Its mono
is JetBrains Mono where the app's is CaskaydiaCove Nerd Font Mono: the app's terminal
needs Nerd Font glyphs and the mockup has no terminal to feed.

`mockups/assets/deck-ui.css` is **not** `src/styles.css`, and the difference is larger in
this pass than in the last one — see "Designed, not ported".

## What was wrong with Slate & Ember

Two things, and neither is a matter of taste.

**The warm cast read as brown.** OKLch hue ~70 at low chroma is a warm graphite in
theory; in the window, beside `--st-working`'s green, a deck of twelve tiles picked up an
earthy tint. The palette was chosen to keep hue for state, and then spent a cast on the
chrome that competed with the one signal it was protecting.

**Height was declared and not delivered.** `--sh-island` was `inset 0 1px 0 rgba(255,
255, 255, 0.04)` plus a 30px drop shadow at 75% black. On `--bg-void: #0f0d0b` that
shadow has almost nowhere to go: the ground is already nearly as dark as the shadow, so
what a tile got was a hairline highlight nobody sees and a shadow nobody sees. Every
surface in the app was flat, and the file said otherwise.

## The four decisions

### 1 · The cast is cool, and almost absent

Hue 265 at chroma 0.003. Five directions — True Ink, Warm Ember, Graphite, Blue Steel,
Deep Petrol — were authored in OKLch, resolved, measured and drawn on the same fragments
before one was picked; the other four stay in `tools/palette.mjs` and in the sheet, so
reversing this is re-running a generator rather than reopening an argument.

### 2 · Elevation is lightness, not shadow

`--bg-void` resolves to `#040405`. Four units of brightness remain below it and no black
can reach them, so this palette spends its elevation where the room actually is: the step
from stage to raised surface is **0.097 in L**, twice what the warm ladder used. The edge
is paid for by a lit top hairline at 7.5% white rather than by a cast shadow.

`--sh-island` is therefore that hairline plus a 2px **contact** shadow — the one part of
a shadow that still reads on near-black, because it is the line where an object meets
what it lies on. `--sh-float` keeps a large cast shadow and is the only thing that does:
what lies under a modal is a scrim, which is dark enough to take one.

Neither is animated. A `box-shadow` transition repaints every frame; the two properties
that move in this app are `transform` and `opacity`.

### 3 · The accent is light itself

`--accent` resolves to the same value as `--fg`. That is not a collision to fix: hue
belongs to state, so the app's one colour is light. It has one visible consequence, worth
knowing before it is filed as a bug — a primary button is the ground and the ink
inverted, so it reads as a switch that has been thrown rather than as a coloured call to
action. For the actions this app has, that is the right reading.

`--sel` drops from 0.10 to 0.07 and `--sel-hover` from 0.18 to 0.126 for the arithmetic
reason: a purer light drags a row's ground further per point of alpha, and every point it
drags is contrast taken off the captions sitting on it.

### 4 · The terminal does not follow the palette

It is a window onto another program. The six ANSI hues are Claude Code's and stay One
Dark; what moved is the frame — `background`, `foreground`, `cursor`, `black` — which is
the app's, plus `brightBlack`, which is the terminal's equivalent of `--fg-dim` and is
most of what Claude Code's secondary output is drawn in. On the new ground it measures
7.20:1, up from 6.40.

The caret is now the foreground rather than the accent. It stopped being a choice when
the accent became light itself: of two names for the same value, only one is true of a
terminal cursor.

## The mapping table

Four token names differ between the mockups and the app, each because the app's word is
the better one. `tools/palette.mjs --app` emits the app's names, so the translation
happens in one place rather than by hand:

| mockup | app | why |
|---|---|---|
| `--term-bg`, `--bg-code` | `--bg-terminal` | a terminal body and the diff's ground are one surface in the app; the mockup splits them one unit of L apart |
| `--diff-add`, `--diff-del` | `--diff-add-weak`, `--diff-del-weak` | named for being weak tints under code rather than for the hues themselves |
| `--edge-lit` + `--sh-1` | `--sh-island` | composed: on this ground a raised surface IS a lit hairline plus a contact shadow |
| `--sh-2` | `--sh-float` | — |

`--st-working`, `--st-waiting`, `--st-error` and the chip fills did not move between the
two passes. `--app` deliberately does not re-emit them: a value printed again invites an
edit that says it changed.

Three literals in `src/styles.css` are neutral tints of the ink rather than tokens —
`.state-idle`, `.state-ended` and `.run-ended` — and they moved with it. A chip whose
fill is one palette's grey under another palette's text is the kind of thing that reads
as dirt on the screen.

## The shell

### 5 · There are no screens

Four view tabs were not a structure but four states of one window, and the app already
shipped the proof: a floating always-on-top pill counting blocked sessions exists because
the window could not show the deck and anything else at the same time.

`#stage` is a row of three now. The **rail** selects what the **panel** holds, and the deck
never leaves the row. Three icons, not five: a board and a list of pull requests belong to
one repository, and in a column beside the journal and the scenarios they read as the
app's — so switching workspace silently changed what they were about, which is the tab
bar's defect wearing a new shape. They are children of their workspace in the tree
instead, indented with its sessions, and pressing either makes that workspace active on
the way in. What stays in the rail is what is genuinely app-wide: the tree, the journal of
every run, and the scenarios. At its foot, under a spacer, is Settings — which changes
nothing about what the panel holds, and the gap is what says so. `#deck.tk-hidden` is gone from the stylesheet, which is the whole change in one
line.

The top bar carries a **crumb** beside the mark — which workspace this window is
on, and which account a push from it goes out as. The panel's head says the same
while the panel is open, and that is the reason the crumb exists: the panel
closes, zoom closes it, and in that state nothing else on screen named either
fact. Pressing it goes to the tree and focuses the active row, because switching
workspace is what the tree is for; a dropdown switcher would be a second way to do
one thing, and the one that cannot say which workspace is busy.

What replaced the tabs in the top bar is a **ledger**: "1 waiting for a decision", "1
stopped on an error", each reading opening one of the sessions it counted. Two readings
only, because those are the two things that want a person; a run that finished while
nobody watched wants nothing. It is written from the deck's own counts rather than typed
beside them — the two statements of "N waiting" this app used to make came from two places
and could disagree.

Two pages need width rather than a column: a kanban and a diff. They take it from the
deck, which falls into its filmstrip — the layout a zoomed tile already produces, and the
reason the deck *yielding space* is not the same as the deck *disappearing*. The widen
control is present on those two pages and absent everywhere else.

The rail carries no ⌘1…⌘5, and the mockups have them: in this app those five are already
"focus session N", which shipped first and is the more frequent act. The palette carries
every page instead.

### 6 · Workspaces and sessions are one tree

They were two lists — every workspace in one, every workspace again as a group heading in
the other. The same fact twice, in two shapes, and neither of them said where a new
session would go.

A workspace appears once now, and its sessions are its children. Two modules render one
row between them, split by ownership rather than convenience: the workspace row is
`workspaces.ts`'s, which owns activation, the account, the form and the delete; the
sessions under it are the deck's, which owns their state. The panel leaves a container
under each row and `Deck.setTree` asks for it.

So **creation is positional**. The last row inside each group is "New session in <name>",
at the place the new session will appear, and it says which workspace that is — including
for a workspace with nothing running in it, which is the case that needs it most. The
full-width "+ session" button is gone: it created in whichever workspace happened to be
active, so being wrong about which one that was meant a session in the wrong folder,
discovered afterwards. Exactly one create row is prominent — the active workspace's — so
the panel still has one obvious primary action, and pressing any other one creates there.

The active workspace's row carries a chip on its second line — `queue · PRs · journal` —
because a tint and an accent rail say "this one" and not what follows from it. Only that
row has it: three rows claiming it would be three claims where there is one fact.

One gesture, one rule: a workspace row that is not active becomes active, and pressing the
one that already is folds its sessions. Splitting "activate" from "expand" across two
targets inside one row is how a tree gets two things to press, one of which is always the
one you miss — so the chevron in front of the name is an indicator rather than a control:
it rotates with the state and is `aria-hidden`, and `aria-expanded` on the row's own
button is what a reader gets. That a row means two things depending on which row it is —
a workspace changes what three pages show, the create row inside it starts a session
there — is written under the tree, because neither half is guessable from looking.

### 7 · A zoomed session gets its own tools

A session launched on an issue runs in a worktree of its own, so "which files are here" and
"what have I changed" are per-session questions the app panel cannot answer — it does not
know which of a dozen sessions is being asked about. The answer lives inside the tile's
frame, on the opposite edge from the app panel, and states its scope in its own header.

Three tools, each reading something real: **Files** (`git ls-files`, so the repository's
own ignore rules decide what is not worth showing), **Changes** (`--porcelain` and
`--numstat` folded into one answer), **Source** (what launched this session, with its
prompt whole — the one thing about a session that cannot be reconstructed from anything
else on screen). There is no fourth and no "+ add a tool" strip: this app has no extension
point yet, and a list of tools that do not exist is a menu of lies.

In zoom — and when a session is alone in the deck, which is the same thing by another
route: it already fills the stage, and `zoomTo` refuses when there is nothing to zoom
past, so the one case where a person is unambiguously inside a single session would
otherwise have been the case with no tools at all. At deck size with several tiles there
are none: a tile is 400px wide and the terminal is the whole point of it.

**The 80-column floor** is the rule the feature turns on. `fit()` follows whatever box the
terminal sits in, so a panel that narrows the terminal re-wraps the agent's output — and
this app has shipped that bug once already, when the filmstrip resized a PTY to roughly 22
columns by 3 rows. Above the floor the panel takes its room from the terminal; below it,
it floats over the terminal instead. Floating costs some output being covered. Squeezing
costs the transcript. `wouldSqueeze` in `src/tile-tools.ts` is the whole rule, and it
measures from what the terminal is showing rather than from a font metric.

### 8 · Every panel takes a width from the person using it

Four of them: the panel, the panel once it has taken the deck's width, the tool panel
inside a zoomed tile, and the terminal drawer's height. The first two are stored
separately, because a column of names and a kanban do not want the same width and sizing
one says nothing about the other; the tool panel's is one number for the app, since every
session's tools are the same tool.

The widths are custom properties rather than inline widths, and that is the decision:
until somebody drags an edge the width belongs to the stylesheet, whose `clamp(17.5rem,
19vw, 24rem)` tracks both the window and the text size. So the stored fields are
`Option` — the one place in `UiState` where "never set" has to be distinguishable from a
number.

`src/resize.ts` is one handle written once: keys as well as a pointer, because a drag is
the only gesture in this app with no keyboard equivalent unless one is written;
`role="separator"` with `aria-valuenow`, because a focusable separator is a window
splitter and the value is what tells a reader what the keys just did; and a commit
separate from the write, because a save per frame is a file write per frame.

### 9 · Settings says where things are, not only how to change them

Two sections. The text size, with a live preview — a chooser that only takes effect on OK
asks a person to imagine each option, which is what they opened it to stop doing. And
**where things are kept**: the directory the app writes its own state in, every file it
writes by name — including the ones not written yet, which say so — then the active
workspace's folder, the account a push from it goes out as, and where its tasks come from.

That second section is not a preference at all; it is an answer. Every fact in it was
already true and none of it was visible: the paths were in nobody's documentation and the
bindings only inside the form that changes them. Editing is handed to that form, because
it owns those fields and a second editor for them is a second thing to keep in step.

`config_paths` names the files rather than listing the directory, and that is the whole
design: `read_dir` answers "what is there", and the question is "what does this app keep
about me" — which includes the file that does not exist yet because nothing has been
saved to it.

## The second round, after the shell was used

Three things came back from using it, and each one is a decision rather than a
tweak.

**The board and the pull requests left the tree.** They had been in the rail
(app-wide switches over one repository's data — the subject changed in silence
with the workspace), then two rows under every workspace in the tree. The second
placement was honest about the subject and charged for it forever: on six
workspaces, twelve identical navigation rows against eight session rows —
**measured at 261px of a 300px column, the height of four session rows** — and a
kanban opened in that column had to take the deck's width every time. They now
live in `#wspanel` on the right of the deck: head names the repository and the
account, two tabs (a real `role="tablist"`, which the rail deliberately is not),
its own grip and two remembered widths, wide only while a diff is open, closed by
a zoom because a zoomed tile's tool panel takes that same edge. The way in is the
`board · PRs · journal` chip on the active workspace's row, which until then only
*stated* that three pages were showing this workspace. The left panel's wide mode
went with the kanban: `#panel-wide`, `PANEL_WIDE` and `#sidebar.is-wide` are all
gone.

`⇧⌘B` / `⇧⌘P` were proposed and NOT shipped: `Ctrl+Shift+B` is broadcast on
Windows and Linux, and a key that works on one platform and collides on another
is worse than no key. The palette carries both, as it does the rail's three.

**Settings became a rail of sections.** A section is one row in the rail and one
pane beside it — that is the whole extensibility claim. Appearance, Config
repository, Files, ordered "often and harmless" to "rarely and with
consequences". There is no OK: everything applies as it is touched, because
connecting a repository cannot be undone by a Cancel and one rule for the window
beats one rule per section. The config section mounts the *real* sync renderer
(`mountSync`, shared with the first-run dialog) rather than a second copy of five
states.

**Nineteen hairlines went, and San Francisco arrived.** The dividers that sliced
the window into strips are gone: this design is islands on a void, an island
already has an edge, and every line removed sat between two regions that already
differ in lightness. What may still draw one — stated in `styles.css` so it does
not creep back — is an island's own **closed** edge, a document's own `---`, and
forced-colors mode. The type stacks lead with SF Pro Display / SF Pro Text and
fall through to the two bundled faces, so a Windows build looks the way it did;
`--ls-ui` went from +0.01em to -0.01em, because the tracking that kept IBM Plex
from crowding makes SF read sprayed apart. The terminal keeps its own stack — the
Nerd Font's powerline glyphs are why it is bundled.

## What is not ported

**The light theme.** `mockups/assets/deck-ui.css` carries a derived light theme — not an
inversion — and the generator emits its values (`--app` prints the dark set only). The app
declares `color-scheme: dark` and has no `[data-theme]` anywhere, so this is a pass of its
own: every component rule that hard-codes a dark assumption has to be found first, and
`scripts/contrast.mjs` has to grow a second set of grounds to measure it against.

**The rest of the motion set.** The app has `--dur-1`, `--dur-2`, `--dur-3` and one curve,
which is what its rules use. `--dur-4`, `--stagger`, `--ease-in-out` and `--ease-spring`
stay in the mockups until a rule needs them: a declared token nothing renders at is a
claim nobody checks.

**The README's screenshots.** `docs/images/*.png` still show the four tabs. Re-shooting
them is `npm run dev` and `node harness/shoot.mjs`, which needs ImageMagick on the machine
doing the shooting — `magick` is what draws the window's rounded corners and resamples the
2× capture down to the width GitHub lays out at. See `docs/images/README.md`.

## How to check it

```
npm run contrast
```

58 cases from `src/styles.css` and `src/terminal.ts`, 52 with a threshold and all of them
clear, 3 documented rejections. The script reads both files rather than restating them, so
a palette edit moves these numbers instead of silently disagreeing with them. Six of the
cases are this pass's: the ledger's two hues on the chrome and on the ground their own
hover paints, and the rail's dot in both states.

```
npm test            # 1138, including the panel's contract and the 80-column floor
cargo test --manifest-path src-tauri/Cargo.toml   # 645, including the porcelain folding
```
