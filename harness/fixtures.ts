/* Fixture data for the screenshot harness.
 *
 * Everything here is invented: the accounts, the repositories, the paths and the
 * scrollback. Nothing in this file may be copied from a real machine — the point
 * of shooting the README against a harness is that no real account, customer or
 * absolute path ends up on the repository's front page.
 *
 * The shapes mirror `src/ipc.ts` exactly, because the app is booted for real
 * against them: a field missing here is a field missing in the running UI.
 */

import type {
  BoardConfig, GhStatus, MergeOptions, PrDetail, PrDiff, ProviderCapabilities,
  PullRequest, ScheduleRun, SessionEntry, Skill, Task, TokenUsage, UiState, Workspace,
} from "../src/ipc";

/** One fixed clock for the whole fixture, so every "2 hours ago" agrees with
 *  every other one within a single run. */
export const NOW = Date.now();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

/* --- Workspaces, scenarios, sessions ------------------------------------- */

export const WS_RELAY = "ws-relay";
export const WS_HARBOR = "ws-harbor";
export const WS_ATLAS = "ws-atlas";

export const workspaces: Workspace[] = [
  {
    id: WS_RELAY, name: "relay", path: "/home/dev/code/relay", color: "#7bd77f",
    github: { host: "github.com", login: "acme-dev", gitName: "Acme Dev", gitEmail: "dev@acme.example" },
    tracker: { providers: [{ type: "fs", root: { kind: "project" } }] },
  },
  {
    id: WS_HARBOR, name: "harbor", path: "/home/dev/code/harbor", color: "#efc845",
    github: { host: "github.com", login: "acme-release", gitName: "Acme Release", gitEmail: "release@acme.example" },
    tracker: { providers: [{ type: "github" }] },
  },
  {
    id: WS_ATLAS, name: "atlas", path: "/home/dev/code/atlas", color: "#d5eaf3",
    github: null, tracker: null,
  },
];

export const skills: Skill[] = [
  {
    id: "sk-review", name: "Review the diff", icon: "search", workspaceId: null,
    prompt: "Review the working tree against {{branch}} and report what would fail in CI.",
  },
  {
    id: "sk-sweep", name: "Nightly dependency sweep", icon: "shield", workspaceId: WS_RELAY,
    prompt: "Update the lockfile, run the suite, and open a pull request if it is green.",
    schedule: { preset: { kind: "daily", hour: 3, minute: 0 }, defaults: {}, enabled: true },
  },
  {
    id: "sk-notes", name: "Write the release notes", icon: "book", workspaceId: WS_RELAY,
    prompt: "Summarise everything merged since the last tag as release notes.",
  },
];

/** 03:00 today and 03:00 tomorrow, so the row's own words agree with the rule it
 *  prints beside them. */
const at3 = (dayOffset: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(3, 0, 0, 0);
  return d.getTime();
};

export const scheduleState: Record<string, ScheduleRun> = {
  "sk-sweep": {
    lastAttempt: at3(0),
    lastRun: at3(0),
    lastOutcome: "launched",
    nextRunMs: at3(1),
  },
};

/** The card the live session is working on — referenced by both the board and
 *  the restored layout below, so the "in progress" chip is real rather than
 *  drawn by hand. */
export const LIVE_CARD_ID = "01JQ8F2K7M";

export const S_WORK = "s-work-01";
export const S_WAIT = "s-wait-02";
export const S_DONE = "s-done-03";
export const S_ERR = "s-err-04";

export const layout: SessionEntry[] = [
  {
    sessionId: S_WORK, cwd: "/home/dev/code/relay", workspaceId: WS_RELAY,
    name: "☑ Retry the refund webhook on a 410", taskId: LIVE_CARD_ID,
  },
  {
    sessionId: S_WAIT, cwd: "/home/dev/code/relay", workspaceId: WS_RELAY,
    name: "🔍 Review the diff",
  },
  {
    sessionId: S_DONE, cwd: "/home/dev/code/relay", workspaceId: WS_RELAY,
    name: "🛡 Nightly dependency sweep", scheduledSkillId: "sk-sweep",
  },
  {
    sessionId: S_ERR, cwd: "/home/dev/code/relay-pr/128-flaky-timer", workspaceId: WS_RELAY,
    name: "⑂ #128",
  },
];

