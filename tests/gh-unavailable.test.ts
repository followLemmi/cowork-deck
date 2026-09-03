/** The three states in which a GitHub-backed view cannot work at all.
 *
 *  Untested until now (#463), and the reason this module exists is a bug the
 *  tests below pin: while these sentences lived in `pr-view.ts`, the board
 *  imported its user-facing copy from the pull request view — so an issues board
 *  on a machine with no `gh` told the person their *pull requests* could not be
 *  read. One shared sentence with the wrong noun in it is worse than two.
 */
import { describe, it, expect } from "vitest";
import { ghUnavailable, type GhSubject, type GhUnavailable } from "../src/gh-unavailable";

const ALL: GhUnavailable[] = ["no-gh", "no-account", "no-repo"];
const SUBJECTS: GhSubject[] = ["pull requests", "issues"];

describe("every unavailability", () => {
  it("says something, and never says nothing", () => {
    for (const u of ALL) {
      for (const s of SUBJECTS) {
        const c = ghUnavailable(u, s);
        expect(c.text.length).toBeGreaterThan(20);
        expect(c.text.endsWith(".")).toBe(true);
      }
    }
  });

  /** A dead button is worse than none, so `action` is null where nothing in the
   *  app can fix it — and `no-repo` is that case: the app cannot give a folder a
   *  GitHub remote. */
  it("offers a button only where the app can act", () => {
    expect(ghUnavailable("no-gh", "issues").action).toBe("Set up gh");
    expect(ghUnavailable("no-account", "issues").action).toBe("Bind an account");
    expect(ghUnavailable("no-repo", "issues").action).toBeNull();
  });
});

describe("the subject", () => {
  /** THE bug this module was extracted for. An issues board with no `gh` must
   *  not say "pull requests". */
  it("is the caller's own, where the sentence names one", () => {
    expect(ghUnavailable("no-gh", "issues").text).toContain("issues");
    expect(ghUnavailable("no-gh", "issues").text).not.toContain("pull requests");
    expect(ghUnavailable("no-gh", "pull requests").text).toContain("pull requests");
  });

  /** And the two that do NOT name it: what is missing is the account and the
   *  remote, which is the same fact on either screen. They take `subject` all the
   *  same, through the one signature, so a rewording that wants the noun has it. */
  it("is left out where the fact is not about either screen", () => {
    for (const u of ["no-account", "no-repo"] as GhUnavailable[]) {
      const a = ghUnavailable(u, "issues");
      const b = ghUnavailable(u, "pull requests");
      expect(a).toEqual(b);
      expect(a.text).not.toContain("issues");
      expect(a.text).not.toContain("pull requests");
    }
  });
});

describe("the vocabulary", () => {
  /** Each sentence has to name what is missing rather than merely report a
   *  failure: "gh", "account" and "repository" are the three words a person can
   *  act on, and the copy is the only place they appear. */
  it("names the thing that is missing", () => {
    expect(ghUnavailable("no-gh", "issues").text).toContain("gh");
    expect(ghUnavailable("no-account", "issues").text).toContain("account");
    expect(ghUnavailable("no-repo", "issues").text).toContain("repository");
  });
});
