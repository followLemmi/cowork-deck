# Typography, hierarchy and contrast — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Phases 1 and 2 are one commit — see the barrier between them.

**Goal:** The app reads at a comfortable size with a hierarchy carried by size and weight rather than by colour alone, and the measured contrast failures the audit found are fixed. Two separate goals, deliberately named apart — see "The finding that splits this plan".

**Architecture:** One base font-size on `:root` and a `rem` scale off it, so the tokens become a scale down from a declared base instead of three opt-outs from a base nobody declared. Geometry that exists to hold text follows the type; geometry that exists to hold a *target* or a *fraction of the window* does not. No new dependencies, no preprocessor, no framework — `src/styles.css` stays one hand-written stylesheet.

**Origin:** three parallel agent audits on 2026-07-31, after the owner reported that "the fonts and their size are unpleasant" over a screenshot of the expanded pull-request row. Their three reports are not in the repository; everything from them that survived verification is below, and every claim marked **verified** was re-checked against the source by the session that wrote this plan. Claims that were *not* re-checked are marked **unverified** and must be confirmed by whoever executes the task.

---

## The finding that splits this plan

**Raising the type scale fixes no contrast failure. Not one.** Contrast ratio is independent of font size, and the WCAG 3:1 large-text allowance begins at 24px (18.66px at bold) — the scale here tops out at 13px today and 19px after this plan, so it never applies. **Verified** by reasoning about the standard, and stated here because the temptation to book the raise as an accessibility win is the single most likely way this plan gets misreported.

So this is two jobs:

1. **Size and hierarchy** (Phases 1–4) — what the owner asked for. Visible, and improves no measured number.
2. **Contrast and target size** (Phases 5–6) — what the audit found. Improves measured numbers, and is barely visible.

There is exactly one place they meet, and it is worth having: **12px type plus `padding: 4px 10px` carries `.pr-actions button`, `.tk-fix` and `.pr-detail-retry` from 19.2px tall to ~24px**, clearing SC 2.5.8 (24×24 minimum target) for three controls. The type alone does not get there; the padding must land in the same step. Two other controls gain nothing from the raise and need explicit sizing — `.pr-toggle` has a hard-coded `width: 16px`, `.pr-refresh` has no padding at all.

---

## Global Constraints

- **English only**, this document included. (`CLAUDE.md`, "Language".)
- **No new dependencies.** Neither cargo nor npm.
- **`src/styles.css` stays the only stylesheet**, hand-written, with its existing register: a comment says *why* a value is what it is and what the alternative cost. A magic number replaced by another magic number is not progress; where a value can become intrinsic (`min-height`, `ch`, `fit-content`, an `auto` grid row) it should.
- **The pill window is out of scope.** `pill.html` / `src/pill.css` do not load `styles.css`, and the window is sized natively at `inner_size(200.0, 48.0)` (`src-tauri/src/main.rs`). Scaling its `font: 13px/1` without resizing that window from Rust clips "N waiting".
- **The terminal's own font is xterm's**, set from JS (`src/terminal.ts`), not from a token. It is 14px — larger than the entire chrome, which is part of why the chrome reads small.
- **Baseline, measured on this branch on 2026-07-31:** `npx tsc --noEmit` clean, **47 vitest files / 531 tests**, **410 cargo tests**, clippy at the carried ceiling of **6 diagnostics** (4 × `std::io::Error::other`, 2 × `too_many_arguments`). Nothing may regress below those numbers.
  **Count clippy diagnostics, not lines.** `cargo clippy --all-targets 2>&1 | grep -cE '^warning: '` reports **8** at the ceiling, because cargo prints two per-crate summary lines that are not diagnostics. Read the summaries — they are the authority.
- **The full gate:** `npx tsc --noEmit && npx vitest run && (cd src-tauri && cargo test)`.
- **Run everything from this worktree**, never from `/home/evgeny-kharetski/workspace/lemsoft/cowork-deck` — vitest globs suites out of nested worktrees there and the counts are meaningless.
- **Every phase is verifiable twice:** identical at the base scale, and correct at the largest step. A step that can only be checked one way is a step that has not been checked.

---

## What the audits found, as facts

Each is **verified** unless marked otherwise. Line numbers are as of this branch on 2026-07-31 and will drift.

### The mechanical cause

**No base font-size is declared anywhere** — not `:root`, `html`, `body` or `#app`. `styles.css:62-63` sets height, margin, flex, font-*family*, colour and background, and no size. So every text node without an explicit `font-size` falls to the WebView default 16px, and the tokens are not a scale *down from a base* — they are 68% / 75% / 81% opt-outs from a base nobody declared.

Five things land there by accident:

