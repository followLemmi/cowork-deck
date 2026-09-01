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
    expect(describeDeleteImpact("w1", [sk("a", null), sk("b", "w2")], []))
      .toBe("Delete workspace?");
  });

  // Deleting a workspace strands every scenario pinned to it: they cannot run
  // and the schedule quietly stops producing anything.
  it("counts the scenarios that will be stranded", () => {
    const msg = describeDeleteImpact("w1", [sk("a", "w1"), sk("b", "w1"), sk("c", null)], []);
    expect(msg).toContain("2 scenarios");
  });

  it("calls out schedules separately, since those stop running silently", () => {
    const msg = describeDeleteImpact("w1", [sk("a", "w1", true), sk("b", "w1")], []);
    expect(msg).toContain("2 scenarios");
    expect(msg).toContain("1 of them scheduled");
  });

  it("uses singular wording for a single scenario", () => {
    expect(describeDeleteImpact("w1", [sk("a", "w1")], [])).toContain("1 scenario");
  });

  /* The sessions half. It said nothing at all about them before #250: three
     agents were cut loose from their repository, board and pull requests without
     the question ever mentioning it. */
  describe("live sessions", () => {
    it("names the one session running in it", () => {
      const msg = describeDeleteImpact("w1", [], ["fix-250"]);
      expect(msg).toContain("“fix-250” is still running in it");
      expect(msg).toContain("it will keep running");
    });

    it("names a handful, as a sentence rather than a list", () => {
      const msg = describeDeleteImpact("w1", [], ["alpha", "beta", "gamma"]);
      expect(msg).toContain("“alpha”, “beta” and “gamma” are still running in it");
      expect(msg).toContain("they will keep running");
    });

    // Past three the names stop being an answer and start being an inventory.
    it("counts them once there are too many to name", () => {
      const msg = describeDeleteImpact("w1", [], ["a", "b", "c", "d"]);
      expect(msg).toContain("4 sessions are still running in it");
      expect(msg).not.toContain("“a”");
    });

    /* A name is only worth printing while it tells the two apart. A session is
       called "session · <workspace>" until a transcript title replaces it, so
       two fresh ones in the same workspace are the same string, and naming it
       twice answers nothing. */
    it("counts them when the names do not tell them apart", () => {
      const same = "session · Backend";
      const msg = describeDeleteImpact("w1", [], [same, same]);
      expect(msg).toContain("2 sessions are still running in it");
      expect(msg).not.toContain("\u201c");
    });

    // Distinctness only decides between naming and counting. One session is
    // distinct from nothing, so the singular sentence is untouched.
    it("still names a single session, which nothing can duplicate", () => {
      expect(describeDeleteImpact("w1", [], ["session · Backend"]))
        .toContain("“session · Backend” is still running in it");
    });

    // The two halves say opposite things and both have to be said: scenarios
    // stop, sessions carry on with nothing behind them.
    it("reports scenarios and sessions together, each with its own fate", () => {
      const msg = describeDeleteImpact("w1", [sk("a", "w1", true), sk("b", "w1")], ["alpha"]);
      expect(msg).toContain("2 scenarios are pinned to it, 1 of them scheduled — they will stop running.");
      expect(msg).toContain("“alpha” is still running in it");
      expect(msg).toContain("attached to no workspace");
    });

    // A session in another workspace is the caller's to filter out, but the
    // question must not invent one either: no sessions, no sentence.
    it("says nothing about sessions when there are none", () => {
      const msg = describeDeleteImpact("w1", [sk("a", "w1")], []);
      expect(msg).not.toContain("running in it");
    });
  });
});
