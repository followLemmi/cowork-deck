# The pull request screen — rework

**Status:** agreed design, not implemented. Written 2026-08-04.

**Origin:** the owner, looking at the shipped screen: *"описание и изменения друг рядом
с другом и мало места занимают на экране"* — the description and the changed files sit
side by side and use little of the screen — and *"сейчас выглядит очень на коленке
сделанным"*, it looks knocked together. Their own proposal was tabs: description full
width, diffs under a tab.

Three specialist reviews were run against the **real** components rendered in a
browser — not against the source — at 1990×1100 and 900×1100, at root font sizes
11.05px, 13px, 14.95px and 18.85px. This document is their resolution. Every number
here was reproduced or spot-checked by the session that wrote it; the two that were
not have been struck and are named as such.

---

## The root cause, and it is not the layout

**Every gap on this screen is a pixel constant while the type it separates grows 71%
under a control the app ships.**

| root | 11.05px | 13px | 14.95px (shipped) | 18.85px |
|---|---|---|---|---|
| `.pr-title` | 13.6px | 16.0px | 18.4px | 23.2px |
| title → meta | 4.0px | 4.0px | 4.0px | 4.0px |
| meta → actions | 8.0px | 8.0px | 8.0px | 8.0px |
| card → card | 8.0px | 8.0px | 8.0px | 8.0px |
| **title : first gap** | 3.40 | 4.00 | 4.60 | **5.80** |

Two of those gaps are raw literals rather than tokens (`styles.css:1081`
`gap: 4px`, `styles.css:1116` `margin-top: 4px`), which is the small half. The large
half is that **`--sp-1..4` are themselves declared in px** (`styles.css:99`), so even
the tokenised gaps are frozen. The type scale was moved to `rem` in the typography
work; the spacing scale never followed.

**This branch made it worse.** `DEFAULT_SCALE` was raised from 1.0 to 1.15 earlier in
the same session, on good evidence — the owner had complained the type was too small.
Raising the type 15% without touching the spacing moved every reader 20% past the
size the layout was tuned for. The complaint that produced this document is partly a
consequence of the fix for the previous complaint.

So the first change is not a layout change:

> **`--sp-1..4` become `rem`.** `0.3077rem / 0.6154rem / 0.9231rem / 1.2308rem` — the
> same 4/8/12/16px at the 13px base, scaling from there. And the two literals in the
> row become tokens.

**Blast radius: every screen.** This is the one change in this document that is not
confined to the pull request screen, and it needs a visual pass over the deck, the
board and the modals before it lands. It is first because everything below is tuned
on top of it, and tuning the row against frozen spacing would bake the same fault in
one level down.

---

## What the reviews measured

At 1990×1100, 13px, #151 expanded:

| | |
|---|---|
| `.pr-detail-body` (description) | 494 × 440 — **23%** of its content visible |
| `.pr-detail-files` (62 files) | 506 × 330 — **22%** visible |
| Unused width right of the pair | **605px, 37% of the row** |
| Nested vertical scroll containers | **three** |

The `ch` measure caps are correct and stay. **The `vh` caps are the fault**:
`max-height: 40vh` (`styles.css:1204`) and `30vh` (`styles.css:1295`) make two
independent viewports side by side, each showing a fifth of itself, inside a third
scroller. Neither shows a scrollbar until hovered, so the only cue that more exists is
text stopping mid-sentence and a path clipped mid-glyph.

**The drawer is a peephole.** `DEFAULT_COLS = 62` yields **51 code columns** at every
text size. Against #151's own 19,637 patch lines — recomputed independently by the
reviewing session, matching to the decimal:

| code columns | lines that fit without horizontal scrolling |
|---|---|
| **51 (shipped)** | **56.6%** |
| 80 | 87.1% |
| **83 (proposed)** | **92.2%** |

43% of the lines in the pull request the feature was built for need horizontal
scrolling. Meanwhile the drawer showing a six-line hunk is 1070px tall with 150px of
diff in it.

---

## The structure

The owner's tabs are adopted, with one correction and one narrowing.

**The correction is load-bearing:** the diff cannot live inside the expanded row's
DOM. `PrView.render` calls `replaceChildren()` every 15 s while the window has focus;
a diff in that subtree loses scroll position in a document up to 63,000px tall, and
any text selection, twice a minute. The drawer stays a sibling owned by `main.ts`.

**But the tabs earn their place for a reason the proposal did not have to state:**
what they decide is *what occupies the left column while the right column holds code*.
Today that is the description, which is why the diff gets 436px. With tabs, the
description and the diff are never on screen together, and what sits beside a diff is
the file index — which is what you want there.

**The narrowing:** "description full width" cannot mean 200-character lines. The
description's *container* goes full width, so its tables and fenced code get room,
while its paragraphs keep a measure.

```
.pr-row.pr-row--open
  .pr-headline                     position: sticky; top: 0
     ▾  #151  <title>  [draft]                        [ Merge ]
     author · head → base · no checks · 3 d ago · labels
     [ Description ] [ Files 62 ]   +23307 −342       role="tablist"
  .pr-panel                        role="tabpanel" — the selected tab only
  .pr-actions--minor               ▶ Start session · Close · Open in browser
  .pr-refusal                      only when Merge is refused
```

The sticky header is what makes deleting the `vh` caps safe: the description can be
1922px tall and the title, the tabs and Merge stay reachable. Measured cost 78px at
13px, 112px at 18.85px.

**Two tabs, no third.** `ChecksSummary` is a kind and two integers, so a Checks tab
would hold one sentence; there is no comments IPC command, so no Conversation tab.
Default `Description` on first expansion — the first question is what this pull
request *is*. Selection is remembered per pull request for the session and cleared on
workspace switch. Opening a diff forces the Files tab, because the drawer's only tie
back to the list is `aria-current` on a file row and a mark inside a hidden panel is a
mark nobody sees.