| Selector | Renders at | Why |
|---|---|---|
| `.tk-row-title` (`:629`) | 16px | sets colour and weight, no size |
| `.pr-title` (`:792`) | 16px | same |
| `.tk-kind` | 16px | **no CSS rule exists at all** |
| `.pr-fix` | ~13.3px | **no CSS rule**, native button |
| `.pr-title-head` (`:782`) | ~18.7px | bare `<h3>`, UA `1.17em` |

Consequence on screen: the Board's heading `.tk-title` is 13px (`:468`) while the pull-request screen's heading is 18.7px, for the same job. And a `.tk-kind` chip renders 16px unbordered beside an 11px bordered `.tk-label` in the same `.tk-row-main`.

### The distribution

`var(--fs-xs)` (11px) **48 uses**, `var(--fs-sm)` (12px) **36**, `var(--fs-base)` (13px) **16**. Half of all 100 font-size declarations are the smallest step, and it carries uppercase section headings, chips, labels, ages, hints, counts, state words, file paths, `+/−` numbers **and the entire pull-request description**. Ten jobs, one register — which is why colour ends up carrying distinctions that size and weight should.

`line-height` appears with **six ad-hoc values** (1.2, 1.3, 1.35, 1.4, 1.5, 1.6) and no token; `#app` inherits `normal`. `letter-spacing` has **two values for one job** — `#sidebar h3` at 0.06em (`:71`) and `.tk-e-section-head` at 0.04em (`:737`).

### Measured contrast (composited, including `rgba()` tints and ancestor `opacity`)

`--fg-subtle`'s own comment claiming 5.0:1 and 4.61:1 **is accurate for every direct use**. It stopped being true in three ways it could not have anticipated:

| Failure | Measured | Threshold | Fix |
|---|---|---|---|
| `.btn--icon` at rest — `--fg-muted` @ `opacity: 0.45` (`:293`) | **2.68** | 3.0 (1.4.11) | `opacity: 0.7` → 4.56 |
| `.tk-card.done` / `.tk-row.done` — 11px `--fg-subtle` @ `opacity: 0.6` | **2.67** | 4.5 | drop the opacity, add a chip |
| terminal `brightBlack` `#5c6370` on `#1d1f21` | **2.73** | 4.5 | `#8a919e` → ~5.1 |
| non-active tile @ `opacity: 0.82` — `--fg-subtle` badges | **4.00** | 4.5 | drop the rule |
| `.state-error` chip on panel / raised / active row | **4.21 / 3.87 / 3.36** | 4.5 | tint alpha + token |
| `.state-ended` on an active session row | **4.31** | 4.5 | same |
| `button:disabled` — `--fg-muted` @ 0.5 | **2.91–2.98** | exempt | `opacity: 0.62` anyway |
| `--border` / `--border-strong` as a boundary | **1.18–1.73** | 3.0 (1.4.11) | palette; unrelated to type |
| `--bg-app` input fill vs `--bg-panel` dialog | **1.06** | 3.0 | focus-and-hover, not a brighter resting border |

`brightBlack` is the one to care about first in practice: it is the colour Claude Code uses for most secondary output — hints, timestamps, "esc to interrupt", diff context — at **2.73:1 on the app's primary content surface**, and 2.27 on any unfocused tile. It is already 14px, which proves size is not the lever.

All ratios above are the audit's and were **not** independently recomputed by this session. Whoever executes Phase 5 must re-measure rather than trust them, and **the script that produces the table belongs in the repository**: axe-core and Lighthouse report every ancestor-`opacity` row as passing, because neither composites it.

### Three pieces of dead code (verified)

- **`styles.css:88` and `:92`** — `.sk-del, .ws-del` and `.ws-edit, .sk-edit` declare `color: var(--fg-subtle)` and `opacity: 0`. Both are overridden by `.btn--icon` (`:293`, equal specificity, later in the file) to `--fg-muted` and `opacity: 0.45`. The code reads as though those controls are invisible at rest. They are not. Delete the dead declarations.
- **`.tile-close` (`:112`)** — `width: 22px; height: 22px; font-size: 13px`, all three inert: the button is built by `iconButton` (`icons.ts:132`), which composes `btn--icon`, whose `min-width/min-height: 24px` clamps the box past 22px (`min-width` beats `width`), and the button contains an SVG, not text. Delete all three.
- **`--st-idle`** — zero uses. `.state-idle` uses `--fg-muted`. Delete the token.

### The sidebar, which is not a font-size problem (verified)

```
248px  #sidebar width
−16    #sidebar padding: var(--sp-3) var(--sp-2)
−16    .ws-row padding: 6px var(--sp-2)          = 216px content
− 9    .dot
−24    .ws-edit  (btn--icon min-width)
−24    .ws-del   (same; opacity .45 still occupies layout)
−40    five × gap: var(--sp-2)
−90    .ws-account { max-width: 90px }   (:428)
−15    .ws-count
────
 14px  left for .ws-label  →  "co…"
```

