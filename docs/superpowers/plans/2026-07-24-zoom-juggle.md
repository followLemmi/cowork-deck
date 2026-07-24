# Zoom/juggle tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-click a tile header to expand that terminal near-full while the other visible tiles shrink into a bottom filmstrip, with a GPU-composited FLIP morph; single-click a thumbnail to juggle; Esc/double-click to exit.

**Architecture:** New `Deck.zoomedSession` state drives `applyLayout()`, which re-parents non-zoomed visible tiles into a `.deck-strip` flex container (element moves preserve xterm). Every layout change is animated with FLIP (First-Last-Invert-Play) using `transform` only. Pure FLIP math + participant selection live in `src/flip.ts`.

**Tech Stack:** TypeScript + Vite + Vitest (jsdom); xterm terminals with a self-fitting `ResizeObserver`. Tests: `npm test`, typecheck `npx tsc --noEmit`.

## Global Constraints

- Animate **only `transform`/`opacity`**, GPU-composited (ADR-008: no continuous `box-shadow`/`filter`/layout animation). Transition duration `180ms var(--ease)`.
- Do **not** animate CSS grid tracks — use FLIP transforms.
- Zoom participates only over the **active workspace's visible tiles** — never `.ws-hidden` ones; those stay hidden and out of the strip.
- After a morph, terminals must `fit()` to final size; transform does not change the layout box, so no resize feedback loop is introduced.
- Reuse existing CSS custom properties (`--sp-2`, `--ease`, `--border`, `--bg-panel`, etc.). No new UI copy.
- Zoom state is transient (never persisted). Startup is always grid mode.
- Commit after each task passes its tests.

---

### Task 1: Pure FLIP helpers (`src/flip.ts`)

**Files:**
- Create: `src/flip.ts`
- Create: `tests/flip.test.ts`

**Interfaces:**
- Produces:
  - `interface Rect { left: number; top: number; width: number; height: number; }`
  - `interface FlipTransform { dx: number; dy: number; sx: number; sy: number; }`
  - `flipTransform(first: Rect, last: Rect): FlipTransform`
  - `interface ZoomParts { zoomed: string | null; minimized: string[]; }`
  - `zoomParticipants(tiles: { session: string; hidden: boolean }[], zoomedSession: string | null): ZoomParts`

- [ ] **Step 1: Write the failing tests**

Create `tests/flip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { flipTransform, zoomParticipants } from "../src/flip";

describe("flipTransform", () => {
  it("computes translate + scale from last back onto first", () => {
    const first = { left: 0, top: 0, width: 200, height: 100 };
    const last = { left: 50, top: 20, width: 400, height: 300 };
    expect(flipTransform(first, last)).toEqual({ dx: -50, dy: -20, sx: 0.5, sy: 100 / 300 });
  });
  it("is identity when rects match", () => {
    const r = { left: 10, top: 10, width: 100, height: 100 };
    expect(flipTransform(r, { ...r })).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });
  it("guards against a zero last dimension (no Infinity)", () => {
    const first = { left: 0, top: 0, width: 100, height: 100 };
    const last = { left: 0, top: 0, width: 0, height: 0 };
    expect(flipTransform(first, last)).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });
});

describe("zoomParticipants", () => {
  const t = (session: string, hidden = false) => ({ session, hidden });
  it("returns no zoom when zoomedSession is null", () => {
    expect(zoomParticipants([t("a"), t("b")], null)).toEqual({ zoomed: null, minimized: [] });
  });
  it("splits zoomed vs minimized over visible tiles, preserving order", () => {
    expect(zoomParticipants([t("a"), t("b"), t("c")], "b"))
      .toEqual({ zoomed: "b", minimized: ["a", "c"] });
  });
  it("excludes ws-hidden tiles from the strip", () => {
    expect(zoomParticipants([t("a"), t("b", true), t("c")], "a"))
      .toEqual({ zoomed: "a", minimized: ["c"] });
  });
  it("is a no-op (zoomed null) when 1 or fewer visible tiles", () => {
    expect(zoomParticipants([t("a"), t("b", true)], "a")).toEqual({ zoomed: null, minimized: [] });
  });
  it("is a no-op when the zoomed session is hidden or unknown", () => {
    expect(zoomParticipants([t("a"), t("b")], "b-hidden")).toEqual({ zoomed: null, minimized: [] });
    expect(zoomParticipants([t("a"), t("b", true)], "b")).toEqual({ zoomed: null, minimized: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/flip.test.ts`
