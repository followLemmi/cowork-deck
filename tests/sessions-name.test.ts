// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

const startMock = vi.fn();
const { confirmMock, notifyMock, onStateMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  notifyMock: vi.fn(),
  onStateMock: vi.fn(),
}));

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    mount: HTMLElement;
    constructor(session: string, mount: HTMLElement) {
      this.session = session;
      this.mount = mount;
    }
    start = startMock;
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onState: onStateMock,
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/modal", () => ({ confirmModal: confirmMock }));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: notifyMock,
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck, resolveTileName, type TileNames } from "../src/sessions";
import { gitStatus, saveLayout, sessionSnapshots } from "../src/ipc";

const WS = { id: "w", name: "relay", path: "/p", color: "#fff" };

const names = (over: Partial<TileNames> = {}): TileNames => ({
  context: null, placeholder: "session · relay", auto: null, user: null, ...over,
});

/** The truth table, row by row. Each case is named for the decision it pins, not
 *  for the shape of the input. */
describe("resolveTileName", () => {
  it("shows the placeholder while nothing else has a name", () => {
    expect(resolveTileName(names())).toBe("session · relay");
  });

  it("shows the transcript title once one arrives", () => {
    expect(resolveTileName(names({ auto: "Trace the retry budget" })))
      .toBe("Trace the retry budget");
  });

  it("keeps a context name when an auto title arrives", () => {
    // The row that carries the whole precedence decision: `☑ <card>` is already
    // meaningful, and it is how the board says which card a session belongs to.
    expect(resolveTileName(names({ context: "☑ Fix the pill counter", auto: "Pill counter bug" })))
      .toBe("☑ Fix the pill counter");
  });

  it("shows a hand-typed name over a context name", () => {
    expect(resolveTileName(names({ context: "⚡ Daily digest", user: "do not close" })))
      .toBe("do not close");
  });

  it("shows a hand-typed name over a transcript title", () => {
    expect(resolveTileName(names({ auto: "Trace the retry budget", user: "the noisy one" })))
      .toBe("the noisy one");
  });

  it("falls back to the transcript title when a hand-typed name is cleared", () => {
    // Clearing the field is the entire undo story, so the slot below has to be
    // reachable again rather than merely overridden.
    expect(resolveTileName(names({ auto: "Trace the retry budget", user: "" })))
      .toBe("Trace the retry budget");
  });

  it("treats an empty or whitespace-only auto title as absent", () => {
    expect(resolveTileName(names({ auto: "   " }))).toBe("session · relay");
    expect(resolveTileName(names({ auto: "" }))).toBe("session · relay");
  });

  it("trims every slot before showing it", () => {
    expect(resolveTileName(names({ user: "  spaced  " }))).toBe("spaced");
    expect(resolveTileName(names({ auto: "\tTrace it\n" }))).toBe("Trace it");
  });
});

describe("the displayed name is the one the deck speaks with", () => {
  let stateCb: ((session: string, state: SessionState) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    stateCb = null;
    onStateMock.mockImplementation(async (cb: (s: string, st: SessionState) => void) => {
      stateCb = cb;
      return () => {};
    });
  });

  /** A restored tile whose hand-typed name differs from its launch name — the
   *  cheapest way to make "displayed" and "launched" two different strings. */
  async function deckWithRenamedTile() {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS as never]);
    await deck.wireEvents();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder", userName: "the one I must not close",
    }]);
    return { deck, deckEl, listEl };
  }

  it("writes the name into the header and its tooltip together", async () => {
    const { deckEl } = await deckWithRenamedTile();
    const el = deckEl.querySelector<HTMLElement>(".tile-name")!;
    expect(el.textContent).toBe("the one I must not close");
    expect(el.title).toBe("the one I must not close");
  });

  it("asks to close using the displayed name", async () => {
    const { deck } = await deckWithRenamedTile();
    stateCb!("s1", "working");
    confirmMock.mockResolvedValue(false);
    await deck.closeActive();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("the one I must not close"),
    );
  });

  it("sends the notification with the displayed name as its body", async () => {
    await deckWithRenamedTile();
    stateCb!("s1", "waitingInput");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: "the one I must not close" }),
    );
  });

  it("carries the displayed name into the sidebar row and its aria-label", async () => {
    const { listEl } = await deckWithRenamedTile();
    const row = listEl.querySelector<HTMLElement>(".sess-row")!;
    expect(row.textContent).toContain("the one I must not close");
    expect(row.getAttribute("aria-label")).toContain("the one I must not close");
  });
});

