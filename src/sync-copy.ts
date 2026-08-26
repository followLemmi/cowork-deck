// The words sync says, in one place.
//
// Its own module for the reason `gh-unavailable.ts` is one: these sentences are
// read by the dialog and asserted by the tests, and a copy in each would let the
// two drift until a test passes against wording nobody ships.

import type { SyncBlocked, SyncFault, SyncRepoState } from "./ipc";
import { ghUnavailable } from "./gh-unavailable";

/** What stands between a person and switching sync on.
 *
 *  Delegated to `ghUnavailable` rather than reworded: it already owns the two
 *  sentences and the label of the button that fixes each, and it exists because
 *  the same reasons were being worded differently on two screens. A third
 *  wording here would be that mistake with one more copy. */
export function blockedCopy(b: SyncBlocked): { text: string; action: string | null } {
  return ghUnavailable(b === "no-gh" ? "no-gh" : "no-account", "issues");
}

/** What a fault says, and what to do about it.
 *
 *  Every fault names its own next step. A single "sync failed" would have
 *  nothing to offer, which is how an indicator becomes something people learn to
 *  ignore. */
export function faultCopy(f: SyncFault): { text: string; action: string | null } {
  switch (f.kind) {
    case "offline":
      return {
        // Not phrased as a failure, because it is not one and it clears itself.
        text: "No connection, so nothing has been sent yet. This resolves itself.",
        action: null,
      };
    case "conflict":
      return {
        // Named files, and no offer to resolve them. Notes are prose: an
        // automatic merge produces a plausible paragraph nobody wrote.
        text:
          `Two machines changed the same lines. Sync has stopped until this is `
          + `settled by hand: ${f.files.join(", ")}`,
        action: "Show me",
      };
    case "push-rejected":
      return {
        text: `The remote would not accept the last push: ${f.message}`,
        action: "Try again",
      };
    case "auth-gone":
      return {
        // Says the token, not the account. #150 is the standing instance of
        // this going wrong — a revoked token reported as "no account bound",
        // which the person can see is false.
        text: `The GitHub account sync uses is no longer accepted: ${f.message}`,
        action: "Fix the account",
      };
    case "format-newer":
      return {
        text:
          `That repository was written by a newer version of the deck `
          + `(format ${f.found}; this build understands ${f.supported}). Sync has `
          + `stopped rather than write to it. Everything still works locally.`,
        action: null,
      };
  }
}

/** Whether a repository can be adopted, and why not when it cannot. */
export function repoCopy(r: SyncRepoState): { ok: boolean; text: string } {
  switch (r.kind) {
    case "empty":
      return { ok: true, text: "Empty, and ready to use." };
    case "ours":
      return { ok: true, text: "A deck repository. Your memory from another machine is in it." };
    case "ours-newer":
      return {
        ok: false,
        text:
          `Written by a newer version of the deck (format ${r.format}). Update `
          + `before connecting, or this build would write a store the other machine `
          + `can no longer read.`,
      };
    case "foreign":
      return {
        ok: false,
        text:
          "That repository already has content that is not the deck's. Connecting "
          + "would commit your session history into somebody's project.",
      };
    case "missing":
      return { ok: false, text: "No such repository, or this account cannot see it." };
    case "unknown":
      // Never offered as "create it": a repository that already exists, created
      // again, is two repositories and a memory split between them.
      return { ok: false, text: `That repository could not be checked: ${r.why}` };
  }
}

/** "3 weeks ago", for the one number that matters most.
 *
 *  A sync broken for three weeks and one working look identical from outside
 *  until a disk dies and the remote turns out to be a month stale. */
export function agoLabel(then: number | null, now: number): string {
  if (then === null) return "never";
  const s = Math.max(0, now - then);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
