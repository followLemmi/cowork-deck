# A diff drawer for the pull request screen — Design

**Status:** design agreed, not implemented. Written 2026-08-04.

**Origin:** the owner asked for a diff viewer, "a panel that slides out from the
right, or something like that", and for it to be "maximally convenient". Four
specialist reviews were run in parallel — interaction architecture, accessibility,
rendering and data, visual design. This document is the resolution of those four,
including the three places they contradicted each other and the two places a
measurement overturned a premise.

Every number here was measured. Where a claim could not be checked it is marked
**unverified** rather than dropped, because an unmarked guess in a design document
becomes a fact by the time it is implemented.

---

## The measurement that decides the backend

`gh pr diff` cannot serve this feature. On the repository's own PR #151:

```
$ gh pr diff 151 -R followLemmi/cowork-deck
could not find pull request diff: HTTP 406: Sorry, the diff exceeded the
maximum number of lines (20000)
PullRequest.diff too_large
```

`gh pr diff --patch` and `gh api repos/{o}/{r}/pulls/151 -H "Accept:
application/vnd.github.diff"` fail identically. GitHub caps that endpoint at 20,000
lines; #151 is 19,854 patch lines *after* GitHub has already dropped its largest
file, so it is over the line.

This is not a slow path to be optimised — it is a path that fails on the exact pull
request the feature exists for, and it fails at the moment of use. **`gh api
repos/{owner}/{repo}/pulls/{n}/files` is the only mode.** Keeping the whole-diff
route as a fallback was considered and rejected: it would need a second parser
(whole-blob unified diff with `diff --git` headers) and a second set of tests, to
serve small pull requests that the files endpoint already serves in one call.

### What that endpoint gives, measured on #151

| | |
|---|---|
| Round trip | ~1.1 s, HTTP 200 |
| Response | 1.06 MB, of which 960 KB is patch text |
| Files | 62, all in one page at `per_page=100` |
| Largest single patch | 97 KB ≈ 2507 lines |
| Files with **no** `patch` field | **3** |

Those three are the important ones, and they are two different states that must not
share a sentence:

- `docs/superpowers/plans/2026-07-30-github-issues-board.md` — 5290 changes, patch
  omitted **by GitHub** for size. Nothing we can do in-app.
- two files with `changes: 0` — nothing to show because nothing changed, which is a
  success and not a failure.

> **Correction, 2026-08-04.** An earlier version of this paragraph called those two
> "renames with no content change". That was inferred from `changes: 0` and written up
> as if it had been measured. It had not been. Both are
> `"status": "modified"` with **no `previous_filename` at all**, and **#151 contains
> zero renamed files** — re-checked directly against the endpoint.
>
> The consequence is not cosmetic: the *Files with no diff* table below promised
> `previous_filename → filename` for this state, and on the only real instances of it
> there is no previous filename to render. Whatever the drawer says for
> `omitted: null` with empty `hunks` must read correctly when `previousPath` is
> `null`. A rename is a *separate* case that this pull request happens not to contain.
>
> **Since settled against real data.** Four shapes #151 has none of were found by
> scanning 488 patches across `cli/cli`, `rust-lang/rust`, `microsoft/vscode` and
> `nodejs/node`, and are now a fixture (`src-tauri/fixtures/public-shapes.json`) with
> a test over the real parser:
>
> - **A rename** carries `previous_filename`, `changes: 0`, and **no `patch`**. So the
>   one state where a previous name exists is the same state that has nothing to draw
>   — which is the opposite of what this table originally assumed.
> - **`\ No newline at end of file`** sits *inside* the hunk, its own line, after the
>   line it belongs to. Never before the first `@@` in any of the ten real instances,
>   and never twice in one patch. That was the dangerous one: `split_hunks` discards
>   everything ahead of the first header, so a marker outside a hunk would have
>   vanished silently.
> - **`@@ -1 +1 @@`** is real, not theoretical.
> - **A submodule bump** is an ordinary hunk over one `Subproject commit` line and
>   needs no branch anywhere.
>
> Still **unverified**: CRLF — zero instances in 488 patches. The parser handles it
> deliberately anyway, after a defect was found where `str::lines()` silently stripped
> the trailing `\r` and would have broken the copied-patch guarantee the marker column
> exists to protect.