Expected: FAIL — cannot resolve `../src/flip`.

- [ ] **Step 3: Implement `src/flip.ts`**

```ts
export interface Rect { left: number; top: number; width: number; height: number; }
export interface FlipTransform { dx: number; dy: number; sx: number; sy: number; }

/** Inverse transform that visually maps `last` back onto `first` (FLIP invert step). */
export function flipTransform(first: Rect, last: Rect): FlipTransform {
  return {
    dx: first.left - last.left,
    dy: first.top - last.top,
    sx: last.width === 0 ? 1 : first.width / last.width,
    sy: last.height === 0 ? 1 : first.height / last.height,
  };
}

export interface ZoomParts { zoomed: string | null; minimized: string[]; }

/**
 * Decide the zoom layout over the visible (non-hidden) tiles.
 * Returns `zoomed: null` (grid mode / no-op) when there is no valid zoom target:
 * zoomedSession is null, not visible, or there are 1 or fewer visible tiles.
 */
export function zoomParticipants(
  tiles: { session: string; hidden: boolean }[],
  zoomedSession: string | null,
): ZoomParts {
  const visible = tiles.filter((t) => !t.hidden).map((t) => t.session);
  if (zoomedSession === null || !visible.includes(zoomedSession) || visible.length <= 1) {
    return { zoomed: null, minimized: [] };
  }
  return { zoomed: zoomedSession, minimized: visible.filter((s) => s !== zoomedSession) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/flip.test.ts` then `npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/flip.ts tests/flip.test.ts
git commit -m "feat(#5): pure FLIP transform + zoom-participant helpers"
```

---

### Task 2: Zoom layout + interactions (no animation yet)

**Files:**
- Modify: `src/sessions.ts` (Deck: `zoomedSession`/`strip` fields, `applyLayout`, `zoomTo`, `toggleZoom`, `exitZoom`, header dblclick + minimized-click wiring)
- Modify: `src/styles.css` (`.is-zoomed`, `.deck-strip`, `.tile.minimized`, `.tile.zoomed`)

**Interfaces:**
- Consumes: `zoomParticipants` from `./flip`.
- Produces: `Deck.zoomTo(session: string | null)`, `Deck.toggleZoom(session: string)`, `Deck.exitZoom(): boolean`, `Deck.applyLayout()` (private). Layout switches instantly here; Task 3 adds the morph.

- [ ] **Step 1: Add the import and fields**

In `src/sessions.ts`, add to the top imports:
```ts
import { zoomParticipants } from "./flip";
```
Add to the `Deck` class fields (next to the other privates):
```ts
  private zoomedSession: string | null = null;
  private strip: HTMLElement | null = null;
```

- [ ] **Step 2: Add `applyLayout`**

Add this private method to `Deck`:

