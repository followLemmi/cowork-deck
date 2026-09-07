---
status: Accepted
date: 2026-09-01
deciders:
  - evgenykharetski
---

# ADR-0011 — The limits are one line at the foot of the panel, opened on demand

> **Amended three times at the foot of this record.** #461 moved the glance out
> of the panel's foot and into the TOP BAR. #498 then changed its shape: the bar
> carries one WORD, and behind it is a row of DIALS — each AI's own logo with a
> window drawn around it and its reading in figures under it — rather than one
> line naming the worst-off AI with the rest behind a fold. Review of #498 then
> changed which window (the five hours, not the week) and how it is coloured
> (green to three quarters, amber to nine tenths, red past it), which **reverses
> decision 3's "no green for fine"**. Decision 6 stands as written; decision 2 is
> kept in the form ADR-0009 itself was amended into, twice; decision 1 is
> superseded on which AIs are shown and on what is on screen unasked; decision
> 4's disclosure is a hover. Decision 5's button is gone. Read the three
> amendments for what the glance is now.

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
green for "fine" — see ADR-0009 and `docs/design/slate-ember`. *(The no-green
half of this clause is reversed by amendment 3; the hue comes from the level now,
and the words beside it are the half that stands.)*

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

---

## Amendment, 2 September 2026 — the line moved to the top bar (#461)

*Status: Accepted. Amends decision 1's placement and nothing else.*

This record chose the panel's foot and rejected the top bar in as many words:

> **Move the glance into the top bar's ledger.** The ledger is "what is blocked on
> me" — sessions waiting for a decision and sessions that stopped — and it is
> built from the deck's own counts. A quota reading is a different kind of fact
> with a different lifetime, and the tier word makes it two to three times wider
> than a ledger reading. The panel foot is next to the work and has the width.

That rejection is being reversed, so it has to be answered rather than
overwritten.

### What the panel's foot got wrong, and it was not the height

The height argument was sound and this record won it: one line for the whole deck
is what the block should be, and #392 got it there. What was missed is that the
strip did not only *take* space from the tree — it **moved** it.

`#sidebar` is `grid-template-rows: auto minmax(0, 1fr) auto`. Row 3 is the strip;
row 2 is the page stack, and `minmax(0, 1fr)`'s floor is zero. So opening the rows
grew row 3 by up to `min(38vh, 15rem)` and row 2 gave that room up, while
`#ws-page`'s `scrollTop` stayed exactly where it was. The rows a person was
reading went below the fold, and the strip's hairline was drawn where the tree's
last visible row had been a frame earlier.

Nothing overlapped — the grid clips, and there is no `position: absolute` or
`position: sticky` anywhere in that stack. **The tree moved**, which is worse than
being covered: covered content comes back when the cover goes, and moved content
has to be found again.

Decision 4 promised the opposite of this in as many words — "the rows grow upward
out of the panel's foot **so the thing under the pointer stays under it**". The
thing under the pointer did stay. Everything above it did not.

And a second fault, smaller and unrelated to the rows: `#sidebar.is-collapsed` is
width 0, and it took the reading with it. A limit is not a property of the panel
being open.

### Why the top bar, against this record's own objection

Three answers, in the order the objection made them.

**"The ledger is what is blocked on me."** It is, and a quota belongs in that
company. "1 waiting for a decision" and "1 stopped on an error" are readings that
*want a person*; "Claude 87% used — nearly spent" is a third such reading, and the
one whose consequence is that the other two stop appearing. What the bar holds is
not a category, it is the set of facts a person needs without asking. A quota is
one.

**"A different kind of fact with a different lifetime."** True, and it is what
makes the bar the right home rather than the wrong one: a fact with a *slow*
lifetime is exactly what should sit next to a column that grows. The reading
changes on a sixty-second timer; the tree changes every time a session starts.
Stacking the slow thing under the fast one in a 280px column is what produced the
displacement above.

**"The tier word makes it two to three times wider than a ledger reading."** This
is the real cost and it is paid rather than argued away. Two things absorb it. The
state's words move INLINE after the reading instead of onto a second line, because
a 44px bar has no second line to give — the second line was affordable in a panel
foot, where "being larger is the point rather than the complaint", and is not
here. And the bar sheds in a stated order as the window narrows: the state's words
at 60rem, the count of the other AIs at 43.75rem, and the NAME truncates before
either. The reading and its tier are ADR-0009's floor and are in neither list. A
bare percentage is still not an acceptable compression.

### What is unchanged

Every one of #461's own requirements, which are this record's and ADR-0009's:

- **Glanceable while working.** More so: the bar is visible when the panel is
  collapsed, which the foot was not.