export const gitByCwd: Record<string, { branch: string | null; dirty: boolean }> = {
  "/home/dev/code/relay": { branch: "main", dirty: true },
  "/home/dev/code/relay-pr/128-flaky-timer": { branch: "fix-flaky-timer", dirty: false },
  "/home/dev/code/harbor": { branch: "main", dirty: false },
  "/home/dev/code/atlas": { branch: "release/3.2", dirty: false },
};

export const tokens: Record<string, TokenUsage> = {
  [S_WORK]: { input: 48_300, output: 6_120, cacheCreation: 12_400, cacheRead: 214_000 },
  [S_WAIT]: { input: 12_900, output: 1_840, cacheCreation: 3_100, cacheRead: 61_500 },
  [S_DONE]: { input: 91_700, output: 9_430, cacheCreation: 20_800, cacheRead: 412_000 },
  [S_ERR]: { input: 4_200, output: 610, cacheCreation: 900, cacheRead: 8_100 },
};

/* --- Terminal scrollback -------------------------------------------------- */

const O = "\x1b[38;5;215m", G = "\x1b[38;5;114m", R = "\x1b[38;5;203m";
const D = "\x1b[2m", B = "\x1b[1m", C = "\x1b[38;5;110m", X = "\x1b[0m";

const lines = (...l: string[]) => l.join("\r\n") + "\r\n";

/** A tile in the 2×2 deck is about 48 columns wide, so every line here is
 *  written to fit inside 46 — a wrapped line in a screenshot reads as a bug in
 *  the app rather than as a narrow terminal. */
const COLS = 46;
const bare = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A permission box, padded from the visible width rather than by hand: the
 *  colour escapes are zero-width and counting them is how the right edge ends up
 *  ragged. */
function promptBox(...rows: string[]): string {
  const inner = COLS - 4;
  const bar = (s: string) => `${D}│${X} ${s}${" ".repeat(Math.max(0, inner - bare(s).length))} ${D}│${X}`;
  return [
    `${D}╭${"─".repeat(COLS - 2)}╮${X}`,
    ...rows.map(bar),
    `${D}╰${"─".repeat(COLS - 2)}╯${X}`,
  ].join("\r\n") + "\r\n";
}

