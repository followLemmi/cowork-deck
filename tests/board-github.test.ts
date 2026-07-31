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
  onEditBoard: vi.fn(), onFixUnavailable: vi.fn(),
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
  it.each([
    ["no-gh", "Set up gh"],
    ["no-account", "Bind an account"],
  ] as const)("explains %s and offers its next step", (u, action) => {
    const h = handlers();
    const v = new BoardView(h);
    v.render(state({ unavailable: u, tasks: [] }), NOW);
    expect(v.mount.querySelector(".tk-cols")).toBeNull();
    expect(v.mount.querySelector(".tk-unavailable-text")?.textContent).not.toBe("");
    const fix = v.mount.querySelector<HTMLButtonElement>(".tk-fix");
    expect(fix?.textContent).toBe(action);
    fix?.click();
    expect(h.onFixUnavailable).toHaveBeenCalledWith(u);
  });

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
    expect(v.mount.querySelectorAll(".tk-card").length).toBe(1);
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

  /// The arrows stay: they are the keyboard path, not a fallback for the drag —
  /// xterm eats Tab inside a tile. With two steps each card gets exactly one.
  it("gives an open issue one arrow and a closed one the other", () => {
    const v = new BoardView(handlers());
    v.render(state(), NOW);
    expect(v.mount.querySelector(".tk-next")).not.toBeNull();
    expect(v.mount.querySelector(".tk-prev")).toBeNull();
    v.render(state({ tasks: [issue({ status: "closed", resolved: "2026-07-02T00:00:00Z" })] }), NOW);
    expect(v.mount.querySelector(".tk-prev")).not.toBeNull();
  });

  /// Every card is draggable and both actions are always offered: `damaged` and
  /// `conflict` are false by construction for an issue, so `canWrite` is always
  /// true. Correct rather than accidental, which is why it is pinned — over two
  /// cards, since "every" is the claim.
  it("offers ▶ and ✓ on every open issue", () => {
    const v = new BoardView(handlers());
    v.render(state({ tasks: [issue(), issue({ id: "43", title: "Second" })] }), NOW);
    const cards = [...v.mount.querySelectorAll<HTMLElement>(".tk-card")];
    expect(cards.length).toBe(2);
    for (const c of cards) {
      expect(c.querySelector(".tk-run")).not.toBeNull();
      expect(c.querySelector(".tk-done")).not.toBeNull();
      expect(c.draggable).toBe(true);
    }
  });
});