`.ws-account` alone takes 90px of a 216px row — 40% — for a login already shown in the workspace form. Without an account bound the label gets 135px and reads fine. **And `.ws-label` has no `title`**, while `.ws-account` and `.ws-count` both do: the one element that truncates is the one without a tooltip, and the two that have tooltips are what caused it.

Raising `--fs-xs` from 11 to 12px narrows `.ws-account`'s fixed 90px cap from ~15 characters to ~14, so the login begins truncating too — **two ellipses in one row**. Phase 4 must not lag far behind Phases 1–2.

### The measure (verified by arithmetic)

`.pr-detail-body` (`:855`) sets `--fs-xs` + `--font-mono` + `max-height: 40vh` and **no `max-width`**. At a 1970px window: `1970 − 248 − 24 − 18 − 18 = 1662px`, at 11px monospace ≈ **252 characters per line**. Comfortable is 45–75; the WCAG 1.4.8 ceiling (AAA, so not a conformance failure here) is 80. Three choices all push the same way: the smallest size in the app, the typeface least suited to prose, and the widest measure available.

The sibling `.pr-detail-files` already carries `max-width: 72ch` with a comment explaining why. **The fix existed one rule up and was not applied to the body.**

### `.tk-views` will break navigation before anyone sees a benefit (~~unverified arithmetic~~ **re-measured 2026-08-03: the number was wrong by three steps**)

`.tk-views` (`:458`) is an `inline-flex` with no wrap holding "Terminals | Board | Pull requests" at `--fs-sm`, inside a 248px `#sidebar` whose own padding leaves 232px. The audit measures it at roughly 230px today and overflowing at 15px — and `#sidebar { overflow: auto }` turns the app's primary navigation into a horizontal scroll. Re-measure before relying on the numbers; the direction is not in doubt.

> **Re-measured while executing Phase 4, and the audit's ~230px is an artefact of measuring the wrong box.** `.tk-views` is a child of a `flex-direction: column` `#sidebar`, so it stretches to the full content width whatever its own `inline-flex` says: its box *is* ~231px at 248px and ~323px at 340px, by definition, and comparing that to the space available always reads as "1px from overflowing". What can actually overflow is the three buttons inside it. Measured against the real stylesheet:
>
> | `:root` base | buttons + gaps | box at the 248px floor | |
> |---|---|---|---|
> | 13px (today) | 206.2px | 231px | fits, 25px spare |
> | 15px | 227.0px | 231px | fits |
> | 17px | 227.0px | 231px | fits |
> | **18px** | 233.4px | 231px | **overflows** |
> | 19px | 243.3px | 231px | overflows, and `#sidebar` gains a horizontal scroll |
>
> So the switch is not one pixel from breaking; it has 12% slack today and survives to a 17px base. **Task 13 is still worth doing, but not for the reason given above** — the honest reason is that it caps any future text-size control (Phase 7) at 17px, and that the app's primary navigation does not belong in a column sized by workspace names. Measured in headless Chromium against `src/styles.css`, so the exact threshold is indicative: the Tauri WebView resolves `system-ui` to a different face. The 25px of slack is a margin, not a rounding error.

### Level A gaps (verified)

- **`.form-swatch` (`forms.ts:130`)** — six bare `<button>`s carrying only `style.background`. No `aria-label`, no `title`, no `aria-pressed`; selection shown only by a CSS ring. A screen reader announces "button, button, button, button, button, button". Colour is the only carrier and there is no text alternative anywhere: **1.4.1 and 4.1.2, both Level A.** The neighbouring icon picker does it correctly — copy that.
- **Selected state never reaches AT in three places** — `.tk-views` (`main.ts:59-66`, class `active` only), `.ws-row.active` (`workspaces.ts`), `.sess-row.active`. The codebase knows the pattern: `aria-pressed` at `board.ts:443`, `aria-expanded` at `sessions.ts`, `role="radio"`/`aria-checked` in `forms.ts`, `aria-selected` in `palette.ts`.

### A `CLAUDE.md` violation, found in passing (verified)

`github-screen.ts` is **entirely in Russian** — "Установить", "Добавить аккаунт", "Перечитать", "Готово", "состояние: …" — as are `github.ts`'s `accountChoices` labels, four field labels in `forms.ts`, and the `.tile-auth` tooltips in `sessions.ts`. `CLAUDE.md` permits exactly two Cyrillic carve-outs, `src/placeholders.ts` and `src/commands.ts`, and names why each is load-bearing. **These are neither.** Inside `<html lang="en">` a screen reader also pronounces Cyrillic with an English voice, which is unintelligible rather than merely wrong — but the reason to fix it is the project's own rule. Translate; do not add `lang="ru"`.

This is **out of this plan's scope** and belongs in a card of its own: it is a language sweep, not a typography change, and burying it here would make one commit answer for two unrelated decisions.

### What the existing code already got right — do not "fix" these