- **The tier travels with the reading.** ADR-0009, and it is now the thing that
  never gives way rather than one of several.
- **State colour as it is.** Neutral when healthy, `--st-waiting` near the limit,
  `--st-error` when spent. No green for "fine". *(Reversed by amendment 3: the
  hue is the level, and green is the first of the three bands.)*
- **A way out of an unreadable row.** The Probe button is still beside the strip
  and not behind the fold — decision 5, unchanged.
- **`openUsageDialog` is still the detail surface.** Decision 6, untouched.

### What the move let go

`column-reverse`, and its going is a simplification rather than a loss. It existed
to reconcile two orders: the strip had to come FIRST in the DOM, so a screen
reader moving forward off the control it just pressed arrives inside the rows that
press revealed — and it had to appear LAST on screen, so the rows grew upward out
of the panel's foot. A bar at the top of the window has the rows below it, so the
DOM order and the reading order are the same order and nothing has to be reversed.

And the strip keeps its reading while the rows are open. It used to give the line
up for the word "Limits" (decision 4), which was right when the rows sat above it
and it had become their head. The rows now open into a popover with its own edge,
and the reading is the reason the bar carries the line at all: a bar that blanked
its own number on a press would answer less the more it was asked.

### Consequence worth stating

The popover is `position: absolute` and out of the bar's flow, so opening the rows
costs the bar no height and moves nothing below it. That is the same property the
panel's foot was supposed to have and could not, because a grid row cannot both
grow and take no space.

---

## Amendment, 7 September 2026 — the line became a row of dials behind a word (#498)

*Status: Accepted. Supersedes decision 1 and the fold in decision 4, and retires
decision 5. Decisions 3 and 6 stand; decision 2 stands as ADR-0009 amended it.*

### What one line got wrong, and it was not the width

The width argument was won: a name, a tier, a reading and a count do fit, and the
amendment above states the order in which they give way. What one line cannot fix
by getting shorter is that **it names one AI, and which one it names moves**.

Decision 1 defended that: "the others cannot make the answer better". As an
answer to "can I keep working" that is exactly right, and it is still right. But a
glance is not only an answer, it is a PLACE — and this one had none. The word a
person had learned to look for was `Claude` on Monday and `Gemini` on Tuesday,
because a quota crossed a threshold overnight. Reading the line was the only way
to find out which AI the line was about, and a reading you have to read is not a
glance; it is a very short sentence in the chrome.

The rest existed as `+3`. Decision 1 called that count "what stops the line
reading as the whole picture", which it does, and it is also the whole of what the
surface said about two thirds of the accounts on the machine.

### The decision

**One dial per AI, in a fixed order, always all of them.** A dial is the AI's own
logo, the week drawn as a ring around it, and the reading in figures under it.

- **The order does not move.** Claude, Codex, Gemini, then anything the registry
  grew that this app has no logo for. Not by urgency — urgency is what changes,
  and a control that moves when its own reading moves cannot be found by
  position. Where a person looks for Claude is where Claude is, at 100% and at
  0%.
- **The ring is the week.** A ring is a period coming round again, and the period
  worth planning against is the week rather than the five hours. Chosen by window
  id where a provider declares a `week` and otherwise the last window it declared
  — both providers in the tree list theirs shortest first, and no file in `src/`
  keeps a table of provider names. *(Reversed by amendment 3: the ring is the
  five hours. The selection rule is the same one with the ends swapped.)*
- **The figure under it is not decoration.** A ring at 4% is a hairline and a ring
  at 0% is nothing at all — and "nothing at all" is precisely what a dial that is
  not working looks like. A fresh week reads 0% on a Monday morning, which is the
  ordinary case, so without the figure the ordinary case is indistinguishable
  from a fault. It is also what lets the ring be an ARC rather than a number, and
  therefore what keeps decision 2 payable at this size: see below.
- **The five hours is not lost.** It leads the card, and when it is near or spent
  behind a comfortable week it puts a coloured dot on the dial. That case is the
  whole reason the dot exists: a dial drawing 12% while the deck is about to be
  refused would be answering a question nobody asked. *(Amendment 3 acted on
  exactly this sentence and moved the five hours onto the ring; the dot and its
  reasoning survive, with the week in the place the session had.)*
- **A point opens a card**, not a list of rows. Both windows in full, each with
  its reading, its qualifier, its meter and its reset, and the plan and account
  above them. A press still opens `openUsageDialog` (decision 6).

