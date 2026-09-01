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
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
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

/** How many sessions each `session://waiting` said were waiting, in order.
 *
 *  The deck used to send a count of its own, which the floating pill trusted
 *  absolutely — which made two windows flap between two partial totals every
 *  five seconds. A window reports **its own sessions** instead, and the main
 *  window works out the rest, because it is the only participant that hears
 *  everybody (#243). The pill is gone (#394) and this is not about it: the
 *  report is what draws a pulled-out workspace's rows in the main window and
 *  what lets `focusNextWaiting` reach the other monitor. */
const counts = () =>
  vi.mocked(emit).mock.calls
    .filter(([name]) => name === "session://waiting")
    .map(([, payload]) => {
      const { sessions } = payload as { sessions: { state: string }[] };
      return sessions.filter((x) => x.state === "waitingInput").length;
    });

describe("Deck — what a window reports about its own sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  // `renderList` runs on every state transition of every session and on every
  // poll tick, and reports each time even when nothing moved. A window
  // registers its listener asynchronously and drops what arrives before it is
  // ready, so the repeat is the only way an early report lands at all.
  it("repeats the report on a re-render that left it where it was", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launch(WS as never, null);
    await deck.launch(WS as never, null);
    const [a, b] = [...(deck as unknown as { tiles: Map<string, unknown> }).tiles.keys()];

    emitState(a, "waitingInput");
    emitState(b, "working"); // re-renders the list, one session still waiting

    expect(counts().slice(-2)).toEqual([1, 1]);
  });

  it("reports every count that changed", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launch(WS as never, null);
    await deck.launch(WS as never, null);
    const [a, b] = [...(deck as unknown as { tiles: Map<string, unknown> }).tiles.keys()];

    emitState(a, "waitingInput");
    emitState(b, "waitingInput");
    emitState(a, "working");
    emitState(b, "working");

    expect(counts().slice(-4)).toEqual([1, 2, 1, 0]);
  });
});
