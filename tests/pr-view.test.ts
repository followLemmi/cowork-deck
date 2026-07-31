// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { PrView, type PrHandlers, type PrState } from "../src/pr-view";
import type { PrDetail, PullRequest } from "../src/ipc";

const NOW = Date.parse("2026-07-29T12:00:00Z");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "fix the thing", author: "octocat", isDraft: false,
  headRefName: "fix/thing", headRefOid: "abc1234", baseRefName: "main",
  isCrossRepository: false, reviewDecision: null,
  checks: { kind: "passed", total: 2 },
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  updatedAt: "2026-07-29T11:45:00Z", url: "https://example.test/pr/7", labels: [],
  ...over,
});

const state = (over: Partial<PrState> = {}): PrState => ({
  workspace: "cowork-deck", unavailable: null, prs: [pr()],
  error: null, fetchedAt: NOW, total: 1, loading: false, ...over,
});

function mk(): { view: PrView; h: PrHandlers } {
  const h: PrHandlers = {
    onLaunch: vi.fn(), onMerge: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
    onRefresh: vi.fn(), onFixUnavailable: vi.fn(),
    onDetail: vi.fn().mockResolvedValue({
      body: "", additions: 0, deletions: 0, changedFiles: 0, files: [],
    }),
  };
  const view = new PrView(h);
  document.body.replaceChildren(view.mount);
  return { view, h };
}

beforeEach(() => { document.body.replaceChildren(); });

describe("PrView", () => {
  it("renders number, title, author and the branch pair", () => {
    const { view } = mk();
    view.render(state(), NOW);
    const row = document.querySelector(".pr-row")!;
    expect(row.textContent).toContain("#7");
    expect(row.textContent).toContain("fix the thing");
    expect(row.textContent).toContain("octocat");
    expect(row.textContent).toContain("fix/thing → main");
  });

  // The regression this guards: a title arriving from the network must never
  // be parsed as markup.
  it("never renders a title as HTML", () => {
    const { view } = mk();
    view.render(state({ prs: [pr({ title: "<img src=x onerror=alert(1)>" })] }), NOW);
    expect(document.querySelector(".pr-row img")).toBeNull();
    expect(document.querySelector(".pr-title")!.textContent)
      .toBe("<img src=x onerror=alert(1)>");
  });

  it("distinguishes all four check states", () => {
    const { view } = mk();
    const seen = new Set<string>();
    for (const checks of [
      { kind: "none" }, { kind: "passed", total: 1 },
      { kind: "running", done: 1, total: 2 }, { kind: "failed", failed: 1, total: 2 },
    ] as PullRequest["checks"][]) {
      view.render(state({ prs: [pr({ checks })] }), NOW);
      const badge = document.querySelector(".pr-checks")!;
      seen.add(badge.className + "|" + badge.textContent);
    }
    expect(seen.size).toBe(4);
  });

  it("disables merge and names the reason", () => {
    const { view, h } = mk();
    view.render(state({ prs: [pr({ isDraft: true })] }), NOW);
    const btn = document.querySelector<HTMLButtonElement>(".pr-merge")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("draft");
    btn.click();
    expect(h.onMerge).not.toHaveBeenCalled();
  });

  it("hands merge the pull request when it is allowed", () => {
    const { view, h } = mk();
    view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-merge")!.click();
    expect(h.onMerge).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }));
  });

  it("shows how old the data is, always", () => {
    const { view } = mk();
    view.render(state({ fetchedAt: NOW - 120_000 }), NOW);
    expect(document.querySelector(".pr-age")!.textContent).toContain("2 min ago");
  });

  // Serving a stale list silently is the failure mode this guards against.
  it("keeps the list and explains itself when a refresh fails", () => {
    const { view } = mk();
    view.render(state({ error: "rate limit exceeded", fetchedAt: NOW - 300_000 }), NOW);
    expect(document.querySelectorAll(".pr-row")).toHaveLength(1);
    const err = document.querySelector(".pr-error")!;
    expect(err.textContent).toContain("rate limit exceeded");
    expect(document.querySelector(".pr-age")!.textContent).toContain("5 min ago");
  });

  it("says how many were left out rather than truncating in silence", () => {
    const { view } = mk();
    view.render(state({ total: 50 }), NOW);
    expect(document.querySelector(".pr-capped")!.textContent).toContain("50");
  });

  it("offers the next step for each unavailable state", () => {
    const { view, h } = mk();
    for (const u of ["no-gh", "no-account", "no-repo"] as const) {
      view.render(state({ unavailable: u, prs: [] }), NOW);
      const btn = document.querySelector<HTMLButtonElement>(".pr-fix");
      expect(document.querySelector(".pr-unavailable")!.textContent!.length)
        .toBeGreaterThan(10);
      if (u !== "no-repo") {
        btn!.click();
        expect(h.onFixUnavailable).toHaveBeenCalledWith(u);
      }
    }
  });

  // The board draws the same three states, and one sentence named this view's
  // subject there too. The subject is the caller's to supply now, so this pins
  // what *this* view supplies: a screen-neutral "GitHub cannot be read" would be
  // a regression here, not a fix.
  it("names pull requests when gh is missing", () => {
    const { view } = mk();
    view.render(state({ unavailable: "no-gh", prs: [] }), NOW);
    expect(document.querySelector(".pr-unavailable-text")!.textContent)
      .toBe("The gh command-line tool is not installed, so pull requests cannot be read.");
  });

  it("says nothing is open, distinctly from being unavailable", () => {
    const { view } = mk();
    view.render(state({ prs: [], total: 0 }), NOW);
    expect(document.querySelector(".pr-empty")).not.toBeNull();
    expect(document.querySelector(".pr-unavailable")).toBeNull();
  });

  /// "No open pull requests" is a claim about the repository, and one `gh pr list`
  /// on a slow network is long enough for it to be read and believed. Skeleton rows
  /// say the truth instead — and never over a list that is merely a minute old.
  it("draws skeleton rows while a first read is in flight, never over a list", async () => {
    const { view } = mk();
    view.render(state({ loading: true, prs: [], fetchedAt: null }), NOW);
    expect(document.querySelectorAll(".pr-skeleton-row").length).toBeGreaterThan(0);
    expect(document.querySelector(".pr-empty")).toBeNull();

    view.render(state({ loading: true }), NOW);
    expect(document.querySelector(".pr-skeleton")).toBeNull();
    expect(document.querySelectorAll(".pr-row").length).toBe(1);
  });
});

