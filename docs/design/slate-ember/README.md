# Slate & Ember — the 2026-08-04 redesign

The visual language `src/styles.css` implements, and why each decision is the one it is.
Everything here shipped: this is a record of the design, not a proposal.

Written in English per `CLAUDE.md`. The working session that produced it was held in
Russian and its running narrative stays in the Open Design project; nothing in that
narrative is load-bearing that is not restated here.

## Restoring the work

```
mockups/index.html        open in a browser — the launcher, then the four screens
mockups/assets/deck-ui.css   the design system as authored (the source of src/styles.css)
mockups/assets/icons.js      the icon sprite: src/icons.ts's geometry plus the new glyphs
tools/palette.mjs         node tools/palette.mjs → the palette, resolved and measured
```

The mockups are self-contained and need no build. They load three webfonts from Google
Fonts, which is the one way they differ from the app — the app bundles the same faces as
variable TTFs under `src/assets/fonts/`, because a Tauri window has no network guarantee
and a CSP.

`mockups/assets/deck-ui.css` and `src/styles.css` are **not** the same file. The mockup
carries the system as designed, with its own class names; the app carries it applied to
the class names the app already had. Where the two disagree, `src/styles.css` is what
ships and the mapping table below says why.

## What was wrong

Three complaints, none of them a matter of taste.

**Nothing grouped.** `--border: #2c313a` measured 1.28:1 against `--bg-panel` — a border
nobody can see. There was no raised surface in the file at all: no shadow on content, no
inner highlight, no radius above 10px. The screen was a flat run of boxes on one ground,
and the only hierarchy left was type size.

**Empty where it needed density.** `.tk-cols` declared `grid-auto-columns: minmax(240px,
1fr)`, so four board columns stretched across the whole window; `.pr-detail-body` capped
text at 72ch in the middle of a 1970px screen. Meanwhile the sidebar was one
undifferentiated scroll of `h3`s and rows.

**Five hues for four meanings.** A blue accent competed with `--st-working`,
`--st-waiting`, `--st-ended` and `--st-error` on a screen whose whole job is reporting
what a dozen concurrent sessions are doing.

## The three decisions

### 1 · Islands

Content lives on raised, rounded, hairlined surfaces above a darker ground. Elevation is
three things at once:

```css
--sh-island: inset 0 1px 0 rgba(255,255,255,.04), 0 10px 30px -14px rgba(0,0,0,.75);
```

Any one of the three alone is a flat box again. Island radius 14px, control radius 8px —
and the radius belongs to the size of the object, which is why a 59px filmstrip card
takes the control radius instead.

What became an island: the terminal tile, the board card, the pull request row, each
sidebar section, the modal, the command palette. What stayed ground: the stage, the
sidebar, the board column. **The column is not an island** — the cards in it are, and
that is what gives the board depth: the things you can pick up sit above the ground you
cannot.

### 2 · Hue belongs to state

The accent is near-achromatic light, `#d5eaf3`. The argument in one sentence: *in an app
whose job is reporting the state of N concurrent sessions, hue is a scarce resource and it
belongs to state.*

- Selection, focus and the primary action are light, not coloured.
- Green, amber and red mean working, needs-you and broken, and nothing else borrows them.
- **`--st-ended` gave up its cyan.** Ended is the absence of a signal, not a signal, and a
  fifth hue made the three that matter harder to separate. It is `--fg-mid`, not
  `--fg-dim`: hueless does not have to mean "the dimmest step", and at `--fg-dim` the
  ended chip on a selected row measured 3.62. Ended is told from idle by a border.
- Workspace colour swatches moved onto this palette too. A workspace dot sits two pixels
  from a state chip, so a dot in the old blue-cyan family read as a sixth signal.

### 3 · The state rail

The one flourish: a 3px bar on the left edge of every tile, row and card, carrying its
state colour.

```css
.tile::before { left: 0; top: 0; bottom: 0; width: 3px; background: var(--rail); }
.tile[data-state="waitingInput"] { --rail: var(--st-waiting); }
```

A dozen tiles read in one sweep instead of by reading a dozen small chips. Full-height on
a tile, inset from the corners on a row or a card — a bar reaching the corners of a small
object reads as its border.

Driven by `data-state`, never by a class: `.state-*` already means "a chip with this fill
and this text colour", and one of those names on a row would paint a chip's background
across the whole line.

`idle` gets no rail, and neither does a pull request whose checks passed. A rail on the
resting state of most rows most of the time says nothing.

## Tokens