**Two of the dials are held at "coming soon", and that is a claim about the
roadmap rather than about the machine.** A held brand is not asked for a reading
even where the backend has one — Gemini's provider exists and can answer nothing
without a credential this app will not take (see the head of `gemini.rs`), and a
permanent row of unknowns dressed as a live reading is worse than saying plainly
that it is not ready. The alternative was to draw one brand and let the row change
shape on the day a second arrives; a lineup that is stable across that day is
worth more than one that is honest only about today.

### The bar carries one word, not the dials

This is the part of decision 1 that goes furthest: **nothing of the reading is on
screen unasked except one word and, when there is one, an alarm.**

The top bar is a row of the deck's OWN state — what is blocked, what is waiting —
and three logos parked in it read as three more controls rather than as a
reading. They also cost the bar height that the whole of ADR-0011 was written to
stop the limits taking. So the bar says `Limits`, and pointing at it or pressing
it opens the row and the card together.

That is a real loss and it is paid for by the one thing that does not go behind
the press: **the word itself carries the alarm.** It turns amber when anything is
nearly spent and red when anything is spent, out of every window of every AI —
not only the ones the rings draw. Hiding a reading is acceptable when the reading
is "fine, keep working", which is what it is almost always; hiding the fact that
it is NOT would be the failure ADR-0009 and this record are both about.

A press pins the box open, which is what a keyboard needs: a pointer holds it
open by being there and a keyboard has nothing to hold it with. There is
deliberately no `focus` opener — Escape shuts the box and hands the keyboard back
to the word, and a word that opened on focus would re-open it on the way and make
Escape do nothing.

### The AIs' own logos, not this app's hand

The first cut of this drew three marks on the icon set's own 16-unit grid, in its
stroke weight, so that they would sit in the family. That was the wrong instinct
and the review said so. An icon's job is to belong; a **logo's job is to be
recognised**, and a mark redrawn at a different weight on a different grid is a
mark a person has to learn a second time. So the three come in whole, filled, on
their owners' 24-unit grid, traced from Simple Icons (CC0 files; the marks
themselves stay their owners' trademarks and are used here to identify their own
products). They are vendored rather than depended on: three path strings do not
earn a package, and a logo that changed under us on an `npm update` is worse than
one we have to notice by hand. `icons.ts` grows a second symbol family for them,
because `.icon` sets `fill: none; stroke: currentColor` and would draw every one
of them as nothing at all.

### What ADR-0009 costs here, and what it does not

Decision 2 said the tier survives the shrink, and this shape shrinks the glance
further than any before it: a dial has room for a logo, an arc and about four
characters. That would be the failure ADR-0009 exists to refuse — a number with
nothing beside it to say which of three kinds of number it is — if a dial drew
its number bare. Two things keep it honest. The dial's figure is a percentage of
a window that HAS a denominator, and where there is none it prints `—` rather
than inventing one, exactly as the ring draws no arc. And every surface that
gives the number in full carries its qualifier: the card, the dialog, the Linux
menu row, and the dial's own accessible name.

The card prints `tierNote` — the CAVEAT, not the tier's name — which means the
account's own accounting prints **nothing at all**. An unqualified number is the
account's, which is what a person assumes anyway; the failure that record exists
to prevent is the other direction, this app's own narrower count being read as
the account's, and only the weaker tiers can commit it. This reverses the first
cut of this amendment, which printed `Reported` in full because the card had the
room. Having the room is not a reason: ADR-0009's own amendment retired that word
because it changed nothing, and a card is not a place to un-retire it. The tier
NAMES survive where they are taught — in the dialog, beside `sourceExplanation`.

### The panel shows its dials, and its card floats

The status-area panel (ADR-0013) draws the same block with two hooks changed, and
they are the two decisions above, inverted for a surface that is nothing but the
glance:

- **No word in front.** That window was opened deliberately and contains nothing
  else worth the room; putting its content behind a hover would make it two
  gestures deep.
- **The card FLOATS over what is under it.** In the flow it pushed the sessions
  down every time a pointer crossed a logo, which is the same displacement fault
  #461 moved this whole surface out of the panel to escape — one level smaller.
  It is hung on `#tray` rather than inside `#tray-sections`, and that is not a
  detail: an absolutely positioned card inside a scroll container is clipped by
  it AND adds to its scroll height, so the content moves anyway. `#tray` clips to
  the panel's own rounded edge, which is right, so the card is measured and
  clamped to the room under the row and scrolls inside it — a scrollbar is a
  worse card than one that fits and a far better one than one whose last line is
  sheared off, and the last line of a spent window is when work becomes possible
  again.

### What the shape let go

- **The fold, and everything it needed.** No caret on a strip, no rows, no state
  to keep out of a repaint's way beyond the one dial the card is on.