export const scrollback: Record<string, string> = {
  [S_WORK]: lines(
    `${D}> Retry the refund webhook on a 410${X}`,
    "",
    `${O}⏺${X} Reading the retry policy first.`,
    "",
    `${O}⏺${X} ${B}Read${X}(src/webhooks/retry_policy.rs)`,
    `  ${D}⎿  Read 214 lines${X}`,
    "",
    `${O}⏺${X} ${B}Search${X}(pattern: "RETRYABLE")`,
    `  ${D}⎿  Found 6 matches in 3 files${X}`,
    "",
    `${O}⏺${X} A 410 is classed with the 5xx family, so`,
    `  a dead endpoint is retried on the same`,
    `  schedule as a busy one.`,
    "",
    `${O}⏺${X} ${B}Update${X}(src/webhooks/retry_policy.rs)`,
    `  ${D}⎿  Updated with 18 additions${X}`,
    `  ${D}⎿  and 4 removals${X}`,
    "",
    `${O}⏺${X} ${B}Update${X}(tests/retry_policy.rs)`,
    `  ${D}⎿  Updated with 61 additions${X}`,
    "",
    `${O}⏺${X} ${B}Bash${X}(cargo test -p webhooks retry)`,
    `  ${D}⎿  running 12 tests${X}`,
    `  ${D}⎿  ${X}${G}ok. 12 passed; 0 failed${X}`,
    "",
    `${O}⏺${X} The verdict is right. What is left is the`,
    `  backoff: the worker builds a fresh policy`,
    `  on boot, so a restart starts the ladder`,
    `  again at one second.`,
    "",
    `${O}✻${X} Resetting the backoff on restart…`,
    `  ${D}(21s · ↑ 2.1k tokens · esc to interrupt)${X}`,
  ),
  [S_WAIT]: lines(`${O}⏺${X} The suite has to run before I touch the timer.`, "")
    + promptBox(
      `${B}Bash command${X}`,
      "",
      `${C}npm test -- tests/webhook.test.ts${X}`,
      `${D}Run the webhook suite${X}`,
      "",
      "Do you want to proceed?",
      `${O}❯ 1. Yes${X}`,
      "  2. Yes, and don't ask again",
      "  3. No, and tell Claude what to do",
    ),
  [S_DONE]: lines(
    `${O}⏺${X} ${B}Bash${X}(npm update --save && npm test)`,
    `  ${D}⎿  changed 14 packages in 6s${X}`,
    `  ${D}⎿  ${X}${G}Test Files  38 passed (38)${X}`,
    `  ${D}⎿  ${X}${G}     Tests  412 passed (412)${X}`,
    "",
    `${O}⏺${X} ${B}Bash${X}(gh pr create --fill)`,
    `  ${D}⎿  acme-labs/relay/pull/161${X}`,
    "",
    `${O}⏺${X} The sweep is done. Fourteen packages`,
    `  moved, the suite is green, and #161 is`,
    `  open with the lockfile diff.`,
    "",
    `${D}> ${X}`,
  ),
  [S_ERR]: lines(
    `${O}⏺${X} ${B}Bash${X}(cargo test -p relay timer)`,
    `  ${D}⎿  ${X}${R}error: linker \`cc\` not found${X}`,
    `  ${D}⎿  ${X}${R}error: could not compile \`relay\`${X}`,
    "",
    `${R}⏺${X} The toolchain in this worktree cannot`,
    `  link. I stopped rather than guess at a`,
    `  build environment.`,
    "",
    `${D}[process exited with code 101]${X}`,
  ),
};

/* --- The file board (relay) ----------------------------------------------- */

export const fileBoard: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "Todo" },
    { id: "doing", label: "Doing", working: true },
    { id: "shipped", label: "Shipped", terminal: true },
  ],
  kinds: [
    { id: "bug", label: "bug" },
    { id: "feature", label: "feature" },
    { id: "chore", label: "chore" },
    { id: "spike", label: "spike" },
  ],
};

const card = (
  id: string, title: string, kind: string, status: string, agoMs: number,
  body: string, origin: "human" | "session" = "human", resolvedAgo?: number,
): Task => ({
  id, title, kind, status, project: "relay",
  created: iso(agoMs),
  resolved: resolvedAgo === undefined ? null : iso(resolvedAgo),
  origin, session: null, body,
  path: `/home/dev/code/relay/.cowork/tasks/${id}.md`,
  damaged: null, conflict: false, labels: [],
});