So the "too big to render" rule is not ours to invent. It is set upstream, signalled
for free by an absent JSON key, and our only job is to report it honestly.

### The counts can lie, and that is the discriminator

**Found late, and it invalidates the paragraph above twice over.** `tests/tasks.test.ts`
arrives in the 62-file response as `additions: 0, deletions: 0, changes: 0` with no
`patch`. Requested on a **three-file page**, the same file at the same commit comes
back with **163 additions, 3 deletions and a patch**.

GitHub zeroes the counts along with the text when the *response as a whole* hits a
budget. So `changes: 0` is not evidence that nothing changed, and both of #151's
"unchanged" files are this — not renames (the first correction), and not unchanged
either (the second).

The 5290-change file is genuinely different: fetched on a page of **one**, it still
has no patch and its count is still 5290. So:

| shape | meaning | does re-fetching help? |
|---|---|---|
| counts **kept**, no patch | really too large upstream | **No** — measured |
| counts **zeroed**, no patch | we were told nothing | **Yes** — a narrower page resolves it |

Three causes produce that second shape and one response cannot tell them apart: a
binary file, a mode-only change, and budget truncation. A rename is the one zeroed
case that explains itself, because the row names two paths.

Two consequences, both now implemented in `gh_pr.rs`:

1. **`Omission::Unreported`** exists as its own state. Reporting these as "nothing
   changed" would have had the drawer say exactly that about a file with 166 changes
   — the absent-`patch` failure arriving on a second axis, where it is not the patch
   that is missing but the counts lying about why.
2. **The re-fetch is one mechanism, not two.** A narrower page resolves `Unreported`
   *and* supplies the text for a locally-capped file. That settles the "Show anyway"
   contradiction below in favour of building a single narrow-window fetch, rather
   than an `uncapped_path` exemption that would only serve one of the two.

`gh api graphql` is already an established idiom here — `issue_totals_argv` in
`src-tauri/src/tasks/gh_issues.rs:150` builds argv as a pure function and
`parse_issue_totals` parses in a second, both unit-tested. `run_gh_for_workspace`
(`src-tauri/src/commands.rs:547`) already owns the token, the working directory and
the redaction, so `gh api` inherits all three unchanged.

---

## The three conflicts, resolved

### 1. Soft-wrap or horizontal scroll — **no wrap by default, with a toggle**

Two of the three reviews that touched it said no-wrap, and the decisive argument is
theirs: a wrapped `−` line and its `+` counterpart stop lining up, which is the one
thing a diff is for.

The visual review's objection to horizontal scroll was that a `position: sticky`
gutter under a translucent tint shows the scrolling text through it. **That objection
is dissolved by the visual review's own contrast decision** (§ *Line colouring*): the
gutter is deliberately untinted and keeps an opaque `--bg-app`, because `--fg-subtle`
numbers measure 4.16 and 4.29 on the tinted bands and fail AA. An opaque sticky
gutter has nothing to show through.

The toggle is cheap rather than architectural: flipping 2507 rows to `pre-wrap` was
measured at 42 ms of reflow, so with nothing virtualised it is one CSS class.

**Accessibility consequence that must not be dropped:** a scroll container is not
keyboard-operable unless it is focusable. Each file's scroll container needs
`tabindex="0"` and an accessible name, or a keyboard-only user cannot reach the
right-hand end of a long line (SC 2.1.1). Horizontal scroll belongs to the file
container only — the page must never scroll horizontally.

### 2. What happens at the narrow end — **collapse the list, never cover it**

The architecture review proposed the drawer becoming an overlay (`position:
absolute`, the `.bcast-panel` pattern at `src/styles.css:404`). The accessibility
review is right to refuse it, and has a criterion rather than a preference: a drawer
covering a list that is still focusable fails **SC 2.4.11 Focus Not Obscured** — you
tab back into the list and the focus ring sits behind the drawer. Making it safe
would need `inert` applied at the same instant from the same place, a synchronisation
that will eventually drift.

