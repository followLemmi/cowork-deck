---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0011 — The limits are one line at the foot of the panel, opened on demand

## Context

ADR-0009 put a limits block in the panel and argued for the placement rather than
the shape. The argument was about navigation:

> A block in the panel rather than a page of it … a limit is something you glance
> at WHILE working, so a screen you have to navigate to would be consulted once,
> on the day you first found it, and never at the moment it matters.

That still holds and is not what this record changes.

What it changes is how much of the panel the block takes. It was a heading plus
one row per connected AI, and a row was three stacked lines — the name, tier and
reading; the meter; the foot with the reset time. `#limits` sat in the panel's
grid as `auto` above a `minmax(0, 1fr)` stack, which means it never yielded: the
height came out of `#panel-stack`, the part of the panel actually being worked in.

With one AI that was a modest block. With four it was a slab of some 250px, and
the states that matter made it worse — an exhausted row's foot grows to a
sentence, and a row nobody can read gains a button beside it. So the block was
largest exactly when a person most needed the room above it, and it was
permanently holding panel height for a reading whose answer is usually "fine,
keep working".

The failure to avoid while fixing that is the one ADR-0009 already named: moving
the numbers behind a settings section, a fifth page or a dialog would shrink the
block by making it invisible, which is worse than the slab.

## Decision

### 1. The glance is one line, for the whole deck

Always on screen, at the foot of the panel, and it does not grow with the number
of connected AIs. It names **one** AI — the one whose answer to "can I keep
working" is worst — with a count of the others (`+3`).

Naming one is not a compression of the truth. The others cannot make the answer
better: if any of them were worse, one of them would be the one named. The count
is what stops the line reading as the whole picture, and it is what says there is
a list behind it.

Which AI is worst comes from the ranking already in `usage.ts` — a refusal, then a
nearly-spent window, then the fullest reading, then an AI that cannot be read at
all. `primaryWindow` ranks the windows of one AI and `rankedAis` ranks the AIs
against each other **through the same comparator**, so the strip cannot name an AI
that is not at the top of the list it opens.

That last clause is a property of the LIST as much as of the strip, and it has to
be built rather than hoped for: the rows are drawn in `rankedAis` order too, not
in the order the AIs were detected. Sharing a comparator only guarantees that the
strip and the named AI's own row choose the same window; it says nothing about
where that row sits. Drawn in detection order the two agreed by luck, and the
unlucky case is the one that matters — an exhausted AI found last is named by the
strip and drawn at the bottom of a list capped at `min(38vh, 15rem)`, below the
fold, so the one press that was supposed to explain the line opens on somebody
else and asks for a scroll.

### 2. The tier survives the shrink

ADR-0009's rule is not weakened by having less room: the line carries the tier
beside the reading, in the same size, on the surface that is always visible. A
bare percentage in a strip would be exactly the screen that record exists to
refuse — a number that is sometimes three times wrong with nothing beside it to
say which time this is.

Four things fit on 246px of a 280px panel: name, tier, reading, count. That is
the budget, and it is why the two decisions below went the way they did.

### 3. The state is in words as well as in hue, and the strip has no meter

`--st-waiting` near a ceiling and `--st-error` past it, unchanged, and still no
green for "fine" — see ADR-0009 and `docs/design/slate-ember`.

The strip carries them on its **second line**, with the words: *nearly spent —
resets 19:00*, *nothing moves until 19:00*. That line exists only when something
is nearly or wholly spent, so the strip is one line while the answer is "keep
working" and two when being larger is the point rather than the complaint. In the
rare case where a second AI is also spent it is three, which is still constant in
the number of accounts.

The meter was dropped from the strip and kept in the rows. It was the only one of
the five candidates for the line that said something the reading beside it already
said, and at 34px it pushed the name down to "Clau…" — a clipped label identifies
an AI badly, a clipped number identifies nothing at all. Moving the hue onto the
words is a strict gain for anybody the hue does not reach.

### 4. The rows are a disclosure, and they grow upward

One press on the strip shows the rows as they were. Three properties of that
matter enough to be decisions:

- **The list is capped** (`min(38vh, 15rem)`) and scrolls. The old block could not
  scroll, which is why adding an account took height from the page above; now
  adding one lengthens a list that is bounded either way.
