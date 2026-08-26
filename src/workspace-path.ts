// A workspace that arrived over sync names a folder on another computer.
//
// The question is asked when the person first opens that workspace, not as a
// wall of them after the first pull: someone with a dozen projects wants the one
// they came for, and the other eleven can wait.

import type { Workspace } from "./ipc";

/** A workspace is usable as a record without a folder — its memory is
 *  searchable, its scenarios are listed — so this is about what to ask, not
 *  about what to hide. */
export function needsLocalPath(ws: Pick<Workspace, "path"> | null | undefined): boolean {
  return !!ws && ws.path.trim() === "";
}

/** What a person answered, and what happens next time.
 *
 *  `later` is a first-class answer, not a dismissal: it stays available and the
 *  workspace stays usable. It is remembered for this run only — asking again
 *  next launch is the difference between a reminder and a thing you can lose. */
export type PathAnswer = "picked" | "cloned" | "later";

export class PathPrompts {
  private asked = new Set<string>();

  /** Whether to put the question up now. */
  shouldAsk(ws: Pick<Workspace, "id" | "path"> | null | undefined): boolean {
    if (!ws || !needsLocalPath(ws)) return false;
    return !this.asked.has(ws.id);
  }

  /** Record that it was put up, whatever the answer. Called for `later` too —
   *  re-asking on every click between two workspaces would make the answer
   *  meaningless. */
  markAsked(id: string): void {
    this.asked.add(id);
  }

  /** A path arrived from somewhere else — the workspace form, a clone — so the
   *  question is settled and a later visit must not raise it again. */
  resolved(id: string): void {
    this.asked.add(id);
  }
}

/** The sentence the deck shows when a session is refused for want of a folder.
 *
 *  Matched on the marker rather than the prose, the way `unavailableFrom` reads
 *  the `gh` states: the backend appends the marker and the wording either side
 *  of it is free to change. */
export function isNoLocalPath(message: unknown): boolean {
  return typeof message === "string" && message.includes("no-local-path:");
}
