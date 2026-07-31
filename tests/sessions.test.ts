// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const writeSpy = vi.fn();
const startMock = vi.fn();
// `vi.mock` factories are hoisted above ordinary top-level `const`s, so a
// variable a factory reaches into has to be hoisted the same way — unlike
// `writeSpy`/`startMock` above, this one is read from the "../src/ipc" mock,
// which loads before this file's own top-level statements run.
const { updateTaskMock } = vi.hoisted(() => ({ updateTaskMock: vi.fn() }));

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    mount: HTMLElement;
    constructor(session: string, mount: HTMLElement) {
      this.session = session;
      this.mount = mount;
    }
    start = startMock;
    write = writeSpy;
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionTokens: vi.fn().mockResolvedValue({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }),
  updateTask: updateTaskMock,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { Deck, serializeTiles } from "../src/sessions";
import type { Task, BoardConfig } from "../src/ipc";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

describe("Deck.launch error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("marks the tile as error when start rejects", async () => {
    startMock.mockRejectedValueOnce(new Error("claude-not-found"));
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => []);

    await deck.launch(WS as any, null);

    const label = deckEl.querySelector(".tile-state")!;
    expect(label.className).toContain("state-error");
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("claude not found"));
  });
});

describe("Deck.focusTile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
  });

  it("clicking a session row marks its tile active", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => []);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    const firstRow = listEl.querySelectorAll<HTMLElement>(".sess-row")[0];
    firstRow.click();

    const activeTiles = deckEl.querySelectorAll(".tile.is-active");
    expect(activeTiles.length).toBe(1);
    expect(deckEl.classList.contains("has-active")).toBe(true);
  });
});

describe("Deck zoom edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
  });

  it("closing the zoomed tile reconciles the deck to grid mode", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    const zoomedTile = deckEl.querySelector(".tile.zoomed") as HTMLElement;
    // data-action, not glyph text: an SVG icon has no textContent.
    const closeBtn = zoomedTile.querySelector<HTMLButtonElement>('[data-action="x"]')!;
    closeBtn.click();

    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
    expect(deckEl.querySelector(".deck-strip")).toBeNull();
    const remainingTile = deckEl.querySelector(".tile") as HTMLElement;
    expect(remainingTile).not.toBeNull();
    expect(remainingTile.parentElement).toBe(deckEl);
  });

  it("closing a non-zoomed tile reconciles the deck from zoom to grid", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);
    expect(deckEl.querySelector(".deck-strip")).not.toBeNull();

    const allTiles = deckEl.querySelectorAll(".tile");
    const nonZoomedTile = [...allTiles].find((t) => !t.classList.contains("zoomed")) as HTMLElement;
    // data-action, not glyph text: an SVG icon has no textContent.
    const closeBtn = nonZoomedTile.querySelector<HTMLButtonElement>('[data-action="x"]')!;
    closeBtn.click();

    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
    expect(deckEl.querySelector(".deck-strip")).toBeNull();
    const remainingTile = deckEl.querySelector(".tile") as HTMLElement;
    expect(remainingTile).not.toBeNull();
    expect(remainingTile.parentElement).toBe(deckEl);
  });

  it("switching to a workspace without the zoomed tile exits zoom", async () => {
    const WS2 = { id: "w2", name: "Q", path: "/q", color: "#000" };
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS, WS2]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any)
      .mockReturnValueOnce("c" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);
    await deck.launch(WS2 as any, null);

    deck.setActiveWorkspace(WS.id);
    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    deck.setActiveWorkspace(WS2.id);
    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
  });

  it("launching a new session while zoomed exits zoom", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any)
      .mockReturnValueOnce("c" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    await deck.launch(WS as any, null);

    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
    expect(deckEl.querySelector(".deck-strip")).toBeNull();
  });

  it("exitZoom() reports whether it actually exited zoom", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    expect(deck.exitZoom()).toBe(false);

    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    expect(deck.exitZoom()).toBe(true);
    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
  });

  it("focusing another visible tile while zoomed juggles it into the main area", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("a" as any)
      .mockReturnValueOnce("b" as any);

    await deck.launch(WS as any, null);
    await deck.launch(WS as any, null);

    deck.zoomTo("a");
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);
    const firstZoomed = deckEl.querySelector(".tile.zoomed") as HTMLElement;
    expect(firstZoomed).not.toBeNull();

    // "b" is the other visible tile — focusByIndex(2) targets it in launch order.
    deck.focusByIndex(2);

    expect(deckEl.classList.contains("is-zoomed")).toBe(true);
    const strip = deckEl.querySelector(".deck-strip") as HTMLElement;
    expect(strip).not.toBeNull();
    // The tile that was zoomed is now the one juggled into the strip...
    expect(firstZoomed.classList.contains("zoomed")).toBe(false);
    expect(strip.contains(firstZoomed)).toBe(true);
    // ...and a different tile now occupies the zoomed slot.
    const zoomedTile = deckEl.querySelector(".tile.zoomed") as HTMLElement;
    expect(zoomedTile).not.toBeNull();
    expect(zoomedTile).not.toBe(firstZoomed);
  });
});

