# True Ink — the 2026-08-25 palette pass

The second pass over the visual language `src/styles.css` implements. **Only the palette
has shipped**, and this record says so where it matters: what is below under "The four
decisions" is in the app and measured by `npm run contrast`; what is under "Designed, not
ported" is drawn and argued but is not in the product yet.

Written in English per `CLAUDE.md`. The working sessions were held in Russian and their
running narrative stays in the Open Design project; nothing load-bearing lives only
there.

## Restoring the work

```
tools/palette.mjs --app     the block that stands in src/styles.css
tools/palette.mjs --base    the same values under the mockups' own token names
tools/palette.mjs           all five directions, as a table
mockups/palette-directions.html   the five directions on identical fragments, in a browser
```

The mockup opens with no build and loads three webfonts from Google Fonts, which is the
one way it differs from the app — the app bundles its faces as variable TTFs under
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

## Designed, not ported

The pass also produced an information architecture the app does not have yet: no view
tabs, a five-icon rail selecting what **one** panel holds, a deck that never yields, a
ledger of "what requires me" in the title bar, positional session creation inside a
workspace tree, and a tool panel that belongs to a zoomed tile and is scoped to its
worktree. `mockups/assets/deck-ui.css` carries the system that shell is built from,
including a light theme and a motion set the app has neither of.

None of that is in `src/`. It is not recorded here as a proposal either — when a piece of
it ships, it earns its section in this file, and until then the mockups in the Open Design
project are where it lives.

## How to check it

```
npm run contrast
```

55 cases from `src/styles.css` and `src/terminal.ts`, 52 with a threshold and all of them
clear, 3 documented rejections. The script reads both files rather than restating them, so
a palette edit moves these numbers instead of silently disagreeing with them.