/** The five-second tick already reads the transcript for token counts; these
 *  cover it reading the name out of the same bytes. */
describe("the poll tick names a tile from its transcript", () => {
  const snapshots = vi.mocked(sessionSnapshots);
  const git = vi.mocked(gitStatus);
  const save = vi.mocked(saveLayout);

  const usage = { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 };
  const snap = (title: string | null) => ({ usage, title, titleSource: title ? "ai" : null });

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    git.mockResolvedValue({ branch: null, dirty: false });
    save.mockResolvedValue(undefined);
    snapshots.mockResolvedValue({});
    vi.spyOn(crypto, "randomUUID").mockReturnValue("s1" as never);
  });

  /** `pollOnce` is private and fires on its own timer; a test drives it directly
   *  rather than waiting five seconds for the interval that already exists. */
  const tick = (deck: Deck) =>
    (deck as unknown as { pollOnce(): Promise<void> }).pollOnce();
  const persist = (deck: Deck) =>
    (deck as unknown as { persistLayout(): Promise<void> }).persistLayout();

  function mount() {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    return { deckEl, listEl, deck: new Deck(deckEl, listEl, () => [WS as never]) };
  }
  const shown = (deckEl: HTMLElement) => deckEl.querySelector<HTMLElement>(".tile-name")!;

  it("renames a plainly launched tile to the transcript title", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    expect(shown(deckEl).textContent).toBe("session · relay");

    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    expect(shown(deckEl).title).toBe("Trace the retry budget");
  });

  it("carries the new name into the sidebar row and its aria-label", async () => {
    const { deck, listEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    const row = listEl.querySelector<HTMLElement>(".sess-row")!;
    expect(row.textContent).toContain("Trace the retry budget");
    expect(row.getAttribute("aria-label")).toContain("Trace the retry budget");
  });

  it("never overwrites a name from a tracker card", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([
      { sessionId: "s1", cwd: "/p", name: "☑ Fix the pill counter", workspaceId: "w" },
    ]);
    snapshots.mockResolvedValue({ s1: snap("Pill counter bug") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("☑ Fix the pill counter");
  });

  it("never overwrites a scheduled scenario's name", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "⚡ Daily digest", workspaceId: "w",
      scheduledSkillId: "sk-digest",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Summarise yesterday") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("⚡ Daily digest");
  });

  it("follows the latest transcript title while no hand-typed name exists", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("First topic") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("First topic");

    snapshots.mockResolvedValue({ s1: snap("Second topic") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("Second topic");
  });

  it("leaves the name alone when the snapshot call fails", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    snapshots.mockRejectedValue(new Error("ipc down"));
    git.mockResolvedValue({ branch: "main", dirty: false });
    await tick(deck);

    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    // The halves of the tick are isolated: the git badge still filled in.
    expect(deckEl.querySelector(".tile-git")!.classList.contains("hidden")).toBe(false);
  });

  it("does not write to a tile removed while the call was in flight", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    const el = shown(deckEl);
    snapshots.mockImplementation(async () => {
      (deck as unknown as { remove(s: string): void }).remove("s1");
      return { s1: snap("Trace the retry budget") } as never;
    });
    await tick(deck);
    expect(el.textContent).toBe("session · relay");
  });

  it("does not persist the layout when only the transcript title changed", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    save.mockClear();
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(save).not.toHaveBeenCalled();
  });

  it("skips saving when the serialized layout has not changed", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    expect(save).toHaveBeenCalledTimes(1);
    // The spawn, restart and remove bursts all end in this call; only the first
    // of them has anything to write.
    await persist(deck);
    await persist(deck);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("stays dirty when the write fails, so the next attempt tries again", async () => {
    const { deck } = mount();
    save.mockRejectedValueOnce(new Error("disk full"));
    await deck.launch(WS as never, null);
    expect(save).toHaveBeenCalledTimes(1);
    await persist(deck);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("restores a hand-typed name and keeps it against a new transcript title", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder", userName: "the one I must not close",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("the one I must not close");
  });

  it("restores a legacy entry's name as a context name", async () => {
    // Nothing on disk tells `☑ <card>` from `session · foo` in a file written
    // before `nameKind` existed, and leaving a recognised name alone is the
    // safer of the two mistakes.
    const { deck, deckEl } = mount();
    await deck.restore([{ sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w" }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("session · relay");
  });

  it("restores a placeholder-marked entry so the transcript title can take over", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
  });
});