```ts
  private applyLayout() {
    const parts = zoomParticipants(
      [...this.tiles.values()].map((t) => ({
        session: t.session, hidden: t.el.classList.contains("ws-hidden"),
      })),
      this.zoomedSession,
    );
    if (parts.zoomed === null) {
      // Grid mode: return every tile to #deck in Map order, drop the strip.
      this.zoomedSession = null;
      this.deckEl.classList.remove("is-zoomed");
      for (const t of this.tiles.values()) {
        t.el.classList.remove("minimized", "zoomed");
        this.deckEl.appendChild(t.el);
      }
      if (this.strip) { this.strip.remove(); this.strip = null; }
      return;
    }
    this.deckEl.classList.add("is-zoomed");
    if (!this.strip) {
      this.strip = document.createElement("div");
      this.strip.className = "deck-strip";
    }
    const z = this.tiles.get(parts.zoomed)!;
    z.el.classList.add("zoomed");
    z.el.classList.remove("minimized");
    this.deckEl.appendChild(z.el);
    this.deckEl.appendChild(this.strip);
    for (const s of parts.minimized) {
      const t = this.tiles.get(s)!;
      t.el.classList.add("minimized");
      t.el.classList.remove("zoomed");
      this.strip.appendChild(t.el);
    }
  }
```

- [ ] **Step 3: Add `zoomTo` / `toggleZoom` / `exitZoom`**

Add these public methods to `Deck`:

```ts
  zoomTo(session: string | null) {
    if (session !== null) {
      const parts = zoomParticipants(
        [...this.tiles.values()].map((t) => ({
          session: t.session, hidden: t.el.classList.contains("ws-hidden"),
        })),
        session,
      );
      if (parts.zoomed === null) return; // nothing to zoom (≤1 visible / not visible)
    }
    if (this.zoomedSession === session) return;
    this.zoomedSession = session;
    this.applyLayout();
  }

  toggleZoom(session: string) {
    this.zoomTo(this.zoomedSession === session ? null : session);
  }

  exitZoom(): boolean {
    if (this.zoomedSession === null) return false;
    this.zoomTo(null);
    return true;
  }
```

- [ ] **Step 4: Wire header double-click and minimized-tile juggle-click**

In `spawnTile`, after `head` is assembled and the `el.addEventListener("mousedown", ...)` line exists, add a double-click handler on the header:
```ts
    head.addEventListener("dblclick", () => this.toggleZoom(session));
```
Change the existing tile mousedown handler from:
```ts
    el.addEventListener("mousedown", () => this.focusTile(session));
```
to also juggle when a *minimized* thumbnail is clicked while zoomed:
```ts
    el.addEventListener("mousedown", () => {
      this.focusTile(session);
      // Clicking a shrunken thumbnail while zoomed juggles it to the main area.
      if (this.zoomedSession !== null && this.zoomedSession !== session
          && !tile.el.classList.contains("ws-hidden")) {
        this.zoomTo(session);
      }
    });
```
(`tile` is the `Tile` created later in `spawnTile`; the handler closes over it, consistent with the existing restart/search closures.)

- [ ] **Step 5: Add CSS**

In `src/styles.css`, after the `#deck.has-active` rule (~line 119), add:

