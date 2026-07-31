import type { BoardConfig, StepId, TrackerConfig } from "./ipc";
import { isTerminal } from "./board-config";
import type { GhUnavailable } from "./pr-view";

/** Which source a workspace's board reads. */
export type TaskSource = "fs" | "github";

/** One interval, not two. Nothing on an issue changes on its own the way a check
 *  run does, so the PR view's two-speed poll has no analogue here. Faster than
 *  that view's settled 60 s because a board is the screen you sit on while
 *  triaging; far slower than the board's current blind 5 s, which at 720 calls an
 *  hour is 14.4% of the GraphQL budget for one workspace. */
export const ISSUE_POLL_MS = 30_000;
/** The file board's own cadence, unchanged. It reads a directory, so it costs
 *  nothing but a stat — what changes in Task 22 is that it is finally gated. */
export const FILE_POLL_MS = 5_000;

export function boardPollMs(source: TaskSource): number {
  return source === "github" ? ISSUE_POLL_MS : FILE_POLL_MS;
}

/** All open issues in one page, and the number the count line is measured
 *  against. Mirrors `gh_issues::OPEN_PAGE_LIMIT`. */
export const OPEN_PAGE_LIMIT = 50;

/** Whether the totals query can still change the answer. A page shorter than the
 *  cap *is* the total, so the only moment worth a second call is a capped page —
 *  which is what makes the count both honest and free. */
export function needsTotals(openOnPage: number, limit = OPEN_PAGE_LIMIT): boolean {
  return openOnPage >= limit;
}

/** "Showing 50 of 63 open issues.", or nothing at all.
 *
 *  Absent on a short page, absent with no total, and absent when the total has
 *  fallen below what is on screen — an issue closed between the two calls is a
 *  moment's inconsistency at GitHub, and "showing 50 of 49" would read as a bug
 *  in the app. */
export function countLine(shown: number, total: number | null): string | null {
  if (total === null || total <= shown) return null;
  return `Showing ${shown} of ${total} open issues.`;
}

/** Whether a move needs confirming before it is sent.
 *
 *  Only for a GitHub board, and only in the closing direction. A close is visible
 *  to the whole repository and undoing it is a second public action; a reopen
 *  restores the state of a moment ago. The same asymmetry, for the same reason,
 *  as the pull request view's merge confirmation. */
export function needsCloseConfirmation(
  cfg: BoardConfig, from: StepId, to: StepId, source: TaskSource = "github",
): boolean {
  if (source !== "github") return false;
  return from !== to && isTerminal(cfg, to) && !isTerminal(cfg, from);
}

export function closeConfirmText(number: number | string, title: string): string {
  return `Close issue #${number}, “${title}”? A closed issue is visible to everyone in the `
    + "repository.";
}

/** GraphQL points below which the board says so. At the worst steady rate — a
 *  capped page, so three points every 30 s — the board spends 360 points an hour,
 *  so this is under an hour of headroom: late enough not to be permanent noise on
 *  a shared token, early enough that "wait" is still actionable. */
export const RATE_WARN_BELOW = 250;

/** One sentence, because the fix is "wait", not "retry".
 *
 *  Driven by `X-Ratelimit-Remaining` from the totals call's own response headers,
 *  never by matching the refusal's text: that text is unverified, and a handler
 *  keyed on it would be a guess dressed as a check. `null` means the headers said
 *  nothing and must never read as exhausted. */
export function rateLimitBanner(remaining: number | null): string | null {
  if (remaining === null || remaining >= RATE_WARN_BELOW) return null;
  return "GitHub's hourly API budget is nearly used up — the board will stop refreshing shortly.";
}

/** The markers that name an unavailability, as data rather than an if-chain, and
 *  matched with `includes` because the message arrives wrapped: a GitHub failure
 *  reaches the frontend through `TaskError::Io`, whose Display prefixes
 *  "filesystem error: ". `gh-not-found` and `no-account` are the backend's own
 *  words (`commands.rs:424-425`); the three `no-repo` markers are `gh`'s. */
const UNAVAILABLE_MARKERS: { marker: string; state: GhUnavailable }[] = [
  { marker: "gh-not-found", state: "no-gh" },
  { marker: "no-account", state: "no-account" },
  { marker: "no git remotes", state: "no-repo" },
  { marker: "not a git repository", state: "no-repo" },
  { marker: "none of the git remotes", state: "no-repo" },
];

/** Which unavailability an error names, or null for everything else.
 *
 *  One table for both GitHub views: the pull request list grew this mapping first
 *  and read it as an if-chain of its own, which is one place for the two to
 *  disagree about what "no repository" looks like.
 *
 *  **`gh`'s exit code is not part of this, and cannot be.** Exit 4 is `gh`'s own
 *  "authentication required" and would be a far better signal than any string —
 *  but `run_gh_for_workspace` returns `Err(redacted stderr)` and drops the status
 *  (`commands.rs:451-453`), so no exit code reaches the frontend at all. Keying on
 *  a guessed *phrase* for that state instead was considered and refused: the
 *  message is unobserved, and a match on an unobserved message is a guess that
 *  fails on the one day it matters. Everything unrecognised stays an ordinary
 *  error, which keeps the last good list on screen beside it — the conservative
 *  outcome. A missing *scope* is exit 1 with nothing on stdout and belongs in that
 *  group too. */
export function unavailableFrom(message: string): GhUnavailable | null {
  return UNAVAILABLE_MARKERS.find((m) => message.includes(m.marker))?.state ?? null;
}

/** `owner/name` from an issue's own URL, or `""`.
 *
 *  The launch needs the repository for the prompt, and the issue's `path` is
 *  already that URL — so this replaces a second IPC command and its failure mode
 *  with a pure read of a value the board already has.
 *
 *  The segments are found by searching for `issues` from the end rather than by
 *  taking positions 1 and 2: a repository may legitimately be called `issues`,
 *  and the host is not assumed to be github.com. Anything unreadable — a card
 *  file's filesystem path, a truncated URL — is `""` rather than a throw or a
 *  guess; `issuePrompt` says nothing about the repository in that case. */
export function repoFromIssueUrl(url: string): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return ""; }
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.lastIndexOf("issues");
  if (at < 2) return "";
  return `${parts[at - 2]}/${parts[at - 1]}`;
}

/** A workspace's one task source. `TrackerConfig.providers` is a list so a second
 *  kind arrives as an added variant, and every reader — here and in Rust — takes
 *  the first. Anything unrecognised reads as file-backed: the conservative
 *  answer, since that path polls slowly and asks for no token. */
export function sourceOf(tracker: TrackerConfig | null | undefined): TaskSource {
  return tracker?.providers[0]?.type === "github" ? "github" : "fs";
}
