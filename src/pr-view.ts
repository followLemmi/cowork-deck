import type { PullRequest } from "./ipc";
import { ago, canMerge, checksLabel, reviewLabel, sortPrs } from "./pr";

/** The three states in which a GitHub-backed view cannot work at all. Shared with
 *  the board, so the three sentences exist once: the board's source can be
 *  unavailable for exactly the same three reasons, and two copies of the prose
 *  would drift. */
export type GhUnavailable = "no-gh" | "no-account" | "no-repo";
export type PrUnavailable = GhUnavailable;

export interface PrState {
  workspace: string | null;
  /** Non-null when the view cannot work at all — never rendered as an empty list. */
  unavailable: PrUnavailable | null;
  prs: PullRequest[];
  /** Last failure. The list stays on screen beside it. */
  error: string | null;
  /** When `prs` was fetched. Null before the first successful fetch. */
  fetchedAt: number | null;
  /** How many came back, so a capped page can say so. */
  total: number | null;
}

export interface PrHandlers {
  onLaunch: (pr: PullRequest) => void;
  onMerge: (pr: PullRequest) => void;
  onClose: (pr: PullRequest) => void;
  onReopen: (pr: PullRequest) => void;
  onRefresh: () => void;
  onFixUnavailable: (u: PrUnavailable) => void;
}

export const GH_UNAVAILABLE: Record<GhUnavailable, { text: string; action: string | null }> = {
  "no-gh": {
    text: "The gh command-line tool is not installed, so pull requests cannot be read.",
    action: "Set up gh",
  },
  "no-account": {
    text: "This workspace has no GitHub account bound, so there is no account to read as.",
    action: "Bind an account",
  },
  "no-repo": {
    text: "This workspace is not a git repository with a GitHub remote.",
    action: null,
  },
};
/** The name the rest of this file has always used. Kept so nothing below moves. */
const UNAVAILABLE = GH_UNAVAILABLE;

const PAGE_LIMIT = 50;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always textContent: titles, branches and logins come from the network.
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PrView {
  readonly mount = el("div", "pr-view");
  constructor(private h: PrHandlers) {}

  render(state: PrState, now: number) {
    this.mount.replaceChildren();

    const head = el("div", "pr-head");
    head.append(el("h3", "pr-title-head", "Pull requests"));
    const refresh = el("button", "pr-refresh", "↻");
    refresh.title = "Refresh";
    refresh.onclick = () => this.h.onRefresh();
    head.append(refresh);
    // Shown on every render, not only on failure: data that can be stale has
    // to say how stale.
    head.append(el("span", "pr-age",
      state.fetchedAt === null ? "never loaded" : `updated ${ago(new Date(state.fetchedAt).toISOString(), now)}`));
    this.mount.append(head);

    if (state.unavailable) {
      const spec = UNAVAILABLE[state.unavailable];
      const box = el("div", "pr-unavailable");
      box.append(el("p", "pr-unavailable-text", spec.text));
      if (spec.action) {
        const fix = el("button", "pr-fix", spec.action);
        const u = state.unavailable;
        fix.onclick = () => this.h.onFixUnavailable(u);
        box.append(fix);
      }
      this.mount.append(box);
      return;
    }

    if (state.error) this.mount.append(el("p", "pr-error", state.error));

    if (state.prs.length === 0) {
      this.mount.append(el("div", "pr-empty", "No open pull requests."));
      return;
    }

    for (const pr of sortPrs(state.prs)) this.mount.append(this.row(pr, now));

    if (state.total !== null && state.total >= PAGE_LIMIT) {
      this.mount.append(el("p", "pr-capped",
        `Showing the first ${PAGE_LIMIT} — the repository has more open.`));
    }
  }

  private row(pr: PullRequest, now: number): HTMLElement {
    const row = el("div", "pr-row");

    const main = el("div", "pr-main");
    main.append(el("span", "pr-number", `#${pr.number}`));
    main.append(el("span", "pr-title", pr.title));
    if (pr.isDraft) main.append(el("span", "pr-draft", "draft"));
    row.append(main);

    const meta = el("div", "pr-meta");
    meta.append(el("span", "pr-author", pr.author || "unknown author"));
    meta.append(el("span", "pr-branches", `${pr.headRefName} → ${pr.baseRefName}`));
    meta.append(el("span", `pr-checks pr-checks--${pr.checks.kind}`, checksLabel(pr.checks)));
    const review = reviewLabel(pr.reviewDecision);
    if (review) meta.append(el("span", "pr-review", review));
    meta.append(el("span", "pr-updated", ago(pr.updatedAt, now)));
    for (const l of pr.labels) meta.append(el("span", "pr-label", l));
    row.append(meta);

    const actions = el("div", "pr-actions");

    const launch = el("button", "pr-launch", "▶");
    launch.title = "Start a session on this branch, in a worktree of its own";
    launch.onclick = () => this.h.onLaunch(pr);
    actions.append(launch);

    const verdict = canMerge(pr);
    const merge = el("button", "pr-merge", "Merge");
    merge.disabled = !verdict.ok;
    // The reason travels with the disabled button, so the refusal is readable
    // before the click rather than after it.
    merge.title = verdict.ok ? "Merge this pull request" : verdict.reason;
    merge.onclick = () => { if (verdict.ok) this.h.onMerge(pr); };
    actions.append(merge);

    const close = el("button", "pr-close", "Close");
    close.onclick = () => this.h.onClose(pr);
    actions.append(close);

    // An anchor, not a button with a handler: the project has no URL-opening
    // plugin, and `github-screen.ts` already links out exactly this way.
    // Whether Tauri routes target=_blank to the system browser is unverified
    // there too — it is on the manual checklist in Task 13.
    const open = el("a", "pr-open", "Open in browser");
    open.href = pr.url;
    open.target = "_blank";
    open.rel = "noreferrer";
    actions.append(open);

    row.append(actions);
    return row;
  }
}
