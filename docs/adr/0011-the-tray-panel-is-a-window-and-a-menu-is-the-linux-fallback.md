---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0011 — The tray panel is a window, and a menu is the Linux fallback

## Context

The app existed only as its windows. Everything it knows — what each AI has left,
which sessions are waiting — was readable only with the deck on screen and in
front. The floating pill was the one exception, and it is a single sentence with
no way to ask it anything.

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
paid the click, the person deserves more than the pill already tells them.

Two further things bear on the choice, and are not general:

1. **The rendering rules for a limit are already pure functions in TypeScript** —
   `primaryWindow`, `readingOf`, `sourceLabel`, `formatReset` in `src/usage.ts`,
   written that way so the block, the dialog and the pill cannot disagree about a
   number. A menu built in Rust would reimplement every one of them.
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
`heading`, `openDetail`, `openProbe` — are the whole difference between the two
surfaces, and each defaults to what the deck already did. A second implementation
of a row is how the two would come to disagree about a number, which is what
`usage.ts` exists to prevent.

### 3. The tray icon never carries the count. The pill does.

#393 is explicit that the two must not both answer the same question. They do not:

- **The pill is the glance.** It floats over every other application, says "3
  waiting for input" or "limit · resets 19:00" with no interaction at all, and is
  up only while there is something to say.
- **The tray is the question.** It is permanently present, including when the
  deck is idle and the pill is down, and it answers on demand — every connected
  AI's meter with its tier, and every session that is waiting, each one a row you
  can click.

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

This does overlap the pill's count, and knowingly. The badge and the pill are
visible in different places — the dock is what a person looks at when deciding
whether to switch to the deck; the pill is what they see while they are not.

### 5. The status-area icon is the app's icon, in colour, and not a template

`icons/tray-mac.png`, 36×36, drawn by `scripts/tray-icon.mjs` from the geometry
and the colours of the shipped `icons/icon.png`: the dark rounded frame, the four
black tiles, the white chevron, the blue cursor block. One image on all three
platforms.

**It was a template image and that was wrong twice over.** Apple's guidance for a
status item is a template — monochrome art, tinted by the system for a light menu
bar, a dark one, and the inverted state while the panel is open — and this record
originally followed it, with the tiles alone as the mark. Two reports from a real
menu bar, in order:

1. *"You can't see the tiles"* — the first draft was the icon's chevron and
   cursor block, on the theory that four squares would be noise at 18 points. It
   was not: 36 pixels is room for four tiles with a gutter. But the tiles alone
   were not the answer either, because —
2. *"The icon doesn't match the app's logo, and it's black."* Both true. A
   monochrome mark **cannot** be this icon: take the colour away and what is left
   is four squares, a different mark from the one on the dock. And the black was
   a plain regression — decision 1's rework dropped `icon_as_template(true)`
   along with the macOS branch that carried it, leaving the platform to draw
   black-on-transparent art literally.

The person scanning a menu bar for this app is looking for the thing on their
dock. So it is that thing, in colour, and the flag is gone rather than restored.

What that gives up is the automatic light/dark adaptation, and it is paid for
explicitly: the frame carries a lit hairline along its inside edge — one pixel at
22%, where the app icon has three units of 1024 at 9% — because a #27292C square
against a dark menu bar otherwise has no edge at all, leaving a chevron and a
blue dash floating in the bar. Checked against a light bar, a dark bar and a mid
grey before shipping.

36×36 because `tray-icon` scales a status item's image to 18 points tall, so 36
pixels is exactly 2× and nothing is resampled. Drawn rather than downscaled:
there is no SVG rasteriser in this project's toolchain and none on a stock macOS,
and a 14× reduction of the 512px icon turns a 2.5-pixel chevron into a grey
smear. Every shape has an exact distance function, so the edges are right at this
size.

`icons/tray-source.svg` carries the same numbers so the shapes can be looked at;
the script is the thing that runs, and the PNG is committed.

**A note for whoever touches `icons/icon-source.svg`:** its geometry is exact to
the pixel and its colours are stale. It is an earlier candidate — its own comment
says "four tiles, one live" — with a #1d1f21 ground, tiles *lighter* than the
ground and the top-left one tinted with the accent. The shipped icon has a
#27292C ground, black tiles and none lit. That file did not produce the icon this
app ships, and it should not be trusted for colour by the next person to draw
from it.

### 6. The panel loads the app's whole stylesheet

`src/tray.css` begins `@import "./styles.css"`. `pill.css` copies four colours by
hand instead, and its own comment records the cost: the pill was left behind by
two palettes in a row and came to look like a different program's.

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
- The pill and the dock badge say the same number in two places. Decision 4 owns
  that; a future decision to drop one should argue with it rather than around it.

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
  Linux, unsupported on Windows, and a duplicate of the pill on the two where it
  works. Decision 3.
- **A template (monochrome) icon, per Apple's guidance for status items.** What
  shipped first, and rejected on two reports from a real menu bar. Decision 5.
- **An icon that changes to signal a spent budget.** Attractive, and forbidden by
  ADR-0009's own rule: a mark is a reading with no tier beside it. Decision 3.
- **Downscaling `icons/icon.png` to 36 with `sips`.** One command, and soft: a
  14× reduction smears a 2.5-pixel chevron. Decision 5.
- **Copying the limit styles into `tray.css` rather than importing the
  stylesheet.** What the pill does, and what the pill's own comment advises
  against. Decision 6.
- **Dropping the pill in favour of the tray.** Considered seriously, since it
  would settle decision 3 by subtraction. Rejected because the pill answers
  without being opened and the tray does not, and "how many are waiting" is a
  question worth answering at a glance.