/** The disclosure: a row's description and diffstat, on demand.
 *
 *  Fetched here and not in the list call, so every one of these is also a claim
 *  about how many requests the view makes. */
describe("expanding a pull request", () => {
  const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
    body: "Fixes the thing.\n\n- one\n- two",
    additions: 12, deletions: 3, changedFiles: 2,
    files: [
      { path: "src/board.ts", additions: 10, deletions: 3 },
      { path: "src/styles.css", additions: 2, deletions: 0 },
    ],
    ...over,
  });

  const toggle = () => document.querySelector<HTMLButtonElement>(".pr-toggle")!;

  it("asks for nothing until a row is opened, then once", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail());
    view.render(state(), NOW);
    expect(h.onDetail).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    toggle().click();
    await flush();
    expect(h.onDetail).toHaveBeenCalledTimes(1);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".pr-detail-stat")?.textContent)
      .toBe("2 files changed · +12 −3");
    expect(document.querySelector(".pr-detail-body")?.textContent).toContain("Fixes the thing.");
    expect([...document.querySelectorAll(".pr-detail-path")].map((n) => n.textContent))
      .toEqual(["src/board.ts", "src/styles.css"]);
  });

  /// A poll every 15 s must not fold an open row shut, and must not re-ask for what
  /// it already has: the row has not moved on, so neither has its description.
  it("survives a re-render without asking again", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail());
    view.render(state(), NOW);
    toggle().click();
    await flush();
    view.render(state(), NOW);
    expect(document.querySelector(".pr-detail")).not.toBeNull();
    expect(h.onDetail).toHaveBeenCalledTimes(1);
  });

  /// A push changes the description and the diffstat both, so a panel still showing
  /// the previous commit's numbers beside a row that says "just now" is worse than an
  /// empty one. The row's own `updatedAt` is what says so.
  it("re-fetches when the pull request has moved on", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail());
    view.render(state(), NOW);
    toggle().click();
    await flush();

    (h.onDetail as Mock).mockResolvedValue(detail({ changedFiles: 5, additions: 99, deletions: 0 }));
    view.render(state({ prs: [pr({ updatedAt: "2026-07-29T11:59:00Z" })] }), NOW);
    await flush();
    expect(h.onDetail).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".pr-detail-stat")?.textContent)
      .toBe("5 files changed · +99 −0");
  });

  it("closes again, and asks for nothing to do it", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail());
    view.render(state(), NOW);
    toggle().click();
    await flush();
    toggle().click();
    expect(document.querySelector(".pr-detail")).toBeNull();
    expect(h.onDetail).toHaveBeenCalledTimes(1);
  });

  /// One panel that cannot be read is not the list failing: the row above it keeps
  /// its rows and its buttons, and the panel offers the retry.
  it("reports a failed panel without touching the row, and retries on request", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockRejectedValue(new Error("HTTP 502"));
    view.render(state(), NOW);
    toggle().click();
    await flush();
    expect(document.querySelector(".pr-detail-error")?.textContent).toContain("HTTP 502");
    expect(document.querySelector(".pr-merge")).not.toBeNull();
    expect(document.querySelector(".pr-error")).toBeNull();

    (h.onDetail as Mock).mockResolvedValue(detail());
    document.querySelector<HTMLButtonElement>(".pr-detail-retry")!.click();
    await flush();
    expect(document.querySelector(".pr-detail-stat")).not.toBeNull();
  });

  /// A pull request opened without a description is a legal answer, not an empty
  /// panel — and the diffstat beside it is still worth showing.
  it("says there is no description rather than showing nothing", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail({ body: "   " }));
    view.render(state(), NOW);
    toggle().click();
    await flush();
    expect(document.querySelector(".pr-detail-body")).toBeNull();
    expect(document.querySelector(".pr-detail-note")?.textContent).toBe("No description.");
  });

  /// `files` is a page of its own and `changedFiles` is GitHub's count, so on a very
  /// large pull request the two disagree. Saying so beats a list that quietly stops.
  it("says when the file list is shorter than the count", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail({ changedFiles: 300 }));
    view.render(state(), NOW);
    toggle().click();
    await flush();
    expect([...document.querySelectorAll(".pr-detail-note")].map((n) => n.textContent))
      .toContain("Listing 2 of 300 changed files.");
  });

  /// A description is somebody else's text. It is shown as written, never parsed —
  /// see pr-view.ts on why a hand-rolled Markdown subset is not the third option.
  it("renders a description containing markup as text", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockResolvedValue(detail({ body: "<img src=x onerror=alert(1)>" }));
    view.render(state(), NOW);
    toggle().click();
    await flush();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".pr-detail-body")?.textContent)
      .toBe("<img src=x onerror=alert(1)>");
  });
});

/** Lets the promises the disclosure starts settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));
