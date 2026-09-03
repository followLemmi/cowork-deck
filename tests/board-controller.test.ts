/** The board's read half, tested WITHOUT booting the app.
 *
 *  That is the whole point of the cut (#463). These 167 lines lived inside a
 *  3206-line closure, sharing three pieces of mutable state by lexical scope with
 *  sixty-eight other nested functions — and the only way to reach any of it was
 *  `startApp` behind a mock of thirteen `ipc` exports, which is why eleven tests
 *  could get at it at all. Every case below is about one of the three caches or
 *  the late-reply guard, and not one of them needs a DOM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  taskCapabilities: vi.fn(),
  listTasks: vi.fn(),
  issueTotals: vi.fn(),
  taskMigrationStatus: vi.fn(),
  taskOpenCounts: vi.fn(),
}));
vi.mock("../src/ipc", async (orig) => ({ ...(await orig() as object), ...m }));

import { BoardController, type BoardControllerHost } from "../src/board-controller";
import type { BoardState } from "../src/board";
import type { Task, TrackerConfig, Workspace } from "../src/ipc";

const CAPS = {
  canCreate: true, canEdit: true, canResolve: true, canDelete: true, canMove: true,
  board: { steps: [{ id: "open", label: "Open" }, { id: "done", label: "Done", terminal: true }], kinds: [] },
};

/** A GitHub-backed tracker, which is what `sourceOf` reads. Two of the three
 *  caches behave differently by source, so the fixture has to be a real one. */
const gh: TrackerConfig = { providers: [{ type: "github" }] } as TrackerConfig;

function ws(id: string, tracker?: TrackerConfig): Workspace {
  return { id, name: id, path: `/w/${id}`, color: "#fff", tracker } as unknown as Workspace;
}

function task(id: string, status = "open"): Task {
  return {
    id, title: id, status, kind: null, project: "p", path: `/w/${id}.md`,
    created: "2026-09-02", resolved: null, origin: "human", session: null,
    body: "", damaged: null, conflict: false, labels: [],
  } as unknown as Task;
}

/** `Array.prototype.at` is ES2022 and `tsconfig` targets below it — the last
 *  element the long way, rather than moving the whole project's target for a
 *  test's convenience. */
const last = <T>(xs: T[]): T => xs[xs.length - 1];

function host(active: Workspace | null) {
  const rendered: BoardState[] = [];
  const counts: Record<string, number>[] = [];
  let current = active;
  const h: BoardControllerHost = {
    workspaces: { get active() { return current; } },
    board: { render: (s: BoardState) => { rendered.push(s); } },
    taskLinks: () => [],
    onCounts: (c) => { counts.push(c); },
  };
  return { h, rendered, counts, switchTo: (w: Workspace | null) => { current = w; } };
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.taskCapabilities.mockResolvedValue(CAPS);
  m.listTasks.mockResolvedValue([]);
  m.taskMigrationStatus.mockResolvedValue(null);
  m.issueTotals.mockResolvedValue(null);
  m.taskOpenCounts.mockResolvedValue({});
});

describe("with no workspace", () => {
  it("draws an empty board and forgets whose answer the screen is", async () => {
    const { h, rendered } = host(null);
    await new BoardController(h).refresh();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ tasks: [], caps: null, source: "fs" });
  });
});

describe("the skeleton, which is what `showing` exists for", () => {
  /** A loading state is painted only when nothing on screen belongs to the
   *  workspace about to be read: the first read of a board, and the first read
   *  after a switch. */
  it("paints a loading state on the first read and not on the next", async () => {
    const { h, rendered } = host(ws("a", gh));
    const c = new BoardController(h);
    await c.refresh();
    expect(rendered.filter((r) => r.loading)).toHaveLength(1);
    await c.refresh();
    expect(rendered.filter((r) => r.loading)).toHaveLength(1);
  });

  it("paints one again after a switch, because nothing on screen is that board's", async () => {
    const { h, rendered, switchTo } = host(ws("a", gh));
    const c = new BoardController(h);
    await c.refresh();
    switchTo(ws("b", gh));
    await c.refresh();
    expect(rendered.filter((r) => r.loading)).toHaveLength(2);
  });

  /** For the caller that knows the screen has stopped being an answer without
   *  going through a read: closing the panel. */
  it("paints one again after being told to forget", async () => {
    const { h, rendered } = host(ws("a", gh));
    const c = new BoardController(h);
    await c.refresh();
    c.forget();
    await c.refresh();
    expect(rendered.filter((r) => r.loading)).toHaveLength(2);
  });
});

