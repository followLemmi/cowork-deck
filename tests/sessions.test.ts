// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const writeSpy = vi.fn();
const startMock = vi.fn();

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

describe("Deck.launchFromTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
  });

  it("launches a fresh tile when no session is linked to the card", async () => {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl, () => [WS]);

    const outcome = await deck.launchFromTask(WS as any, { id: "01AAA", title: "Fix" }, "prompt");

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

    const first = await deck.launchFromTask(WS as any, { id: "01AAA", title: "Fix" }, "prompt");
    expect(first).toBe("launched");
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);

    const second = await deck.launchFromTask(WS as any, { id: "01AAA", title: "Fix" }, "prompt");

    expect(second).toBe("focused");
    // No second tile, and no second session-start IPC call: the card's
    // existing (idle) session was focused, not duplicated.
    expect(deckEl.querySelectorAll(".tile").length).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