export const fileTasks: Task[] = [
  card("01JQ7A1B2C", "Cache the git status between deck polls", "chore", "backlog", 9 * DAY,
    "Every tile asks for `git status` on its own five-second tick. One read per\nunique working copy would do."),
  card("01JQ7C4D5E", "Spike: swap the ad-hoc queue for a channel", "spike", "backlog", 7 * DAY,
    "Timebox to a day. The question is whether back-pressure can be expressed\nwithout the retry table."),
  card("01JQ7F6G7H", "Sidebar count flickers on the first paint", "bug", "backlog", 6 * DAY,
    "The badge renders 0 before the first count lands, then jumps."),
  card("01JQ7G8H9J", "Retire the v0 delivery endpoint", "chore", "backlog", 10 * DAY,
    "Two integrators are still on it. Announce first, remove after the next release."),
  card("01JQ7H2J3K", "Remember which session groups are collapsed", "feature", "backlog", 11 * DAY,
    "The sidebar re-expands every group on restart."),
  card("01JQ7J8K9L", "Paginate the audit log endpoint", "feature", "todo", 5 * DAY,
    "`GET /v1/audit-log` returns the whole table. Cursor paging, 100 rows a page."),
  card("01JQ7M1N2P", "Refund worker logs the raw payload", "bug", "todo", 4 * DAY,
    "Found while reading the retry code: the worker logs the whole delivery body,\ncard numbers included.", "session"),
  card("01JQ7Q3R4S", "Document the webhook signature scheme", "chore", "todo", 3 * DAY,
    "The header format is only written down in a test."),
  card("01JQ7T5V6W", "Add a smoke test for the scheduler", "chore", "todo", 3 * DAY,
    "Catch-up on launch has no test at all."),
  card("01JQ7X7Y8Z", "Board loses the label filter on a poll tick", "bug", "todo", 2 * DAY,
    "Pressing a label and waiting thirty seconds clears it."),
  card(LIVE_CARD_ID, "Retry the refund webhook on a 410", "bug", "doing", 2 * DAY,
    "A 410 is terminal: the subscription is gone. Stop retrying it and disable\nthe subscription instead."),
  // No session runs on this one, which the board says out loud: ▶ moves the card
  // itself, so a crashed session would otherwise read as work in progress.
  card("01JQ8A1B2C", "Move the export worker off the request thread", "feature", "doing", 4 * DAY,
    "Started before the refund work jumped the queue."),
  card("01JQ8H3J4K", "Rate-limit the export endpoint", "feature", "shipped", 12 * DAY,
    "Sixty exports an hour per token.", "human", 20 * HOUR),
  card("01JQ8L5M6N", "Fix the flaky timer test", "bug", "shipped", 14 * DAY,
    "The test asserted on wall-clock time.", "human", 2 * DAY),
  card("01JQ8P7Q8R", "Bump tauri to 2.4", "chore", "shipped", 16 * DAY,
    "Nothing in the release notes touches what we use.", "session", 3 * DAY),
  card("01JQ8S9T1V", "Warn when a workspace folder disappears", "feature", "shipped", 18 * DAY,
    "An unmounted volume used to fail silently on every launch.", "human", 5 * DAY),
];

export const fileCaps: ProviderCapabilities = {
  canCreate: true, canResolve: true,
  statuses: ["backlog", "todo", "doing", "shipped"],
  board: fileBoard, boardError: null, boardEditable: true,
};

/* --- The GitHub board (harbor) -------------------------------------------- */

export const REPO = "acme-labs/harbor";

export const githubBoard: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
  kinds: [],
};

export const githubCaps: ProviderCapabilities = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  board: githubBoard, boardError: null, boardEditable: false,
};

const issue = (
  n: number, title: string, status: "open" | "closed", agoMs: number,
  labels: string[], body: string, origin: "human" | "session" = "human", closedAgo?: number,
): Task => ({
  // Empty, exactly as `gh_issues.rs` writes it: nothing on an issue maps to a
  // kind, and `kindLabel` omits the chip for "".
  id: String(n), title, kind: "", status, project: "harbor",
  created: iso(agoMs),
  resolved: status === "closed" ? iso(closedAgo ?? agoMs / 2) : null,
  origin, session: null, body,
  path: `https://github.com/${REPO}/issues/${n}`,
  damaged: null, conflict: false, labels,
});

/** The one the dialog is shot on: a title long enough to wrap, and a body with a
 *  heading, a code span and a quote so the Markdown rendering is visibly
 *  rendering rather than merely reflowed. */
export const DIALOG_ISSUE = 150;

