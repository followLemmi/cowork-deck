# Zoom/juggle tiles (#5)

Date: 2026-07-24
Issue: #5 — double-click a tile header to expand one terminal near-full while the
others shrink to a bottom filmstrip; click a shrunken tile to juggle; animated.

## Problem

The deck is a flat CSS `auto-fit` grid (`#deck`, `src/styles.css:97-101`) where every
tile gets roughly equal space. When one session matters right now, the user wants to
enlarge it and push the rest aside without closing them — and "juggle" which tile is
large. No such focus/zoom mode exists today.

## Constraints (from the issue + ADR-008)

- Animate **only `transform`/`opacity`**, GPU-composited. No `box-shadow`/`filter`/layout
  animation on a continuous basis (ADR-008: an infinite box-shadow animation previously
  lagged the whole app via WebKit repaints). A one-shot morph is fine.
- CSS grid track changes are **not** transform-animatable, and `auto-fit` produces a
  variable track count that can't interpolate to a fixed zoom layout — so the animation
  uses **FLIP** (First-Last-Invert-Play) transforms, not grid-template transitions.
- xterm terminals must `fit()`/reflow to their final size after the morph, with **no
  resize feedback loop**.
- Zoom operates only over the **active workspace's visible tiles** (post-#7, other
  workspaces' tiles carry `.ws-hidden` and must stay hidden and out of the strip).

## Approach — FLIP morph + bottom filmstrip

New `Deck` state: `zoomedSession: string | null`.

### Layout (`applyLayout()`)

A single method arranges the DOM from `zoomedSession`:

- **Grid mode** (`zoomedSession === null`): today's behavior — all visible tiles are
  direct children of `#deck` in `this.tiles` (Map) order; no `.deck-strip`; `#deck` has
  no `.is-zoomed`.
- **Zoom mode**: `#deck` gets `.is-zoomed`. The zoomed tile is a direct child occupying
  the main row. A `.deck-strip` flex container (created lazily, row 2) holds the *other*
  visible tiles as `.tile.minimized` thumbnails, in Map order. Re-parenting a tile's
  element into/out of `.deck-strip` preserves its xterm instance (the element is moved,
  never destroyed/recreated).

`ws-hidden` tiles are never moved and never enter the strip.

CSS:
```css
#deck.is-zoomed { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
#deck.is-zoomed > .tile:not(.deck-strip) { grid-row: 1; grid-column: 1; } /* the zoomed tile */
.deck-strip { grid-row: 2; grid-column: 1; display: flex; gap: var(--sp-2); overflow-x: auto; max-height: 130px; }
.deck-strip .tile.minimized { flex: 0 0 220px; min-height: 0; height: 118px; cursor: pointer; }
```
(Exact selectors finalized in the plan; the zoomed tile is targeted by a `.zoomed` class
rather than `:not(.deck-strip)` to avoid ambiguity.)

### FLIP animation

Used for every layout change (grid→zoom, zoom→grid, juggle zoom→zoom):

1. **First** — record `getBoundingClientRect()` for each visible tile.
2. **Last** — call `applyLayout()` (adds/removes `.is-zoomed`, re-parents tiles); force a
   reflow; read new rects.
3. **Invert** — for each tile compute the delta and set
   `transform: translate(dx,dy) scale(sx,sy)` with `transition: none`, so it visually sits
   where it was.
4. **Play** — on the next animation frame, set `transform: ''` with
   `transition: transform 180ms var(--ease)`; the tile animates to its real position.
5. On `transitionend` (with a timeout fallback), clear inline `transform`/`transition`,
   and call `panel.fit()` on every participating tile.

Only `transform` animates. Because transform does not change an element's layout box,
`TerminalPanel`'s `ResizeObserver` fires once at the Last step (fitting each terminal to
its final size immediately) and is **not** retriggered by the animating transform — so
there is no resize feedback loop. The `transitionend` `fit()` is a safety net.

### Pure helper (`src/flip.ts`, unit-tested)

```ts
export interface Rect { left: number; top: number; width: number; height: number; }
export interface FlipTransform { dx: number; dy: number; sx: number; sy: number; }
/** Inverse transform that visually maps `last` back onto `first`. */
export function flipTransform(first: Rect, last: Rect): FlipTransform;
```
`dx = first.left - last.left`, `dy = first.top - last.top`,
`sx = first.width / last.width`, `sy = first.height / last.height`
(guarded so a zero `last` dimension yields `sx/sy = 1`, not `Infinity`).

`zoomParticipants(tiles, zoomedSession)` returns `{ zoomed, minimized }` session-id lists
over the visible (non-`ws-hidden`) tiles — also pure/unit-tested.

## Interaction

- **Double-click a tile header** (`.tile-head` `dblclick`) → `toggleZoom(session)`:
  if not zoomed, zoom that session; if that session is already the zoomed one, exit zoom.
- **Single-click a minimized thumbnail** → `zoomTo(session)` (juggle: it becomes zoomed,
  the previous zoomed tile drops into the strip). The click also focuses the session.
- **Esc** (when `zoomedSession != null` and no modal/palette/search is open) → exit zoom.
  Wired into the existing `keydown` handler in `main.ts`, guarded by the same
  `.modal-overlay` check already used there.

Double-click must not be swallowed by the existing single-click `mousedown → focusTile`
on the tile; `focusTile` on the first click is harmless (the header dblclick still fires).

## Edge-case decisions

1. **Switching workspace exits zoom** — `setActiveWorkspace` resets `zoomedSession` to
   `null` and applies grid layout (the zoomed tile may belong to the now-hidden set).
2. **Closing the zoomed tile exits zoom** — `remove()` clears `zoomedSession` when it
   removes the zoomed session, then applies grid layout.
3. **Launching a new session exits zoom** — `spawnTile` (non-restore path) resets to grid
   so the new tile is visible.
4. **≤1 visible tile → zoom is a no-op** — nothing to shrink; the single tile already
   fills the deck.
5. **Zoom state is transient** — not persisted; startup always restores into grid mode.

## Testing

- **TS unit** (`tests/flip.test.ts`): `flipTransform` (translate + scale math; zero-size
  guard); `zoomParticipants` (excludes `ws-hidden`, splits zoomed vs minimized, empty/one
  tile).
- **Manual acceptance** (live GUI): double-click header zooms with a smooth morph; strip
  shows the others; click a thumbnail juggles; double-click zoomed header and Esc both
  exit; terminals stay legible/refit after each morph (no drift beyond pre-existing #4);
  switching workspace / closing the zoomed tile / launching a new session all return to
  grid; a single-tile deck does not zoom.

## Out of scope

- Persisting zoom across restarts.
- Keyboard cycling within the strip (arrow keys) — Esc + click are enough for v1.
- Fixing terminal layout drift in the thumbnails — that is issue #4.
- Multi-tile zoom (more than one enlarged at once).
