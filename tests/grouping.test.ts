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
    expect(groups[groups.length - 1].workspace).toBeNull();
    expect(groups[groups.length - 1].tiles.map((t) => t.session)).toEqual(["z"]);
  });
});