Named because a plan that only lists faults invites a worker to change things that are correct.

- **State is not carried by colour alone anywhere it matters.** `checksLabel()` (`pr.ts:31`) returns four distinct strings behind `.pr-checks--*`; session states carry a text label plus a distinct motion signature; `.tile-auth` differs by glyph; the damaged-card `⚠` has `role="img"` + `aria-label` + `title` with the full reason (`board.ts`); `.tk-col-unknown`'s heading reads "unknown step"; `.pr-detail-plus/minus` are literally `+12` / `−3`.
- **`--font-mono` on the description is correct and is not taste.** `pr-view.ts` rejects the alternative with a reason — no Markdown renderer, and a hand-rolled subset that turns `[x](javascript:…)` into an anchor is not a third option. `pre-wrap` at a fixed pitch is the only thing making the `|` tables in real descriptions line up.
- **`min-height: 24px` on the board's glyph buttons** is the WCAG 2.2 target minimum and its comment says so. It may be exceeded, never scaled down.
- **`.tk-card`'s `min-height`** (rather than `height`) is the fix for a real bug where label chips overlapped the row below. The *property* must never regress; only the number becomes type-relative.
- **`prefers-reduced-motion`** covers the FLIP animation, because `!important` in an author stylesheet beats an inline non-important declaration.
- **`matchHotkey` on `e.code`** is load-bearing for a Cyrillic keyboard layout, not a nicety.

---

## Phases and barriers

```
Phase 1  Declare the base, tokens to rem          ┐ ONE COMMIT — see Barrier A
Phase 2  Hierarchy: two steps up, line-height     ┘
                            │
Phase 3  The measure
                            │
Phase 4  The sidebar and the view switch
                            │
Phase 5  Contrast                                   ← independent of 1–4
                            │
Phase 6  Level A and reflow
                            │
Phase 7  (optional) A text-size control the user can reach
```

### Barrier A — Phases 1 and 2 are one commit, and this is not a preference

The moment `:root` gets a `font-size`, the five accidentally-sized selectors above stop inheriting 16px and **shrink**. Phase 1 alone therefore makes the Board and pull-request screens *worse*: row titles drop from 16px to the base, and `.tk-kind` from 16px to a chip size it has no rule for. Phase 2's new steps are what catches them. Landing Phase 1 on its own is a regression with a green test suite.

### Barrier B — Phase 5 must not be reported as a consequence of Phases 1–4

See "The finding that splits this plan". A commit message that says the type raise improved contrast is false.

---

## Phase 1 + 2 — The base, the scale, the hierarchy

**One commit.** Touches `src/styles.css` only.