export const issues: Task[] = [
  issue(152, "Delivery worker holds a connection open after the subscription is deleted", "open",
    3 * HOUR, ["bug", "webhooks"],
    "The pool never drops it, so a deleted subscription still costs a slot until\nthe worker restarts."),
  issue(151, "Add a `--since` flag to the export command", "open", 8 * HOUR, ["feature", "cli"],
    "Exporting the whole history to diff two days is wasteful."),
  issue(DIALOG_ISSUE,
    "Refund webhook retries forever when the endpoint answers 410 Gone, and the backoff never resets between attempts",
    "open", 26 * HOUR, ["bug", "webhooks", "priority"],
    "## What happens\n\n"
    + "A subscription whose endpoint answers `410 Gone` is retried on the same schedule as one\n"
    + "answering `503`. The backoff resets to one second whenever the worker restarts, so a dead\n"
    + "endpoint is polled forever.\n\n"
    + "> Over one weekend we delivered 41,000 times to a single endpoint that had been gone since\n"
    + "> Friday afternoon.\n\n"
    + "## What should happen\n\n"
    + "`410` is terminal — the subscription is gone, not busy. Mark it dead, stop retrying, and\n"
    + "emit `webhook.subscription.disabled` so the dashboard can say why.\n\n"
    + "- [ ] classify `410` as terminal in `RetryPolicy`\n"
    + "- [ ] persist the backoff across a worker restart\n"
    + "- [ ] a test that a dead endpoint is dropped after one attempt\n"),
  issue(149, "Signature header is documented only in a test", "open", 2 * DAY, ["docs"],
    "`X-Harbor-Signature` is not in the public docs at all."),
  issue(148, "Rate limiter counts preflight requests", "open", 2 * DAY, ["bug", "api"],
    "An OPTIONS request costs a token from the caller's bucket."),
  issue(147, "Export job runs out of memory over 2M rows", "open", 3 * DAY, ["bug", "performance"],
    "The whole result set is materialised before the first byte is written."),
  issue(146, "Retry metrics have no subscription dimension", "open", 4 * DAY, ["feature", "observability"],
    "You can see that retries are up and not which endpoint is causing it."),
  issue(145, "Document the sandbox environment's limits", "open", 5 * DAY, ["docs", "good first issue"],
    "New integrators hit the 100-delivery cap without warning."),
  issue(144, "Idempotency keys are case-sensitive", "open", 6 * DAY, ["bug", "api"],
    "Two clients sending the same key in different cases get two charges."),
  issue(143, "Webhook replay should be available from the dashboard", "open", 8 * DAY, ["feature", "webhooks"],
    "Support currently replays by hand with a script.", "session"),
  issue(142, "Signature verification fails on a payload with a BOM", "open", 9 * DAY,
    ["bug", "webhooks"],
    "Two integrators send UTF-8 with a byte order mark; we hash the raw bytes and they do not."),
  issue(141, "Audit log query is unindexed on `actor_id`", "open", 11 * DAY, ["performance"],
    "Sequential scan over 40M rows on every filtered read."),
  issue(140, "Delivery detail view does not show past attempts", "open", 12 * DAY,
    ["bug", "observability"],
    "Support has to read the worker log to answer “how many times did you try?”."),
  issue(139, "Clarify which errors are retryable in the docs", "open", 14 * DAY, ["docs", "good first issue"],
    "The table lists status codes but not what the worker does with them."),
  issue(138, "Delivery latency p99 doubled after the 3.1 rollout", "closed", 16 * DAY,
    ["performance", "priority"], "Traced to the new signature hashing on the hot path.", "human", 9 * DAY),
  issue(136, "Support `HEAD` on the subscription endpoint", "closed", 20 * DAY, ["feature", "api"],
    "Used by integrators to check liveness cheaply.", "human", 12 * DAY),
  issue(134, "Typo in the quickstart curl example", "closed", 22 * DAY, ["docs", "good first issue"],
    "`--data-raw` was spelled `--data-row`.", "human", 21 * DAY),
];

export const openCount = issues.filter((i) => i.status === "open").length;
export const closedCount = issues.filter((i) => i.status === "closed").length;

/* --- Pull requests (harbor) ----------------------------------------------- */

