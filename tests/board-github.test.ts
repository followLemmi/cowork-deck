// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { BoardView } from "../src/board";
import type { BoardState } from "../src/board";
import type { ProviderCapabilities, Task } from "../src/ipc";

const GH_CAPS: ProviderCapabilities = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  boardEditable: false, boardError: null,
  board: {
    v: 1,
    steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
    kinds: [{ id: "issue", label: "Issue" }],
  },
};

const handlers = () => ({
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(),
  onEditBoard: vi.fn(), onFixUnavailable: vi.fn(), onShowMore: vi.fn(),
});

const issue = (over: Partial<Task> = {}): Task => ({
  id: "42", title: "Sidebar badge sticks", kind: "", status: "open", project: "deck",
  created: "2026-07-01T10:00:00Z", resolved: null, origin: "human", session: null,
  body: "", path: "https://github.com/o/n/issues/42", damaged: null, conflict: false,
  labels: [], ...over,
});

const state = (over: Partial<BoardState> = {}): BoardState => ({
  project: "deck", caps: GH_CAPS, error: null, tasks: [issue()], links: [],
  source: "github", fetchedAt: Date.parse("2026-07-30T12:00:00Z"), unavailable: null,
  total: null, rateRemaining: null, ...over,
});

const NOW = Date.parse("2026-07-30T12:01:00Z");

