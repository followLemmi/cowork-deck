import { describe, it, expect } from "vitest";
import { describeDeleteImpact } from "../src/workspaces";
import type { Skill } from "../src/ipc";

const sk = (id: string, workspaceId: string | null, scheduled = false): Skill => ({
  id, name: id, icon: "▶", prompt: "p", workspaceId,
  ...(scheduled
    ? { schedule: { preset: { kind: "daily" as const, hour: 9, minute: 0 }, defaults: {}, enabled: true } }
    : {}),
});

describe("describeDeleteImpact", () => {
  it("asks plainly when nothing else is affected", () => {
    expect(describeDeleteImpact("w1", [sk("a", null), sk("b", "w2")]))
      .toBe("Delete workspace?");
  });

  // Deleting a workspace strands every scenario pinned to it: they cannot run
  // and the schedule quietly stops producing anything.
  it("counts the scenarios that will be stranded", () => {
    const msg = describeDeleteImpact("w1", [sk("a", "w1"), sk("b", "w1"), sk("c", null)]);
    expect(msg).toContain("2 scenarios");
  });

  it("calls out schedules separately, since those stop running silently", () => {
    const msg = describeDeleteImpact("w1", [sk("a", "w1", true), sk("b", "w1")]);
    expect(msg).toContain("2 scenarios");
    expect(msg).toContain("1 of them scheduled");
  });

  it("uses singular wording for a single scenario", () => {
    expect(describeDeleteImpact("w1", [sk("a", "w1")])).toContain("1 scenario");
  });
});