```css
#deck.is-zoomed { grid-template-columns: 1fr; grid-template-rows: 1fr auto; overflow: hidden; }
#deck.is-zoomed > .tile.zoomed { grid-row: 1; grid-column: 1; min-height: 0; }
.deck-strip { grid-row: 2; grid-column: 1; display: flex; gap: var(--sp-2); overflow-x: auto; overflow-y: hidden; max-height: 132px; padding-top: var(--sp-2); }
.deck-strip .tile.minimized { flex: 0 0 220px; min-height: 0; height: 118px; cursor: pointer; }
.deck-strip .tile.minimized .tile-body { padding: 4px; }
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (existing suite green; no new unit test — logic is in the Task 1 helpers).

- [ ] **Step 7: Manual smoke check**

Run the dev app with ≥2 sessions in one workspace. Double-click a tile header → it fills the deck, others drop to a bottom strip (instant, no animation yet). Click a thumbnail → it becomes the big one (juggle). Double-click the big tile's header → back to grid. With a single session, double-click does nothing.

- [ ] **Step 8: Commit**

```bash
git add src/sessions.ts src/styles.css
git commit -m "feat(#5): zoom layout + juggle interactions (instant, pre-animation)"
```

---

### Task 3: FLIP morph animation

**Files:**
- Modify: `src/sessions.ts` (add `animateLayoutChange`; route `zoomTo` through it)
- Modify: `src/flip.ts` (no change) — import `flipTransform`

**Interfaces:**
- Consumes: `flipTransform` from `./flip`.
- Produces: `Deck.animateLayoutChange(mutate: () => void)` (private) — FLIP-animates all visible tiles across a layout mutation and refits terminals afterward.

- [ ] **Step 1: Extend the flip import**

In `src/sessions.ts`, change the flip import to also bring in `flipTransform`:
```ts
import { zoomParticipants, flipTransform } from "./flip";
```

- [ ] **Step 2: Add `animateLayoutChange`**

Add this private method to `Deck`:

```ts
  // FLIP: measure visible tiles (First), run the layout mutation (Last),
  // set the inverse transform, then animate it away. transform-only, so the
  // ResizeObserver (which fits terminals to the already-final layout box) is
  // not retriggered — no resize feedback loop.
  private animateLayoutChange(mutate: () => void) {
    const before = [...this.tiles.values()].filter((t) => !t.el.classList.contains("ws-hidden"));
    const first = new Map(before.map((t) => [t.session, t.el.getBoundingClientRect()]));
    mutate();
    const after = [...this.tiles.values()].filter((t) => !t.el.classList.contains("ws-hidden"));
    const animating: Tile[] = [];
    for (const t of after) {
      const f = first.get(t.session);
      if (!f) continue;
      const last = t.el.getBoundingClientRect();
      const { dx, dy, sx, sy } = flipTransform(f, last);
      if (dx === 0 && dy === 0 && sx === 1 && sy === 1) continue;
      t.el.style.transformOrigin = "top left";
      t.el.style.transition = "none";
      t.el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      animating.push(t);
    }
    requestAnimationFrame(() => {
      for (const t of animating) {
        t.el.style.transition = "transform 180ms var(--ease)";
        t.el.style.transform = "";
      }
    });
    // Authoritative cleanup + refit after the morph (covers no-transition cases).
    setTimeout(() => {
      for (const t of after) {
        t.el.style.transition = "";
        t.el.style.transform = "";
        t.el.style.transformOrigin = "";
        t.panel.fit();
      }
    }, 220);
  }
```

- [ ] **Step 3: Route `zoomTo` through the animation**

In `zoomTo`, replace the direct mutation:
```ts
    if (this.zoomedSession === session) return;
    this.zoomedSession = session;
    this.applyLayout();
```
with:
```ts
    if (this.zoomedSession === session) return;
    this.animateLayoutChange(() => { this.zoomedSession = session; this.applyLayout(); });
```

- [ ] **Step 4: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (no new unit test; the FLIP math is covered by `tests/flip.test.ts`).

- [ ] **Step 5: Manual smoke check**

Dev app, ≥2 sessions. Zoom / juggle / exit now animate with a smooth ~180ms expand/shrink morph. Terminal text briefly scales during the morph then snaps crisp. No stutter, no lingering transforms. Rapidly juggling several times leaves the layout correct (the 220ms cleanup resets any interrupted transform).

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts
git commit -m "feat(#5): FLIP morph animation for zoom/juggle transitions"
```

---

### Task 4: Edge-case integration (exit zoom on workspace switch / close / new session; Esc)

**Files:**
- Modify: `src/sessions.ts` (`setActiveWorkspace`, `remove`, `spawnTile` reset zoom; use `applyLayout` where appropriate)
- Modify: `src/main.ts` (Esc → `deck.exitZoom()`)

**Interfaces:**
- Consumes: `Deck.applyLayout` (private), `Deck.exitZoom()` (public).
- Produces: zoom is reset to grid on workspace switch, on closing the zoomed tile, and on launching a new session; Esc exits zoom.

- [ ] **Step 1: Exit zoom when switching workspace**