- **It grows upward, out of the strip.** The control a person just pressed stays
  where their pointer is, and the reading they were looking at does not jump.
  Upward on SCREEN only: in the DOM the strip comes first and the rows follow it,
  and `#limits` is `flex-direction: column-reverse`. A disclosure whose content
  precedes its own control reads, to anybody moving forward through the document,
  as content that button leads away from — so a screen-reader user who pressed the
  strip would leave the block instead of entering what the press revealed. The
  reversal buys the visual behaviour without paying for it in reading order.
- **Open, the strip stops repeating the row above it** and shows the block's name
  instead. Folded, the reading is worth more than the word "Limits"; open, every
  row says what the strip was saying, and the word is what is left to say — which
  is also where a person learns what the strip is called.

The state of the fold is held in the module and **not** persisted. Folded is the
default because folded is the answer; an app that came up expanded because of
something done last Tuesday would have given the panel height back away. It is
also dropped whenever the block itself goes — no AI detected is no block, and a
block that comes back should come back folded rather than with a press made
before the last account disappeared still in force.

The fold is the only thing a repaint keeps. The read runs on a sixty-second timer
and replaces every element in the block, so the keyboard's place and the list's
scroll are read off the old DOM and put back on the new one, keyed by what a
control is rather than by node. Without that, a person reading the ninth row is
returned to the first by a clock, mid-sentence.

### 5. The way out of an unreadable reading is not behind the fold

A snapshot nobody can read offers the probe command in a tile. That button sits
beside its row, as before, **and beside the strip** when the AI the strip names is
the unreadable one — the one reading with nothing to show for itself is the one
whose action must not be hidden.

### 6. The detail dialog is untouched

`openUsageDialog` remains where the follow-up questions are answered, reached from
a row. The strip answers "can I keep working" and nothing else.

## Consequences

- The panel gives up 34px to the limits, and the figure no longer moves when an
  account is connected. It was a heading and 41 to 58px per AI depending on what
  the row had to say — a little over 200px with four accounts, all of it taken from
  the page above. The rows are one press away and, unlike the slab, they can be put
  away again.
- Two surfaces now describe one snapshot at two levels of detail, and they can
  drift. They are held together by construction rather than by discipline: one
  comparator decides which AI is worst and which window it shows, and one function
  writes the words under a reading for both. The single difference is deliberate
  and lives in that function's one parameter — the strip drops a healthy window's
  reset time, which a row keeps.
- There is no visible heading over the folded strip. Its identity comes from its
  position, its tooltip, and the accessible name, which begins with the word
  "Limits" — so the name still starts with the visible label the moment there is
  one (WCAG 2.5.3).
- The strip is chrome on the panel's own ground rather than an island, so every
  measured contrast pair for the limits moved from `--bg-island` to `--bg-void`.
  All of them improved; `scripts/contrast.mjs` carries the new numbers and two new
  cases for the amber words.
- A person with four healthy accounts sees one of them named and three counted.
  Learning that a specific AI is at 40% now takes a press. That is the trade this
  record makes, and it is made in the direction of the question actually asked at
  a glance.

## Alternatives considered

- **Cap the block's height and let it scroll.** The cheapest fix and it treats the
  symptom: the block would still hold its full height by default, still be mostly
  "fine, keep working", and now with a scrollbar in it.
- **Show only what is not healthy.** Attractive, and rejected because it makes the
  surface appear and disappear under a person as numbers cross a threshold — and
  because a healthy set collapsing to "everything is fine" is a line that cannot
  be checked. The strip always names something, always with its tier, which is
  checkable. The spirit of the idea survives in decision 3: what is *added* to the
  strip is exactly what is not healthy.
- **Move the glance into the top bar's ledger.** The ledger is "what is blocked on
  me" — sessions waiting for a decision and sessions that stopped — and it is
  built from the deck's own counts. A quota reading is a different kind of fact
  with a different lifetime, and the tier word makes it two to three times wider
  than a ledger reading. The panel foot is next to the work and has the width.
- **A fifth page, or a section in Settings.** The failure ADR-0009 chose the block
  to avoid, restated. Rejected without a second look.