Roles: `role="tab"` + `aria-selected` + `aria-controls`, one tab stop with a roving
tabindex, **manual activation** — the file list directly beneath is manual for a
measured reason, and a strip whose arrows commit above a list whose arrows do not is a
trap inside one region. Both tabs need `data-fk`, or the poll destroys the focused tab
twice a minute.

**Expansion becomes exclusive.** `expanded: Set<number>` → `number | null`. Nothing on
this screen compares two descriptions; with the `vh` caps gone two open rows are
3000px+, so the drawer would routinely show a file from a pull request scrolled off
screen. It also *removes* a documented objection: the diff drawer design refused
`tab`/`tabpanel` roles partly because a `Set` gives several tablists pointing at one
panel. Collapsing a row whose diff is open must close the drawer **first** — `onClosed`
→ `focusFile` needs the row to still exist.

---

## Defects found, all reproduced

These are not polish. Three are in work committed earlier in this same session.

1. **The poll wipes both nested scroll positions.** Measured: description `scrollTop`
   400 → 0, file list 700 → 0, focus restored to a row now off screen. The focus/scroll
   restore added in `af3eebe` saves `this.mount.scrollTop` only; the inner scrollers are
   new nodes every render. The drawer's own scroll survived untouched at 2500px — the
   fix was applied to the container it was written about, and the two scrollers *inside*
   it were added later. **Removing the `vh` caps deletes this defect rather than
   patching it.**
2. **The file list prints `+0 −0` for an `unreported` file.** The drawer refuses to
   print zeroed counts and the announcement omits them, because they are the lie the
   state exists to refuse to repeat — and the list beside it prints them anyway
   (`pr-view.ts:391-392`). Two places on one screen contradict each other and the wrong
   one is read first.
3. **`.dv-file--wrap` is dead.** Styled at `styles.css:1647` with a comment justifying
   a 42 ms measurement; applied nowhere in any `.ts`, `.rs` or `.html`. The wrap toggle
   was specified and never built, so horizontal scrolling cannot be turned off.
4. **Prev/Next desynchronise the list from the drawer.** `step()` moves the index,
   renders and announces, but never calls `setOpenDiff` — after two Nexts the drawer
   says file 33 and the list still marks file 1.
5. **Clicking a file scrolls the file list to the top**, hiding the row just clicked.
6. **Clicking a row's title does nothing.** The only expander is a 24px triangle at the
   far left of a 555px title.
7. **Disabled `Merge` keeps `cursor: pointer`.**

---

## Visual craft

- **Merge takes the primary-button idiom the stylesheet already owns** —
  `.modal-actions .modal-ok` (`styles.css:389`): `--accent` fill, `--bg-app` label,
  `--fw-medium`. Today `▶`, `Merge` and `Close` share one rule and differ only by
  label, so the app's one irreversible action has no visual weight. On a realistic
  list, two of three rows show Merge disabled, so most of the time the row is three
  identical ghost buttons of which the greyed one matters most.
- **`▶` gets a written label.** Its meaning lives in a `title` today — unreachable by
  keyboard and by touch, the exact criticism this codebase already accepted for the
  Merge refusal and never applied here. A glyph-only button in a row of worded ones is
  the loudest single "knocked together" signal in the row.
- **`Close` and `Open in browser` move off the collapsed row** into the expanded row's
  minor bar. *This survives on clutter grounds only:* an earlier draft justified it by
  saying `Close` acts without confirmation, which is **false** — `main.ts:914` asks
  ``Close #N “title” without merging?`` and then offers worktree cleanup. A rare action
  holding permanent space on every row, one button from Merge, is still worth moving,
  but not for that reason.
- **`.pr-detail-stat` is deleted as a line of its own** and folded into the tab strip,
  placed immediately after the last tab rather than right-aligned: at 1990px the strip
  is 1608px, and a right-aligned diffstat is 1100px from the thing it describes — the
  exact failure the file list's own comment already names.
- **`.pr-detail-files` cap 72ch → 80ch.** #151's widest row needs 76 characters, so at
  72ch the ten longest paths wrap.
- **`DEFAULT_COLS` 62 → 95** — 83 code columns, 92.2% fit. Floor arithmetic verified at
  every size: at 1990/18.85 a 95ch drawer leaves the list 638px against its 452px
  floor; at 900/13 it crosses the floor and the existing collapse path takes over.
- **The drawer head's `+n −m` become conditional on `.pr-view--narrow`.** They
  duplicate the `aria-current` file row a few hundred pixels left, except when the list
  is collapsed and that row is not on screen.

---

## Order of work

1. `--sp-*` to `rem`, plus the two literals. **Needs a visual pass over every screen.**
2. Sticky headline, exclusive expansion, tabs. These three are one change: the caps
   cannot go before the header is sticky, and the header is not worth it for two rows
   at once.
3. Delete the `vh` caps. Defect 1 dies here.
4. The seven defects above that are not deleted by step 3.
5. Visual craft: Merge, `▶`, the minor bar, the diffstat, the two caps.
6. Drawer width.

## Unverified

- **WebKitGTK.** All of it is Chromium. `position: sticky` inside an `overflow: auto`
  flex child is the one construct here not already used in `styles.css` — check it in
  the app before building on it.
- **The sticky header's height with many labels.** 112px is a mock-up with two; six
  labels wrap the meta line and the header grows. Not designed.
- **Prefetching `prDiff` when the Files tab opens** would make the first file instant —
  it is one call for all 62 files — at ~1 MB for a tab that may be opened out of
  curiosity. No recommendation without usage data.
