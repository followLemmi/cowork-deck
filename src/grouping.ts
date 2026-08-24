import type { SessionState } from "./ipc";

export interface WorkspaceMeta { id: string; name: string; color: string; path: string; }
export interface GroupTile {
  session: string; name: string; state: SessionState;
  workspaceId?: string; workspacePath: string;
  /** The label of the window holding this session, when it is not this one.
   *
   *  A workspace pulled into a window of its own does not vanish from the main
   *  window's sidebar — its sessions stay listed, as proxies, and clicking one
   *  raises the window that has it. That is what keeps "who is blocked on me"
   *  reaching the other monitor. Absent for a session this window renders. */
  remote?: string;
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