**So: squeeze until the list hits a `rem` floor, then `display: none` the list and
give the drawer the whole area.** Not `visibility`, not an overlay. In that collapsed
mode the drawer's Prev/Next buttons stop being a convenience and become the only way
to change file, which is why they are built from the start rather than added later.

### 3. Files with no diff — **stay enabled, the drawer explains**

The visual review wanted them unopenable (`aria-disabled`, no pointer). The
accessibility review is right: `disabled` removes the row from the tab order and
takes its own explanation with it — the mistake Task 18 of the typography plan
already corrected on `.pr-merge`, where a refusal reason lived in a `title`
unreachable by keyboard and by touch.

The row stays an ordinary button. The drawer says why there is nothing, and the
reason differs by cause because the escape hatch differs:

| Cause | What the drawer offers |
|---|---|
| Over **our** 2000-line cap | "Show anyway" **and** "Open on GitHub" — but see the contradiction below |
| Omitted **upstream** | "Open on GitHub" only — the bytes never arrived, and a button that fails is worse than no button |
| `unreported` — counts zeroed, no patch | "GitHub sent no diff for this file." Offer **Check again**: a narrower page resolves it. Names **no** counts, because the zeroed ones are the lie |
| `null` + empty hunks | Always a rename or a copy. Since `Omission::Unreported` landed, the parser cannot emit `null` for anything else — a zeroed row with no previous name is routed there instead, so this row no longer needs to hedge about `previousPath` |

**Two rules about the previous path that are easy to get backwards:**

- The file **header** shows `previousPath → path` whenever `previousPath` is set, and
  that is *independent* of whether there is a note. A rename **with** content changes
  has both a previous path and hunks; its note is `null` precisely because there are
  rows to draw and a sentence above them would contradict the diff.
- So a null note does **not** mean there is no previous path. Reading it that way
  hides the rename on exactly the files where the rename matters most.

> **"Show anyway" and "the cap is applied in Rust" contradict each other, and the
> implementation resolved it one way.** This table priced "Show anyway" at ~33 ms,
> which is a *render* cost and presumes the text is already on the client. *Data and
> IPC* says a file over the cap crosses "as metadata plus an omission reason, never as
> patch text". Both cannot hold.
>
> The Rust layer implements the second: the patch is dropped before serialisation,
> which is the whole reason the parse lives there. So **"Show anyway" is a second IPC
> round trip, and no command performs it yet.** The cheapest fix is an optional
> `uncapped_path: Option<String>` on `pr_diff` exempting one named file; it was
> deliberately not added, because it changes the IPC surface the frontend is being
> built against. Decide it when the drawer is built, and until then the honest
> affordance for a locally-capped file is "Open on GitHub" like the upstream case.
> `Omission::TooLargeLocal` carries the exact line count either way.

---

## The premise that did not survive measurement

The drawer was to be "a sibling that squeezes the list narrower rather than covering
it". Measured in headless Chromium against the real stylesheet at 1280×800:

| root font | `#sidebar` | `.pr-view` left over |
|---|---|---|
| 13px | 248.0px | 1017.0px |
| 14.95px (the shipped default) | 285.2px | 979.8px |
| **18.85px (the ceiling)** | **359.6px** | **905.4px** |

The sidebar's `clamp(19.0769rem, 18vw, 26.1538rem)` (`src/styles.css:169`) is won by
its `rem` floor out to a ~1998px window, so it holds 359.6px at the ceiling however
wide the screen. A realistic diff row — 4ch of line number, the marker, 80 columns of
code — is ~876px at the measured 10.19px/ch, ~900px with padding, against 905.4px of
total available width.

**At the top of the text-size scale the squeeze has nothing left to squeeze.** This
is what makes § *Conflict 2* a real design requirement rather than a nicety: the
collapse is reached by ordinary use of a control the app ships, not by an
unreasonable window.

---

## A bug to fix before the drawer, not with it

