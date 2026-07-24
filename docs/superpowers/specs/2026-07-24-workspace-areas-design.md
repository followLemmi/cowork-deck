# Workspace-scoped sessions: grouped sidebar (#6) + per-workspace terminal areas (#7)

Date: 2026-07-24
Issues: #6 (group sessions under workspace, color-coded), #7 (per-workspace terminal areas)

## Problem

Sessions currently live in one flat pile. A `Tile` only knows its `workspacePath`
(cwd), not which workspace launched it; `SessionEntry` (persisted layout) carries no
workspace identity either. There is no way to (a) group the sidebar list by workspace
or (b) switch the visible deck to only one workspace's terminals.

Both features need the same foundation: a persisted **session ↔ workspace** association
and a **workspace-aware Deck**. Build the foundation + #6 first, then #7 on top.

## Approach (chosen: A — workspace-aware Deck via live lookup)

The `Deck` becomes workspace-aware:
- holds `activeWorkspaceId: string | null`
- is given a live lookup `workspaces: () => Workspace[]` (same pattern `SkillsPanel`
  already uses via `main.ts`), so names/colors are always fresh — never denormalized
  onto tiles.

Rejected alternatives:
- **B — one deck container per workspace.** Cleaner isolation, but forces rework of the
  broadcast panel, polling, focus, and the zoom feature (#5) across N containers. Too
  much churn.
- **C — denormalize name+color onto Tile/SessionEntry.** Simplest data flow, but workspace
  rename/recolor leaves stale copies and duplicates the source of truth.

## Data / persistence (foundation — ships with #6)

- `Tile.workspaceId: string` — set at `launch()` from the `Workspace` already passed in.
- `SessionEntry` gains a workspace id:
  - Rust (`model.rs`): `pub workspace_id: Option<String>` with `#[serde(rename = "workspaceId", default)]`.
  - TS (`ipc.ts`): `workspaceId?: string`.
  - `#[serde(default)]` keeps **back-compat**: existing `sessions.json` files that predate
    this field deserialize fine (field = `None`).
- `spawnTile(opts)` gains a `workspaceId` param; `serializeTiles` / `persistLayout` write it.
- Deck construction/wiring (`main.ts`):
  - pass `workspaces: () => Workspace[]` (reads `WorkspacesPanel`'s live list).
  - wire `WorkspacesPanel.onSelect` (currently the no-op `() => {}`) to
    `deck.setActiveWorkspace(ws.id)`.
  - `deck.launch(ws, skill)` already receives the full `Workspace`, so `workspaceId = ws.id`.

### Restore migration

On `restore(entries)`:
- if `entry.workspaceId` is present → use it.
- else (old file) → match by `entry.cwd === workspace.path`; use that workspace's id.
- else (no match; workspace was deleted) → leave `workspaceId` unmatched → the tile falls
  into the **"Другие"** orphan group.

## #6 — grouped, collapsible sidebar

`renderList()` changes from a flat list to grouped:
- Bucket tiles by `workspaceId`, resolving name/color from `workspaces()`.
- One **collapsible header** per workspace: `▾/▸` toggle + color dot + workspace name +
  that workspace's own waiting-count badge (`(N ждёт)`, hidden when 0).
- Sessions nested under their header, each row with a **left-border stripe** in the
  workspace color. Active workspace's group is visually emphasized.
- Collapse state: in-memory `Set<string>` of collapsed workspace ids on the Deck
  (not persisted — YAGNI).
- The global header (`Сессии · N ждут ввода`) and `Σ токенов` sum stay on top, unchanged.
- **Orphan group ("Другие")**: neutral gray accent, rendered only when non-empty.

### Extracted pure helper (unit-tested)

```
groupTilesByWorkspace(
  tiles: { session, workspaceId, ... }[],
  workspaces: { id, name, color }[],
): { workspace: {id,name,color} | null /* null = orphan */, tiles: [...] }[]
```

Deterministic ordering: groups follow `workspaces()` order; orphan group last.

## #7 — per-workspace terminal areas

`Deck.activeWorkspaceId` filters the deck:
- Tiles whose `workspaceId !== activeWorkspaceId` get a `.ws-hidden` class (`display:none`);
  their PTYs stay alive.
- `setActiveWorkspace(id)`:
  1. set `activeWorkspaceId`
  2. toggle `.ws-hidden` on every tile
  3. `fit()` the now-visible tiles (a `display:none → block` element goes from
     `clientWidth 0` to real; `TerminalPanel.fit()` self-guards on zero size and a
     `ResizeObserver` already refits on layout — the explicit `fit()` makes it immediate)
  4. `renderList()`
- New sessions launch into the active workspace (already the behavior).
- On startup: `restore()` all tiles, then `setActiveWorkspace(persisted activeWorkspaceId)`
  shows that workspace's set.

### Cross-workspace awareness

- **Waiting count** (pill `pill://count` + window title) = total across **all** tiles,
  every workspace (unchanged aggregate — it already counts all tiles).
- **`focusNextWaiting`**: selects the next `waitingInput` session across **all** tiles; if
  the chosen session is in a hidden workspace, `setActiveWorkspace` to it first, then focus.
- **Clicking a sidebar session** in another workspace: `setActiveWorkspace` to its workspace,
  then focus it.
- **`focusByIndex(n)`**: operates over the **visible** (active-workspace) tiles only
  (matches the on-screen 1..9 ordering).

### Extracted pure helper (unit-tested)

```
nextWaitingAcross(
  tiles: { session, workspaceId, state }[],
  currentSession: string | null,
): { session, workspaceId } | null
```
Wraps around the full ordered tile list; returns the target session + its workspace so the
caller can switch workspace then focus.

## Edge-case decisions

1. **Delete a workspace with live sessions** → sessions stay alive and drop into the
   "Другие" orphan group; if the deleted workspace was active, switch to the first
   remaining workspace. No PTYs killed. (`WorkspacesPanel.del` already returns the new list;
   `main.ts` re-selects — Deck reacts via `setActiveWorkspace`.)
2. **Switch to a workspace with zero terminals** → empty deck (acceptable).
3. **Orphan group** shown only when non-empty.

## Testing

- **TS unit:** `groupTilesByWorkspace` (grouping order, orphan bucketing, unknown id);
  `nextWaitingAcross` (wrap-around, none-waiting, cross-workspace selection).
- **Rust unit:** `SessionEntry` serde round-trip **with** `workspaceId` and **without**
  (old-file back-compat → `None`).
- **Manual acceptance:** launch sessions in 2 workspaces; switch workspaces (deck swaps,
  terminals refit cleanly); collapse a group; a waiting session in a hidden workspace bumps
  the pill and "next waiting" jumps to it (switching workspace); delete a workspace with a
  live session (session moves to "Другие", stays alive); restart app (sets restore per
  workspace, last-active workspace shown, old sessions.json still loads).

## Out of scope

- Persisting collapse state across restarts.
- Reassigning a session to a different workspace via UI (drag/move).
- Per-workspace layouts for the zoom feature (#5) — handled in its own spec.