Authored in OKLch, resolved to sRGB by `tools/palette.mjs`, which also measures every
pair the design asserts. The stylesheet carries hex and `rgba()` rather than `oklch()`
because `scripts/contrast.mjs` parses `#rgb`, `#rrggbb` and `rgba()` and nothing else —
**a colour that script cannot read is a colour nobody can check.**

```
node docs/design/slate-ember/tools/palette.mjs        # the table and every measurement
node docs/design/slate-ember/tools/palette.mjs --css  # a ready :root block
```

| Token | hex | OKLch | Role |
|---|---|---|---|
| `--bg-void` | `#0f0d0b` | `0.160 0.006 70` | the stage and the sidebar: what islands float on |
| `--bg-chrome` | `#171412` | `0.195 0.006 70` | the top bar only; it gives the window a top edge |
| `--bg-island` | `#201e1b` | `0.235 0.007 70` | a raised content surface |
| `--bg-inset` | `#302d2a` | `0.300 0.008 70` | fields and controls sunk into an island |
| `--bg-terminal` | `#13110f` | `0.178 0.005 70` | a terminal body, and the diff's ground |
| `--bg-hover` | `#302d2a` | `0.300 0.008 70` | a row on an island under the cursor |
| `--bg-hover-2` | `#413e3a` | `0.365 0.008 70` | a control already sitting on `--bg-inset` |
| `--line` | `#393632` | `0.335 0.008 70` | the hairline |
| `--line-strong` | `#55504b` | `0.435 0.010 70` | a field's edge; a seam that must be seen |
| `--fg` | `#efece8` | `0.945 0.006 80` | ink |
| `--fg-mid` | `#bab7b2` | `0.780 0.008 80` | secondary text, paths, meta |
| `--fg-dim` | `#9a9690` | `0.675 0.010 80` | captions and gutters: the quietest legible step |
| `--accent` | `#d5eaf3` | `0.925 0.025 225` | selection, focus, the primary action |
| `--accent-press` | `#bed5df` | `0.860 0.028 225` | the same fill, one step down |
| `--st-working` | `#7bd77f` | `0.800 0.150 145` | working |
| `--st-waiting` | `#efc845` | `0.845 0.150 92` | needs a decision |
| `--st-error` | `#fb817a` | `0.740 0.150 25` | broken |
| `--st-ended` | `#bab7b2` | `0.780 0.008 80` | ended — hueless by design |

The grounds carry a **warm** cast (OKLch hue 70). Every default dark theme, One Dark
included, casts blue-violet; a warm graphite is the cheapest way for the app to stop
looking like a template.

### Why the surface ladder is uneven

The steps are spaced by what has to be *distinguishable*, not by pleasing arithmetic.
`--bg-inset` sits 0.065 above `--bg-island` because a field is recognised by its fill
rather than by its border — at the even 0.04 this started with, that pair measured 1.12
and the claim was false.

Raising it had a consequence: `--fg-dim` at its first value (0.640) then measured 4.05 on
`--bg-inset`, which is a placeholder below AA inside every field in the app. So the
quietest ink step went to 0.675. That is also the direct answer to "the type feels
small": the token it replaces measured 3.44 and carried nine different meanings.

### Measurements

`node tools/palette.mjs` asserts **56 pairs** and passes all of them. Two deviations are
recorded in the script itself, each naming the rule that carries the requirement instead:

- `--fg-dim` on a selected row — 4.36. Fixed by a rule, not a token: a selected row
  raises its own captions one step to `--fg-mid` (6.42). Lowering the selection alpha far
  enough to rescue `--fg-dim` would make selection invisible.
- `--line-strong` against `--bg-inset` — 1.72. That is a field's border against the
  field's own fill, which is not the pair that decides anything. On a dark theme a border
  bright enough to pass 3.0 against its surroundings is near-white and reads as broken, so
  SC 1.4.11 is carried by the fill step (1.21) and the 2px focus ring (13.4).

In the repository, `npm run contrast` asserts **38 composited cases** and passes all of
them, with three documented rejections. It reads values out of `src/styles.css` and
`src/terminal.ts` rather than restating them, so a palette edit moves its numbers instead
of silently disagreeing with them.

## Type

| Role | Size | Tracking | Face |
|---|---|---|---|
| xl — one screen title per view | 22px (`1.375rem`) | `-0.015em` | Space Grotesk |
| lg — row and card titles | 19px (`1.1875rem`) | 0 | IBM Plex Sans |
| body | **16px** (`1rem`) | 0 | IBM Plex Sans |
| small | 14px (`0.875rem`) | `0.01em` | IBM Plex Sans |
| caption | 13px (`0.8125rem`) | `0.01em` | IBM Plex Sans |
| UPPERCASE | 13px | **`0.08em`** | IBM Plex Sans |
| code | 14px | 0 | CaskaydiaCove |

