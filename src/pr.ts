import type { ChecksSummary, PullRequest } from "./ipc";

/** While something is building, the answer changes in under a minute. */
export const POLL_FAST_MS = 15_000;
/** Once it has settled, only a human action changes anything. */
export const POLL_SLOW_MS = 60_000;

export type MergeVerdict = { ok: true } | { ok: false; reason: string };

/** Whether merge may be offered, and if not, why — the reason is shown on the
 *  disabled button, so a refusal never arrives after the click. */
export function canMerge(pr: PullRequest): MergeVerdict {
  if (pr.isDraft) return { ok: false, reason: "This pull request is still a draft." };
  if (pr.mergeable === "CONFLICTING") {
    return { ok: false, reason: "The branch has conflicts with its base." };
  }
  if (pr.mergeable !== "MERGEABLE") {
    return { ok: false, reason: "GitHub has not finished working out whether this can merge." };
  }
  if (pr.checks.kind === "running") {
    return { ok: false, reason: "Checks are still running." };
  }
  // BEHIND and DIRTY are covered by `mergeable` above; BLOCKED is the branch
  // protection case, which `mergeable` reports as MERGEABLE.
  if (pr.mergeStateStatus === "BLOCKED") {
    return { ok: false, reason: "Merging is blocked — a required review or check is missing." };
  }
  return { ok: true };
}

export function checksLabel(c: ChecksSummary): string {
  switch (c.kind) {
    case "none": return "no checks";
    case "running": return `${c.done}/${c.total} running`;
    case "passed": return `${c.total} passed`;
    case "failed": return `${c.failed} of ${c.total} failed`;
  }
}

export function reviewLabel(d: string | null): string {
  switch (d) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "review required";
    default: return "";
  }
}

/** Rank: what needs a decision first, drafts last. */
function rank(pr: PullRequest): number {
  if (pr.isDraft) return 3;
  if (pr.checks.kind === "failed") return 0;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return 0;
  return 1;
}

export function sortPrs(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function pollIntervalMs(prs: PullRequest[]): number {
  return prs.some((p) => p.checks.kind === "running") ? POLL_FAST_MS : POLL_SLOW_MS;
}