- **The Ask button** (decision 5). Nothing interactive lives in the card: it is a
  description, and a control that appears under the pointer and vanishes when it
  leaves is a control nobody can reach. The offer moved into the dialog a press
  opens — where it already was. With it goes the tray's `probe` action verb,
  since nothing mints it any more.
- **`No AI detected on this machine` as a whole-surface state.** Two dials are
  always drawn, so the row is always there, and the brand that was meant to
  answer says for itself that it did not.

### Consequences

- The bar gives up about 60px of width and no height at all, for any number of
  accounts. The line it replaces was up to 246px and grew a second line when
  something was spent.
- **The panel has to carry the open card across its own repaint.** It rebuilds its
  entire document on every report from the deck, so nothing inside it can remember
  anything — the provider being described is read off the old DOM and handed back
  in, beside the scroll position and the focused control it already carried.
- **The listeners that open and close the deck's popover are installed once**, in
  the constructor, and read the DOM when they fire. (Three of them when this was
  written; a fourth — the `mouseenter` that cancels a pending close — came with
  amendment 3.) Every other listener in the block
  is on a node it creates and throws away once a minute; these are on `#limits`,
  which outlives the paint, and attaching them per paint would add one a minute
  for as long as the window is open.
- Every measured contrast pair for the limits moved again, and this time onto two
  grounds that are not the old one: `--bg-chrome` under the word in the bar, and
  `--bg-island` under the dials and everything they open — in the deck's popover
  and in the status-area panel alike. The cases in `scripts/contrast.mjs` had
  still been recorded against `--bg-void` from #392, which #461 had already made
  wrong.

### Alternatives considered

- **Keep the line and add a second one per AI.** The slab this record replaced,
  with extra steps.
- **Order the dials by urgency.** Everything this amendment is against, in one
  sentence: it makes the worst one easy to find and the specific one impossible.
  The urgency ordering survives where it belongs — in the card, which opens on
  the AI that is worst off rather than on the first one drawn.
- **Draw only the AIs that are installed.** Rejected for the same reason "show
  only what is not healthy" was rejected in this record: a surface that appears
  and disappears under a person cannot be learned. A held dial is also the only
  honest way to say a thing is planned.
- **Show the five-hour window in a second, inner ring.** Two arcs at 40px are two
  hairlines, and the reading that would have justified it — the session window in
  trouble — is carried by the dot at a size a person can actually see.
- **Leave the dials in the bar and simply shrink them.** What the first cut did.
  It cost the bar height permanently for a reading that is "fine" almost always,
  and it put three brand marks in a row that is otherwise entirely about this
  deck's own sessions.

## Amendment 3: the ring is the five hours, and the hue is the level

*2026-09-07, prompted by review of #498 before it merged.*

Four changes, and three of them are one argument: the glance was drawing the
right things about the wrong window, and drawing them in a way that only said
something once the answer was already bad.

### The ring is the five-hour window, not the week

Amendment 2 said *"the ring is the week … the period worth planning against is
the week rather than the five hours"*, and put the five hours in the card and in
a dot eight pixels across. That is the wrong way round for a surface whose whole
justification is that **a limit is something you look at while working** — this
record's first sentence. Planning is what the card and the dialog are for. The
question a person asks of the chrome, twenty times a day, is whether the next
prompt will be answered, and that is the five hours.

The mechanism does not change at all: `glanceWindow` replaces `ringWindow`,
picking the window whose id is `session` and otherwise the FIRST one a provider
declared — both providers in the tree list theirs shortest first, so the first is
the narrowest, and no file in `src/` keeps a table of provider names. The week
takes the place the session had: the second block of the card, and the dot on the
dial when it is the one in trouble (`dialAlert`, unchanged but for which window
it is handed).

**The status-area menu reads the same window.** It was `primaryWindow` —
whichever of them was worst off — which meant a menu and a panel built from one
report could name two different windows, and that which window a row was about
moved with the readings. ADR-0013's decision 1 is amended where it named the old
function.

### The hue is the level, and there is green

This record said, twice, that there is deliberately no green: *"Neutral when
healthy, `--st-waiting` near the limit, `--st-error` when spent. No green for
'fine'."* The reasoning was that green already means "working" on every session
rail in the window, and a deck of healthy meters would read as activity.

**Reversed.** Green under three quarters, amber to nine tenths, red past it
(`zoneOf`, `NEAR_FROM`, `OUT_FROM`), on the arc, on the figure under it, on the
dot, on the word in the bar, and on every meter in the card and the dialog.

