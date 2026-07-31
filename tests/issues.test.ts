import { describe, it, expect } from "vitest";
import {
  ISSUE_POLL_MS, FILE_POLL_MS, boardPollMs, OPEN_PAGE_LIMIT, needsTotals, countLine,
  needsCloseConfirmation, closeConfirmText, RATE_WARN_BELOW, rateLimitBanner, sourceOf,
  unavailableFrom, repoFromIssueUrl,
} from "../src/issues";
import type { BoardConfig, TrackerConfig } from "../src/ipc";

const GH: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
  kinds: [{ id: "issue", label: "Issue" }],
};

describe("the poll interval", () => {
  // 30 s, and one interval rather than two: nothing on an issue changes on its
  // own the way a check run does, so the PR view's fast/slow split has no
  // analogue. Far slower than the board's blind 5 s, because at that rate one
  // workspace would spend 14.4% of the hourly GraphQL budget.
  it("is 30 seconds for a github board and unchanged for a file one", () => {
    expect(ISSUE_POLL_MS).toBe(30_000);
    expect(boardPollMs("github")).toBe(ISSUE_POLL_MS);
    expect(boardPollMs("fs")).toBe(FILE_POLL_MS);
    expect(FILE_POLL_MS).toBe(5_000);
  });
});

describe("the totals call", () => {
  // A page that came back with fewer rows than the cap *is* the total —
  // "showing 12 of 12" needs no second call — so the only moment the totals
  // query can change the message is the moment the page is capped. In a
  // repository with fewer than 50 open issues it never fires at all.
  it("fires only when the open page came back full", () => {
    expect(needsTotals(12)).toBe(false);
    expect(needsTotals(OPEN_PAGE_LIMIT - 1)).toBe(false);
    expect(needsTotals(OPEN_PAGE_LIMIT)).toBe(true);
  });

  it("is skipped for an empty repository", () => {
    expect(needsTotals(0)).toBe(false);
  });
});

describe("the count line", () => {
  it("has two real numbers when the page was capped", () => {
    expect(countLine(50, 63)).toBe("Showing 50 of 63 open issues.");
  });

  // Absent on a short page: the list is the whole truth there, and a line
  // saying so is noise on every render.
  it("is absent on a short page and when no total is known", () => {
    expect(countLine(12, 12)).toBeNull();
    expect(countLine(50, null)).toBeNull();
  });

  // The total can be lower than the page if an issue closed between the two
  // calls. Saying "showing 50 of 49" would look like a bug in the app rather
  // than a moment's inconsistency at GitHub.
  it("is absent when the total has fallen below what is on screen", () => {
    expect(countLine(50, 49)).toBeNull();
  });
});

describe("the close confirmation", () => {
  // A close is visible to the whole repository; a reopen restores the state of
  // a moment ago. Same asymmetry, same reason, as the pull request view's.
  it("is asked in the closing direction only", () => {
    expect(needsCloseConfirmation(GH, "open", "closed")).toBe(true);
    expect(needsCloseConfirmation(GH, "closed", "open")).toBe(false);
    expect(needsCloseConfirmation(GH, "open", "open")).toBe(false);
  });

  // The file board writes a local file; nothing there is worth a modal, and
  // adding one would change a shipped board's behaviour for no reason.
  it("is never asked on a board that has no such asymmetry", () => {
    const fs: BoardConfig = {
      v: 1,
      steps: [{ id: "todo", label: "To do" }, { id: "done", label: "Done", terminal: true }],
      kinds: [{ id: "task", label: "Task" }],
    };
    expect(needsCloseConfirmation(fs, "todo", "done", "fs")).toBe(false);
  });

  it("names the issue and offers both reasons", () => {
    const t = closeConfirmText(42, "Sidebar badge sticks");
    expect(t).toContain("#42");
    expect(t).toContain("Sidebar badge sticks");
    expect(t).toContain("everyone in the repository");
  });
});