// The list is rebuilt via innerHTML on every poll — five seconds apart. Rows
// only became focusable once they were buttons, which made that rebuild a
// focus-stealing bug waiting to happen.
it("keeps keyboard focus on the same row when the list is rebuilt", async () => {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  const deck = new Deck(deckEl, listEl, () => []);

  await deck.launch(WS as any, null);
  const row = listEl.querySelector<HTMLElement>(".sess-row")!;
  row.focus();
  const key = row.dataset.focusKey;

  await deck.launch(WS as any, null); // any state change re-renders the list

  expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(key);
});

describe("serializeTiles + taskId", () => {
  it("persists the task link so a restored tile is still linked", () => {
    const tiles = [
      { session: "s1", workspacePath: "/p", name: "n", workspaceId: "w1", taskId: "01AAA" },
      { session: "s2", workspacePath: "/p", name: "n2", workspaceId: "w1" },
    ];
    const out = serializeTiles(tiles as never);
    expect(out[0].taskId).toBe("01AAA");
    expect(out[1].taskId).toBeUndefined();
  });
});

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "Fix", kind: "bug", status: "open", project: "P",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "", path: "/p/01AAA-fix.md", damaged: null, conflict: false, labels: [],
    ...over,
  };
}

// No `working: true` step — ▶ has nowhere it is told to move a card to.
const CFG_NO_WORKING: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }],
};

