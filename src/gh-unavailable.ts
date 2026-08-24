/** The three states in which a GitHub-backed view cannot work at all, and the
 *  sentence each one shows. Two views draw them — the pull request list and the
 *  board — so the prose exists once: both can be unavailable for exactly the same
 *  three reasons, and two copies would drift apart.
 *
 *  Its own module rather than one of the two views: while these lived in
 *  `pr-view.ts` the board imported its user-facing copy from the pull request
 *  view, and one sentence had that view's vocabulary baked in — an issues board
 *  with no `gh` installed told the person their *pull requests* could not be
 *  read. Neither view's name belongs on the shared file. */
export type GhUnavailable = "no-gh" | "no-account" | "no-repo";

/** What the calling view is reading, named in the sentence so each screen speaks
 *  about itself. A closed union rather than a free string: the vocabulary both
 *  screens use is worth being able to read in one place. */
export type GhSubject = "pull requests" | "issues";

/** `action` is the label of the button that fixes it, or null when nothing in the
 *  app can — a dead button is worse than none. */
export function ghUnavailable(
  u: GhUnavailable, subject: GhSubject,
): { text: string; action: string | null } {
  switch (u) {
    case "no-gh":
      return {
        text: `The gh command-line tool is not installed, so ${subject} cannot be read.`,
        action: "Set up gh",
      };
    // Neither of the two below names the subject: what is missing is the account
    // and the remote, which is the same fact on either screen. They take
    // `subject` all the same, through the one signature, so a future rewording
    // that *does* want the noun has it to hand.
    case "no-account":
      return {
        text: "This workspace has no GitHub account bound, so there is no account to read as.",
        action: "Bind an account",
      };
    case "no-repo":
      return {
        text: "This workspace is not a git repository with a GitHub remote.",
        action: null,
      };
  }
}