describe("the rate limit banner", () => {
  // Detected proactively, never by matching the refusal's message: that text is
  // unverified — the refusal could not be provoked safely — and a string match
  // on an unobserved message is a guess that fails on the one day it matters.
  it("appears below the threshold and says the fix is to wait", () => {
    const b = rateLimitBanner(RATE_WARN_BELOW - 1);
    expect(b).not.toBeNull();
    expect(b).toContain("stop refreshing");
  });

  it("is absent with a healthy budget and absent when nothing is known", () => {
    expect(rateLimitBanner(RATE_WARN_BELOW)).toBeNull();
    expect(rateLimitBanner(4873)).toBeNull();
    // Null, not zero: an absent header must never read as exhausted.
    expect(rateLimitBanner(null)).toBeNull();
  });
});

describe("unavailableFrom", () => {
  /// The messages as they actually arrive, wrapped: a GitHub failure comes back
  /// through `TaskError::Io`, whose Display prefixes "filesystem error: ". So
  /// this matches on a marker inside the message and never on the whole string —
  /// an equality check would recognise none of these.
  it("recognises the three states a GitHub source cannot work in", () => {
    expect(unavailableFrom("filesystem error: gh-not-found")).toBe("no-gh");
    expect(unavailableFrom("no-account")).toBe("no-account");
    expect(unavailableFrom("filesystem error: no git remotes found")).toBe("no-repo");
    expect(unavailableFrom("fatal: not a git repository")).toBe("no-repo");
    expect(unavailableFrom("none of the git remotes point at GitHub")).toBe("no-repo");
  });

  /// The important half. Everything else — offline, rate-limited, a missing
  /// scope, HTTP 502 — keeps the last good list on screen beside the error, and
  /// mapping one of those onto a screen would replace real data with a wrong
  /// explanation. A missing scope in particular is exit 1 with nothing on stdout.
  it("maps anything it does not recognise to null rather than to a screen", () => {
    expect(unavailableFrom("HTTP 502")).toBeNull();
    expect(unavailableFrom("filesystem error: your token has not been granted 'repo'")).toBeNull();
    expect(unavailableFrom("API rate limit exceeded")).toBeNull();
    expect(unavailableFrom("")).toBeNull();
  });
});

describe("repoFromIssueUrl", () => {
  it("reads owner/name off the issue's own URL", () => {
    expect(repoFromIssueUrl("https://github.com/followLemmi/cowork-deck/issues/42"))
      .toBe("followLemmi/cowork-deck");
  });

  /// An enterprise host is not github.com, and nothing here may assume it is:
  /// the owner and the name are the two segments before `issues`, whatever the
  /// host.
  it("works on an enterprise host", () => {
    expect(repoFromIssueUrl("https://github.acme.example/team/tools/issues/7")).toBe("team/tools");
  });

  /// Found by searching for the `issues` segment from the end rather than by
  /// indexing: a repository may legitimately be called `issues`, and taking
  /// positions 1 and 2 would be right only by luck.
  it("survives an owner or a repository called issues", () => {
    expect(repoFromIssueUrl("https://github.com/issues/issues/issues/1")).toBe("issues/issues");
  });

  /// The empty string, never a guess and never a throw: this feeds the prompt,
  /// and a card file's `path` is a filesystem path rather than a URL.
  it("falls back to the empty string on anything it cannot read", () => {
    expect(repoFromIssueUrl("/home/u/vault/Tasks/01AAA-pill.md")).toBe("");
    expect(repoFromIssueUrl("https://github.com/o/issues/42")).toBe("");
    expect(repoFromIssueUrl("not a url at all")).toBe("");
    expect(repoFromIssueUrl("")).toBe("");
  });
});

describe("sourceOf", () => {
  it("reads the workspace's one configured source", () => {
    expect(sourceOf({ providers: [{ type: "github" }] })).toBe("github");
    expect(sourceOf({ providers: [{ type: "fs", root: { kind: "project" } }] })).toBe("fs");
    expect(sourceOf(null)).toBe("fs");
    // A record from a future build, or an empty list: treated as file-backed,
    // which is the conservative answer — it polls slowly and asks for no token.
    expect(sourceOf({ providers: [] } as TrackerConfig)).toBe("fs");
  });
});