**Everything about the reading, and nothing about the identity.** The first cut
of this coloured the logo too, on the argument that a logo is the biggest thing
on a 40px dial and the arc alone leaves the reading in the thinnest part of the
drawing. That argument was about the wrong element, and review said so: a green
Claude mark is not Claude's mark. The logo answers WHICH AI, it answers it before
anything has been read, and it answers it the same way at 3% and at 97% —
tinting it by the quota made the one fixed thing on the dial move with the
readings, which is the fault the fixed ORDER exists to prevent, one element
further in.

So the mark is drawn in **the brand's own colour** — Claude's `#D97757`, the
coral of the Anthropic palette's accent and the `hex` of `claude` in Simple
Icons, which is where the path itself was traced from. This is the one hue on the
surface that is not this app's to choose, and it is the same argument that made
these marks come in whole on their owners' 24-unit grid rather than redrawn to
match the icon set. The division that results is cleaner than the one it
replaces: **identity in the middle, level around it.**

There is no token for Codex or Gemini, and that is not an omission. OpenAI's own
hex is `#000000`, which on this ground is not a mark at all; Gemini's logo is a
gradient with no single official hex. Both are also HELD, and a held dial is
drawn dim on purpose — dimming is how "not ready" is said, and a full-colour logo
would say the opposite. A brand with no token of its own keeps the dial's neutral.

What the old rule cost is the thing a gauge is for. A provider's state is a step
function — `ok` until it says `near` — so a ring three quarters of the way
through the five hours was drawn in exactly the hue of a ring at four percent,
and the only way to tell them apart was to read the figure. That is a gauge whose
hue answers a question nobody asks ("is it broken?") and stays silent on the one
they do ("how close is it?"). A person watching a quota wants the distance, and
hue is the one channel that gives it without being read.

The collision the old rule feared does not happen, because the two never share a
surface: a rail is a bar down the side of a session row or a tile, and these
bands are inside a dial or a meter with its own track. What survives is the rule
underneath the old one — hue belongs to MEANING — with the meaning restated:
here it is how much is left.

Three consequences, all deliberate:

- **The bands are the provider's floor, not its ceiling.** A window a provider
  calls `near` is at least amber whatever the share says, because it knows things
  this app does not. The bands only add urgency that was not declared.
- **A reading with no denominator gets no hue.** An absolute with no ceiling is
  not green; it is neutral, which is the same rule `meterFraction` keeps by
  drawing no meter at all.
- **The word in the bar is banded too**, on the same thresholds, and it is still
  never green: "fine" is the state it is in almost always, and a chrome carrying a
  hue almost always spends attention on the answer nobody asked for. What it must
  not do is stay neutral over a dial that has gone red, which is the property that
  makes hiding the dials acceptable — so the word's alarm now comes from every
  window of every AI through `alarmOf` rather than from the provider's own word
  for its state.

Because a band and a refusal share the red, they are told apart in **words**:
`alarmPhrase` says *spent* only where something is actually refusing work and
*over 90% spent* where it is not. A dial claiming work had stopped when it had
not would be the same class of error as an unlabelled tier.

### The popover survives the pointer crossing a corner

The reported defect: point at `Limits`, move diagonally towards the Claude dial,
and the box shuts on the way in.

It is geometry and not a bug in the listener. The word is in the top bar and the
box hangs from its bottom edge growing LEFTWARD, so the straight line a hand
draws between the word and the leftmost dial passes through the corner that
belongs to neither — the bar, left of the word and above the box. A `mouseleave`
fires there, and it fires while somebody is on their way in. No placement of the
box fixes this: every diagonal has a corner like that one.

**So a pointer leaving is a request to close, and returning within 300ms cancels
it** (`POP_GRACE_MS`). Escape and a focus that has left the block still close it
at once: those are deliberate acts rather than a hand in transit. The rejected
alternative was a bridging element — an invisible box over the corner — which
would swallow clicks meant for the bar underneath it.

### `REPORTED` leaves the dialog too

ADR-0009's first amendment took the word out of every row and kept it in the
dialog, on the grounds that a dialog is where a vocabulary is taught. Its second
amendment, made here, takes it out of the dialog as well: the word labels the one
case that cannot mislead, and the sentence directly under it already says what it
means. The two weaker tiers keep their names, which are the vocabulary actually
worth teaching. See `sourceBadge`.

### What this costs

- Every hue on every limit surface is measured again in `scripts/contrast.mjs`,
  and the green is new there: the arc, the logo (on the box's ground and on the
  hover's, because a band deliberately does not move under a pointer) and the
  figure, in all three bands.
- The card's window order flips — the session leads, the week follows — because
  the card explains the drawing before it explains anything else.
