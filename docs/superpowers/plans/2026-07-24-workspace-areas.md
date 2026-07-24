# Workspace-scoped Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a session↔workspace association, group the sidebar sessions list by workspace (#6), and filter the deck to show only the active workspace's terminals (#7).

**Architecture:** The `Deck` becomes workspace-aware — it holds an `activeWorkspaceId` and a live `workspaces: () => Workspace[]` lookup (never denormalizes name/color). Each `Tile` carries its `workspaceId`; `SessionEntry` persists it (optional, back-compatible). Tile→workspace resolution (`resolveWorkspaceId`) and sidebar grouping (`groupTilesByWorkspace`) are extracted as pure, unit-tested helpers. Filtering hides non-active tiles via a `.ws-hidden` (`display:none`) class; PTYs stay alive.

**Tech Stack:** TypeScript + Vite + Vitest (jsdom) frontend; Rust + serde + Tauri backend. Tests: `npm test` (vitest), `cargo test` (in `src-tauri/`).

## Global Constraints

- Frontend pure helpers live in focused modules and are exported for unit tests (existing pattern: `src/sessions.ts`, `src/commands.ts`).
- Tests: TS in `tests/*.test.ts` with `// @vitest-environment jsdom` when touching DOM/globals; Rust inline `#[cfg(test)] mod tests`.
- UI copy is Russian (matches existing: `готов`, `ждёт ввода`, `Сессии`, `Пространства`).
- Reuse existing CSS custom properties (`--accent`, `--accent-weak`, `--bg-raised`, `--fg-muted`, `--fs-sm`, `--fs-xs`, `--r-sm`, `--sp-2`, `--dur-1`, `--ease`, `--fw-medium`).
- Never denormalize workspace name/color onto tiles — always resolve via the live `workspaces()` lookup.
- Animate nothing here; visibility toggling is `display:none` (no transitions — that's #5's concern).
- Commit after each task passes its tests.

---

### Task 1: Persist `workspaceId` on `SessionEntry` (Rust)

**Files:**
- Modify: `src-tauri/src/model.rs` (SessionEntry struct + tests mod)
- Modify: `src-tauri/src/store.rs` (test literals that construct `SessionEntry`)

