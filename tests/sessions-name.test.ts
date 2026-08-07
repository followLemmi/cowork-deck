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
