---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0011 — The tray panel is a native menu whose rows are written in the webview

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

**A native menu** is cheap, behaves correctly on every desktop, and is what
Linux may force anyway — but it cannot draw a meter, and its rows are text.

**A small webview window** anchored under the icon could reuse the deck's CSS and
its existing limit rendering — but positioning it under a status icon is fiddly
on all three platforms, dismiss-on-blur has to be built, and it needs a window
label, a capability entry and a stylesheet of its own.

Three facts about this codebase bear on the choice and are not general:

1. **The rendering rules for a limit are already pure functions in TypeScript** —
   `primaryWindow`, `readingOf`, `sourceLabel`, `formatReset` in `src/usage.ts`,
   written that way so the block, the dialog and the pill cannot disagree about
   a number. A menu built in Rust would have to reimplement every one of them,
   which is exactly the disagreement those functions exist to prevent.
2. **A second webview window is a known cost here, not a hypothetical one.** The
   pill is one, and it carries its own `pill.html`, its own `pill.css` copy of
   the tokens, its own entry in the capability file and its own module graph —
   `pill-util.ts` exists because importing `usage.ts` into that window would drag
   the IPC surface into a page that has none.
3. **On Linux the click may never reach us.** On most desktops a
   StatusNotifierItem's left click is not guaranteed to be deliverable, and some
   environments only ever show the menu. A design whose panel is a window opened
   on a click is a design that has nothing to show on those desktops.

## Decision

### 1. The panel is a native menu

`tray-icon`'s menu on all three platforms. No second webview, no anchoring, no
dismiss-on-blur, no new window label, and — because Tauri's ACL governs core and
plugin commands rather than an application's own — no change to
`capabilities/default.json` at all.

What is given up is the meter. That is a smaller loss than it looks, because
ADR-0009 already establishes that **the reading is the number and the tier, and
the meter is decoration**: "no share, no meter" is a legitimate state that the
deck draws today, and `readingOf` produces the whole reading as one string
without one. The tray says `Claude · Reported · 23% used · resets 19:00`, which
is every fact the block's row carries except the bar.

### 2. The rows are written in the webview, and Rust knows nothing about limits

This is the half of the decision that makes the first half affordable.

The main window already holds both inputs: `lastUsage` from `usageSnapshot`, and
every window's sessions in `sessionsByWindow`. It composes the menu as data —
sections of rows of text — using the same `src/usage.ts` helpers the block and
the dialog use, and hands it to `tray_update`. `src-tauri/src/tray.rs` turns any
list of sections into a menu and routes clicks back; it contains no provider
name, no window name, no reading, and no reset time.

So the tray and the deck cannot disagree about a number, for the same reason the
block and the dialog cannot: there is one implementation of the rule, and it is
the pure one that is unit-tested.

Two consequences worth naming:

- **Adding a section means adding an entry to `PANEL` in `src/tray-panel.ts`.**
  Nothing in `tray.rs` changes; nothing in `trayPanel()` changes either. That is
  the same shape, for the same reason, as `SECTIONS` in `src/settings.ts`.
- **The menu is rebuilt only when the model changes.** The deck reports on every
  poll tick, five seconds apart; rebuilding a menu that often would rebuild it
  under an open cursor. `TrayPanel` is compared with the last one and an
  identical report is dropped, so a rebuild happens when a reading or a session
  actually changed — which can still land while the menu is open, and is
  accepted.

### 3. The tray icon never carries the count. The pill does.

#393 is explicit that the two must not both answer the same question. They do not:

- **The pill is the glance.** It floats over every other application, says "3
  waiting for input" or "limit · resets 19:00" with no interaction at all, and is
  up only while there is something to say.
- **The tray is the question.** It is permanently present, including when the
  deck is idle and the pill is down, and it answers on demand — every connected
  AI with its tier, and every session that is waiting.

So the status icon has **no title text and no count**, on any platform, and its
image never changes. A hueless glyph that changed shape to mean "spent" would be
an unlabelled signal, which is the thing ADR-0009 was written to forbid; the
state is said in words in the menu, where there is room to say which tier it is
on.

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
Neither is a surface you have to open, which is what separates both of them from
the tray.

### 5. The macOS icon is a template image

`icons/tray-mac.png`, black on transparent, installed with
`icon_as_template(true)`. macOS reads its alpha channel alone and tints the
result for a light menu bar, a dark one, and the inverted state while the menu is
open — which is what makes decision 3's "the image never changes" survive both
appearances.

It is 36×36 because `tray-icon` scales a status item's image to 18 points tall,
so 36 pixels is exactly 2× and nothing is resampled. Off macOS the tray uses the
app's own colour icon, which is what those platforms expect.

`scripts/tray-icon.mjs` draws it, and the PNG is committed. There is no SVG
rasteriser in this project's toolchain and no stock one on macOS; the icon is two
shapes with exact distance functions, so drawing them directly was smaller than
adopting a rasteriser to draw them for us.

## Consequences

- The tray cannot draw a meter, ever. If a section is later added that genuinely
  needs pixels rather than a sentence, this record is what has to be reopened —
  and the answer then is a webview window, not a richer menu.
- Sections are cheap and rows are cheap, so the pressure will be to add both.
  A menu is a list somebody reads standing up; the session section already caps
  its rows and says how many it did not list.
- Nothing in the tray works while the main window is closed, because the main
  window is what composes the panel. That is already true of the pill, and the
  app exits when the main window is destroyed (`main.rs`), so the window between
  the two states does not exist in practice.
- `tauri`'s `tray-icon` and `image-png` features are now on, which pulls in the
  `image` crate's PNG decoder. Linux packages need `libayatana-appindicator3-1`
  at runtime; CI already installs the `-dev` package.
- The pill and the dock badge say the same number in two places. Decision 4 owns
  that; a future decision to drop one of them should argue with it rather than
  around it.

## Alternatives considered

- **A webview panel anchored under the icon.** The only version that could grow
  a meter or a chart, and the version #393 leans towards. Rejected on decision
  1's three facts, and most of all on the third: on a Linux desktop that only
  ever shows a menu, the anchored-window design has no panel at all, so it would
  have had to be built *and* a menu built beside it.
- **A native menu built in Rust from the usage snapshot.** The obvious shape, and
  the one that reimplements `readingOf`, `sourceLabel` and `formatReset` in a
  second language. Rejected: #393 asks for those helpers to be reused precisely
  so the tray and the deck can never disagree about a number, and two
  implementations of a formatting rule diverge the first time one is fixed.
- **A tray icon that shows the waiting count as its title.** Free on macOS and
  Linux, unsupported on Windows, and a duplicate of the pill on the two where it
  works. Decision 3.
- **A template icon that changes shape when the budget is spent.** Attractive,
  and forbidden by ADR-0009's own rule: a glyph is a reading with no tier beside
  it.
- **Dropping the pill in favour of the tray.** Considered seriously, since it
  would settle decision 3 by subtraction. Rejected because the pill answers
  without being opened and the tray does not, and "how many are waiting" is a
  question worth answering at a glance.