describe("the board's github states", () => {
  /// It is currently drawn whenever a tracker is configured. There is no
  /// board.json for a synthesized board, and one synthetic kind is not a choice.
  it("hides ⚙ when the board is not editable and shows it when it is", () => {
    const gone = new BoardView(handlers());
    gone.render(state(), NOW);
    expect(gone.mount.querySelector(".tk-board-edit")).toBeNull();

    const there = new BoardView(handlers());
    there.render(state({ caps: { ...GH_CAPS, boardEditable: true } }), NOW);
    expect(there.mount.querySelector(".tk-board-edit")).not.toBeNull();
  });

  /// On every render, not only on failure: data that can be stale has to say how
  /// stale. The board has had no data age at all until now. The third render is
  /// what makes "every" true rather than "twice": an unavailable source returns
  /// early, and the age has to have been written before that.
  it("shows the data's age on every render, and says so before the first fetch", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-age")?.textContent).toContain("1 min ago");
    v.render(state({ fetchedAt: null }), NOW);
    expect(v.mount.querySelector(".tk-age")?.textContent).toBe("never loaded");
    v.render(state({ unavailable: "no-repo", tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-age")?.textContent).toContain("1 min ago");
  });

  /// Never rendered as an empty list: from one it is impossible to tell whether
  /// something broke.
  /// The sentence is asserted, not merely its existence: "explains %s" is a claim
  /// about what the box says, and a non-empty check would pass on any prose at
  /// all — including prose written for another screen, which is exactly what it
  /// did pass on.
  it.each([
    ["no-gh", "Set up gh", "so issues cannot be read"],
    ["no-account", "Bind an account", "no GitHub account bound"],
  ] as const)("explains %s and offers its next step", (u, action, says) => {
    const h = handlers();
    const v = new BoardView(h);
    v.render(state({ unavailable: u, tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-cols")).toBeNull();
    expect(v.mount.querySelector(".tk-unavailable-text")?.textContent).toContain(says);
    const fix = v.mount.querySelector<HTMLButtonElement>(".tk-fix");
    expect(fix?.textContent).toBe(action);
    fix?.click();
    expect(h.onFixUnavailable).toHaveBeenCalledWith(u);
  });

  /// The three sentences are shared with the pull request view, and one of them
  /// carried that view's subject: a person looking at an issues board with no
  /// `gh` installed was told their *pull requests* could not be read. The board
  /// is the screen they are on, and pull requests are not what they asked for.
  it.each(["no-gh", "no-account", "no-repo"] as const)(
    "never names pull requests in %s", (u) => {
      const v = new BoardView(handlers());
      v.render(state({ unavailable: u, tasks: [] }), NOW);
      expect(v.mount.querySelector(".tk-unavailable-text")?.textContent)
        .not.toContain("pull request");
    },
  );

  /// Nothing in the app can fix it, so no button is offered — a dead button is
  /// worse than none. It still has to say what is wrong, which is the half of
  /// "explains and offers nothing" a missing-button assertion cannot see.
  it("explains no-repo and offers nothing", () => {
    const v = new BoardView(handlers());
    v.render(state({ unavailable: "no-repo", tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-unavailable")).not.toBeNull();
    expect(v.mount.querySelector(".tk-unavailable-text")?.textContent)
      .toContain("not a git repository");
    expect(v.mount.querySelector(".tk-fix")).toBeNull();
  });

  /// Half the claim, and the name now says which half: the view draws whatever
  /// list it is handed beside the error, rather than treating a failure as a
  /// screen of its own. What *supplies* a list after a failure is `lastGood` in
  /// `main.ts`, which this cannot see — a state literal with cards in it proves
  /// nothing about where they came from. Both directions of that live in
  /// `tests/pr-polling.test.ts`, which drives `main.ts` itself.
  it("draws the error beside the cards it was handed, not instead of them", () => {
    const v = new BoardView(handlers());
    v.render(state({ error: "HTTP 502" }), NOW);
    expect(v.mount.textContent).toContain("HTTP 502");
    expect(v.mount.querySelectorAll(".tk-row").length).toBe(1);
  });

  /// The second render is a real short page: one card and `total: null`, which is
  /// what the board is given when the page came back under the cap, since the
  /// totals call is skipped entirely there. It used to pass `total: 1` against one
  /// card — a page that *was* capped and whose total merely equalled it, so the
  /// case it tested was "total <= shown", not a short page at all.
  it("shows the count line with two real numbers, and nothing on a short page", () => {
    const v = new BoardView(handlers());
    v.render(state({ total: 63, tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })) }), NOW);
    expect(v.mount.querySelector(".tk-count")?.textContent).toBe("Showing 50 of 63 open issues.");
    v.render(state({ total: null }), NOW);
    expect(v.mount.querySelector(".tk-count")).toBeNull();
  });

  /// `issue_totals` is a separate `gh api` call and fails on its own, leaving
  /// `total` null on a page that really was cut short. Silence there says the
  /// repository has exactly fifty open issues, which is the one thing known to be
  /// false. Asserted through the view, since what the board passes for "capped" is
  /// wiring the rule's own unit tests cannot see.
  it("says a capped page is capped when the totals call brought nothing back", () => {
    const v = new BoardView(handlers());
    v.render(state({
      total: null,
      tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })),
    }), NOW);
    expect(v.mount.querySelector(".tk-count")?.textContent)
      .toBe("Showing the first 50 open issues.");
  });

  /// A count is a statement about a repository's open issues, so a file board has
  /// no business printing one whatever left a `total` behind — and something can:
  /// the last-good list a GitHub board kept is still in memory when the same
  /// workspace is switched to a folder.
  it("prints no count line on a file board, whatever supplied the total", () => {
    const v = new BoardView(handlers());
    v.render(state({
      source: "fs", total: 63,
      tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })),
    }), NOW);
    expect(v.mount.querySelector(".tk-count")).toBeNull();
  });

  it("warns before the refusal, not after it", () => {
    const v = new BoardView(handlers());
    v.render(state({ rateRemaining: 40 }), NOW);
    expect(v.mount.querySelector(".tk-rate")?.textContent).toContain("nearly used up");
    v.render(state({ rateRemaining: 4873 }), NOW);
    expect(v.mount.querySelector(".tk-rate")).toBeNull();
  });

  /// The message says what is wrong and the wrapper says what the board did
  /// about it — and only a file-backed board has a `board.json` or a fallback
  /// board to describe. Asserted as the whole string: the old wrapper's clauses
  /// were all false for this sender, and a `toContain` would not see them
  /// arrive back.
  it("shows a github board's configuration error as the message alone", () => {
    const v = new BoardView(handlers());
    v.render(state({ caps: { ...GH_CAPS, boardError: "the source could not be read." } }), NOW);
    expect(v.mount.querySelector("p.tk-board-error")?.textContent)
      .toBe("the source could not be read.");
  });

  /// Labels are chips in the meta row, exactly as a pull request's are — and
  /// never a kind, which is why no kind chip appears for an issue at all.
  it("renders every label as a chip and no kind chip", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue({ labels: ["bug", "good first issue"] })] }), NOW);
    expect([...v.mount.querySelectorAll(".tk-label")].map((n) => n.textContent))
      .toEqual(["bug", "good first issue"]);
    expect(v.mount.querySelector(".tk-kind")).toBeNull();
  });

  /// A label is a repository's text, not ours: anyone who can open an issue on a
  /// repository the user can read chooses it. Built with textContent, so markup
  /// in one is a chip that reads oddly rather than a script that runs.
  it("renders a label carrying markup as text, never as markup", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue({ labels: ["<img src=x onerror=alert(1)>"] })] }), NOW);
    expect(v.mount.querySelector("img")).toBeNull();
    expect(v.mount.querySelector(".tk-label")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  /// **This reverses an earlier decision.** It used to give the list layout both arrows,
  /// on the grounds that ‹ and › "carry the whole of reopen and close beside ✓" — which
  /// is true of ‹ and false of ›. A GitHub board has two steps, `open` and `closed`, so
  /// on an open issue `stepAfter` IS the closing step: › and ✓ reached the same end
  /// through two different handlers, and › was labelled "Move to the next step", which
  /// names nothing on a two-step board. Both paths ask for a reason, so nothing was
  /// bypassed; it was two buttons for one action.
  /// ‹ stays and is the only way to reopen, which is what that argument really
  /// established.
  it("gives an open issue no › — ✓ already closes it — and a closed one ‹ to reopen", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-next")).toBeNull();
    expect(v.mount.querySelector(".tk-done")).not.toBeNull();
    expect(v.mount.querySelector(".tk-prev")).toBeNull();

    v.render(state({ tasks: [issue({ status: "closed", resolved: "2026-07-02T00:00:00Z" })] }), NOW);
    // Still on the open filter, which is now empty and says so rather than
    // silently showing the closed issue in a list labelled Open.
    expect(v.mount.querySelector(".tk-row")).toBeNull();
    expect(v.mount.querySelector(".tk-empty")?.textContent).toBe("No open issues.");
    closedFilter(v).click();
    const prev = v.mount.querySelector(".tk-prev")!;
    expect(prev).not.toBeNull();
    // And it says where it goes, rather than "the previous step".
    expect(prev.getAttribute("aria-label")).toBe("Move to Open");
  });

  /// Both actions are always offered: `damaged` and `conflict` are false by
  /// construction for an issue, so `canWrite` is always true. Correct rather than
  /// accidental, which is why it is pinned — over two rows, since "every" is the
  /// claim.
  it("offers ▶ and ✓ on every open issue", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue(), issue({ id: "43", title: "Second" })] }), NOW);
    const rows = [...v.mount.querySelectorAll<HTMLElement>(".tk-row")];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.querySelector(".tk-run")).not.toBeNull();
      expect(r.querySelector(".tk-done")).not.toBeNull();
    }
  });

  /// One list, not two columns. The columns bought a drag gesture for an action
  /// that has a button, and paid for it by splitting fifty rows across two narrow
  /// strips — so the GitHub source draws rows and the file source keeps its board.
  it("draws one list for an issue source and columns for a folder", () => {
    const gh = new BoardView(handlers());
    gh.render(state(), NOW);
    expect(gh.mount.querySelector(".tk-list")).not.toBeNull();
    expect(gh.mount.querySelector(".tk-cols")).toBeNull();

    const fs = new BoardView(handlers());
    fs.render(state({ source: "fs" }), NOW);
    expect(fs.mount.querySelector(".tk-cols")).not.toBeNull();
    expect(fs.mount.querySelector(".tk-list")).toBeNull();
  });

  /// The issue's number is the name a person uses for it, and the card layout had
  /// nowhere to put one.
  it("names each row by its issue number", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-row-number")?.textContent).toBe("#42");
  });

  /// The chip counts the repository where that is known, so it agrees with GitHub
  /// rather than with whatever a page happened to fit; the count line under the
  /// rows is what says how much of it is on screen.
  it("counts the repository on the filter chips, not the page", () => {
    const v = new BoardView(handlers());
    v.render(state({
      total: 63, closedTotal: 400,
      tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })),
    }), NOW);
    expect([...v.mount.querySelectorAll(".tk-filter")].map((n) => n.textContent))
      .toEqual(["Open (63)", "Closed (400)"]);
  });

  /// The filter is the view's own, so a poll landing on it must not fold it back
  /// to Open under the person's hand — that is the whole reason it does not travel
  /// through `BoardState`.
  it("keeps the chosen filter across a re-render", () => {
    const v = new BoardView(handlers());
    const closed = issue({ id: "7", status: "closed", resolved: "2026-07-02T00:00:00Z" });
    v.render(state({ tasks: [issue(), closed] }), NOW);
    closedFilter(v).click();
    expect(v.mount.querySelector(".tk-row-number")?.textContent).toBe("#7");
    v.render(state({ tasks: [issue(), closed] }), NOW);
    expect(v.mount.querySelector(".tk-row-number")?.textContent).toBe("#7");
  });

  /// The count line follows the filter: "showing the first 20 open issues" under a
  /// list of closed ones is a sentence about a different set of rows.
  it("counts the state the filter is on, by its own name", () => {
    const v = new BoardView(handlers());
    const closed = Array.from({ length: 20 }, (_, i) =>
      issue({ id: `c${i}`, status: "closed", resolved: "2026-07-02T00:00:00Z" }));
    v.render(state({
      closedTotal: 400,
      tasks: [...Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })), ...closed],
      total: 63,
    }), NOW);
    expect(v.mount.querySelector(".tk-count")?.textContent).toBe("Showing 50 of 63 open issues.");
    closedFilter(v).click();
    expect(v.mount.querySelector(".tk-count")?.textContent)
      .toBe("Showing 20 of 400 closed issues.");
  });

  /// A full page may have more behind it and a short one is the whole of that
  /// state — so the button appears only where pressing it could change the answer,
  /// and it hands back the page size the rows were measured against.
  it("offers Show more only on a full page, and says which page it grew from", () => {
    const h = handlers();
    const v = new BoardView(h);
    v.render(state({
      total: 63, tasks: Array.from({ length: 50 }, (_, i) => issue({ id: String(i) })),
    }), NOW);
    v.mount.querySelector<HTMLButtonElement>(".tk-more")!.click();
    expect(h.onShowMore).toHaveBeenCalledWith(50);

    v.render(state({ total: null, tasks: [issue()] }), NOW);
    expect(v.mount.querySelector(".tk-more")).toBeNull();
  });

  /// A board already paged to 150 compares its full page against 150, not against
  /// the constant 50 — otherwise it would call every page capped and go on offering
  /// rows that are already all of them.
  it("measures a grown page against the page it was fetched with", () => {
    const v = new BoardView(handlers());
    const tasks = Array.from({ length: 60 }, (_, i) => issue({ id: String(i) }));
    v.render(state({ total: 60, pageLimit: 150, tasks }), NOW);
    expect(v.mount.querySelector(".tk-more")).toBeNull();
    expect(v.mount.querySelector(".tk-count")).toBeNull();
  });

  /// A first read of a GitHub board is a repository lookup and a page per state
  /// deep. Skeleton rows say so; an empty board says something false, and
  /// `caps: null` says something worse — "no task tracker is configured".
  it("draws skeleton rows while a first read is in flight, and never over a list", () => {
    const v = new BoardView(handlers());
    v.render(state({ loading: true, tasks: [], caps: null }), NOW);
    expect(v.mount.querySelectorAll(".tk-skeleton-row").length).toBeGreaterThan(0);
    expect(v.mount.textContent).not.toContain("No task tracker is configured");

    v.render(state({ loading: true }), NOW);
    expect(v.mount.querySelector(".tk-skeleton")).toBeNull();
    expect(v.mount.querySelectorAll(".tk-row").length).toBe(1);
  });

  /// An unavailable source is still its own screen while a read is in flight: it is
  /// the answer for this workspace, and replacing it with grey boxes would hide the
  /// only button that fixes it.
  it("keeps the unavailable box ahead of the skeleton", () => {
    const v = new BoardView(handlers());
    v.render(state({ loading: true, tasks: [], unavailable: "no-gh" }), NOW);
    expect(v.mount.querySelector(".tk-unavailable")).not.toBeNull();
    expect(v.mount.querySelector(".tk-skeleton")).toBeNull();
  });

  /// A row was a strip of clickable text in a box that did nothing. The whole row
  /// opens it now — except the controls, where a click means something else and a
  /// modal over the top of it would bury what just happened.
  it("opens the card from anywhere in the row but the actions", () => {
    const h = handlers();
    const v = new BoardView(h);
    v.render(state(), NOW);
    v.mount.querySelector<HTMLElement>(".tk-row-title")!.click();
    v.mount.querySelector<HTMLElement>(".tk-row-when")!.click();
    v.mount.querySelector<HTMLElement>(".tk-row")!.click();
    expect(h.onOpen).toHaveBeenCalledTimes(3);

    h.onOpen.mockClear();
    v.mount.querySelector<HTMLButtonElement>(".tk-run")!.click();
    v.mount.querySelector<HTMLButtonElement>(".tk-done")!.click();
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onLaunch).toHaveBeenCalledTimes(1);
    expect(h.onResolve).toHaveBeenCalledTimes(1);
  });
});