In `setActiveWorkspace`, reset zoom before/while applying visibility so the deck returns to grid (the zoomed tile may belong to the now-hidden set). At the top of the method add:
```ts
    this.zoomedSession = null;
```
and after the visibility loop (before or right after the focus/renderList logic) ensure grid layout is applied:
```ts
    this.applyLayout();
```
(Placement: set `zoomedSession = null` first; keep the existing `.ws-hidden` toggling + `fit()` loop; then call `this.applyLayout()` — with `zoomedSession` null it re-parents every tile back to `#deck` and removes the strip — then the existing focus/`renderList()`. Verify the existing `firstVisible`/focus logic still runs after `applyLayout`.)

- [ ] **Step 2: Exit zoom when the zoomed tile is closed**

In `remove(session)`, before/after removing the tile, if the removed session was zoomed, drop to grid. After `this.tiles.delete(session);` add:
```ts
    if (this.zoomedSession === session) { this.zoomedSession = null; this.applyLayout(); }
```

- [ ] **Step 3: Exit zoom when a new session is launched**

In `spawnTile`, only for the non-restore (new launch) path, return to grid so the new tile is visible. After the tile is created and appended (near the end of `spawnTile`, after `this.tiles.set(session, tile);`) add:
```ts
    if (!resume && this.zoomedSession !== null) { this.zoomedSession = null; this.applyLayout(); }
```

- [ ] **Step 4: Esc exits zoom (main.ts)**

In `src/main.ts`, in the global `keydown` handler, after the existing `if (document.querySelector(".modal-overlay")) return;` guard, add — before the `matchHotkey` call:
```ts
  if (e.key === "Escape" && deck.exitZoom()) { e.preventDefault(); return; }
```
(When not zoomed, `exitZoom()` returns `false` and Esc falls through to the terminal as before.)

- [ ] **Step 5: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 6: Manual smoke check**

Dev app. While zoomed: (a) switch workspace → deck returns to grid, correct workspace's tiles shown; switch back → still grid. (b) Close the zoomed tile → grid with remaining tiles. (c) Launch a new session while zoomed → grid including the new tile. (d) Press Esc while zoomed → exits to grid; Esc when not zoomed still reaches the terminal.

- [ ] **Step 7: Commit**

```bash
git add src/sessions.ts src/main.ts
git commit -m "feat(#5): exit zoom on workspace switch / close / launch; Esc to exit"
```

---

## Self-Review

**Spec coverage:**
- FLIP morph, transform-only, no grid-track animation → Tasks 1 + 3. ✓
- Bottom filmstrip layout, re-parenting preserves xterm → Task 2 (`applyLayout`, CSS). ✓
- Double-click header zoom/exit, single-click thumbnail juggle, Esc exit → Tasks 2 + 4. ✓
- Zoom over active-workspace visible tiles only; `ws-hidden` excluded → `zoomParticipants` (Task 1), used everywhere. ✓
- Terminal refit after morph, no feedback loop → `animateLayoutChange` transitionless-box rationale + `fit()` (Task 3). ✓
- Edge cases: workspace switch / close / new session exit zoom; ≤1 tile no-op; transient state → Tasks 1 (no-op via `zoomParticipants`) + 4. ✓
- Tests: `flipTransform` + `zoomParticipants` unit-tested (Task 1); layout/animation manual (per repo's live-acceptance pattern). ✓

**Placeholder scan:** none — every code step has full code; every run step has a command + expected result.

**Type consistency:** `zoomParticipants(tiles, zoomedSession)` and `flipTransform(first, last)` signatures match between `flip.ts` (Task 1) and all `sessions.ts` call sites (Tasks 2, 3). `zoomTo(string|null)` / `toggleZoom(string)` / `exitZoom(): boolean` are consistent across `sessions.ts` and `main.ts`. `applyLayout()` reads `this.zoomedSession` set by its callers.
