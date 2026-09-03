---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0013 — The tray panel is a window, and a menu is the Linux fallback

## Context

The app exists only as its windows. Everything it knows — what each AI has left,
which sessions are waiting — is readable only with the deck on screen and in
front. The floating pill was the one exception, and it was a single sentence with
no way to ask it anything; #394 removed it while this was being built, which
leaves the app with nothing at all outside its own windows.

#393 asks for a second, permanent surface: an icon in the menu bar on macOS, the
top panel on Linux and the notification area on Windows, with a panel behind it,
built as a place things can be added to rather than as a fixed readout of two
facts. It names the choice that shapes everything else and asks for it to be
made first.

**A native menu** is cheap, behaves correctly on every desktop, and is what Linux
may force anyway — but it cannot draw a meter, and its rows are text.

**A small webview window** anchored under the icon can reuse the deck's CSS and
its existing limit rendering — but positioning it under a status icon is fiddly
on all three platforms, dismiss-on-blur has to be built, and it needs a window
label, a capability entry and a stylesheet of its own.

The menu was built first, on the reasoning that ADR-0009 already treats the meter
as decoration — the tier and the number are the reading, and `readingOf` produces
both as one string. Looked at in a real menu bar, that reasoning did not survive
contact:

```
Limits
  Claude · Reported · 17% used
Sessions
  Nothing is waiting for input.
  5 other sessions
```

Every fact is there and it is the wrong surface for them. "17% used" as a
sentence has to be read; a bar is seen. The whole reason the deck's limits block
is a block and not a fifth page (`usage-block.ts`) is that a limit is something
you glance at — and a menu is the one form of UI that cannot be glanced at,
because it does not exist until you have already committed to opening it. Having
paid the click, the person deserves more than a sentence.

Two further things bear on the choice, and are not general:

1. **The rendering rules for a limit are already pure functions in TypeScript** —
   `primaryWindow`, `readingOf`, `tierNote`, `limitFoot`, `formatReset` in
   `src/usage.ts`, written that way so the block, the dialog and anything after
   them cannot disagree about a number. A menu built in Rust would reimplement
   every one of them.
2. **On Linux the click may never reach us.** On most desktops a
   StatusNotifierItem's left click is not deliverable to the application, and
   some environments only ever show the menu. A design whose panel is a window
   opened on a click has nothing to show on those desktops.

## Decision

### 1. The panel is a webview window, and a native menu is the Linux fallback

`windows::TRAY` — `tray.html`, created hidden at startup, positioned under the
icon and shown on a click, dismissed on blur or Escape. It draws the deck's own
limits block, meters and all.

On Linux, no such window is created and the icon carries a menu instead, built
from the same report. That is not a lesser Linux build made out of pessimism: it
is the only thing the platform guarantees, and a menu is strictly better than a
panel that never opens.

What follows is that **the two surfaces must not be two designs.** They are
rendered from one list — see decision 2 — so a section added for one appears in
the other.

### 2. One section list, two renderers, and Rust knows nothing about limits

`PANEL` in `src/tray-panel.ts`. A section is one entry with four fields: an id, a
heading, `rows(facts)` for the menu, and `fill(body, facts, act)` for the window.

Declaring both together is the part that matters. Two lists — one per surface —
is how a Linux desktop comes to be told something different from a Mac one, six
months after nobody remembers there were two.