describe("the last good list", () => {
  /** Being offline or rate-limited is a blip in front of data that is still
   *  true, so the rows stay on screen beside the error with their age. */
  it("keeps a GitHub board's rows on screen when a later read fails", async () => {
    const { h, rendered } = host(ws("a", gh));
    const c = new BoardController(h);
    m.listTasks.mockResolvedValue([task("1"), task("2")]);
    await c.refresh();
    m.listTasks.mockRejectedValue(new Error("offline"));
    await c.refresh();
    const shown = last(rendered);
    expect(shown.tasks.map((t: Task) => t.id)).toEqual(["1", "2"]);
    expect(shown.error).toBe("offline");
  });

  /** A file board's failure is almost always "the folder is gone", where phantom
   *  cards invite actions that can only fail and replace the one screen offering
   *  `Configure`. */
  it("keeps nothing for a file board, so a missing folder reads as one", async () => {
    const { h, rendered } = host(ws("a"));
    const c = new BoardController(h);
    m.listTasks.mockResolvedValue([task("1")]);
    await c.refresh();
    m.listTasks.mockRejectedValue(new Error("no such directory"));
    await c.refresh();
    expect(last(rendered).tasks).toEqual([]);
  });

  /** The map is keyed by workspace and outlives a source switch, so an ungated
   *  READ is how a file board ends up drawing the issues that workspace had while
   *  it was GitHub-backed — phantom cards on a board whose root is gone. */
  it("does not hand a file board the issues it had as a GitHub one", async () => {
    const gone = ws("a", gh);
    const { h, rendered, switchTo } = host(gone);
    const c = new BoardController(h);
    m.listTasks.mockResolvedValue([task("42")]);
    await c.refresh();
    switchTo(ws("a"));                    // same id, source changed
    m.listTasks.mockRejectedValue(new Error("no such directory"));
    await c.refresh();
    expect(last(rendered).tasks).toEqual([]);
  });
});

describe("a reply that arrives after a switch", () => {
  /** The workspace may have been switched while the read was in flight, and a
   *  late reply must not repaint the board with another workspace's data. */
  it("is discarded rather than painted over the board on screen", async () => {
    const { h, rendered, switchTo } = host(ws("a", gh));
    const c = new BoardController(h);
    let release: ((v: Task[]) => void) | null = null;
    m.listTasks.mockImplementation(() => new Promise((r) => { release = r; }));
    const pending = c.refresh();
    // `refresh` awaits `taskCapabilities` before it reaches `listTasks`, so the
    // read has not started yet on the first turn of the loop.
    for (let i = 0; i < 4 && release === null; i++) await Promise.resolve();
    switchTo(ws("b", gh));
    release!([task("1")]);
    await pending;
    // The loading paint from the first read is there; the answer is not.
    expect(rendered.some((r) => r.tasks.length > 0)).toBe(false);
  });
});

describe("paging", () => {
  /** "Show more" is one step past the page the rows on screen were measured
   *  against, and every poll from then on fetches the larger page — the honest
   *  cost of showing rows somebody asked to see. */
  it("asks for a wider page from then on, and only for that workspace", async () => {
    const { h, switchTo } = host(ws("a", gh));
    const c = new BoardController(h);
    await c.showMore(50);
    expect(m.listTasks).toHaveBeenLastCalledWith("a", 100);
    await c.refresh();
    expect(m.listTasks).toHaveBeenLastCalledWith("a", 100);
    switchTo(ws("b", gh));
    await c.refresh();
    expect(m.listTasks).toHaveBeenLastCalledWith("b", undefined);
  });
});

describe("the totals", () => {
  /** Only when it can change the answer: a page shorter than what was asked for
   *  IS the total, so a repository under fifty open issues never asks. */
  it("are not asked for while the page is not full", async () => {
    const { h } = host(ws("a", gh));
    m.listTasks.mockResolvedValue([task("1")]);
    await new BoardController(h).refresh();
    expect(m.issueTotals).not.toHaveBeenCalled();
  });

  it("are asked for once the open page is at its cap", async () => {
    const { h } = host(ws("a", gh));
    m.listTasks.mockResolvedValue(Array.from({ length: 50 }, (_, i) => task(String(i))));
    m.issueTotals.mockResolvedValue({ open: 120, closed: 40, rateRemaining: 4000 });
    await new BoardController(h).refresh();
    expect(m.issueTotals).toHaveBeenCalledWith("a");
  });

  /** None of the unavailable markers can come out of a folder, and a file
   *  board's own errors already say what is wrong. */
  it("are never asked for a file board", async () => {
    const { h } = host(ws("a"));
    m.listTasks.mockResolvedValue(Array.from({ length: 50 }, (_, i) => task(String(i))));
    await new BoardController(h).refresh();
    expect(m.issueTotals).not.toHaveBeenCalled();
  });
});

describe("migration", () => {
  /** Asked only where it can be answered: a GitHub workspace has no previous
   *  folder, and the backend refuses the command rather than inventing one. */
  it("is asked about a file board and not a GitHub one", async () => {
    const file = host(ws("a"));
    await new BoardController(file.h).refresh();
    expect(m.taskMigrationStatus).toHaveBeenCalledWith("a");

    m.taskMigrationStatus.mockClear();
    const github = host(ws("b", gh));
    await new BoardController(github.h).refresh();
    expect(m.taskMigrationStatus).not.toHaveBeenCalled();
  });
});

describe("the counts", () => {
  it("are handed out, because the badge is the panel tab's", async () => {
    const { h, counts } = host(ws("a"));
    m.taskOpenCounts.mockResolvedValue({ a: 3 });
    await new BoardController(h).refreshCounts();
    expect(counts).toEqual([{ a: 3 }]);
  });

  /** One failing handle must not take a tick down: the poll calls this after the
   *  board's own read, and a badge is a background hint. */
  it("say nothing at all when the read fails", async () => {
    const { h, counts } = host(ws("a"));
    m.taskOpenCounts.mockRejectedValue(new Error("nope"));
    await new BoardController(h).refreshCounts();
    expect(counts).toEqual([]);
  });
});