`PrView.render` opens with `this.mount.replaceChildren()` (`src/pr-view.ts:83`).
`refreshPrs` calls it on every poll tick (`src/main.ts:779`), and polling is gated on
`document.hasFocus()` (`src/main.ts:710`) — true precisely while someone is reading.
Every focused node is destroyed twice a minute and focus drops to `<body>`.

Today that costs one disclosure button, which is why nobody has noticed. With 62 file
rows navigated by arrow key it destroys the browse loop on a timer, and it makes any
"restore focus on close" written the `openDialog` way (`previouslyFocused?.focus?.()`,
`src/dialog-shell.ts:87`) a no-op against a detached node.

**Done — landed as `af3eebe`, before the rest of this design.** `render()` captures
the focused control's `data-fk` and the mount's `scrollTop` before `replaceChildren()`
and puts both back afterwards. Restoring by key rather than by node, because the node
itself no longer exists; every control that can hold focus now carries one.

Two limits, recorded rather than hidden:

- The scroll half **cannot be unit-tested here.** jsdom has no layout, so `scrollTop`
  is a stored number that `replaceChildren` leaves alone — measured, not assumed — and
  the test that exists would pass with the restore deleted. It is on the manual
  checklist.
- **A text selection still dies on every tick**, and no focus restore fixes that. The
  fix is the section below.

A second instance of the same class, found in passing: `hideBroadcastPanel`
(`src/sessions.ts:625`) applies `display: none` to a panel whose input still holds
focus. Worth its own card.

### And the drawer must mount outside `PrView` — this one is not optional

Fixing the focus restore is necessary but not sufficient. If the drawer's DOM lives
inside `prView.mount`, then every 15 seconds the reader also loses **scroll position**
in a document that can be 63,000px tall, loses **focus** if it was on a "Show anyway"
button, and loses any **text selection** mid-copy. No focus-restore fixes those.

So: the drawer is a **sibling of `prView.mount`, owned by `main.ts`** and keyed by
pull request number. `PrView` gains an `onOpenDiff(pr, path)` handler alongside the
existing `onDetail` (`src/pr-view.ts:37`), and the poll tick then re-renders rows
only.

Note this also kills windowed virtualisation a second time over, independently of the
timings below: a virtualiser inside the re-rendered subtree would lose its measurement
cache on every tick.

---

## The design

### Data and IPC

```rust
pub struct PrDiff  { pub files: Vec<DiffFile>, pub total_files: u64 }
pub struct DiffFile {
    pub path: String, pub previous_path: Option<String>, pub status: String,
    pub additions: u64, pub deletions: u64, pub blob_url: String,
    pub hunks: Vec<Hunk>,
    pub omitted: Option<Omission>,   // TooLargeUpstream | TooLargeLocal { lines }
}
pub struct Hunk { pub header: String, pub old_start: u64, pub new_start: u64,
                  pub lines: Vec<String> }   // leading '+', '-', ' ', '\' kept
```

Parsing lives in **Rust**, beside `parse_pr_detail` (`src-tauri/src/gh_pr.rs:240`),
for three reasons: the per-file cap must be applied before the payload crosses IPC,
so a patch the UI will refuse to draw is never serialised; the absent-`patch` case is
a JSON-shape fact, and it is exactly where that file's house rule "an absent field is
its empty value" (`gh_pr.rs:232-239`) is the *wrong* reflex — an absent patch is not
an empty diff; and `pr_files_argv` then gets tested the way `pr_detail_argv` already
is (`commands.rs:415`, test at `commands.rs:1749`).

**Rust must not emit one JSON object per diff line.** 20k objects of
`{kind, oldNo, newNo, text}` roughly doubles the payload against the raw text. Rust
does files and hunks; TypeScript turns a hunk's marker characters into classes and
running line numbers, as a pure function.

**One command, one response, the frontend keeps it. Rust stays stateless for diffs**,
exactly as `pr_detail` is today (`commands.rs:691-699` — fetch, parse, return, keep
nothing).

This reverses an earlier draft of this document, which had Rust cache the parsed
response and serve one file per IPC call. That was wrong, and the reason is the
measurement above: all 62 files arrive in **one** response, so per-file IPC would be
62 round trips slicing a single fetch, each taking an `AppState` mutex — and it would
need an eviction policy, a lifetime tied to `head_ref_oid` and workspace, and a
cache-miss path that is an error case existing *only* because of the optimisation.

