// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrView, type PrHandlers, type PrState } from "../src/pr-view";
import type { PullRequest } from "../src/ipc";

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
  error: null, fetchedAt: NOW, total: 1, ...over,
});

function mk(): { view: PrView; h: PrHandlers } {
  const h: PrHandlers = {
    onLaunch: vi.fn(), onMerge: vi.fn(), onClose: vi.fn(), onReopen: vi.fn(),
    onRefresh: vi.fn(), onFixUnavailable: vi.fn(),
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

  it("says nothing is open, distinctly from being unavailable", () => {
    const { view } = mk();
    view.render(state({ prs: [], total: 0 }), NOW);
    expect(document.querySelector(".pr-empty")).not.toBeNull();
    expect(document.querySelector(".pr-unavailable")).toBeNull();
  });
});