Three weights: 400 to read, 500 to emphasise, 600 to announce. Line heights 1.25 for
one-line UI, 1.55 for prose and for code.

**The base is 16px, and the comparison that matters is not against 13.** `ui-scale.ts`
defaulted to a 1.15 multiplier, so the app already shipped at root = 14.95px and rendered
12.65 / 13.80 / 14.95 / 18.40 / 21.85. A 15px base with tighter ratios — the obvious
move — would have been a step *down* at four steps out of five. 16px with
`DEFAULT_SCALE` back at 1 raises every step and makes 100% and the shipped size the same
number.

A side effect worth knowing: 16 is a power of two, so multiplying it by any scale step is
exact in binary floating point and the rounding in `rootFontPx` no longer corrects
anything. It stays as a guard, and the test says so rather than pretending otherwise.

The largest step anything renders at is 22px, below the 24px where WCAG's large-text
allowance begins. A 30px token was declared during the redesign and removed again because
nothing used it: a declared token nothing uses is a claim nobody checks.

## States and interaction

**Hover moves the ground, never the ink.** Each hover token is +0.065 on L from the
surface it covers — inside the 0.06–0.12 band that reads as a change without reading as a
different component.

This replaced the app's most consequential defect. `.btn--icon` was muted with
`opacity: 0.7`; ancestor opacity renders the subtree to a buffer and composites it over
the backdrop, so it dragged the glyph towards whatever was behind it. Every icon control
in the app sat at **2.67:1 while doing nothing**, and neither axe-core nor Lighthouse
reports that row because neither composites an ancestor's opacity. It is a colour now,
with three honest steps: 5.65 at rest, 4.65 on a hovered row, 11.62 on its own hover, and
4.35 on a selected row.

A light fill does not invert on hover — it steps its own fill down and its dark ink stays,
both halves in one rule. Disabled is the only state allowed to lose contrast.

Hit targets stay in **CSS pixels**, not `rem`: SC 2.5.8 is written in pixels, so a
relative value would fall under the minimum at the smallest step of the text-size control.

## What changed in the app

Class names were **not** renamed. They are load-bearing for a 747-test suite and for the
panels' own code, and the visual goal needed only that the shared look be declared once.
The table therefore says what was *restyled*, not what was renamed.

| What | What became of it |
|---|---|
| `#viewbar` | wrapped in `<header class="topbar">`; 52px, wordmark and global actions |
| `.tk-views` | restyled as a segmented control, sunk into the bar, active segment raised |
| `#sidebar` | three `.island` panels on the existing mount nodes; no `render()` rewritten |
| `.ws-row` / `.sess-row` / `.sk-row` | one shared declaration plus a `::before` rail |
| `.tile` | island with a full-height rail; the head lost its own fill |
| `.bcast-panel` | still absolute, but `#deck.has-bcast` makes room for it |
| `.deck-strip` | status cards, no terminal (see below) |
| `.tk-cols` | `minmax(18rem, 21.5rem)` and `justify-content: start` |
| `.tk-card` / `.tk-row` | island and rail; the rail left `inset box-shadow` for `::before` |
| `.pr-row` | an island each, rail driven by `data-checks` |
| `.pr-drawer*` / `.dv-*` | tokens and spacing only; the diff logic was already right |
| `.modal-box` | `--sh-float`, island radius, a display-face title |
| `.btn--icon` | `opacity` → `color` |

### Three defects the port surfaced

**The filmstrip was resizing PTYs.** A minimized tile gave its terminal about 220×90px, so
`fit()` resized the agent's terminal to roughly 22 columns by 3 rows and the output
re-wrapped to that width until the tile came back. The strip shows status cards now; with
the body hidden, `TerminalPanel.fit` returns early on a zero-size mount and the PTY keeps
its dimensions.

**The tile name was never truncating.** It was styled by `.tile-head span:first-child`,
and `sessions.ts` inserts the broadcast checkbox before the title on every tile — so an
`<input>` is always the head's first child and that selector matched nothing. A long
session name pushed the badges out of the head. It has a class now.

**`›` and `✓` did the same thing.** A GitHub board has two steps, so on an open issue
`stepAfter` *is* the closing step: two controls reached one end through two handlers, and
one of them was labelled "Move to the next step", which names nothing on a two-step board.
Both paths ask for a reason, so no guard was bypassed — it was two buttons for one action.
`›` is now withheld whenever it would perform the transition `✓` already performs, stated
generally: on any board, a card in the last non-terminal step has a `›` that closes it.
Both arrows name their destination now.

## Deliberately not done

