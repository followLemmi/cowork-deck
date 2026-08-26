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
most of what Claude Code's secondary output is drawn in.

**The ground moved once more in the third round, and the sentence above is still
true.** `term` went from L 0.145 to 0.180 — see *the terminal was a hole* below. The
hues did not move; the surface they are read on did, so `brightBlack` measures 6.81
rather than 7.20 and One Dark's `red`, the floor of the set, measures 5.87. Both are
asserted in `scripts/contrast.mjs`, which reads the theme rather than quoting it.

The caret is now the foreground rather than the accent. It stopped being a choice when
the accent became light itself: of two names for the same value, only one is true of a
terminal cursor.

## The mapping table

Four token names differ between the mockups and the app, each because the app's word is
the better one. `tools/palette.mjs --app` emits the app's names, so the translation
happens in one place rather than by hand:

| mockup | app | why |
|---|---|---|
| `--term-bg`, `--bg-code` | `--bg-terminal`, `--bg-code` | one token carried both while the two resolved close together; with `term` at the island's own lightness they answer different questions, so the app takes both names — see *a tile is one surface* below |
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

## The third round: the panel was a strip, and its door did not open

Three findings from using the second round, all about the same panel, and two of
them are defects rather than decisions.

**The panel is an island now.** It shipped as a flat `--bg-void` column: head,
tabs and page lying straight on the void, no edge, no radius, no contact shadow,
flush against the window's own frame. That is the one region of this shell that
contradicted the pass it came from — a deck of islands on a void to its left, a
sidebar whose every list is one, and between them a strip, which is exactly what
"the dividers that sliced the window into strips are gone" was about. So:
`--bg-island`, a hairline, `--r-island`, `--sh-island`, and a margin so the void
shows on three sides. Nothing on the left, because the deck's own padding is
already a gap of that size and two of them read as a mistake.

The ladder has two rungs and no third, so every surface that was an island *on the
void* keeps its edge inside the panel and gives up its shadow — `.tk-card`,
`.tk-rows`, `.tk-migrate`, `.pr-row`. Enumerated rather than
`#wspanel * { box-shadow: none }`, because in this stylesheet a focus ring IS a
box-shadow and that rule would take the keyboard's only feedback with it. The clip
that rounds the page is on `#wsp-body` and not on the island: the grip hangs off
the island's left edge, and an `overflow: hidden` there halves its hit area.

`scripts/contrast.mjs` moved four declarations with it, and one group of them was
already wrong: the diff bands are a 0.13 tint over `--bg-terminal` — which
`.pr-drawer-body` states outright, *code gets the terminal's ground and chrome gets
the island's* — and the file said `--bg-void`, which is neither. A translucent tint
measured over the wrong base is a measurement of a screen nobody sees. They move by
little, because `--bg-terminal` and `--bg-void` are five units of brightness apart,
and that is exactly why nobody caught it. All of them clear the threshold on the
real ground, so this is a corrected declaration and not a fixed failure. 60 cases
now, including both states of the new chip below.

**A zoom left no pointer route to the board at all.** The chip on the workspace's
row was the only one, and it lives in the panel a zoom collapses — so from the
state a person spends most of their day in, the board was reachable by palette and
by nothing else. The second door is on the **crumb**: it already names the
workspace these two pages are about, and it is the one thing on screen the zoom
leaves. A toggle rather than an opener, with `aria-expanded` and `aria-controls`,
because unlike the chip it is visible in both states — and the state has three
writers (the door, the chip's route in, the panel's own ✕), so `drawCrumbPages`
answers to all three.

**A tile is one surface, and the terminal has no ground of its own.** Everything
around it was a raised grey island; inside the tile was near-black with square
corners butted against the head, so the frame read as the object and the body as a
hole cut in it.

*It took two goes, and the middle one is the useful part of the record.* `term`
began at L 0.145 — 0.060 under the island, 0.037 over the void, nearer to the stage
than to its own card. Raising it to 0.180 halved that and left 0.025, which turned
out to be the worst of the range: too small to read as a surface, too large to
disappear, so what a person saw was a **seam** under the tile's head. A step between
a title and the thing it titles has nothing to say. So `term` is the island's own
0.205: head and body are one ground, and the deck is islands on a void with nothing
drawn inside them.