The main window already holds both inputs: `lastUsage` from `usageSnapshot`, and
every window's sessions in `sessionsByWindow`. It sends the composed report to
`tray_update` (the tooltip, the badge count, the menu's sentences) and the raw
facts to the panel window (`tray://facts`), which runs the same helpers and the
same `LimitsBlock` the deck's block does.

`src-tauri/src/tray.rs` positions a window, turns any list of sections into a
menu, routes a click back and tells the dock a number. It contains no provider
name, no window name, no reading and no reset time.

**`LimitsBlock` is reused, not copied.** Three optional hooks on `LimitsHost` —
`strip`, `openDetail`, `openProbe` — are the whole difference between the two
surfaces, and each defaults to what the deck already does. A second
implementation of a row is how the two would come to disagree about a number,
which is what `usage.ts` exists to prevent.

`strip: false` is the one that is about this surface rather than about what it
lacks. In the deck the block is a folded line with the rows behind it (ADR-0011 —
at the foot of the panel when this was written, in the top bar since #461),
because the deck is a surface being worked in and the rows would take room from
it. This window is nothing but the glance: it draws
its own "Limits" heading, it was opened deliberately, and folding the rows inside
it would put them two presses deep in a surface that exists to show them in one.

### 3. The tray icon never carries the count. The dock badge does.

#393 is explicit that no two surfaces may answer the same question. Two answer
different ones:

- **The dock badge is the glance.** A number on an icon the person is already
  looking at when they decide whether to switch, with no interaction at all, and
  up only while there is something to say. Decision 4.
- **The tray is the question.** It is permanently present, including when the
  deck is idle and the badge is clear, and it answers on demand — every connected
  AI's meter with its tier, and every session that is waiting, each one a row you
  can click.

This was first written with the floating pill as the glance; #394 removed the
pill, and the decision came out unchanged because it was never about the pill.
The count belongs on the surface a person is already looking at, and a status
icon is not that surface — it is where you go to ask.

So the status icon has **no title text and no count**, on any platform, and its
image never changes. A hueless glyph that changed shape to mean "spent" would be
an unlabelled signal, which is the thing ADR-0009 was written to forbid; the
state is in the panel, beside the tier.

### 4. The dock badge is the count, and it clears on three events

`WebviewWindow::set_badge_count` on macOS and Linux; on Windows that call is
unsupported and `set_overlay_icon` takes its place — 16×16 over the taskbar
button is no room for a number, so the badge there degrades to a state, which is
what #393 asks for.

It clears on the deck being focused, on the queue emptying, and on quit. The
first is a rule rather than an event: while the main window has focus the badge
is suppressed, so the next report does not put it back. A stale badge trains
people to ignore the badge.

Nothing else in the app says this number. It overlapped the floating pill's count
while both existed, knowingly and briefly — the dock is what a person looks at
when deciding whether to switch to the deck, and the pill was what they saw while
they were not. The pill went with #394; the badge is now the whole of the glance.

### 5. A template image on macOS, the colour icon on Windows and Linux

Two files, both 36×36, both drawn by `scripts/tray-icon.mjs` from the geometry
and colours of the shipped `icons/icon.png`:

- **`icons/tray-template.png`** — monochrome, installed with
  `icon_as_template(true)`. macOS reads its alpha channel alone and supplies the
  ink: white against a dark menu bar, black against a light one, inverted while
  the panel is open. That is why every other icon in a menu bar is white on
  grey, and it is the only way to be one of them.
- **`icons/tray-colour.png`** — the app's icon, in colour, for Windows and
  Linux. Neither tints anything; a notification-area icon and a panel icon are
  drawn as they are, colour is both platforms' own convention, and a white glyph
  would vanish on a light Windows 11 taskbar.

`icon()` returns the image **and the flag together**, as a pair, and `install`
sets both in one expression. That is a fix for a class of bug rather than a
tidy-up — see the sequence below.

#### The template mark is a simplification, and had to be

The logo is a rounded frame, four black tiles, a white chevron and a blue cursor
block. At 18 points, two of those four cannot survive a single ink:

- **The tiles go.** One ink cannot draw tiles *darker* than their frame — only
  the frame minus the tiles, which leaves a cross of gutters. Drawn and looked
  at: at 18 points that cross and the chevron cannot both be read, the cross
  wins, the chevron disappears, and the icon becomes a window-tiling utility.
  The chevron is the half that says which app this is, so the tiles give way.
- **The colour goes**, by definition. The cursor block keeps its shape and loses
  its blue.

What is left — the frame's outline, the chevron, the cursor block — is the
logo's silhouette, legible at 16, 18 and 22 points. Six candidates were drawn
and compared against a light bar and a dark bar before this one.

#### How this took three attempts, two of which shipped

Recorded because the failures were not random and the last one is a design rule:

1. **The chevron and cursor block, as a template.** *"You can't see the tiles."*
   Fair: the first draft dropped the frame as well, on the theory that four
   squares would be noise at 18 points.
2. **The four tiles, as a template.** *"It's black, and it doesn't match the
   logo."* Two separate faults in one report. The black was a plain regression —
   decision 1's rework dropped `icon_as_template(true)` along with the macOS
   branch that carried it, leaving black-on-transparent art to be drawn
   literally. And four squares is not this app's mark.
3. **The app's icon, in colour, everywhere.** *"Now it's colour and it stands out
   — the others are all white on grey."* Correct, and the question that came with
   it — does that depend on the OS theme? — is the answer: on macOS it does, and
   a template image is the mechanism. On Windows and Linux it does not, and there
   colour is right.

The rule that falls out: **the art and the `icon_as_template` flag are one
decision.** Monochrome art with the flag off is a black smudge; the flag on with
colour art throws the colour away. Holding them in separate places is what let
attempt 2 happen, so `icon()` returns them as a pair and they cannot be set
independently.

#### The rest of it

36×36 because `tray-icon` scales a status item's image to 18 points tall, so 36
pixels is exactly 2× and nothing is resampled. Drawn rather than downscaled:
there is no SVG rasteriser in this project's toolchain and none on a stock
macOS, and a 14× reduction of the 512px icon turns a 2.5-pixel chevron into a
grey smear. Every shape has an exact distance function, so the edges are right
at this size.

The colour icon carries one thing the app icon does not: a lit hairline along the
inside of its frame, a pixel at 22% where the app icon has three units of 1024 at
9%. Without an edge a #27292C square has none against a dark taskbar, and the
mark becomes a chevron and a blue dash floating in the bar. The template needs
none of this — its frame is an outline and the system tints it to contrast.

`icons/tray-template.svg` and `icons/tray-colour.svg` carry the same numbers so
the shapes can be looked at; the script is the thing that runs, and both PNGs are
committed.

**A note for whoever touches `icons/icon-source.svg`:** its geometry is exact to
the pixel and its colours are stale. It is an earlier candidate — its own comment
says "four tiles, one live" — with a #1d1f21 ground, tiles *lighter* than the
ground and the top-left one tinted with the accent. The shipped icon has a
#27292C ground, black tiles and none lit. That file did not produce the icon this
app ships, and it should not be trusted for colour by the next person to draw
from it.

### 6. The panel loads the app's whole stylesheet

`src/tray.css` begins `@import "./styles.css"`. The obvious alternative — copying
the handful of colours a small window needs out of the palette — is what the
floating pill's stylesheet did, and the cost is on record: the pill was left
behind by two palettes in a row and came to look like a different program's
before #394 removed it.

This window cannot afford that and does not have to. What it draws *is* the
deck's limits block. Copying `.lim-row`, `.lim-meter` and the state classes here
would be copying the thing the surface exists to reuse, and a meter that is a
different colour in the menu bar than in the panel is worse than no meter.

The cost, measured rather than waved at: Vite inlines an `@import` into the
importing entry, so the built bundle carries a **duplicate** of `styles.css` —
99 kB beside the app's own 100 kB, not a shared file. The font files *are* shared
(one emitted asset, referenced by both stylesheets), and of the four faces
declared only the UI one is fetched, because a browser loads a font when a rule
matches text in it and nothing in this panel is set in the terminal's mono. So
the bill is 99 kB of CSS on disk and one local 537 kB face, paid once into a
webview created hidden at startup that never navigates again.

## Consequences

- Two renderings to keep working, and one list to keep them honest. A section
  that forgets `fill` does not compile; a section that forgets `rows` does not
  compile either. What no compiler catches is the two saying different *things*,
  and that is what the tests in `tests/tray-panel.test.ts` are for.
- The panel is a third webview process, created at startup and hidden. Measured
  against the alternative — the menu, which is free — this is the cost of the
  meter, paid knowingly.
- Positioning is ours now: under the icon, flipped above it where there is no
  room below (Windows), clamped to the work area of the monitor whose status area
  was clicked. `tray::place` is pure and tested for all four cases, because none
  of them can be tested through a window that has to be on screen to have a
  position.
- Dismiss-on-blur is ours too, and with it the popover toggle problem: clicking
  the icon while the panel is open blurs it first, so the click would reopen what
  it just closed. `REOPEN_GUARD` is the standard 250ms answer.
- The panel window needs a capability entry. `capabilities/default.json` lists
  windows explicitly, and a window whose label is not in that list can `invoke`
  nothing at all with nothing reported at either end — so
  `every_fixed_label_is_in_the_capability_file` now holds the two files together
  the way the workspace glob already was.
- `tauri`'s `tray-icon` and `image-png` features are on, which pulls in the
  `image` crate's PNG decoder. Linux packages need `libayatana-appindicator3-1`
  at runtime; CI already installs the `-dev` package.
- The dock badge is the only thing that speaks the count. Nothing polls it and
  nothing else may print it: a second surface with the same number is what
  decision 3 forbids, and a future one has to argue with it rather than around it.

## Alternatives considered

- **A native menu everywhere.** Built, and rejected on sight — see Context. It
  survives as the Linux path, where it is the only thing that works, and the code
  that builds it is `#[cfg(target_os = "linux")]` rather than deleted.
- **A native menu built in Rust from the usage snapshot.** The obvious shape, and
  the one that reimplements `readingOf`, `sourceLabel` and `formatReset` in a
  second language. Rejected before the menu was even written: #393 asks for those
  helpers to be reused precisely so the tray and the deck can never disagree
  about a number.
- **The webview panel on Linux too, with the menu as a fallback only where the
  click is undeliverable.** Attractive, and undecidable at runtime: there is no
  way to ask a desktop whether it will deliver an indicator's activation before
  trying it, and a surface that sometimes does nothing is worse than one that
  always shows a menu.
- **A tray icon that shows the waiting count as its title.** Free on macOS and
  Linux, unsupported on Windows, and a duplicate of the dock badge on the two
  where it works. Decision 3.
- **The colour icon on macOS too.** What attempt 3 shipped, and it is the app's
  icon exactly — which is its whole problem: a menu bar is a row of tinted
  glyphs, and a colour square in it is the one thing that does not belong.
  Decision 5.
- **A monochrome mark on Windows and Linux too, for consistency.** Consistency
  with what? Neither platform tints, so the mark would be one fixed ink against
  a taskbar that can be light or dark. Decision 5.
- **The tiles in the template, as the frame minus a cross of gutters.** The
  faithful reading of the logo in one ink, and illegible at 18 points: the cross
  wins and the chevron goes. Decision 5.
- **An icon that changes to signal a spent budget.** Attractive, and forbidden by
  ADR-0009's own rule: a mark is a reading with no tier beside it. Decision 3.
- **Downscaling `icons/icon.png` to 36 with `sips`.** One command, and soft: a
  14× reduction smears a 2.5-pixel chevron. Decision 5.
- **Copying the limit styles into `tray.css` rather than importing the
  stylesheet.** What the floating pill's stylesheet did, and what its own comment
  advised against. Decision 6.
- **Dropping the pill in favour of the tray.** Considered seriously while this
  record was being written, since it would settle decision 3 by subtraction, and
  rejected then because the pill answered without being opened and the tray does
  not. #394 dropped it anyway, on its own reasoning, and the question it answered
  went to the dock badge rather than to the icon — which is decision 3, arrived at
  from the other direction.