**Interfaces:**
- Produces: `SessionEntry.workspace_id: Option<String>` serialized as `"workspaceId"`, omitted when `None`, defaulted when absent (back-compat with pre-existing `sessions.json`).

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/model.rs`:

```rust
    #[test]
    fn session_entry_workspace_id_is_backward_compatible() {
        // Old file (pre-feature) has no workspaceId → deserializes to None.
        let old = r#"[{"sessionId":"s1","cwd":"/a","name":"N"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(old).unwrap();
        assert_eq!(v[0].workspace_id, None);

        // New file carries workspaceId.
        let new = r#"[{"sessionId":"s2","cwd":"/b","name":"M","workspaceId":"w1"}]"#;
        let v: Vec<SessionEntry> = serde_json::from_str(new).unwrap();
        assert_eq!(v[0].workspace_id.as_deref(), Some("w1"));

        // None is omitted from output (keeps files clean).
        let entry = SessionEntry {
            session_id: "s3".into(), cwd: "/c".into(), name: "K".into(), workspace_id: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("workspaceId"), "None workspaceId must be omitted, got {json}");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test session_entry_workspace_id_is_backward_compatible`
Expected: FAIL — compile error (`SessionEntry` has no field `workspace_id`).

- [ ] **Step 3: Add the field**

In `src-tauri/src/model.rs`, change the `SessionEntry` struct to:

```rust
/// A persisted tile in the deck layout — enough to reopen it and resume its
/// claude conversation on next launch. The PTY itself is not persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    pub name: String,
    /// Workspace this session belongs to. Optional + defaulted so that
    /// layout files written before this field existed still load (→ None).
    #[serde(rename = "workspaceId", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}
```

- [ ] **Step 4: Fix existing `SessionEntry` literals in store.rs tests**

In `src-tauri/src/store.rs`, the `layout_round_trips_and_defaults_empty` test constructs two `SessionEntry` values. Add `workspace_id` to each:

```rust
        let entries = vec![
            SessionEntry { session_id: "s1".into(), cwd: "/tmp/a".into(), name: "▶ Fix".into(), workspace_id: Some("w1".into()) },
            SessionEntry { session_id: "s2".into(), cwd: "/tmp/b".into(), name: "терминал · P".into(), workspace_id: None },
        ];
```

- [ ] **Step 5: Verify no other literal constructions break**

Run: `cd src-tauri && grep -rn "SessionEntry {" src/`
Expected: only the occurrences in `model.rs` (the test above) and `store.rs` (just fixed). If any other file constructs `SessionEntry { .. }` positionally/struct-literally, add `workspace_id: None`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (all tests, including the new one and the round-trip).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/model.rs src-tauri/src/store.rs
git commit -m "feat(#6): persist workspaceId on SessionEntry (back-compatible)"
```

---

### Task 2: Thread `workspaceId` through the frontend data path

**Files:**
- Modify: `src/ipc.ts` (SessionEntry type)
- Modify: `src/workspaces.ts` (expose `all` getter)
- Modify: `src/sessions.ts` (Tile, spawnTile, launch, restore, serializeTiles, persistLayout, Deck constructor)
- Modify: `src/main.ts` (pass `workspaces` lookup to Deck; load workspaces before restore)
- Modify: `tests/layout.test.ts` (serializeTiles carries workspaceId)

**Interfaces:**
- Consumes: none.
- Produces:
  - `interface SessionEntry { sessionId: string; cwd: string; name: string; workspaceId?: string; }`
  - `WorkspacesPanel.all: Workspace[]` (getter)
  - `Deck` constructor: `constructor(deckEl: HTMLElement, listEl: HTMLElement, workspaces: () => Workspace[])`
  - `Tile.workspaceId?: string`
  - `serializeTiles(tiles: { session; workspacePath; name; workspaceId? }[]): SessionEntry[]`

- [ ] **Step 1: Write the failing test**

Replace the `serializeTiles` block in `tests/layout.test.ts` with one that includes `workspaceId`:

```ts
describe("serializeTiles", () => {
  it("maps tile fields to SessionEntry shape, carrying workspaceId", () => {
    expect(serializeTiles([{ session: "s1", workspacePath: "/a", name: "▶ Fix", workspaceId: "w1" }]))
      .toEqual([{ sessionId: "s1", cwd: "/a", name: "▶ Fix", workspaceId: "w1" }]);
  });
  it("omits workspaceId when absent", () => {
    expect(serializeTiles([{ session: "s2", workspacePath: "/b", name: "N" }]))
      .toEqual([{ sessionId: "s2", cwd: "/b", name: "N" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/layout.test.ts`
Expected: FAIL — `serializeTiles` output has no `workspaceId`.

- [ ] **Step 3: Update the `SessionEntry` type**

In `src/ipc.ts`:

```ts
export interface SessionEntry { sessionId: string; cwd: string; name: string; workspaceId?: string; }
```

- [ ] **Step 4: Update `serializeTiles`**

In `src/sessions.ts`, replace `serializeTiles`:

```ts
export function serializeTiles(
  tiles: { session: string; workspacePath: string; name: string; workspaceId?: string }[],
): SessionEntry[] {
  return tiles.map((t) => ({
    sessionId: t.session, cwd: t.workspacePath, name: t.name,
    ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/layout.test.ts`
Expected: PASS.

- [ ] **Step 6: Add `Tile.workspaceId` and thread it through spawn/launch/restore/persist**

In `src/sessions.ts`:

Add to the `Tile` interface (after `workspacePath: string;`):
```ts
  workspaceId?: string;
```

Change the `Deck` constructor signature:
```ts
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement, private workspaces: () => Workspace[]) {}
```

Change `spawnTile`'s `opts` type and destructure to include `workspaceId`:
```ts
  private async spawnTile(opts: {
    session: string; cwd: string; workspaceId?: string; titleText: string; prompt: string | null; resume: boolean;
  }) {
    const { session, cwd, workspaceId, titleText, prompt, resume } = opts;
```
and add `workspaceId` to the `Tile` object literal (next to `workspacePath: cwd,`):
```ts
      workspacePath: cwd, workspaceId, prompt, restartBtn: restart, searchBar, bcastCheck,
```

In `launch`, pass the workspace id:
```ts
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText,
      prompt: skill ? skill.prompt : null,
      resume: false,
    });
```

In `restore`, pass the entry's workspaceId (may be undefined for old files — resolution happens later at group/filter time):
```ts
        await this.spawnTile({
          session: e.sessionId, cwd: e.cwd, workspaceId: e.workspaceId,
          titleText: e.name, prompt: null, resume: true,
        });
```

In `persistLayout`, carry workspaceId:
```ts
    const entries = serializeTiles([...this.tiles.values()].map((t) => ({
      session: t.session, workspacePath: t.workspacePath, name: t.name, workspaceId: t.workspaceId,
    })));
```

- [ ] **Step 7: Expose `all` on WorkspacesPanel**

In `src/workspaces.ts`, add after the `active` getter:
```ts
  get all(): Workspace[] { return this.items; }
```

- [ ] **Step 8: Wire the lookup and load order in main.ts**

In `src/main.ts`:

Change the Deck construction (currently `const deck = new Deck(deckEl, listMount);`) to:
```ts
const deck = new Deck(deckEl, listMount, () => workspaces.all);
```
(`workspaces` is declared later as a `const`; the arrow is only invoked at render time, after module init — safe.)

Replace the `boot()` function and the standalone `workspaces.load(); skills.load();` lines so workspaces load before restore:
```ts
async function boot() {
  await deck.wireEvents();
  await workspaces.load();
  skills.load();
  const entries = await loadLayout();
  if (entries.length) await deck.restore(entries);
}
```
Remove the now-duplicate `workspaces.load();` / `skills.load();` calls near the bottom. Keep the single `void boot();` — move it to the end of the file (after `workspaces`/`skills`/`newBtn.onclick` are declared) so those bindings exist when boot's async body runs.

- [ ] **Step 9: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (no type errors; all tests green). Sidebar is still flat here — no visible change yet.

- [ ] **Step 10: Commit**

```bash
git add src/ipc.ts src/workspaces.ts src/sessions.ts src/main.ts tests/layout.test.ts
git commit -m "feat(#6): thread workspaceId through tiles, launch, restore, persist"
```

---

### Task 3: Pure helpers — `resolveWorkspaceId` + `groupTilesByWorkspace`

**Files:**
- Create: `src/grouping.ts`
- Create: `tests/grouping.test.ts`

**Interfaces:**
- Produces:
  - `resolveWorkspaceId(workspaceId: string | undefined, cwd: string, workspaces: WorkspaceMeta[]): string | null`
  - `groupTilesByWorkspace(tiles: GroupTile[], workspaces: WorkspaceMeta[]): TileGroup[]`
  - `interface WorkspaceMeta { id: string; name: string; color: string; path: string; }`
  - `interface GroupTile { session: string; name: string; state: SessionState; workspaceId?: string; workspacePath: string; }`
  - `interface TileGroup { workspace: WorkspaceMeta | null; tiles: GroupTile[]; }` (`workspace: null` = orphan group)

- [ ] **Step 1: Write the failing tests**

Create `tests/grouping.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveWorkspaceId, groupTilesByWorkspace, type GroupTile, type WorkspaceMeta } from "../src/grouping";

const WS: WorkspaceMeta[] = [
  { id: "w1", name: "Grosh", color: "#3b82f6", path: "/p/grosh" },
  { id: "w2", name: "Landing", color: "#ef4444", path: "/p/landing" },
];

describe("resolveWorkspaceId", () => {
  it("returns the id when it matches a workspace", () => {
    expect(resolveWorkspaceId("w2", "/whatever", WS)).toBe("w2");
  });
  it("falls back to path match when id is missing (old restored session)", () => {
    expect(resolveWorkspaceId(undefined, "/p/landing", WS)).toBe("w2");
  });
  it("falls back to path match when id is unknown (deleted workspace re-created elsewhere)", () => {
    expect(resolveWorkspaceId("gone", "/p/grosh", WS)).toBe("w1");
  });
  it("returns null (orphan) when neither id nor path match", () => {
    expect(resolveWorkspaceId("gone", "/p/nope", WS)).toBeNull();
  });
});

describe("groupTilesByWorkspace", () => {
  const tile = (session: string, workspaceId: string | undefined, workspacePath: string): GroupTile =>
    ({ session, name: session, state: "idle", workspaceId, workspacePath });

  it("groups tiles under workspaces in workspaces() order", () => {
    const groups = groupTilesByWorkspace(
      [tile("a", "w2", "/p/landing"), tile("b", "w1", "/p/grosh"), tile("c", "w1", "/p/grosh")],
      WS,
    );
    expect(groups.map((g) => g.workspace?.id)).toEqual(["w1", "w2"]);
    expect(groups[0].tiles.map((t) => t.session)).toEqual(["b", "c"]);
    expect(groups[1].tiles.map((t) => t.session)).toEqual(["a"]);
  });
  it("omits workspaces that have no tiles", () => {
    const groups = groupTilesByWorkspace([tile("a", "w1", "/p/grosh")], WS);
    expect(groups.map((g) => g.workspace?.id)).toEqual(["w1"]);
  });
  it("puts unresolvable tiles in a trailing orphan group (workspace: null)", () => {
    const groups = groupTilesByWorkspace(
      [tile("a", "w1", "/p/grosh"), tile("z", "gone", "/p/nope")],
      WS,
    );
    expect(groups.at(-1)!.workspace).toBeNull();
    expect(groups.at(-1)!.tiles.map((t) => t.session)).toEqual(["z"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/grouping.test.ts`
Expected: FAIL — cannot resolve `../src/grouping`.

- [ ] **Step 3: Implement the module**

Create `src/grouping.ts`:

```ts
import type { SessionState } from "./ipc";

export interface WorkspaceMeta { id: string; name: string; color: string; path: string; }
export interface GroupTile {
  session: string; name: string; state: SessionState;
  workspaceId?: string; workspacePath: string;
}
export interface TileGroup { workspace: WorkspaceMeta | null; tiles: GroupTile[]; }

/**
 * Resolve a tile/entry to a workspace id:
 *  1. explicit id that matches a live workspace wins,
 *  2. else match by working directory (path),
 *  3. else null → orphan.
 * Used by both sidebar grouping and per-workspace deck filtering so they agree.
 */
export function resolveWorkspaceId(
  workspaceId: string | undefined,
  cwd: string,
  workspaces: WorkspaceMeta[],
): string | null {
  if (workspaceId && workspaces.some((w) => w.id === workspaceId)) return workspaceId;
  const byPath = workspaces.find((w) => w.path === cwd);
  return byPath ? byPath.id : null;
}

/**
 * Bucket tiles under their workspace. Groups follow `workspaces` order;
 * workspaces with no tiles are omitted; unresolvable tiles collect in a
 * trailing orphan group (`workspace: null`), shown only when non-empty.
 */
export function groupTilesByWorkspace(tiles: GroupTile[], workspaces: WorkspaceMeta[]): TileGroup[] {
  const byId = new Map<string, TileGroup>();
  const ordered: TileGroup[] = workspaces.map((w) => {
    const g: TileGroup = { workspace: w, tiles: [] };
    byId.set(w.id, g);
    return g;
  });
  const orphan: TileGroup = { workspace: null, tiles: [] };
  for (const t of tiles) {
    const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, workspaces);
    const group = rid !== null ? byId.get(rid)! : orphan;
    group.tiles.push(t);
  }
  const result = ordered.filter((g) => g.tiles.length > 0);
  if (orphan.tiles.length > 0) result.push(orphan);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/grouping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/grouping.ts tests/grouping.test.ts
git commit -m "feat(#6): pure helpers for workspace resolution and grouping"
```

---

### Task 4: Grouped, collapsible sidebar (#6 visible deliverable)

**Files:**
- Modify: `src/sessions.ts` (`renderList`, add `collapsed` set + `activeWorkspaceId` field, imports)
- Modify: `src/styles.css` (group header + row accent styles)

**Interfaces:**
- Consumes: `groupTilesByWorkspace`, `WorkspaceMeta` from `./grouping`; `waitingVerb` (already in this file).
- Produces: `Deck` renders a grouped, collapsible sidebar. Adds private `activeWorkspaceId: string | null = null` (setter arrives in Task 6) and `collapsed: Set<string>`.

- [ ] **Step 1: Add imports and fields**

In `src/sessions.ts`, add to the import from `./grouping` (new import line near the top):
```ts
import { groupTilesByWorkspace } from "./grouping";
```
Add these fields to the `Deck` class (next to the other privates):
```ts
  private activeWorkspaceId: string | null = null;
  private collapsed = new Set<string>();
```

- [ ] **Step 2: Replace `renderList`**

Replace the entire `renderList` method body in `src/sessions.ts` with:

```ts
  private renderList() {
    const tiles = [...this.tiles.values()];
    const waiting = waitingCount(tiles.map((t) => t.state));
    void emit("pill://count", { n: waiting });
    const header = waiting > 0 ? `Сессии · ${waiting} ${waitingVerb(waiting)} ввода` : "Сессии";
    this.listEl.innerHTML = `<h3>${header}</h3>`;
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
    const total = sumUsage([...this.usage.values()]);
    if (this.usage.size > 0) {
      const sum = document.createElement("div");
      sum.className = "sess-tokens-sum";
      sum.textContent = `Σ токенов · ↑${formatTokens(total.input)} ↓${formatTokens(total.output)}`;
      this.listEl.appendChild(sum);
    }
    const groups = groupTilesByWorkspace(
      tiles.map((t) => ({
        session: t.session, name: t.name, state: t.state,
        workspaceId: t.workspaceId, workspacePath: t.workspacePath,
      })),
      this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path })),
    );
    const ORPHAN_KEY = " orphan";
    for (const g of groups) {
      const wsId = g.workspace?.id ?? ORPHAN_KEY;
      const color = g.workspace?.color ?? "#6b7280";
      const name = g.workspace?.name ?? "Другие";
      const collapsed = this.collapsed.has(wsId);
      const groupWaiting = g.tiles.filter((t) => t.state === "waitingInput").length;

      const head = document.createElement("div");
      head.className = "sess-group-head"
        + (g.workspace && g.workspace.id === this.activeWorkspaceId ? " active" : "");
      head.style.setProperty("--ws-color", color);
      const toggle = document.createElement("span");
      toggle.className = "sess-group-toggle";
      toggle.textContent = collapsed ? "▸" : "▾";
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = color;
      const nm = document.createElement("span");
      nm.className = "sess-group-name"; nm.textContent = name;
      head.append(toggle, dot, nm);
      if (groupWaiting > 0) {
        const badge = document.createElement("span");
        badge.className = "sess-group-badge";
        badge.textContent = `${groupWaiting} ${waitingVerb(groupWaiting)}`;
        head.append(badge);
      }
      head.onclick = () => {
        if (collapsed) this.collapsed.delete(wsId); else this.collapsed.add(wsId);
        this.renderList();
      };
      this.listEl.appendChild(head);
      if (collapsed) continue;

      for (const t of g.tiles) {
        const live = this.tiles.get(t.session);
        const row = document.createElement("div");
        row.className = "sess-row" + (live?.el.classList.contains("is-active") ? " active" : "");
        row.style.borderLeftColor = color;
        row.onclick = () => this.focusTile(t.session);
        const stateSpan = document.createElement("span");
        stateSpan.className = `tile-state state-${t.state}`;
        stateSpan.textContent = LABEL[t.state];
        const nameSpan = document.createElement("span");
        nameSpan.textContent = t.name;
        row.append(stateSpan, " ", nameSpan);
        this.listEl.appendChild(row);
      }
    }
  }
```

- [ ] **Step 3: Add CSS**

In `src/styles.css`, after the `.sess-row.active` rule (line ~156), add:

```css
.sess-group-head { display: flex; align-items: center; gap: 6px; margin: 8px 0 2px; padding: 3px 4px; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-muted); cursor: pointer; border-radius: var(--r-sm); user-select: none; }
.sess-group-head:hover { background: var(--bg-raised); }
.sess-group-head.active { color: var(--fg); }
.sess-group-toggle { width: 1em; flex: none; color: var(--fg-subtle); }
.sess-group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-group-badge { font-size: var(--fs-xs); color: var(--fg-subtle); }
.sess-row { border-left: 3px solid transparent; }
```

(The last rule augments the existing `.sess-row`; keep the original `.sess-row` declaration — CSS merges the `border-left`.)

- [ ] **Step 4: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. No new unit test here — `renderList` is DOM glue over the Task 3 helpers (already tested). Behavior verified manually in Step 5.

- [ ] **Step 5: Manual smoke check**

Run: `npm run tauri dev` (or the project's usual dev command). Create two workspaces with different colors, launch a session in each. Confirm: sidebar shows a collapsible header per workspace (▾/▸ + color dot + name), sessions nested with a left color stripe, clicking a header collapses/expands, a waiting session shows a `(N ждёт/ждут)` badge on its group header.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts src/styles.css
git commit -m "feat(#6): grouped collapsible sidebar, color-coded by workspace"
```

---

### Task 5: Pure helper — `nextWaitingAcross` (cross-workspace)

**Files:**
- Modify: `src/sessions.ts` (add exported helper next to `waitingCount`)
- Create: `tests/sessions-next-waiting.test.ts`

**Interfaces:**
- Produces: `nextWaitingAcross(tiles: { session: string; workspaceId?: string; state: SessionState }[], currentSession: string | null): { session: string; workspaceId?: string } | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/sessions-next-waiting.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextWaitingAcross } from "../src/sessions";
import type { SessionState } from "../src/ipc";

const t = (session: string, state: SessionState, workspaceId?: string) => ({ session, state, workspaceId });

describe("nextWaitingAcross", () => {
  it("returns null when nothing is waiting", () => {
    expect(nextWaitingAcross([t("a", "idle"), t("b", "working")], null)).toBeNull();
  });
  it("finds the first waiting session when none is active", () => {
    const r = nextWaitingAcross([t("a", "idle"), t("b", "waitingInput", "w2")], null);
    expect(r).toEqual({ session: "b", workspaceId: "w2" });
  });
  it("wraps around past the current session", () => {
    const tiles = [t("a", "waitingInput", "w1"), t("b", "idle"), t("c", "waitingInput", "w2")];
    // current = c (last) → next waiting wraps to a
    expect(nextWaitingAcross(tiles, "c")).toEqual({ session: "a", workspaceId: "w1" });
  });
  it("skips the current session even if it is waiting", () => {
    const tiles = [t("a", "waitingInput", "w1"), t("b", "waitingInput", "w2")];
    expect(nextWaitingAcross(tiles, "a")).toEqual({ session: "b", workspaceId: "w2" });
  });
  it("returns the only waiting session (not the current) across workspaces", () => {
    const tiles = [t("a", "working", "w1"), t("b", "waitingInput", "w2")];
    expect(nextWaitingAcross(tiles, "a")).toEqual({ session: "b", workspaceId: "w2" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/sessions-next-waiting.test.ts`
Expected: FAIL — `nextWaitingAcross` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/sessions.ts`, add next to `waitingCount` (bottom of file, among the exported functions):

```ts
export function nextWaitingAcross(
  tiles: { session: string; workspaceId?: string; state: SessionState }[],
  currentSession: string | null,
): { session: string; workspaceId?: string } | null {
  const n = tiles.length;
  if (n === 0) return null;
  const start = tiles.findIndex((t) => t.session === currentSession); // -1 if not found
  for (let i = 1; i <= n; i++) {
    const t = tiles[(start + i + n) % n];
    if (t.state === "waitingInput" && t.session !== currentSession) {
      return { session: t.session, workspaceId: t.workspaceId };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/sessions-next-waiting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts tests/sessions-next-waiting.test.ts
git commit -m "feat(#7): nextWaitingAcross helper for cross-workspace navigation"
```

---

### Task 6: Per-workspace deck filter (#7 core)

**Files:**
- Modify: `src/sessions.ts` (`setActiveWorkspace`, import `resolveWorkspaceId`)
- Modify: `src/styles.css` (`.tile.ws-hidden`)
- Modify: `src/workspaces.ts` (`del` re-selects active so onSelect fires)
- Modify: `src/main.ts` (wire `onSelect` → `setActiveWorkspace`; apply after restore)

**Interfaces:**
- Consumes: `resolveWorkspaceId` from `./grouping`; `WorkspacesPanel.active`.
- Produces: `Deck.setActiveWorkspace(id: string | null): void` — sets the filter, toggles `.ws-hidden` on non-active tiles, refits visible tiles, re-renders the sidebar.

- [ ] **Step 1: Extend the grouping import**

In `src/sessions.ts`, change the grouping import to also bring in the resolver:
```ts
import { groupTilesByWorkspace, resolveWorkspaceId } from "./grouping";
```

- [ ] **Step 2: Add `setActiveWorkspace`**

In `src/sessions.ts`, add this public method to `Deck` (e.g. after `launch`):

```ts
  setActiveWorkspace(id: string | null) {
    this.activeWorkspaceId = id;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    for (const t of this.tiles.values()) {
      const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, ws);
      // Orphan tiles (rid === null) stay visible everywhere so a session whose
      // workspace was deleted remains reachable.
      const visible = rid === null || rid === id;
      t.el.classList.toggle("ws-hidden", !visible);
      if (visible) t.panel.fit();
    }
    this.renderList();
  }
```

- [ ] **Step 3: Add the hide CSS**

In `src/styles.css`, after the `.tile` rules (line ~103), add:
```css
.tile.ws-hidden { display: none; }
```

- [ ] **Step 4: Make `WorkspacesPanel.del` re-select the active workspace**

In `src/workspaces.ts`, replace the `del` method body so that deleting the active workspace fires `onSelect` (the deck needs to react):

```ts
  private async del(id: string) {
    if (!(await confirmModal("Удалить пространство?"))) return;
    this.items = await removeWorkspace(id);
    if (this.activeId === id) {
      const next = this.items[0]?.id ?? null;
      this.activeId = null;
      if (next) { this.select(next); return; } // select() fires onSelect + renders
    }
    this.render();
  }
```

- [ ] **Step 5: Wire main.ts**

In `src/main.ts`:

Change the `WorkspacesPanel` construction (currently `new WorkspacesPanel(wsMount, () => {})` with the multi-line NOTE comment) to wire selection into the deck. Replace the NOTE comment and the constructor with:
```ts
// Selecting a workspace (click, startup restore of the active one, or after a
// deletion re-selects the next one) switches the deck to that workspace's tiles.
const workspaces = new WorkspacesPanel(wsMount, (ws) => deck.setActiveWorkspace(ws.id));
```

In `boot()`, after the restore line, apply the filter to the now-existing tiles:
```ts
  if (entries.length) await deck.restore(entries);
  deck.setActiveWorkspace(workspaces.active?.id ?? null);
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 7: Manual smoke check**

Run the dev app. With sessions in two workspaces: selecting a workspace in the "Пространства" panel shows only that workspace's tiles in the deck (others hidden), and the visible terminals refit to fill the deck. Launch a new session — it appears in the active workspace. Delete a workspace that has a live session — the deck switches to another workspace, and the deleted one's session appears (and stays alive) under "Другие" in the sidebar.

- [ ] **Step 8: Commit**

```bash
git add src/sessions.ts src/styles.css src/workspaces.ts src/main.ts
git commit -m "feat(#7): per-workspace deck — switching workspace swaps visible terminals"
```

---

### Task 7: Cross-workspace focus & index navigation (#7 completion)

**Files:**
- Modify: `src/sessions.ts` (`focusNextWaiting`, `focusByIndex`, sidebar row click, add `focusSessionAnywhere`, drop unused `nextWaitingIndex` import)

**Interfaces:**
- Consumes: `nextWaitingAcross` (Task 5), `resolveWorkspaceId` (Task 3), `setActiveWorkspace` (Task 6).
- Produces: focus operations that cross workspace boundaries — jumping to a waiting session in a hidden workspace switches the active workspace first.

- [ ] **Step 1: Add `focusSessionAnywhere` and update `focusNextWaiting`**

In `src/sessions.ts`, add a private helper and rewrite `focusNextWaiting`:

```ts
  private focusSessionAnywhere(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    const rid = resolveWorkspaceId(tile.workspaceId, tile.workspacePath, ws);
    if (rid !== null && rid !== this.activeWorkspaceId) this.setActiveWorkspace(rid);
    this.focusTile(session);
  }

  focusNextWaiting() {
    const tiles = [...this.tiles.values()];
    const target = nextWaitingAcross(
      tiles.map((t) => ({ session: t.session, workspaceId: t.workspaceId, state: t.state })),
      this.activeSession,
    );
    if (target) this.focusSessionAnywhere(target.session);
  }
```

- [ ] **Step 2: Scope `focusByIndex` to visible tiles**

Replace `focusByIndex`:
```ts
  focusByIndex(n: number) {
    const ids = [...this.tiles.values()]
      .filter((t) => !t.el.classList.contains("ws-hidden"))
      .map((t) => t.session);
    const id = ids[n - 1];
    if (id) this.focusTile(id);
  }
```

- [ ] **Step 3: Make sidebar row clicks cross workspaces**

In `renderList`, change the row click handler from `row.onclick = () => this.focusTile(t.session);` to:
```ts
        row.onclick = () => this.focusSessionAnywhere(t.session);
```

- [ ] **Step 4: Remove the now-unused import**

`focusNextWaiting` no longer uses `nextWaitingIndex`. In `src/sessions.ts`, delete `nextWaitingIndex` from the `import { ... } from "./commands"` line. If that leaves the import empty, remove the whole line. (`nextWaitingIndex` remains exported/tested in `commands.ts` — do not delete it there.)

- [ ] **Step 5: Typecheck + full test run**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (no unused-import / type errors; all green).

- [ ] **Step 6: Manual smoke check**

Run the dev app. Put a session in workspace B into "waitingInput" while workspace A is active. Trigger "next waiting" (palette or hotkey): the deck switches to workspace B and focuses that session. The pill/title still counts it while hidden. Clicking a workspace-B session row in the sidebar while A is active also switches to B and focuses it. `Cmd/Ctrl+1..9` focuses among the visible workspace's tiles only.

- [ ] **Step 7: Commit**

```bash
git add src/sessions.ts
git commit -m "feat(#7): cross-workspace focus (next-waiting, sidebar click) + visible-only index nav"
```

---

## Self-Review

**Spec coverage:**
- Data foundation (`Tile.workspaceId`, `SessionEntry.workspaceId`, back-compat) → Tasks 1–2. ✓
- Restore migration (match by path) → `resolveWorkspaceId` (Task 3), applied at group/filter time (Tasks 4, 6). ✓
- #6 grouped collapsible sidebar, color accent, per-workspace waiting badge, orphan group → Task 4 (+ helpers Task 3). ✓
- #7 per-workspace filter, refit, launch into active, startup restore → Task 6. ✓
- Waiting count across all workspaces (unchanged aggregate) → preserved in `renderList` (Task 4 counts all tiles). ✓
- `focusNextWaiting` cross-workspace, sidebar click cross-workspace, `focusByIndex` visible-only → Task 7. ✓
- Edge cases: delete workspace with sessions (Task 6, step 4 + orphan-visible rule), zero-terminal workspace (empty deck, inherent), orphan shown only when non-empty (Task 3). ✓
- Tests: `groupTilesByWorkspace` + `resolveWorkspaceId` (Task 3), `nextWaitingAcross` (Task 5), `SessionEntry` serde round-trip (Task 1). ✓

**Placeholder scan:** none — every code step shows full code; every run step shows command + expected result.

**Type consistency:** `resolveWorkspaceId(workspaceId, cwd, workspaces)` and `groupTilesByWorkspace(tiles, workspaces)` signatures match across Tasks 3/4/6/7. `WorkspaceMeta` shape (`{id,name,color,path}`) is built identically wherever `this.workspaces()` is mapped. `setActiveWorkspace(id: string | null)` matches its call sites (main.ts, focusSessionAnywhere). `nextWaitingAcross` return `{session, workspaceId?}` matches its consumer in Task 7.
