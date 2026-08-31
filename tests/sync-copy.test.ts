import { describe, expect, it } from "vitest";
import {
  agoLabel,
  blockedCopy,
  faultCopy,
  questionCopy,
  questionCountLabel,
  repoCopy,
} from "../src/sync-copy";
import { ghUnavailable } from "../src/gh-unavailable";

describe("what sync says when it cannot start", () => {
  it("borrows the sentences that already exist rather than writing new ones", () => {
    // The point is not the wording but that there is only one of it: two
    // screens said the same thing differently once already, which is why
    // gh-unavailable.ts exists at all.
    expect(blockedCopy("no-gh")).toEqual(ghUnavailable("no-gh", "issues"));
    expect(blockedCopy("no-account")).toEqual(ghUnavailable("no-account", "issues"));
  });

  it("offers a way out of each", () => {
    expect(blockedCopy("no-gh").action).toBeTruthy();
    expect(blockedCopy("no-account").action).toBeTruthy();
  });
});

describe("what a fault says", () => {
  it("gives every fault its own sentence, so none is a bare 'sync failed'", () => {
    const texts = [
      faultCopy({ kind: "offline", since: 1 }).text,
      faultCopy({ kind: "conflict", files: ["a"] }).text,
      faultCopy({ kind: "push-rejected", message: "m" }).text,
      faultCopy({ kind: "auth-gone", message: "m" }).text,
      faultCopy({ kind: "format-newer", found: 2, supported: 1 }).text,
    ];
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
  });

  it("does not call being offline a failure, because it is not one", () => {
    const c = faultCopy({ kind: "offline", since: 1 });
    expect(c.text.toLowerCase()).not.toContain("fail");
    expect(c.text.toLowerCase()).not.toContain("error");
    // Nothing to press: it clears itself, and a dead button is worse than none.
    expect(c.action).toBeNull();
  });

  it("names the conflicting files and never offers to resolve them", () => {
    const c = faultCopy({ kind: "conflict", files: ["ws-1/Facts.md", "Diaries/r/2026-08.md"] });
    expect(c.text).toContain("ws-1/Facts.md");
    expect(c.text).toContain("Diaries/r/2026-08.md");
    // An automatic merge of prose produces a plausible paragraph nobody wrote.
    expect(c.action).not.toMatch(/resolve|merge|fix it for me/i);
  });

  it("says the token was refused rather than blaming a missing account", () => {
    // #150 is the standing instance of this: a revoked token reported as "no
    // account bound", which the person can see is false.
    const c = faultCopy({ kind: "auth-gone", message: "403" });
    expect(c.text).toMatch(/no longer accepted/i);
    expect(c.text).not.toMatch(/no account (is )?bound/i);
  });

  it("says the deck still works when the format is too new", () => {
    const c = faultCopy({ kind: "format-newer", found: 9, supported: 1 });
    expect(c.text).toContain("9");
    expect(c.text).toMatch(/locally/i);
    expect(c.action).toBeNull();
  });
});

describe("whether a repository can be adopted", () => {
  it("accepts an empty one and one of ours", () => {
    expect(repoCopy({ kind: "empty" }).ok).toBe(true);
    expect(repoCopy({ kind: "ours", format: 1 }).ok).toBe(true);
  });

  it("refuses somebody's project, and says what connecting would do", () => {
    const c = repoCopy({ kind: "foreign" });
    expect(c.ok).toBe(false);
    expect(c.text).toMatch(/session history/i);
  });

  it("refuses a newer format instead of writing a store the other machine cannot read", () => {
    expect(repoCopy({ kind: "ours-newer", format: 7 }).ok).toBe(false);
    expect(repoCopy({ kind: "ours-newer", format: 7 }).text).toContain("7");
  });

  it("refuses when the check itself failed, rather than treating it as absent", () => {
    // Absent invites "create it", and creating one that already exists is two
    // repositories and a memory split between them.
    const c = repoCopy({ kind: "unknown", why: "rate limit" });
    expect(c.ok).toBe(false);
    expect(c.text).toContain("rate limit");
    expect(c.text).not.toMatch(/create/i);
  });
});