const CFG_WITH_WORKING: BoardConfig = {
  v: 1,
  steps: [
    { id: "open", label: "open" },
    { id: "doing", label: "doing", working: true },
    { id: "done", label: "done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "bug" }],
};

describe("Deck.launchFromTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    // The real IPC call returns the card as the write actually left it, and
    // `launchFromTask` now builds the prompt from that return value — so the
    // mock has to answer with a real card, not `undefined`, or building the
    // prompt after a successful move would throw on every test here.
    updateTaskMock.mockImplementation((_ws: string, id: string, patch: { status?: string }) =>
      Promise.resolve(card({ id, ...(patch.status ? { status: patch.status } : {}) })));
  });

  it("launches a fresh tile when no session is linked to the card", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    const outcome = await deck.launchFromTask(WS as any, card(), CFG_NO_WORKING);

    expect(outcome).toBe("launched");
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  // Deleting the `if (alive) { ...; return "focused"; }` guard in
  // Deck.launchFromTask must fail this test: without it, a second click on the
  // same card would start a second agent editing the same files.
  it("focuses the existing session instead of launching a second one", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS]);

    const first = await deck.launchFromTask(WS as any, card(), CFG_NO_WORKING);
    expect(first).toBe("launched");
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);

    const second = await deck.launchFromTask(WS as any, card(), CFG_NO_WORKING);

    expect(second).toBe("focused");
    // No second tile, and no second session-start IPC call: the card's
    // existing (idle) session was focused, not duplicated.
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  // ▶ writes the step itself, so the card moves whether or not the agent
  // remembers to.
  it("moves the card to the configured working step", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    await deck.launchFromTask(WS as any, card({ status: "open" }), CFG_WITH_WORKING);

    expect(updateTaskMock).toHaveBeenCalledWith(WS.id, "01AAA", { status: "doing" });
  });

  // No step is marked `working` — there is nothing ▶ has been told to do,
  // so it must not guess at one.
  it("does not move the card when the configuration has no working step", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    await deck.launchFromTask(WS as any, card({ status: "open" }), CFG_NO_WORKING);

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  // The work matters more than the bookkeeping: a rejected updateTask must
  // not stop the session from launching.
  it("still launches when moving the card to the working step fails", async () => {
    updateTaskMock.mockRejectedValueOnce(new Error("boom"));
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    const outcome = await deck.launchFromTask(WS as any, card({ status: "open" }), CFG_WITH_WORKING);

    expect(outcome).toBe("launched");
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);
  });

  // The prompt used to be built at the call site, before the move — true only
  // on a board with no `working` step. Here the move succeeds, so the prompt
  // handed to the session must name the step the card is *actually* in now,
  // not the one it started in.
  it("builds the prompt from the card's step after a successful move, not the step it started in", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    await deck.launchFromTask(WS as any, card({ status: "open" }), CFG_WITH_WORKING);

    const prompt = startMock.mock.calls[0][2] as string;
    expect(prompt).toContain('"doing"');
    expect(prompt).not.toContain('"open"');
  });

  // The move is best-effort and must not block the launch — but the prompt it
  // feeds the session has to stay true when the write fails, which means
  // reporting the step the card is still actually in, not the step the move
  // was trying to reach.
  it("builds the prompt from the card's unmoved step when the move fails, not the step it was trying to reach", async () => {
    updateTaskMock.mockRejectedValueOnce(new Error("boom"));
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    await deck.launchFromTask(WS as any, card({ status: "open" }), CFG_WITH_WORKING);

    const prompt = startMock.mock.calls[0][2] as string;
    expect(prompt).toContain('"open"');
    expect(prompt).not.toContain('"doing"');
  });
});

describe("Deck.launchOnWorktree", () => {
  const WT = "/p-pr/7-fix-thing";

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
  });

  // The session runs in the worktree, but belongs to the workspace: `cwd` and
  // `workspaceId` are deliberately not about the same directory.
  it("starts in the worktree while staying bound to the workspace", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    await deck.launchOnWorktree(WT, WS.id, "⑂ #7", "PR #7");

    expect(deckEl.querySelectorAll(".tile").length).toBe(1);
    const [cwd, workspaceId, prompt] = startMock.mock.calls[0];
    expect(cwd).toBe(WT);
    expect(workspaceId).toBe(WS.id);
    expect(prompt).toBe("PR #7");
  });

  // Grouping and filtering follow `workspaceId`, not the directory — otherwise a
  // PR session would read as an orphan and stay visible in every workspace.
  it("is filtered with the workspace, not with its own directory", async () => {
    const WS2 = { id: "w2", name: "Q", path: "/q", color: "#000" };
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS, WS2]);

    await deck.launchOnWorktree(WT, WS.id, "⑂ #7", "PR #7");

    deck.setActiveWorkspace(WS.id);
    expect(deckEl.querySelector(".tile")!.classList.contains("ws-hidden")).toBe(false);
    deck.setActiveWorkspace(WS2.id);
    expect(deckEl.querySelector(".tile")!.classList.contains("ws-hidden")).toBe(true);
  });

  // Removing a worktree under a live session would leave it restarting in a
  // directory that no longer exists, so removal has to be able to ask first.
  it("reports a live session inside a worktree path", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    expect(deck.hasSessionIn(WT)).toBe(false);

    await deck.launchOnWorktree(WT, WS.id, "⑂ #7", "PR #7");

    expect(deck.hasSessionIn(WT)).toBe(true);
    expect(deck.hasSessionIn("/p-pr/8-other")).toBe(false);
  });
});
