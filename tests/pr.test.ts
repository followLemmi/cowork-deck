import { describe, it, expect } from "vitest";
import {
  ago, canMerge, checksLabel, pollIntervalMs, reviewLabel, sortPrs,
  POLL_FAST_MS, POLL_SLOW_MS,
} from "../src/pr";
import type { PullRequest } from "../src/ipc";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1, title: "t", author: "a", isDraft: false,
  headRefName: "h", headRefOid: "oid", baseRefName: "main",
  isCrossRepository: false, reviewDecision: null,
  checks: { kind: "passed", total: 1 },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  updatedAt: "2026-07-29T12:00:00Z", url: "u", labels: [],
  ...over,
});

describe("canMerge", () => {
  it("allows a clean, mergeable pull request", () => {
    expect(canMerge(pr())).toEqual({ ok: true });
  });

  // Each refusal names its own cause: "cannot merge" without a reason sends
  // people to the browser to find out why.
  it("refuses a draft", () => {
    const r = canMerge(pr({ isDraft: true }));
    expect(r).toEqual({ ok: false, reason: "This pull request is still a draft." });
  });

  it("refuses on conflicts", () => {
    const r = canMerge(pr({ mergeable: "CONFLICTING" }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("conflict");
  });

  it("refuses while the branch protection blocks it", () => {
    const r = canMerge(pr({ mergeStateStatus: "BLOCKED" }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("blocked");
  });

  it("refuses while checks are still running", () => {
    const r = canMerge(pr({ checks: { kind: "running", done: 1, total: 3 } }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("running");
  });

  // Not a refusal: a repository with no required checks is a normal repository,
  // and GitHub itself allows the merge.
  it("allows a pull request with no checks at all", () => {
    expect(canMerge(pr({ checks: { kind: "none" } }))).toEqual({ ok: true });
  });

  it("refuses when mergeability is still unknown", () => {
    const r = canMerge(pr({ mergeable: "UNKNOWN" }));
    expect(r.ok).toBe(false);
  });
});

describe("checksLabel", () => {
  it("never calls an unchecked pull request green", () => {
    expect(checksLabel({ kind: "none" })).toBe("no checks");
    expect(checksLabel({ kind: "passed", total: 3 })).toBe("3 passed");
    expect(checksLabel({ kind: "running", done: 1, total: 3 })).toBe("1/3 running");
    expect(checksLabel({ kind: "failed", failed: 2, total: 5 })).toBe("2 of 5 failed");
  });
});

describe("reviewLabel", () => {
  it("renders each verdict, and says nothing when there is none", () => {
    expect(reviewLabel("APPROVED")).toBe("approved");
    expect(reviewLabel("CHANGES_REQUESTED")).toBe("changes requested");
    expect(reviewLabel("REVIEW_REQUIRED")).toBe("review required");
    expect(reviewLabel(null)).toBe("");
  });
});

describe("sortPrs", () => {
  // Whatever needs a decision comes first; drafts are nobody's next action.
  it("puts failures first and drafts last", () => {
    const failed = pr({ number: 1, checks: { kind: "failed", failed: 1, total: 1 } });
    const plain = pr({ number: 2 });
    const draft = pr({ number: 3, isDraft: true });
    expect(sortPrs([draft, plain, failed]).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("breaks ties by most recently updated", () => {
    const older = pr({ number: 1, updatedAt: "2026-07-01T00:00:00Z" });
    const newer = pr({ number: 2, updatedAt: "2026-07-28T00:00:00Z" });
    expect(sortPrs([older, newer]).map((p) => p.number)).toEqual([2, 1]);
  });
});

describe("ago", () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  it("reads as a person would say it", () => {
    expect(ago("2026-07-29T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-07-29T11:45:00Z", now)).toBe("15 min ago");
    expect(ago("2026-07-29T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-07-26T12:00:00Z", now)).toBe("3 d ago");
  });

  it("does not invent a time from an unparseable stamp", () => {
    expect(ago("nonsense", now)).toBe("unknown");
  });
});

describe("pollIntervalMs", () => {
  it("polls fast while any job is running", () => {
    expect(pollIntervalMs([pr({ checks: { kind: "running", done: 0, total: 2 } })]))
      .toBe(POLL_FAST_MS);
  });

  it("slows down once everything has settled", () => {
    expect(pollIntervalMs([pr(), pr({ checks: { kind: "failed", failed: 1, total: 1 } })]))
      .toBe(POLL_SLOW_MS);
  });

  it("slows down on an empty list rather than hammering an idle repository", () => {
    expect(pollIntervalMs([])).toBe(POLL_SLOW_MS);
  });
});
