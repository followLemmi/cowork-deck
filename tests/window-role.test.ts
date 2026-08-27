import { describe, it, expect } from "vitest";
import { addressedTo, workspaceIdOf } from "../src/window-role";

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

/** The listen options that decide whether an addressed event is actually
 *  addressed.
 *
 *  Written out as a literal rather than compared against anything the source
 *  builds, because the value only means something to Tauri: a target of
 *  `{ kind: "Any" }` — which is what a bare `listen` registers, and what this
 *  exists to replace — is delivered every addressed emit as well as every
 *  broadcast, so `emitTo` stops meaning "to that window" (#349). The literal
 *  here is the shape `@tauri-apps/api`'s own `EventTarget` names, and a drift
 *  from it would be silent: a target Tauri does not recognise fails to
 *  deserialise and the listener registers not at all. */
describe("addressedTo", () => {
  it("narrows a listener to one window, by label", () => {
    expect(addressedTo("main")).toEqual({ target: { kind: "Window", label: "main" } });
  });

  /** The case the bug was about: two windows, two different narrowings, so an
   *  event addressed to one is not delivered to the other. */
  it("gives two windows two different targets", () => {
    expect(addressedTo("workspace-w1")).not.toEqual(addressedTo("main"));
  });
});
