// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) {
      this.session = session;
    }
    start = vi.fn().mockResolvedValue(undefined);
    write = vi.fn();
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
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck } from "../src/sessions";
import { onState } from "../src/ipc";
import { emit } from "@tauri-apps/api/event";

const WS = { id: "w", name: "P", path: "/p", color: "#61afef" };

async function makeDeck() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  const deck = new Deck(deckEl, listEl, () => [WS as never]);
  await deck.wireEvents();
  const emitState = vi.mocked(onState).mock.calls[0][0] as (s: string, st: SessionState) => void;
  return { deck, emitState };
}

/** Every `pill://count` the deck sent, in order. */
const counts = () =>
  vi.mocked(emit).mock.calls
    .filter(([name]) => name === "pill://count")
    .map(([, payload]) => (payload as { n: number }).n);

describe("Deck — the pill count on the wire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  // `renderList` runs on every state transition of every session and on every
  // poll tick. Its own DOM is cheap to rebuild; the event is not, because the
  // window at the other end re-shows itself and takes the keyboard with it.
  it("says nothing when a re-render leaves the count where it was", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launch(WS as never, null);
    await deck.launch(WS as never, null);
    const [a, b] = [...(deck as never as { tiles: Map<string, unknown> }).tiles.keys()];

    emitState(a, "waitingInput");
    emitState(b, "working"); // re-renders the list, one session still waiting

    expect(counts()).toEqual([0, 1]);
  });

  it("reports every count that actually changed", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launch(WS as never, null);
    await deck.launch(WS as never, null);
    const [a, b] = [...(deck as never as { tiles: Map<string, unknown> }).tiles.keys()];

    emitState(a, "waitingInput");
    emitState(b, "waitingInput");
    emitState(a, "working");
    emitState(b, "working");

    expect(counts()).toEqual([0, 1, 2, 1, 0]);
  });
});