/** The Closed chip, by its label rather than by position: which step is second is
 *  the configuration's business, and an index would pass on the wrong chip. */
function closedFilter(v: BoardView): HTMLButtonElement {
  const chip = [...v.mount.querySelectorAll<HTMLButtonElement>(".tk-filter")]
    .find((n) => n.textContent?.startsWith("Closed"));
  if (!chip) throw new Error("no Closed filter chip");
  return chip;
}

// ---------------------------------------------------------------------------

describe("the issue list's label filter and row shape", () => {
  const labelChips = (v: BoardView) =>
    [...v.mount.querySelectorAll<HTMLButtonElement>(".tk-f-kind")];
  const rowTitles = (v: BoardView) =>
    [...v.mount.querySelectorAll(".tk-row-title")].map((n) => n.textContent);
  const chip = (v: BoardView, prefix: string) => {
    const c = labelChips(v).find((n) => n.textContent!.startsWith(prefix));
    if (!c) throw new Error(`no label chip for ${prefix}`);
    return c;
  };

  const LABELLED = [
    issue({ id: "1", title: "a bug", labels: ["bug"] }),
    issue({ id: "2", title: "a payments bug", labels: ["bug", "payments"] }),
    issue({ id: "3", title: "some docs", labels: ["docs"] }),
  ];

  it("offers one chip per label on the page, with its own count", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: LABELLED }), NOW);
    expect(labelChips(v).map((c) => c.textContent))
      .toEqual(["bug (2)", "docs (1)", "payments (1)"]);
  });

  it("draws no chips when there is nothing to choose between", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue({ labels: ["bug"] })] }), NOW);
    expect(labelChips(v)).toHaveLength(0);
  });

  it("filters the rows to the pressed label", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: LABELLED }), NOW);
    chip(v, "bug").click();
    expect(rowTitles(v)).toEqual(["a bug", "a payments bug"]);
    expect(chip(v, "bug").getAttribute("aria-pressed")).toBe("true");
  });

  it("clears the filter when the pressed chip is pressed again", () => {
    // With no "all" chip this is the only way back, and a filter a person cannot
    // clear is a trap.
    const v = new BoardView(handlers());
    v.render(state({ tasks: LABELLED }), NOW);
    chip(v, "docs").click();
    expect(rowTitles(v)).toEqual(["some docs"]);
    chip(v, "docs").click();
    expect(rowTitles(v)).toEqual(["a bug", "a payments bug", "some docs"]);
  });

  it("clears a filter naming a label that has left the page", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: LABELLED }), NOW);
    chip(v, "docs").click();
    // A poll brings a page that no longer carries that label at all.
    v.render(state({ tasks: [LABELLED[0], LABELLED[1]] }), NOW);
    expect(rowTitles(v)).toEqual(["a bug", "a payments bug"]);
    expect(labelChips(v).every((c) => c.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("says what the filter hides rather than folding it into the page count", () => {
    // The repository's total has nothing to say about a label subset, so the two
    // facts are reported as two lines instead of one that compares them.
    const v = new BoardView(handlers());
    v.render(state({ tasks: LABELLED }), NOW);
    chip(v, "payments").click();
    const lines = [...v.mount.querySelectorAll(".tk-count")].map((n) => n.textContent);
    expect(lines.some((l) => l!.includes("1 of 3 on this page carry"))).toBe(true);
  });

  it("gives the issue number a column of its own, outside the title's line", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue({ id: "412" })] }), NOW);
    const row = v.mount.querySelector(".tk-row")!;
    expect(row.querySelector(".tk-row-number")!.textContent).toBe("#412");
    // A sibling of `.tk-row-main`, not a child: that is what lets the numbers line
    // up down the page instead of starting a wrapping line.
    expect(row.querySelector(".tk-row-main .tk-row-number")).toBeNull();
  });

  it("shows one line of the body, and nothing when there is no body", () => {
    const withBody = new BoardView(handlers());
    withBody.render(state({
      tasks: [issue({ body: "## Steps\n\nThe receiver treats 410 as retryable." })],
    }), NOW);
    expect(withBody.mount.querySelector(".tk-row-excerpt")!.textContent)
      .toBe("The receiver treats 410 as retryable.");

    const without = new BoardView(handlers());
    without.render(state({ tasks: [issue({ body: "" })] }), NOW);
    expect(without.mount.querySelector(".tk-row-excerpt")).toBeNull();
  });
});
