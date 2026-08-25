import { describe, expect, it } from "vitest";
import { agoLabel, blockedCopy, faultCopy, repoCopy } from "../src/sync-copy";
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