*`code` did not follow it, and that is the second half.* A patch is read rather than
watched, and the boundary between the list of pull requests and the patch beside it
is carried by that step alone — `.pr-drawer` draws no border, so on one ground the
two regions merge. The mockups always had two names for these two surfaces; it was
the app that collapsed them into `--bg-terminal` while the two resolved close
together. That collapse is undone: `--bg-code` at L 0.173 for the diff and for
`.tool-source-prompt`, which is a box inside an island and would otherwise be a box
nobody can see. The mapping table above records the split.

*What went with the step, and what came back because of it.* `.tile-body` and
`.term-bodies` were briefly inset 8px with a radius — the frame a darker body needs
to stop reading as a hole. On one ground an inset is invisible and costs a column of
width, so both went back to full bleed when the step they justified went. The
drawer's active tab loses the shared fill that said "this one" and keeps its
`--line-strong` edge and its brighter name: one channel of three, which is what the
change costs there.

The zoomed tile's tool panel cost more than that, and it is where **THE RULE gained
its converse**. `.tile-panel` and `.tile-tools` are chrome on the island's ground,
beside a terminal that is now also on the island's ground — so they simply vanished
into it. The nineteen-hairline pass removed lines "between two regions that already
differ in lightness"; these two regions no longer do, and there is no step left to
carry the boundary, so a line is the answer rather than a relapse. Both take
`border-left: 1px solid var(--line)`, which is what the mockups drew from the start
and the port dropped as two of the nineteen — right to go then, right to come back
now. `--line` and not `--line-strong`, for the reason `contrast.mjs` already gives
where it rejects the brighter one for the diff's seam: a seam is not a control.

All of it changed in `tools/palette.mjs` for the `ink` direction and re-emitted,
because that generator is the source. The app's `--bg-terminal` and `--bg-code`,
xterm's three frame colours in `src/terminal.ts` and the mockups' `--term-bg` /
`--bg-code` are all statements OF it, and a hand-edit to any one of them is how a
palette starts disagreeing with itself.

**Every dialog in the app was rendering in Times.** `font-family: var(--font-ui)`
was declared on `#app`, and `openDialog` appends its overlay to `document.body` — so
not one dialog inherited it: the settings window, the workspace form, the launch
parameters, the card, the palette, every confirmation. They came out in the UA's
default serif at the UA's default leading. Anything that set its own family escaped,
which is why the odd title looked right and made the rest look deliberate. The type,
the ink and the leading are on `body` now; `#app` keeps its layout and its ground.

**The settings window had never rendered as its own stylesheet describes it.**
`.modal-box--settings` sets `padding: 0` so the rail can reach the frame — and
`.modal-box`, declared a thousand lines below it with `padding: var(--sp-5)`, won on
source order. What drew instead was a rail inset 20px inside a rounded card, square
corners against round ones. Every other `.modal-box--*` variant happens to be
declared after the base and never noticed. Fixed by specificity rather than by moving
the rule, because the block belongs beside the `.set-*` rules it governs.

And the window's one button was the platform's: `.modal-ok`'s treatment is written as
`.modal-actions .modal-ok`, the foot was a `.set-foot`, and what a person got in the
window whose subject is how the app looks was a grey OS control with a 2px outset
border in Arial. The foot is a `.modal-actions` now — the class IS the styling — and
`.set-foot` adds only this window's padding.

**Settings grew a Scenarios section, and the journal's switch moved into it.**
Second in the rail, which is where "often and harmless" puts it. The section is the
whole extensibility claim being cashed: one entry in `SECTIONS`, one row, one pane,
nothing else touched. `labeledCheck` is exported from `forms.ts` rather than copied,
so "a box, its label and the line under it" stays one shape. The journal keeps the
SENTENCE that says recording is off — an empty page whose emptiness is a setting has
to say so where the emptiness is — and the switch that changes it now lives with the
other things you set once and leave.

**Three islands, three heads, and the heads above them are gone.** The tree and the
scenarios were each a raised surface with a head of its own; the journal was loose
rows on the column's own ground with its title *clipped to a pixel*, because the
panel's head above the page said the name instead. So the column stated every page's
name twice — `.panel-title` in `Sentence case` twelve pixels above the island's
`CAPS` — and one of the three had no head at all.

The name now lives where it is attached to the thing it names: `.panel-title` is
gone, the journal's mount takes `.island` like the other two, and its title is a bare
visible `h3` reading **Journal** — the word the rail and the palette already use,
rather than "Scenario runs". What is left in the panel's head is the half that was
always load-bearing: which workspace, which folder, which account. The workspace's
name inside the journal stays clipped, because that head still states it.

