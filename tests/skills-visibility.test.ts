import { describe, it, expect } from "vitest";
import { visibleSkills, isOrphan } from "../src/skills";
import type { Skill } from "../src/ipc";

const sk = (id: string, workspaceId: string | null): Skill =>
  ({ id, name: id, icon: "▶", prompt: "p", workspaceId });

describe("visibleSkills", () => {
  it("shows unpinned scenarios and those pinned to the active workspace", () => {
    const all = [sk("free", null), sk("here", "w1"), sk("elsewhere", "w2")];
    const shown = visibleSkills(all, "w1", ["w1", "w2"]).map((s) => s.id);
    expect(shown).toEqual(["free", "here"]);
  });

  // A scenario pinned to a deleted workspace used to pass no filter at all: it
  // vanished from every workspace while the scheduler kept firing it into
  // nothing, and there was no way to edit, unpin or delete it from the UI.
  it("keeps a scenario whose workspace is gone reachable", () => {
    const all = [sk("orphan", "deleted"), sk("here", "w1")];
    expect(visibleSkills(all, "w1", ["w1"]).map((s) => s.id)).toEqual(["orphan", "here"]);
    // …and from a different workspace too, so it cannot hide anywhere.
    expect(visibleSkills(all, "w2", ["w1", "w2"]).map((s) => s.id)).toEqual(["orphan"]);
  });

  it("marks only the orphan as such", () => {
    expect(isOrphan(sk("orphan", "deleted"), ["w1"])).toBe(true);
    expect(isOrphan(sk("here", "w1"), ["w1"])).toBe(false);
    expect(isOrphan(sk("free", null), ["w1"])).toBe(false);
  });

  // Workspaces load asynchronously; treating "none known yet" as "everything
  // is orphaned" would flash a wall of warnings on every start.
  it("does not call anything an orphan before workspaces are known", () => {
    expect(isOrphan(sk("here", "w1"), [])).toBe(false);
  });
});