What makes shipping the lot affordable is the cap being applied in Rust, which is the
real link back to the parsing decision: **files over the cap cross as metadata plus an
omission reason, never as patch text.** On a pathological pull request with ten
generated files the payload stays small instead of growing to 10 MB.

**On #151 itself the cap buys rows, not bytes**, and the earlier wording here
overstated it: measured through the real parser, the whole response serialises to
968 KB against 1.06 MB — about 9%. What the cap actually saves on this pull request
is the **2507 DOM rows** it stops the view building. The byte argument only carries
weight on the generated-file case. The frontend can be handed everything
precisely because Rust already threw away what the UI would refuse to draw. 0.8 MB of
strings in the JS heap is nothing beside the xterm buffers this app already carries,
and the `details` Map (`src/pr-view.ts:75`) already holds pull-request bodies on the
same principle.

If `AppState` ever does cache this, it should follow `gh_repos`
(`commands.rs:66-70`) — in memory only, never persisted, cleared when the binding
changes. It should not yet.

Follow the existing capped-page idiom (`PR_PAGE_LIMIT`, `commands.rs:390`, rendered
as "Showing the first N" at `pr-view.ts:131`): `PR_DIFF_FILE_LIMIT = 300` with
`totalFiles` returned, so a 900-file pull request says so rather than quietly
stopping.

### Rendering — plain synchronous, no virtualisation and no chunking

Measured against the real #151 patches with the real stylesheet, root at 18.85px (the
worst case for row height), in Chromium:

| | rows | build | layout | total |
|---|---|---|---|---|
| median file | 149 | 0.8 ms | 17 ms | **18 ms** |
| largest file (97 KB) | 2507 | 2–5 ms | 27–36 ms | **30–38 ms** |
| all 62 at once | 19,854 | 21 ms | 225 ms | **246 ms** |

Opening the worst single file in the motivating pull request costs ~33 ms — two
frames, on a click. Chunking exists to break up work that blows a frame budget by an
order of magnitude; this does not qualify. **Caveat, stated because it is the one
thing that could overturn this:** measured in Chromium via Playwright. Tauri on Linux
is WebKitGTK, which was **not** measured and is plausibly 2–3× slower. At 3× the
largest file is still ~100 ms. Re-measure on WebKitGTK before treating the "no
chunking" decision as settled.

Consequently:

- The drawer draws 62 collapsed file rows, using the disclosure pattern already at
  `pr-view.ts:266-272`.
- Opening a file builds its rows into a `DocumentFragment` and appends synchronously.
  No rAF queue, no cancellation, no scheduler to test.
- Auto-open files from the top until ~500 lines are spent, so a two-file pull request
  opens fully and a 62-file one opens as an index.
- No "expand all" — that is the 246 ms case and nothing needs it.
- No DOM eviction. Reaching 19,854 rows takes 62 deliberate clicks.
- Local cap at **2000 lines** per file. On #151 that bites exactly one file (2507);
  six are over 1000 and eleven over 500, so it is sensitive enough to matter and rare
  enough not to nag. No lockfile or generated-code heuristics — the line cap catches
  them anyway, and a `*.lock` rule would immediately lie about the 2507-line Markdown
  plan that tripped it here.

### Layout, width and persistence

`.pr-view` becomes a flex **row**: `.pr-list` (`flex: 1; min-width: 0; overflow:
auto`) then `.pr-drawer`, in that DOM order so reading order matches visual order
(SC 1.3.2). Today's `overflow`/`padding` on `.pr-view` (`src/styles.css:1032`) move
down to `.pr-list`.

Width is **user-resizable, measured in `ch`, persisted**. Not px: `ui-scale.ts` moves
the root between 11.05px and 18.85px, so a px-width diff pane shows *fewer* code
columns at 145% — the exact regression the sidebar's `rem` clamp was written to kill.
Not percent: 40% of 1970px and 40% of 900px are different column counts, and "does
this line fit" is the only question a diff pane answers. `ch` because 1ch is the mono
face's real advance, the reasoning already written at `src/styles.css:1148-1151`.
Floor ~`40ch`; below that the marker and two number columns crowd out the code.

