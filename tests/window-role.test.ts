import { describe, it, expect } from "vitest";
import { workspaceIdOf } from "../src/window-role";

/** The other half of `windows.rs`'s `a_label_carries_its_workspace_and_gives_it_back`.
 *
 *  The prefix is written twice, once per language, and cannot be shared across
 *  the boundary. A mismatch would be invisible at runtime: a label minted in Rust
 *  would parse to no workspace here, and a window pinned to one would quietly
 *  render as though it were pinned to nothing. So each side is pinned to the same
 *  literal by a test, and the literals are written out here rather than imported
 *  — importing the constant would make this test agree with itself. */
describe("workspaceIdOf", () => {
  it("reads the workspace out of a label Rust minted", () => {
    expect(workspaceIdOf("workspace-3f2b1c4e-0a11-4c2d-9f77-1b2c3d4e5f60"))
      .toBe("3f2b1c4e-0a11-4c2d-9f77-1b2c3d4e5f60");
  });

  it("says nothing for the windows that are not workspaces", () => {
    expect(workspaceIdOf("main")).toBeNull();
    expect(workspaceIdOf("pill")).toBeNull();
  });

  /** The bare prefix names no workspace. Otherwise an empty id would round trip
   *  through a label and back as the empty string, which reads as a workspace. */
  it("says nothing for the bare prefix", () => {
    expect(workspaceIdOf("workspace-")).toBeNull();
  });

  /** A prefix match, not a substring one: a label that merely contains the word
   *  must not be read as a workspace window. */
  it("matches at the start and nowhere else", () => {
    expect(workspaceIdOf("pill-workspace-w1")).toBeNull();
  });
});
