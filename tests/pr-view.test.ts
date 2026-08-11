// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrView, type PrHandlers, type PrState } from "../src/pr-view";
import type { PrDetail, PullRequest } from "../src/ipc";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

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
    onRefresh: vi.fn(), onFixUnavailable: vi.fn(), onOpenDiff: vi.fn(),
    onDetail: vi.fn().mockResolvedValue({
      body: "", additions: 0, deletions: 0, changedFiles: 0, files: [],
    }),
  };
  const view = new PrView(h);
  document.body.replaceChildren(view.mount);
  return { view, h };
}

beforeEach(() => { document.body.replaceChildren(); vi.mocked(openUrl).mockClear(); });

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

  it("disables merge and names the reason where it can be reached", () => {
    const { view, h } = mk();
    view.render(state({ prs: [pr({ isDraft: true })] }), NOW);
    const btn = document.querySelector<HTMLButtonElement>(".pr-merge")!;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(h.onMerge).not.toHaveBeenCalled();

    // This asserted `btn.title` until the reason moved out of it. A `title` is
    // reachable by neither keyboard nor touch, which are the two ways of using
    // the app that most need to know why its highest-stakes button is refused.
    const refusal = document.querySelector<HTMLElement>(".pr-refusal")!;
    expect(refusal.textContent).toContain("draft");
    // The link is the whole point: without it the sentence is on screen but not
    // attached to the control it explains.
    expect(btn.getAttribute("aria-describedby")).toBe(refusal.id);
    expect(refusal.id).not.toBe("");
  });

  it("has no refusal line, and no dangling description, when merge is allowed", () => {
    const { view } = mk();
    view.render(state(), NOW);
    expect(document.querySelector(".pr-refusal")).toBeNull();
    const btn = document.querySelector<HTMLButtonElement>(".pr-merge")!;
    expect(btn.disabled).toBe(false);
    // An `aria-describedby` pointing at an element that is not rendered is worse
    // than none: a screen reader announces the button with no description and the
    // markup claims otherwise.
    expect(btn.getAttribute("aria-describedby")).toBeNull();
  });

  it("hands merge the pull request when it is allowed", () => {
    const { view, h } = mk();
    view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-merge")!.click();
    expect(h.onMerge).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }));
  });

  // #252: this button was an `<a target="_blank">`, and a Tauri window has
  // nowhere to navigate that to — the click was dropped and nothing happened.
  // It reaches the system browser through the opener plugin now, and the app's
  // own window must not navigate, which is what `preventDefault` is here for.
  it("opens the pull request in the system browser rather than navigating", () => {
    const { view } = mk();
    view.render(state(), NOW);
    const link = document.querySelector<HTMLAnchorElement>(".pr-open")!;
    expect(link.getAttribute("target")).toBeNull();
    const click = new MouseEvent("click", { cancelable: true, bubbles: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://example.test/pr/7"]]);
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

/** The poll calls `render` every 15 s while the window has focus — which is exactly
 *  while somebody is reading the list. Each call empties the mount and builds every
 *  node again, so without these restores the reader loses their place twice a
 *  minute. The bug predates the diff drawer; the drawer is what made it matter. */
describe("a redraw keeps the reader's place", () => {
  it("puts focus back on the same control after the list is rebuilt", () => {
    const { view } = mk();
    view.render(state(), NOW);

    const before = document.querySelector<HTMLButtonElement>(".pr-toggle")!;
    before.focus();
    expect(document.activeElement).toBe(before);

    view.render(state(), NOW);

    const after = document.querySelector<HTMLButtonElement>(".pr-toggle")!;
    // The node really was destroyed — this is what makes restoring by identity
    // impossible and `data-fk` necessary.
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it("tells the row's controls apart, so focus does not jump between pull requests", () => {
    const { view } = mk();
    const two = state({ prs: [pr({ number: 7 }), pr({ number: 9 })], total: 2 });
    view.render(two, NOW);

    const merges = document.querySelectorAll<HTMLButtonElement>(".pr-merge");
    expect(merges).toHaveLength(2);
    merges[1].focus();

    view.render(two, NOW);

    const active = document.activeElement as HTMLElement;
    expect(active.dataset.fk).toBe("merge-9");
    expect(active.closest(".pr-row")!.textContent).toContain("#9");
  });

  /** **This asserts less than it looks like it does, and the difference is worth
   *  writing down.** In a browser, emptying a scroll container collapses its content
   *  and the scroll position goes to zero, which is the bug being fixed. jsdom has no
   *  layout: `scrollTop` there is a plain stored number that `replaceChildren` leaves
   *  alone — measured, not assumed. So this test would pass with the restore deleted.
   *
   *  What it does still catch is a redraw that writes `0` — an easy mistake if the
   *  capture is ever moved after the rebuild instead of before it. The real behaviour
   *  belongs on the manual checklist, and is there. */
  it("does not reset the scroll position to zero", () => {
    const { view } = mk();
    view.render(state(), NOW);
    view.mount.scrollTop = 120;

    view.render(state(), NOW);

    expect(view.mount.scrollTop).toBe(120);
  });

  it("leaves focus alone when it was never inside the list", () => {
    const { view } = mk();
    const outside = document.createElement("button");
    document.body.append(outside);
    view.render(state(), NOW);
    outside.focus();

    view.render(state(), NOW);

    // Not stolen into the list. A redraw is not a reason to take focus from
    // whatever the person was actually using.
    expect(document.activeElement).toBe(outside);
  });

  it("does not throw when the focused control no longer exists", () => {
    const { view } = mk();
    view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-merge")!.focus();

    // The pull request was merged away between two polls.
    expect(() => view.render(state({ prs: [], total: 0 }), NOW)).not.toThrow();
    expect(document.querySelector(".pr-empty")).not.toBeNull();
  });

  it("keeps focus on a panel control across the poll that re-renders it", async () => {
    const { view, h } = mk();
    (h.onDetail as Mock).mockRejectedValue(new Error("network is down"));
    view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-toggle")!.click();
    await flush();

    const retry = document.querySelector<HTMLButtonElement>(".pr-detail-retry")!;
    retry.focus();

    view.render(state(), NOW);

    const active = document.activeElement as HTMLElement;
    expect(active.dataset.fk).toBe("retry-7");
    expect(active).not.toBe(retry);
  });
});

// The way into the diff drawer, and the list's one keyboard widget. What matters
// is that arrowing is free: each file is an IPC round trip, so a list that
// activated on focus would spend 62 `gh` processes on a walk through 62 rows.
describe("the changed files are the way into the diff", () => {
  const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
    body: "Fixes the thing.",
    additions: 12, deletions: 3, changedFiles: 3,
    files: [
      { path: "src/board.ts", additions: 10, deletions: 3 },
      { path: "src/styles.css", additions: 2, deletions: 0 },
      { path: "docs/x.md", additions: 0, deletions: 0 },
    ],
    ...over,
  });

  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".pr-detail-file")];

  async function open(): Promise<{ view: PrView; h: PrHandlers }> {
    const kit = mk();
    (kit.h.onDetail as Mock).mockResolvedValue(detail());
    kit.view.render(state(), NOW);
    document.querySelector<HTMLButtonElement>(".pr-toggle")!.click();
    await flush();
    return kit;
  }

  it("draws each file as a button inside its list item", async () => {
    await open();
    expect(rows()).toHaveLength(3);
    expect(rows()[0].type).toBe("button");
    expect(rows()[0].parentElement!.tagName).toBe("LI");
    expect(rows()[0].textContent).toBe("src/board.ts+10−3");
  });

  // One tab stop, not 62. Everything else is reached with the arrows.
  it("puts exactly one row in the tab order", async () => {
    await open();
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves the tab stop with the arrows, and never fires a request doing it", async () => {
    const { h } = await open();
    const list = document.querySelector<HTMLElement>(".pr-detail-files")!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(rows()[2]);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(rows()[0]);
    expect(h.onOpenDiff).not.toHaveBeenCalled();
  });

  it("stops at both ends rather than wrapping", async () => {
    await open();
    const list = document.querySelector<HTMLElement>(".pr-detail-files")!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("opens the diff on a click, by index and with the path along for the label", async () => {
    const { h } = await open();
    rows()[1].click();
    expect(h.onOpenDiff).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7 }), 1, "src/styles.css",
    );
  });

  // A file with nothing to show stays an ordinary enabled button: `disabled`
  // takes the row out of the tab order and its explanation with it, and the
  // explanation is in the drawer the row opens.
  it("leaves a file with no changes openable", async () => {
    const { h } = await open();
    expect(rows()[2].disabled).toBe(false);
    rows()[2].click();
    expect(h.onOpenDiff).toHaveBeenCalledWith(expect.anything(), 2, "docs/x.md");
  });

  it("marks the row whose diff is showing, and unmarks it on close", async () => {
    const { view } = await open();
    view.setOpenDiff(7, 1);
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual([null, "true", null]);
    view.setOpenDiff(null, null);
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual([null, null, null]);
  });

  // The drawer never took focus, so on close there is a specific row to come
  // back to — and by then the poll has rebuilt the list, so the row it goes to
  // is a different node with the same key.
  it("puts focus back on a row that has been redrawn since", async () => {
    const { view } = await open();
    const before = rows()[2];
    view.render(state(), NOW);
    view.focusFile(7, 2);
    const active = document.activeElement as HTMLElement;
    expect(active.dataset.fk).toBe("file-7-2");
    expect(active).not.toBe(before);
  });

  it("says nothing when the row to go back to has gone", async () => {
    const { view } = await open();
    view.render(state({ prs: [], total: 0 }), NOW);
    expect(() => view.focusFile(7, 2)).not.toThrow();
  });

  // The poll destroys every node twice a minute; the tab stop has to survive it.
  it("keeps the tab stop where the person left it across a redraw", async () => {
    const { view } = await open();
    const list = document.querySelector<HTMLElement>(".pr-detail-files")!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    view.render(state(), NOW);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });
});