Persist as `prDiffCols: u32` on `UiState` with `#[serde(default = "…")]` — and note
that `src-tauri/src/model.rs:333-340` documents precisely why a non-`Option` without
a default silently blanks the file through `unwrap_or_default()`. `save_ui_state` is
already a merge with a regression test for exactly this clobbering
(`src-tauri/src/store.rs:346-360`). Write on `pointerup`, never during the drag.

The resize handle is an interactive control, so **1.4.11 applies to it for real**,
unlike the surface seams below. Measured: `--border-strong` grip on `--bg-panel` is
**1.62** and fails; `--fg-subtle` is **5.00**; `--accent` on hover/focus is **7.07**.
Draw the grip in `--fg-subtle`. It must be keyboard-operable — `role="separator"`,
`aria-orientation="vertical"`, `aria-valuenow` in `ch`, arrow keys — or the width
becomes a mouse-only setting. Hit area ≥24px per the rule `.pr-toggle` documents at
`src/styles.css:1067-1073`, even if it draws as 1px.

### Colour, and the honest state of the seams

Two new tokens, both `rgba()` literals of hues already in `:root` — the
`--accent-weak` idiom at `src/styles.css:34`. Literal `rgba()` rather than
`color-mix()` because `contrast.mjs`'s `parseColor` cannot read `color-mix()`, and a
colour the script cannot parse is a colour nobody can check.

```css
--diff-add-weak: rgba(152, 195, 121, 0.13);
--diff-del-weak: rgba(231, 143, 150, 0.13);
```

Derived from `--st-working`/`--st-error` rather than given their own hue, because
`.pr-detail-plus`/`.pr-detail-minus` already mean added/removed with those tokens in
this same view (`styles.css:1178-1179`) and that list is the drawer's navigation.
0.13 is deliberately low: the tint sits *under* code, so every point of alpha is
contrast taken off `--fg`, and 0.22 costs two full points while moving the two bands
0.03 further apart.

All measured through a verbatim copy of `scripts/contrast.mjs`, with two control
cases that reproduce `npm run contrast` exactly (`.state-error on panel` 6.12,
`closed row meta` 5.00):

| Line kind | Background | Text | Ratio | Need |
|---|---|---|---|---|
| context | `--bg-app` `#16181d` | `--fg-muted` | **8.33** | 4.5 |
| added | `#272e29` | `--fg` | **11.13** | 4.5 |
| removed | `#31272d` | `--fg` | **11.48** | 4.5 |
| `+` marker | `#272e29` | `--st-working` | **6.89** | 4.5 |
| `−` marker | `#31272d` | `--st-error` | **5.98** | 4.5 |
| hunk header | `--bg-raised` `#21252b` | `--fg-muted` | **7.22** | 4.5 |
| line numbers, untinted gutter | `--bg-app` | `--fg-subtle` | **5.31** | 4.5 |

Rejected, and worth keeping as permanent documentation: `--fg-subtle` on the added
band is **4.16** and on the removed band **4.29** — both fail. That is what makes the
gutter untinted. `--fg-subtle` on the open-file row measures **3.57** and fails, which
is why the whole file list uses `--fg-muted` (7.22 at rest, 5.60 selected).

**Added and removed cannot be told apart by tint** — the two bands measure **1.30**
against each other where 1.4.11 asks 3.0. Colour is doing essentially nothing, and no
alpha rescues it at a price worth paying. Two independent consequences:

1. The `+`/`−` marker is a **real text node in its own grid column**, produced by
   slicing the leading character off the patch line — relocated, not duplicated, so a
   copied selection still reassembles into a valid patch. Not `::before`, not a
   background image.
2. `src/styles.css` has **no `forced-colors` block at all** (verified: zero
   occurrences). Under Windows high contrast every tint collapses to a system colour
   and the two bands become identical. The literal character is the only
   differentiator that survives.

A third channel falls out free: changed lines are `--fg` and context is `--fg-muted`,
so changed is brighter than unchanged without reference to hue.

