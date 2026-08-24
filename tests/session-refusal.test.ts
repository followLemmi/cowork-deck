import { describe, it, expect } from "vitest";
import { sessionRefusal, SESSION_NOT_OWNER, SESSION_GONE } from "../src/session-refusal";

/** The other half of `ownership.rs`. The two literals cross the language
 *  boundary and cannot be shared, so each side is pinned to them by a test —
 *  written out here rather than imported, since importing the constant would
 *  only make this test agree with itself.
 *
 *  A drift would be silent and would undo the whole point of having two
 *  refusals: an unrecognised one falls through to "something else went wrong",
 *  which is a console error on every keystroke that lands after a close. */
describe("sessionRefusal", () => {
  it("recognises the two refusals Rust sends", () => {
    expect(sessionRefusal("not-owner")).toBe(SESSION_NOT_OWNER);
    expect(sessionRefusal("no-session")).toBe(SESSION_GONE);
  });

  /** `invoke` rejects with the string for a `Result<_, String>`, but a rejection
   *  that has been through an Error on the way must still be readable. */
  it("reads a refusal that arrived wrapped in an Error", () => {
    expect(sessionRefusal(new Error("not-owner"))).toBe(SESSION_NOT_OWNER);
  });

  it("says nothing for a failure that is neither", () => {
    expect(sessionRefusal("Broken pipe (os error 32)")).toBeNull();
    expect(sessionRefusal(undefined)).toBeNull();
    expect(sessionRefusal({ code: "not-owner" })).toBeNull();
  });

  /** Whole-string, not a substring: a PTY error that happened to mention a
   *  session must not be read as this window being stale and silently dropped. */
  it("matches the whole message and not a part of it", () => {
    expect(sessionRefusal("write failed: no-session handling")).toBeNull();
  });
});