> **Executed 2026-07-31, with three deviations from the plan as written above.**
>
> 1. **Phase 3 landed in the same change**, not separately. The owner's complaint was
>    made over a screenshot of the pull-request description, and shipping the base
>    scale without the measure cap would have answered everything except the thing
>    they pointed at. The phases stay separate in this document because the *review*
>    of each is different; the commit is one because the visual check is one.
> 2. **`.tk-card-title` was deliberately NOT given `--fs-lg`**, though Task 2 above
>    says "the card title". The audit's own blast-radius list names this as the
>    plan's one real content regression: `.tk-cols` is `minmax(240px, 1fr)`, so a
>    240px column leaves the card 216px, and a 16px two-line clamp holds ~54
>    characters against ~66 at 13px. Raising the card title *truncates more of it*.
>    It waits for Phase 4's column widening, and `.tk-row-title` — which has a full
>    row to itself — took the step alone.
> 3. **Task 4's chip shaping did not land.** The letter-spacing token, `.tk-kind`'s
>    first rule and `.tk-col-head`'s uppercase idiom did; giving the five state chips
>    `.tile-state`'s pill treatment is a design change rather than a mechanical one,
>    and mixing it in would have made "confirm nothing else moved" unreviewable. It
>    is still worth doing and is still Task 4.
>
> Also done here, out of order because the type raise is what made them reachable:
> the three `2px` control paddings (Task 6, as planned), `min-height: 24px` on the
> same three controls (Task 19's half that the raise could reach), and `--fs-sm` on
> `.pr-detail-error` — an error the same size as a caption reads as a caption, and
> `.form-error`/`.tk-error` were already a step up.
>
> **One correction to Task 1 as written.** "Pixel-identical by construction" was not
> true as stated: three `rem` values elsewhere in the file (`4rem` and `4.5rem` on the
> schedule time fields, `12rem` on the card modal's body) resolved against the
> WebView's undeclared 16px, so declaring a 13px base would have shrunk all three by
> 19% silently. They are pinned to px in the same change, with a comment; making them
> type-relative on purpose is a separate decision and belongs in the geometry sweep.
> **Anyone re-running this plan on another branch must look for `rem` before
> declaring a base.**

- [x] **Task 1: Declare the base and convert the three tokens to `rem`.**
      `:root { font-size: 13px }` and `--fs-xs: 0.8462rem; --fs-sm: 0.9231rem; --fs-base: 1rem;` — each with the px it resolves to in a trailing comment, because `0.8462rem` reads worse in source than `11px` and this file's register invites the explanation. Pixel-identical by construction at the base; the whole of the review is "confirm nothing moved except the five selectors in Task 2".
      Alternatives rejected, recorded because the decision was contested by the audits: **absolute px with more steps** answers "make it bigger" but not "let me choose", and leaves the ~40 non-type px values out of step with the type they were derived from — the same drift that produced the overlapping-label bug. **A `--scale` multiplier with `calc()`** scales the type in three declarations but needs a hand-written `calc(… * var(--scale))` at every non-type value, each unreadable inside `minmax()`/`clamp()` and each a site to forget one; it also leaves two scaling mechanisms alongside the `ch`/`em`/`rem` values already in the file, with nothing keeping them in agreement.

- [x] **Task 2: Two steps up, and a rule for the selectors that never had one.**
      Add `--fs-lg` (16px) and `--fs-xl` (~19px). Apply `--fs-lg` to `.tk-row-title`, `.pr-title` and the card title; `--fs-xl` to `.tk-title` and `.pr-title-head`, so one screen title per view reads as one. Write the first rule for `.tk-kind` (a chip: `--fs-xs`, and the shape treatment in Task 4) and for `.pr-fix` (match `.tk-fix`).
      19px is **taste** — 18 or 20 serve. What is not taste is that it must sit above the 16px row titles, which today it does not.

- [x] **Task 3: Three line-height tokens, and `#app`'s own.**
      `--lh-tight: 1.25` for one-line UI, `--lh-body: 1.5` for wrapping prose, `--lh-code: 1.55` for the `<pre>` and the file list. Set `#app { line-height: var(--lh-tight) }` — it inherits `normal` (≈1.15–1.2) today, and cramped leading is a real part of why 13px "reads tiny". Collapse the six ad-hoc values into the tokens, **with two exceptions that are functional rather than typographic and must survive:** `.tile-state { line-height: 1.4 }` is tuned to its 7px `::before` dot, and `.select-wrap select { line-height: 1.2 }` makes the native control match the field height. `--lh-tight: 1.25` over 1.3 is **taste**.

- [~] **Task 4: One letter-spacing token, and shape for the chips.** *(the token, `.tk-kind` and `.tk-col-head` landed; the chip shaping did not — see the deviation note above)*
      `--ls-caps: 0.06em`, replacing both existing values — `#sidebar h3` and `.tk-e-section-head` are the same kind of thing and should not differ by 0.02em for no reason. Deliberately **not** adding tracking on the 11–14px steps: system-ui is already tuned there and negative tracking at 12px costs exactly the legibility being complained about.
      Then the chips. `.tk-kind`, `.tk-label`, `.tk-bot`, `.tk-busy`, `.tk-stale` are all one size and differ only by colour; `.tile-state` already solved this — border, tinted background, radius, leading dot — and its comment says "States differ by shape, not by colour alone". **The board never got that treatment.** Give the state chips a shape and leave `.tk-label` as the outlined one. That the answer is `.tile-state`'s specific pill is **taste**; that the five must differ by more than hue is not.
      Also: `.tk-col-head` (`:480`) is 11px `--fg-subtle` sentence-case, so a kanban column name reads *quieter* than the cards under it. The app has one idiom for "heading over a list" (`#sidebar h3`) and the board does not use it.

- [x] **Task 5: `tabular-nums`, declared nowhere today.**
      On `.tile-tokens`, `.sess-tokens-sum`, `.ws-count`, `.sess-group-badge`, `.tk-col-head`, `.tk-filter`, `.pr-detail-plus`, `.pr-detail-minus`. `.tile-tokens` re-renders every 5 s, so its digits change width and the badge jitters. One declaration, and it does more for dense numerics than 2px of size would.

- [x] **Task 6: Control padding 2px → 4px** on `.pr-actions button`, `.tk-fix`, `.pr-detail-retry`. **This must land here, not in Phase 5**: with 12px type it is what carries all three from 19.2px to ~24px and clears SC 2.5.8. The type alone does not reach it.

**Gate:** the full gate, plus a visual check of the Board, the pull-request screen with a row expanded, the deck, and one modal — at the base scale and at the largest step.

---

## Phase 3 — The measure

- [x] **Task 7: Cap the description.**
      `.pr-detail-body`: `max-width: 80ch`, `font-size: var(--fs-sm)`, `line-height: var(--lh-code)`. Keep `white-space: pre-wrap`, `overflow-wrap: anywhere` (unbroken URLs), `max-height: 40vh` and `overflow: auto`.
      **80ch is a judgement, and the audits disagreed on it.** One argued 96ch to keep ASCII tables in real descriptions from wrapping — a wrapped table is destroyed, not merely ugly. The other held 80 as the AAA ceiling and the conventional code column. 80 is chosen because prose dominates the content; the cost is that a table wider than 80 columns wraps, and the honest answer to that is a Markdown renderer, which is out of scope.
      `ch` rather than px because `1ch` *is* the loaded face's advance, so the cap is exactly N columns whatever CaskaydiaCove's metrics are — and it is already the idiom one rule down.

- [x] **Task 8: Keep `.pr-detail-files` at 72ch** and only raise its size. Its comment explains why: `.pr-detail-path { flex: 1 }` pushes the `+/−` counts to the block's right edge, so a wider cap puts the numbers a hand's width from the path again.
      **Corrected while executing it:** keeping the cap was not enough. A *fixed* 72ch does the same damage a wider cap would whenever the paths are short — the counts sit at the block's edge regardless, so `+187 −13` still ended up a hand's width from `src/board.ts`. `width: fit-content` under the 72ch cap keeps the aligned column *and* the proximity: the block is as wide as its longest path needs and no wider. Intrinsic, which is what the constraint at the top of this plan asks for.

- [x] **Task 9: The other unbounded prose**, all currently free to fill 1700px for one sentence: `.tk-unavailable` and `.pr-unavailable` → `60ch`; `.gh-note` → `64ch`; `#deck:empty::before`'s `max-width: 320px` → `44ch` and its `line-height: 1.6` → `--lh-body`.

---

## Phase 4 — The sidebar and the view switch

> **Tasks 10–12 executed 2026-08-03**, one commit, measured against the real
> stylesheet on a static harness rather than estimated. `.ws-label`, holding
> "cowork-deck" in a row with a bound account and an open-task count:
>
> | window | `#sidebar` | `.ws-label` | |
> |---|---|---|---|
> | before, any width | 248px | **28.2px** | "c…" |
> | after, 1000px (clamp floor) | 248px | **119.8px** | full, **at the unchanged width** |
> | after, 1400px | 252px | 123.8px | full |
> | after, 1970px (clamp ceiling) | 340px | 212px | full, and `lemsoft-internal-tooling` stops clipping too |
>
> The second line lands where it was meant to: `.ws-account`'s text starts at 25px
> from the row's left edge, the same as `.ws-label`'s, so the login sits under the
> name rather than under the dot. Rows with a bound account grow from 36px to
> 51.8px — the cost of the fix, and the reason `row-gap` is 2px against the row's
> 8px column gap.
>
> **Two deviations from the plan as written:**
>
> 1. **Not a two-row grid — `flex-wrap` plus `flex-basis: 100%`.** `.ws-row` holds
>    two conditional children (the account and the count), and `grid-template-areas`
>    cannot place a child that may not exist without a rule per combination. Wrapping
>    needs one declaration on the row and one on the account, and stays correct for
>    all four combinations.
> 2. **`.ws-account` is appended last in the DOM, not reordered with `order: 1`.**
>    `order` would have left it reading between the name and the count while
>    displaying below both — a 1.3.2 meaningful-sequence mismatch, in a plan half of
>    which is an accessibility plan. `workspaces.ts` appends it after the two icon
>    buttons instead; neither is focusable, so nothing moves in the tab order.
>
> Also: the 9px dot became `--dot-size`, because the account's indent is that plus a
> gap and the two must agree — the plan's own constraint forbids a second magic
> number justifying the first.

- [x] **Task 10: `.ws-account` onto a second row** of a two-row `.ws-row` grid, at `--fs-xs`/`--fg-subtle`, indented past the dot. Returns ~98px to the label **at 248px, with no width change** — this is the whole of the truncation bug, and it is worth landing before any width change so the two are reviewable apart.
- [x] **Task 11: `title` on `.ws-label`** — one line in `workspaces.ts`. Also on `.sess-group-name`, `.tile-head span:first-child` and `.tk-card-title`, which truncate the same way. (`.tk-card-title` already reaches AT through its `aria-label`; the `title` is for the sighted user.)
- [x] **Task 12: `#sidebar { width: clamp(248px, 18vw, 340px) }`.** At 1970px that is 340px. Re-measure `.tk-views` before and after — its overflow is the thing this must not leave broken.
      **Re-measured, and the overflow was never as close as the audit said** — see the correction under "`.tk-views` will break navigation" above. The clamp's floor is the old fixed width, so at the narrow end this changes nothing at all, which is also what makes it safe: widening cannot be what overflows a switch that had 25px spare at 248px.
- [ ] **Task 13: Move the three view tabs out of the sidebar** into a full-width bar above the three screens (`main.ts` currently prepends them into `#sidebar`). Then the sidebar's width is driven only by workspace names, and the tabs get a real size with real padding. Touches `index.html` and `main.ts`, and `tests/view-switch.test.ts` asserts against the switch — read it first.
      This is the structural answer rather than the stylesheet one, and it is separable: Tasks 10–12 stand without it.

---

## Phase 5 — Contrast

Independent of everything above. **Re-measure every ratio before and after** — and add the measuring script to the repository, because axe-core and Lighthouse pass every ancestor-`opacity` case in this list.

- [ ] **Task 14: `.btn--icon { opacity: 0.45 → 0.7 }`** — 2.68 → 4.56, clearing even the text threshold while staying visibly quieter than hover. This is the resting state of every icon control in the app. Then **delete the dead declarations at `:88` and `:92`.**
- [ ] **Task 15: `brightBlack: "#5c6370" → "#8a919e"`** in `src/terminal.ts` — 2.73 → ~5.1 on the surface the user actually reads. And **delete `#deck.has-active .tile:not(.is-active)`**: `.tile.is-active` already signals with a border *and* a shadow, so dimming three terminals out of four to reinforce a border is a bad trade that also drags `--fg-subtle` badges to 4.00.
- [ ] **Task 16: Drop `opacity: 0.6` from `.tk-card.done` / `.tk-row.done`** and push a `"closed"` chip from `chips()` instead — that function already does exactly this for `working`, `damaged` and `stale`. Fixes 2.67:1 on every closed row's meta *and* gives closed-ness a carrier that is not presentational.
- [ ] **Task 17: `.state-error` and `.state-ended`** — raise the fill alpha and the token, then **re-measure against all three backgrounds**, not just `--bg-panel`. `.state-error` is currently the weakest chip in the set and fails worst (3.36) on the selected session row, which is where a user is most likely looking.
- [ ] **Task 18: `:disabled { opacity: 0.62 }`**, and move `.pr-merge`'s refusal reason out of `title` into a visible line with `aria-describedby` — it is the highest-stakes button in the app and its refusal is currently unreachable by keyboard and by touch.
- [ ] **Task 19: `min-width`/`min-height: 24px` on `.pr-toggle` and `.pr-refresh`.** Neither benefits from the type raise: the first hard-codes `width: 16px`, the second has no padding. The disclosure is the only way to read a description and is currently 224px² against a 576px² requirement.
- [ ] **Task 20: Delete `--st-idle`** and `.tile-close`'s three inert declarations.

---

## Phase 6 — Level A and reflow

- [ ] **Task 21: Name the colour swatches** (`forms.ts`) — `aria-label` per colour plus `role="radio"`/`aria-checked`, copying the icon picker beside it.
- [ ] **Task 22: Expose selected state** — `role="tablist"`/`aria-selected` on `.tk-views`, `aria-current` on `.ws-label` and `.sess-row`.
- [ ] **Task 23: The modals at 400% zoom.** `.modal-box--form`'s `min-width: 480px` overrides its own `width: min(560px, 92vw)`; `.palette-box` and `.gh-screen` are 420px, `.modal-box` 340px. Inside a centred `position: fixed` overlay a 480px box at a 320px equivalent overflows *both* edges with nothing scrollable. Cap each with `min(…, 100vw − 32px)` and add `overflow: auto` to `.modal-overlay`.
- [ ] **Task 24: Widen the focus ring** to `0 0 0 2px var(--accent), 0 0 0 4px var(--bg-app)`. On `.tk-filter.selected` the current 1px accent ring sits 1px outside an accent border, so focus adds no new information to a keyboard user tabbing across Open/Closed.
- [ ] **Task 25: Make `REGIONS` view-aware** (`main.ts`). `currentRegion()` returns `"terminal"` for anything outside the sidebar, so from a board row F6 twice calls `focus()` on an xterm inside a `display: none` `#deck` and strands focus. Plain Tab still works, so this is a degraded shortcut rather than a trap.

---

## Phase 7 — A text-size control (optional, decide after Phase 2)

Worth doing only if the base chosen in Phase 1 turns out to be a matter of taste rather than a fix. The `rem` architecture exists so that this is possible, not so that it is mandatory.

- [ ] **Task 26: `src/ui-scale.ts`**, pure and unit-tested, following `pr.ts`/`issues.ts`: the steps, `clampScale`, `nextScale`/`prevScale`, `applyScale(scale, root)` writing the root's inline `fontSize`, and `terminalFontPx(scale)` **rounded to an integer** — xterm renders on a cell grid and 16.1px gives sub-pixel cells and blurry glyphs.
- [ ] **Task 27: `terminal.setFontSize(px)`** — sets `this.term.options.fontSize` and calls `this.fit()`. **The refit is the load-bearing half:** it changes cols/rows, which fires the existing `onResize` handler and pushes `resizeSession` to the PTY. Omitting it leaves every PTY on stale dimensions with no symptom until the agent's output wraps wrong. Two xterm mocks (`tests/terminal-passthrough.test.ts`, `tests/terminal-search.test.ts`) have no `options` property and need one.
- [ ] **Task 28: Deliver the change as a `window` `CustomEvent("ui-scale")`**, subscribed in `TerminalPanel`'s constructor and removed in `dispose()` — **not** as a `Deck` fan-out. Five test files hand-roll a `TerminalPanel` mock with a fixed method list and every one would throw on a new method; an event costs one listener and leaves all five untouched. It is also the fan-out shape the app already uses for `pill://count`.
- [ ] **Task 29: Persist it.** `UiState` gains `ui_scale: f32` — **non-`Option`, with `#[serde(default)]`.** Without the default every existing `ui_state.json` fails to parse and `store.rs`'s `unwrap_or_default()` swallows it, silently forgetting the active workspace on the first launch after upgrade; extend `ui_state_round_trips_and_defaults_empty` to cover exactly that.
      **And `save_ui_state` must stop replacing the whole file.** It takes a whole `UiState` today, and `saveUiState` has exactly one caller passing only `{ activeWorkspaceId }` — so adding a field without a patch-merge wipes the scale on every workspace switch. Change the parameter to a patch of `Option`s. Non-`Option` in the TS interface too, so `tsc` *refuses* the current call site rather than letting it compile and lose data. (**Verified:** one caller, `workspaces.ts:68`; `save_ui_state` is a whole-file replace.)
- [ ] **Task 30: A settings dialog** on `openDialog`, opened from the palette, plus two direct palette entries for larger/smaller. Rejected: the palette alone (it renders one-shot commands with nowhere to show the current value, so a size chooser becomes a guessing game); a fourth view-switch button (a preference is not a screen, and that row is the one that overflows first); a settings *screen* (its own `ViewName`, its own hidden-root rule, its own switch tests, for one control); a hotkey (`matchHotkey` is crowded and a preference does not earn one).
- [ ] **Task 31: Apply at boot *before* `boot()` runs**, not as a `runBoot` step — `runBoot` stops at the first failing step, so a failed preference read would take the layout restore and the scheduler wiring with it. A preference that cannot be read is a preference at its default, not a dead app.

---

## Tests

- **`tests/view-switch.test.ts` is the only test that reads the real stylesheet** (`?raw`, enabled by `test: { css: true }`). All its cases assert `getComputedStyle(el).display`, which no type change touches — jsdom resolves `display` independently of font metrics. Keep it in the gate for every phase: it is also the test that would catch a botched hidden-root rule if Phase 4 reorders selectors.
- **No other test asserts a computed style, a dimension or a pixel.** jsdom computes no layout, so the DOM-shape suites are structurally immune. (Reported by the audit as a grep result; **unverified** by this session — confirm before relying on it.)
- **`#board.hidden`'s comment warns that jsdom applies a group's highest specificity to every selector in it.** Do not merge new font-size rules into the grouped selectors near `.tk-hidden`, or a class selector gains id-level weight in tests and a regression test passes against the bug it exists to catch.
- **New tests worth writing** if Phase 7 happens: `ui-scale.test.ts` (clamping, stepping, integer rounding, `applyScale` writing the root), `settings.test.ts` (the dialog reflects the stored value, Cancel changes nothing, OK persists), and one asserting `setFontSize` calls `fit()`.

---

## Taste, collected so it can be discounted

Everything here is a judgement rather than a rule, gathered in one place so a reviewer can overrule it without unpicking the plan:

- `--fs-xl` at ~19px (18–20 all serve).
- `--lh-tight: 1.25` over 1.3.
- 80ch for the description over 96ch — and the disagreement behind it is recorded in Task 7.
- Giving the board's state chips `.tile-state`'s specific pill treatment, rather than some other shape.
- `clamp(248px, 18vw, 340px)` for the sidebar: the number of workspace-name characters to aim for is a preference, not a measurement.
- Moving the view tabs out of the sidebar (Task 13) is a structural opinion; Tasks 10–12 do not depend on it.

## Deliberately out of scope

- **The Russian UI copy** — a language sweep, not a typography change. Its own card.
- **The pill window** — needs a native resize from Rust to go with it.
- **`icon()`'s dead `size` argument.** `.icon { width: 16px; height: 16px }` is a class selector and outranks the `width`/`height` presentation attributes `icon()` writes, which carry zero specificity — so `icon("clock", 12)` renders at 16px everywhere except the three places CSS re-sizes it. Making icons scale is a CSS-only change plus one `--icon-size` token in `em`, and the `size` parameter should either start being honoured or be dropped. (**Unverified**; worth its own card.)
- **`--border` at 1.18–1.73:1 and the 1.06:1 input fill.** Real 1.4.11 failures, but fixing them is a palette decision about how the whole app looks, not a typography one.