describe("how long ago the last push was", () => {
  it("says 'never' rather than pretending to a time", () => {
    expect(agoLabel(null, 1000)).toBe("never");
  });

  it("stays legible across the range that matters", () => {
    const now = 100_000_000;
    expect(agoLabel(now - 10, now)).toBe("just now");
    expect(agoLabel(now - 600, now)).toBe("10 min ago");
    expect(agoLabel(now - 7200, now)).toBe("2 h ago");
    // Three weeks is the number this exists for: a sync broken that long and a
    // working one look identical until a disk dies.
    expect(agoLabel(now - 21 * 86400, now)).toBe("21 days ago");
  });

  it("does not go backwards when a clock does", () => {
    expect(agoLabel(1000, 500)).toBe("just now");
  });
});

describe("what a pull could not decide", () => {
  it("names the project rather than the ids nobody can read", () => {
    const c = questionCopy({
      kind: "duplicate", arrivingId: "ws-a", localId: "ws-b", name: "cowork-deck",
      basis: "repository",
    });
    expect(c.text).toContain("cowork-deck");
    expect(c.text).not.toContain("ws-a");
  });

  it("offers both answers to a duplicate, and promises neither is destructive", () => {
    const c = questionCopy({
      kind: "duplicate", arrivingId: "ws-a", localId: "ws-b", name: "deck",
      basis: "repository",
    });
    expect(c.primary).toBeTruthy();
    expect(c.secondary).toBeTruthy();
    // Merging means one of two memories stops being findable under the
    // surviving id. Saying so is the whole reason this is asked at all.
    expect(c.text).toMatch(/nothing is deleted/i);
    expect(c.text).toMatch(/both machines' history/i);
  });

  /** #359: a pair recognised by its folder is not "the same repository", and
   *  neither record arrived from anywhere — both are on this machine. Saying
   *  otherwise describes something that is not on screen. */
  it("does not claim a repository for a pair recognised by its folder", () => {
    const c = questionCopy({
      kind: "duplicate", arrivingId: "ws-a", localId: "ws-b", name: "claude-config",
      basis: "folder",
    });
    expect(c.text).toContain("claude-config");
    expect(c.text).toMatch(/same folder/i);
    expect(c.text).not.toMatch(/same repository/i);
    expect(c.text).not.toMatch(/another machine/i);
    expect(c.text).toMatch(/nothing is deleted/i);
  });

  /** A folder match means "no repository *recorded*", which is all the deck
   *  checked. A folder whose remote is called something the old build could not
   *  see reaches this sentence too, and "it has no git remote" would be a claim
   *  about that folder nobody made (#359). */
  it("says the repository is unrecorded rather than absent", () => {
    const c = questionCopy({
      kind: "duplicate", arrivingId: "ws-a", localId: "ws-b", name: "claude-config",
      basis: "folder",
    });
    expect(c.text).toMatch(/neither has a repository recorded/i);
    expect(c.text).not.toMatch(/no git remote/i);
  });

  it("says what a workspace with no folder here can still do meanwhile", () => {
    const c = questionCopy({
      kind: "needs-path", workspaceId: "ws-a", name: "deck", cloneFrom: null,
    });
    expect(c.text).toMatch(/memory is searchable/i);
    expect(c.secondary).toBeNull();
  });

  it("names the repository when there is one, so it can be cloned first", () => {
    const c = questionCopy({
      kind: "needs-path", workspaceId: "ws-a", name: "deck",
      cloneFrom: "https://github.com/me/deck.git",
    });
    expect(c.text).toContain("https://github.com/me/deck.git");
  });

  it("explains that a board path could not travel, rather than that it vanished", () => {
    const c = questionCopy({ kind: "needs-board-path", workspaceId: "ws-a", name: "deck" });
    expect(c.text).toMatch(/could not travel/i);
    expect(c.primary).toMatch(/board/i);
  });

  it("counts in a way that does not read as a bug in the code", () => {
    expect(questionCountLabel(1)).toBe("1 thing to answer");
    expect(questionCountLabel(3)).toBe("3 things to answer");
  });
});