- **No light theme.** The brief asked for a new dark one, so the surface ladder runs one
  way. A light theme needs a second set of measurements, not an inversion.
- **No coloured issue labels.** They are the obvious "make it nicer" move and they would
  collide with the state hues in the same row. The distinction went into structure and a
  label filter instead.
- **No active-workspace chip in the top bar.** It is in the mockups; it needs wiring into
  `WorkspacesPanel.onSelect`, and the sidebar beside it already shows the name and the
  bound account.
- **The pill keeps the platform typeface.** Bundling the UI face into a second window
  means a second copy of a 537 kB file for one line of text.
- **Nothing was verified by running the app.** Every claim here is either a measurement
  from `npm run contrast` / `tools/palette.mjs`, a test, or static review. Geometry the
  tests cannot see — the sidebar's three islands, tile heads on a narrow window, the
  broadcast bar, the card dialog's height — is the first thing to look at with the app
  open.

## The 2026-08-05 quality pass

A second reading of work already shipped: not filling gaps, but looking for what these
screens get wrong. Six findings, all fixed. Each is a state the system promises and does
not show, or a label that names the wrong thing.

**The pressed filter had no hover.** `.filter:hover` and `.filter[aria-pressed="true"]`
carry the same specificity, so the pressed rule won by being later and swallowed the
hover it never replaced — on the one control that can clear a label filter, since there
is no "all" chip. Fixed with `--sel-hover`; the app carries the same fix for
`.tk-filter.selected` and `.tk-f-kind.selected`. The alpha and its measurements are in
`tools/palette.mjs`, which now asserts 60 pairs.

**Four components ate the focus ring.** The global ring is declared through `:where()`,
so it contributes nothing but the pseudo-class and sits at the top of the file — which
means *any* component painting its own `box-shadow` outranks it, being both later and at
least as specific. The four that did were each in the worst possible place:

| Selector | What it showed instead of a ring |
|---|---|
| `.island` | the launcher's four screen links are `<a class="island">` — no focus state at all |
| `.tile.is-active` | the tile a keyboard is most likely to arrive on |
| `.seg button[aria-selected="true"]` | the view tab the user is standing on |
| `.swatch[aria-pressed="true"]` | the pressed swatch, whose position is the thing to see |

Each now restates the ring beside the shadow that beat it — the idiom `.drawer-grip`
already used. The rule is written into the stylesheet: paint a `box-shadow` on something
focusable and you owe it a `:focus-visible` next to it. The app is immune to this trap
because its global ring is an `outline` (`src/styles.css`), which no shadow can override.

**Three `›` arrows named the wrong step.** The rule that an arrow names its destination
is stated in this file, and the board mockup broke it on three cards out of seven. The
worst was a card in **Todo** whose `›` read **"Move to Todo"** — the button named the
column the card was already in, which is exactly the complaint the rule was written for.

**`✓` was scattered.** It was drawn on one card out of five non-terminal ones, and two
cards in the same column disagreed. Since the rule for `›` depends on where `✓` sends a
card, an invisible `✓` makes that rule unverifiable for anyone reading the mockup. The
footer order is now one order everywhere — `‹ › ▶ ✓`, arrows as a pair, then the
actions, closing last — which is what the issue row already did (`▶ ✓ ↗`). The damaged
card gets no `✓`: closing rewrites the file, and that is the one file we will not write.

**Juggling sessions did not work.** `zoom()` marked the picked tile and moved the rest
into the filmstrip, but never moved the picked one *out* of it. Every zoom rule is
written with `>`, so a card left inside `.strip` got neither the grid row nor a body: the
gesture selected a session and showed nothing. Only the first zoom — from the deck —
ever worked. The deck also reshuffled itself, because returning from zoom inserted tiles
where they had landed rather than where they belonged; the authored order is now held
once and restored from it, filmstrip included.

**The filmstrip card was a dead focus stop.** It is the only way to switch sessions while
one is zoomed, and at 240×59 its own buttons are hidden — yet activation hung on a click
handler on a `<section tabindex="0">`: it took focus, drew a ring, and did nothing on
Enter. A focus stop that promises an action and refuses it is worse than one that never
takes focus. The card is now a real button (`role="button"`, an `aria-label` naming the
session, Enter and Space handled, Space suppressed explicitly because a `<section>`
would scroll the page). In the deck the same element stays a labelled **region**:
`role="button"` there would be a button containing three buttons and a focusable
terminal. In the strip it is legitimate precisely because that content is
`display: none` and absent from the accessibility tree.

Note for the app: zoom there still has no keyboard path at all (`sessions.ts` hangs it on
`dblclick`). That is wave 3 of the UX audit, not a regression of this port.