**The surface seams do not reach 1.4.11 and this document does not claim they do.**
Measured: drawer `--bg-panel` beside list `--bg-app` is **1.06**; `--border` on that
seam **1.36**; `--border-strong` **1.73**; the `--bg-raised` hunk band on `--bg-app`
**1.15**. None reaches 3.0. This is not new debt — it is the app's existing surface
palette, which `contrast.mjs` already records as out of scope at
`scripts/contrast.mjs:189-203`. Match the existing level; do not invent a brighter
border here that the rest of the app does not have.

Mirror `#sidebar` (`styles.css:156`) — `--bg-panel` with a `border-left` — rather
than `.bcast-panel`. A squeezing edge column is not an overlay, and a shadow would
assert an elevation it does not have. No backdrop, no `z-index`.

### Line numbers and grid

Two columns, old and new: one column cannot answer "what line is this now" for a
removed line. Alignment lives on the container, never on cell widths:

```css
.diff { display: grid; grid-template-columns: max-content max-content max-content 1fr; }
```

Old number, new number, marker, content. `max-content` re-measures at every step of
`SCALE_STEPS` and at every digit count — this is the part that satisfies "must work
at 11.05px and at 18.85px". A `ch`-width gutter would be correct at one size only.

Both number cells take `user-select: none` and `aria-hidden="true"`, as real elements
rather than `::before` + `attr()`: generated content's copy behaviour differs across
engines and some screen readers announce it.

### Keyboard, focus and announcement

- **Non-modal, `role="region"` with an `aria-label`** naming the file. Not
  `aria-modal`: it hides the list from the accessibility tree, which is the opposite
  of what someone comparing a path against a diff needs. Not `complementary`: the
  detail half of a master–detail is not meaningful when separated. Not
  `tab`/`tabpanel`: `expanded` is a `Set` (`pr-view.ts:63-67`) so several rows can be
  open, giving several tablists pointing at one panel.
- **Do not reuse `dialog-shell.ts`.** `src/main.ts:1097` reads
  `if (document.querySelector(".modal-overlay")) return;`, and
  `src/dialog-shell.ts:34` gives every dialog that class — so a drawer built on it
  would disable Cmd+K, F6 and the view switch while open. Decisive.
- **Focus does not move on open.** The loop is 62 files; moving focus into the drawer
  costs a Shift+Tab per file. On close, focus returns to the row for the file that
  was showing.
- **File rows become buttons with a roving tabindex** — one tab stop,
  Arrow/Home/End inside, Enter/Space to load. 62 tab stops is unusable. Activation is
  manual, never on arrow: each file is an IPC round trip.
- **Escape is bound on `.pr-view`, in the bubble phase — not on the drawer subtree.**
  Subtree scoping is a trap precisely because focus deliberately stays in the list,
  so the list would be the one place the key does nothing. Start the handler with
  `if (e.defaultPrevented) return;`: `openDialog` calls `preventDefault()` but never
  `stopPropagation()` (`dialog-shell.ts:52-54, 81`), so a modal's Escape would
  otherwise also close the drawer behind it. Do **not** bind on `document` in
  capture — that would fire ahead of xterm, which legitimately consumes Escape and
  sends it to the PTY.
- **F6 must reach the drawer.** `REGIONS` is `["sidebar", "screen"]`
  (`src/main.ts:1042`) and `currentRegion()` decides by `sidebar.contains(...)`
  (`main.ts:1049`), so focus inside the drawer reads as `"screen"` and F6 sends you
  to the sidebar. Add a `"drawer"` region while the drawer is open. This extends
  Task 25 of the typography plan rather than contradicting it.
- **One `aria-live="polite"` region** inside `.pr-view` — the idiom exists at
  `src/forms.ts:283`. Because focus deliberately does not move, this is the *only*
  feedback a screen-reader user gets; drop it and the feature is silent. On open and
  on every file change: "Diff for src/pr-view.ts, file 3 of 62. 24 added, 7 removed.
  5 hunks."