export const pullRequests: PullRequest[] = [
  {
    number: 157, title: "Treat 410 as terminal in the retry policy", author: "acme-dev",
    isDraft: false, headRefName: "issue-150-refund-webhook-410", headRefOid: "9f3c1ab",
    baseRefName: "main", isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED",
    checks: { kind: "running", done: 3, total: 5 }, mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED", updatedAt: iso(11 * MIN),
    url: `https://github.com/${REPO}/pull/157`, labels: ["bug", "webhooks"],
  },
  {
    number: 155, title: "Paginate /v1/audit-log with an opaque cursor", author: "acme-dev",
    isDraft: false, headRefName: "audit-log-paging", headRefOid: "4b7e902",
    baseRefName: "main", isCrossRepository: false, reviewDecision: "APPROVED",
    checks: { kind: "passed", total: 8 }, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", updatedAt: iso(2 * HOUR),
    url: `https://github.com/${REPO}/pull/155`, labels: ["feature", "api"],
  },
  {
    number: 153, title: "Bump tauri to 2.4.1", author: "acme-release",
    isDraft: true, headRefName: "deps/tauri-2.4.1", headRefOid: "c10d55e",
    baseRefName: "main", isCrossRepository: false, reviewDecision: null,
    checks: { kind: "none" }, mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED", updatedAt: iso(5 * HOUR),
    url: `https://github.com/${REPO}/pull/153`, labels: ["chore"],
  },
  {
    number: 151, title: "Rework the delivery worker's backoff", author: "quinn-ops",
    isDraft: false, headRefName: "worker-backoff", headRefOid: "77aa3f1",
    baseRefName: "main", isCrossRepository: true, reviewDecision: "CHANGES_REQUESTED",
    checks: { kind: "failed", failed: 2, total: 9 }, mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY", updatedAt: iso(29 * HOUR),
    url: `https://github.com/${REPO}/pull/151`, labels: ["bug", "performance"],
  },
  {
    number: 149, title: "Document the webhook signature scheme", author: "acme-dev",
    isDraft: false, headRefName: "docs-signature", headRefOid: "20fe4c8",
    baseRefName: "main", isCrossRepository: false, reviewDecision: "APPROVED",
    checks: { kind: "passed", total: 3 }, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", updatedAt: iso(3 * DAY),
    url: `https://github.com/${REPO}/pull/149`, labels: ["docs"],
  },
];

const FILES_157 = [
  { path: "src/webhooks/retry_policy.rs", additions: 34, deletions: 9 },
  { path: "src/webhooks/worker.rs", additions: 12, deletions: 3 },
  { path: "src/events/subscription.rs", additions: 8, deletions: 0 },
  { path: "tests/retry_policy.rs", additions: 61, deletions: 2 },
  { path: "docs/webhooks/retries.md", additions: 17, deletions: 5 },
];

export const prDetails: Record<number, PrDetail> = {
  157: {
    body: "Closes #150.\n\n"
      + "`410 Gone` now ends a delivery chain instead of joining the 5xx schedule: the\n"
      + "subscription is marked dead, `webhook.subscription.disabled` is emitted, and the\n"
      + "attempt counter is persisted so a worker restart no longer resets the backoff.\n\n"
      + "The test covers both halves — a dead endpoint is dropped after one attempt, and a\n"
      + "restart mid-chain resumes at the attempt it was on.",
    additions: 132, deletions: 19, changedFiles: 5, files: FILES_157,
  },
};