Two things left the journal's head with it. The **"Record scenario runs" switch** —
a setting living inside the page it governs, which is a fair argument in a full-width
screen and a bad one in a 280px column where it sat above the records looking like a
third filter. It goes to the settings window; until it gets there `recordScenarioRuns`
is read-only, still gating recording and still defaulting to on, and the empty state
still says so when it is off. And the **⏰** in the empty state's copy, which was the
only emoji in this page's prose.

That copy is now the page's own description, because the `!anyRuns` branch is the one
state a person can reach before they have ever seen a record — the other three
describe a situation, this one describes the page: what a run is, what is written
down, why that matters at 09:00 for something that ran at 03:00, and which sessions
are deliberately not recorded. `#sidebar h3` became `#sidebar .island > h3` in the
same pass: it was catching the empty state's own `h3` and rendering "No scenario runs
yet" — a sentence — in the dim caps of a section head. One treatment per kind of
heading.

`scripts/contrast.mjs` moved twelve declarations onto `--bg-island`, which is what the
journal's rows now sit on. Seven change nothing but the honesty of the record — their
group's base is the row's own opaque fill — and five were measuring ink against the
stage that has sat on an island since this page became one: the erase control, the
chain note, the workspace label, and the two chips on a continued row. All clear.

**And the journal was in the wrong panel.** Not "styled differently" — in the wrong
box. It was inserted as `prEl.after(historyEl)`, which was correct while all five
pages shared `#panel-stack`, and silently wrong from the moment the board moved to
`#wspanel` and took `#pr` with it. The rail's Journal button was un-hiding a page
inside a panel that is hidden by default: the journal rendered at 0×0, and with the
workspace panel open it rendered on the wrong side of the window. It is appended to
the stack explicitly now, between the tree and the scenarios — the order the rail
lists them, which for overlapping pages in one grid cell is the order the keyboard
walks them. `tests/panel-stack.test.ts` asserts the parentage of all five, because
nothing did: the app.ts comment describing the old arrangement was still there,
still saying all five ended up in the stack.

**The third island in the left column is gone, and so is the running bill.** After
the tree arrived, the deck's own list mount held exactly one line — `Total spend ·
N out · N in` — and an island around it. A running total is not something a person
acts on: it does not say which session spent it, and there is nothing to do about it
from here. It is stated nowhere now; each session's own spend is still on its tile's
token badge, in the tooltip `tokenTooltip` writes. The mount stays, because with no
tree — or with sessions whose workspace was deleted from under them — the groups
still render into it, and it is `hidden` when a render leaves it empty. An island
with nothing in it is a box the eye has to dismiss.

**A caption and its title were 1px apart.** `.panel-titles`, `.wsp-titles` and
`.tool-titles` are the same two-line head in three places, and at `gap: 1px` the
title read as a second line of the caption above it rather than as the heading under
it. All three take `--sp-1`: the same shape spaced differently in three places is
three shapes.

**Every control on a workspace row was dead on macOS, Windows and X11.** Not the
chip alone: ✎, 🗑 and the pull-out control with it. The tear-out gesture takes
`setPointerCapture` on the ROW at `pointerdown`, and a captured pointer retargets
the compatibility mouse events along with the pointer ones — `click` included. So
every press on a control arrived at the row, the control's handler never ran, and
the row's ran instead with `e.target` pointing at itself, where its
`closest(".ws-edit, .ws-del, .ws-detach")` guard could not see what had been
pressed. What a person got was the sessions folding.

It was invisible three ways over, which is the part worth keeping written down. It
is behind `placesWindows`, so a Wayland desktop never saw it. The harness's
`host_platform` answered without that field at all — and a missing boolean reads as
false, which is the one value that switches the gesture off, so 1161 tests and every
screenshot ran the branch almost nobody runs. And the pure functions the gesture's
own test file covers are the two that decide *whether* a drag has begun, which is
not where this lives. The fix is one guard, `pressStartsOnControl`: any button in
the row except the name, so a control added next year is protected by having been
added. The mock now sends the field the Rust struct always sends, and
`tests/ws-row-controls.test.ts` reads the panel's real render rather than a fixture,
because the thing that rots here is the class names.

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