- **Per-hunk `<h4>` headings** reading "Hunk 2 of 5, lines 12 to 18" — the parsed
  `@@` header as a sentence, never the raw `@@ -12,7 +12,9 @@`. This is what makes the
  reader's heading key the way to move through a long diff. `<h4>` because the screen
  title is `<h3>` (`pr-view.ts:86`).
- **A visually-hidden word per line** — "Added"/"Removed"/nothing before the code, so
  the reader says "Added, const x = 1". This is why the diff is not one giant
  `<pre>`: the per-line prefix would have nowhere to live.

### Lifecycle

- **Entry: the file row.** Not a button on the PR row — `.pr-actions` already holds
  ▶ / Merge / Close / Open in browser, and Merge is the highest-stakes button in the
  app with a hand-built refusal contract (`pr-view.ts:300-306`); a fifth control
  there buys a misclick on it. "Diff" with no file chosen would also have to guess,
  and file 1 of 62 is rarely the one wanted.
- **Screen switch: nothing.** Inside `prEl` it hides with `#pr.hidden` and returns as
  it was, matching `expanded`, which already survives a switch for the same reason.
- **Workspace switch: close and drop.** `main.ts:943` already re-reads the list on
  switch because the pull requests on screen belong to the workspace that was active
  a moment ago; a diff of #151 beside another workspace's list is that error one
  level down.
- **Head moved while open: do not swap content.** Keep what is on screen and show a
  bar — "The branch moved on since this diff was read — Reload". This diverges from
  the detail panel's auto-refetch (`pr-view.ts:70-75, 170-172`) and the comment must
  say so. Swapping 2000 lines under a reader who has scrolled into them is worse than
  staleness.
- **Prev/Next must not skip the no-patch files.** File 41 of 62 having nothing to show
  is information.

### Syntax highlighting — no

A theme is ~10 token colours and each needs measuring against **three** line
backgrounds (`#16181d`, `#272e29`, `#31272d`) — about thirty new cases in
`contrast.mjs`, and the comment and string colours of every popular dark theme land
in the 3s on a dark ground. That is re-authoring a theme, not installing one. Hue is
also already spent on the added/removed channel.

Legibility is carried instead by `--font-mono` at `--fs-sm` with `--lh-code` 1.55
(`styles.css:90`), the marker column, the two bands, the changed-vs-context
brightness split, and the `--bg-raised` hunk band segmenting the file.

If one thing is added later, make it **character-level intra-line highlighting** — a
stronger tint on the changed span within a line. That recovers most of what unified
loses to split, and costs a diff algorithm rather than a dependency.

---

## What is testable, and what goes on the manual list

**Rust, beside their neighbours in `gh_pr.rs`:** `parse_pr_files`, `split_hunks`,
`pr_files_argv`, `cap_file`.

**TypeScript, vitest + jsdom** — structure and attributes, not geometry:
`classifyHunk` (marker → `add | del | ctx` plus running old/new numbers; this is
where off-by-ones live), `filesToAutoOpen`, `diffCacheNext` as a reducer rather than
entangled with rendering the way `fetchIfStale` currently is.

**Not testable in jsdom** — verified in this repo's jsdom 29.1.1:
`getBoundingClientRect()` returns zeros, `scrollHeight`/`offsetHeight` are 0,
`IntersectionObserver` and `ResizeObserver` are `undefined`. So the manual checklist
(idiom at `pr-view.ts:317`, list in `docs/pr-view-manual-check.md`) gains: that the
file container scrolls horizontally and the page does not; that the largest file
opens without a perceptible hitch **on WebKitGTK**; sticky file headers; scroll
position surviving the reload bar; and the collapse threshold at all five steps of
the text-size control.

## Before merge

None of the contrast cases above are *in* `scripts/contrast.mjs` — they were run
through a copy of it. Add them as real `CASES`, including the rejected rows (4.16,
4.29, 3.57) as permanently-failing documentation of why the gutter is untinted and
why `--fg-subtle` never touches a selected row — the job `assertNoRule` already does
at `scripts/contrast.mjs:84-91`. Otherwise the next palette edit moves them silently,
which is the failure mode that file exists to prevent.