export const prDiffs: Record<number, PrDiff> = {
  157: {
    headRefOid: "9f3c1ab",
    totalFiles: 5,
    files: [
      {
        path: "src/webhooks/retry_policy.rs", previousPath: null, status: "modified",
        additions: 34, deletions: 9,
        blobUrl: `https://github.com/${REPO}/blob/9f3c1ab/src/webhooks/retry_policy.rs`,
        omitted: null,
        hunks: [
          {
            header: "@@ -12,14 +12,24 @@ use crate::events::Subscription;",
            oldStart: 12, newStart: 12,
            lines: [
              " /// What the worker does with a delivery that did not succeed.",
              " #[derive(Debug, Clone, Copy, PartialEq, Eq)]",
              " pub enum Verdict {",
              "     /// Try again after the backoff.",
              "     Retry,",
              "-    /// Give up on this attempt.",
              "-    Drop,",
              "+    /// Give up on this attempt, but keep the subscription.",
              "+    Drop,",
              "+    /// The endpoint is gone. Stop retrying and disable the subscription.",
              "+    Terminal,",
              " }",
              " ",
              " impl RetryPolicy {",
              "-    const RETRYABLE: [u16; 5] = [408, 410, 429, 500, 503];",
              "+    const RETRYABLE: [u16; 4] = [408, 429, 500, 503];",
              "+    /// Answered by an endpoint that no longer exists. Retrying it is not",
              "+    /// patience, it is 41,000 deliveries over a weekend — see #150.",
              "+    const TERMINAL: [u16; 1] = [410];",
              " ",
              "     pub fn verdict(&self, status: u16, attempt: u32) -> Verdict {",
              "+        if Self::TERMINAL.contains(&status) {",
              "+            return Verdict::Terminal;",
              "+        }",
              "         if !Self::RETRYABLE.contains(&status) {",
              "             return Verdict::Drop;",
              "         }",
            ],
          },
          {
            header: "@@ -41,9 +51,19 @@ impl RetryPolicy {",
            oldStart: 41, newStart: 51,
            lines: [
              "     /// Delay before attempt `n`, capped at an hour.",
              "     pub fn backoff(&self, attempt: u32) -> Duration {",
              "-        // Reset by construction: the worker builds a fresh policy on boot,",
              "-        // so a restart mid-chain starts the delay over at one second.",
              "-        let secs = 1u64 << attempt.min(12);",
              "+        // The attempt now comes off the stored delivery, not off this",
              "+        // struct, so a restart resumes where the chain was rather than",
              "+        // starting the ladder again.",
              "+        let secs = 1u64 << attempt.min(12);",
              "         Duration::from_secs(secs.min(3600))",
              "     }",
              "+",
              "+    /// Persisted with the delivery so the ladder survives a restart.",
              "+    pub fn attempt_of(delivery: &Delivery) -> u32 {",
              "+        delivery.attempts",
              "+    }",
              " }",
            ],
          },
        ],
      },
      {
        path: "src/webhooks/worker.rs", previousPath: null, status: "modified",
        additions: 12, deletions: 3,
        blobUrl: `https://github.com/${REPO}/blob/9f3c1ab/src/webhooks/worker.rs`,
        omitted: null, hunks: [],
      },
      {
        path: "src/events/subscription.rs", previousPath: null, status: "modified",
        additions: 8, deletions: 0,
        blobUrl: `https://github.com/${REPO}/blob/9f3c1ab/src/events/subscription.rs`,
        omitted: null, hunks: [],
      },
      {
        path: "tests/retry_policy.rs", previousPath: null, status: "modified",
        additions: 61, deletions: 2,
        blobUrl: `https://github.com/${REPO}/blob/9f3c1ab/tests/retry_policy.rs`,
        omitted: null, hunks: [],
      },
      {
        path: "docs/webhooks/retries.md", previousPath: null, status: "modified",
        additions: 17, deletions: 5,
        blobUrl: `https://github.com/${REPO}/blob/9f3c1ab/docs/webhooks/retries.md`,
        omitted: null, hunks: [],
      },
    ],
  },
};

/** Any row the shots do not open still has to answer for itself. */
export const genericDetail = (n: number): PrDetail => ({
  body: `See the branch for what this changes. (#${n} carries no fixture of its own.)`,
  additions: 21, deletions: 6, changedFiles: 2,
  files: [
    { path: "src/lib.rs", additions: 15, deletions: 4 },
    { path: "tests/lib.rs", additions: 6, deletions: 2 },
  ],
});

export const genericDiff = (n: number): PrDiff => ({
  headRefOid: "0000000", totalFiles: 2,
  files: genericDetail(n).files.map((f) => ({
    path: f.path, previousPath: null, status: "modified",
    additions: f.additions, deletions: f.deletions,
    blobUrl: `https://github.com/${REPO}/blob/HEAD/${f.path}`,
    omitted: null, hunks: [],
  })),
});

export const mergeOptions: MergeOptions = {
  strategies: ["squash", "merge"], default: "squash", repoDeletesBranch: true,
};

/* --- Odds and ends -------------------------------------------------------- */

export const uiState: UiState = { activeWorkspaceId: WS_RELAY, uiScale: 1, prDiffCols: 96 };

export const ghStatus: GhStatus = {
  path: "/usr/bin/gh", version: "2.62.0",
  accounts: [
    { host: "github.com", login: "acme-dev", active: true, scopes: ["repo", "read:org"], state: "ok" },
    { host: "github.com", login: "acme-release", active: false, scopes: ["repo"], state: "ok" },
  ],
};

export const openCounts: Record<string, number> = {
  [WS_RELAY]: fileTasks.filter((t) => t.status !== "shipped").length,
  [WS_HARBOR]: openCount,
};
