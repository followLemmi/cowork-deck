// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

/** Enough of a panel for the deck to hold, plus the one thing under test: the
 *  deck sets `onInterrupt` on every panel it builds, and this keeps the
 *  function where the test can call it — which is what the terminal does when
 *  an `Escape` is followed by the interrupt hint going away. */
vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    onInterrupt: ((session: string) => void) | null = null;
    constructor(public session: string) {}
    start = vi.fn().mockResolvedValue(undefined);
    startCommand = vi.fn().mockResolvedValue(undefined);
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
import { sendNotification } from "@tauri-apps/plugin-notification";

const WS = { id: "w", name: "P", path: "/p", color: "#61afef" };

type Tile = { state: SessionState; panel: { onInterrupt: ((s: string) => void) | null } };

async function deckWithASession() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  const deck = new Deck(deckEl, listEl, () => [WS as never]);
  await deck.wireEvents();
  const report = vi.mocked(onState).mock.calls[0][0] as (s: string, st: SessionState) => void;
  await deck.launch(WS as never, null);
  const tiles = (deck as unknown as { tiles: Map<string, Tile> }).tiles;
  const [session] = [...tiles.keys()];
  const tile = tiles.get(session)!;
  /** What the panel calls when a turn on it was ended by an interrupt. */
  const interrupt = () => tile.panel.onInterrupt?.(session);
  return { deck, report, session, tile, interrupt };
}

/** The last state this deck told the other windows about, for the session
 *  under test. `renderList` emits on every change, which is how a tile the
 *  interrupt corrected reaches the pill and the main window's proxy rows —
 *  there is no second announcement for this path and there must not be. */
const announced = (session: string) => {
  const states = vi.mocked(emit).mock.calls
    .filter(([name]) => name === "session://waiting")
    .flatMap(([, payload]) => (payload as { sessions: { session: string; state: string }[] }).sessions)
    .filter((s) => s.session === session)
    .map((s) => s.state);
  return states[states.length - 1];
};

describe("Deck — a turn ended by an interrupt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  /** #333. `Stop` does not run when the person interrupts, so nothing
   *  superseded the `working` the last `PreToolUse` set — and `working` is what
   *  the scheduler's overlap guard and a card's "in progress" chip read. */
  it("frees a working session the way Stop would have", async () => {
    const { report, session, tile, interrupt } = await deckWithASession();
    report(session, "working");

    interrupt();

    expect(tile.state).toBe("done");
    expect(announced(session)).toBe("done");
  });

  /** A permission prompt approved mid-turn leaves the tile in `waitingInput`:
   *  `PermissionRequest` reported it and nothing reports the approval that put
   *  the agent back to work. An interrupt from there is still a turn ending. */
  it("frees a session still marked as waiting for a decision", async () => {
    const { report, session, tile, interrupt } = await deckWithASession();
    report(session, "waitingInput");

    interrupt();

    expect(tile.state).toBe("done");
  });

  it("leaves a session that had already finished its turn alone", async () => {
    const { report, session, tile, interrupt } = await deckWithASession();
    report(session, "done");

    interrupt();

    expect(tile.state).toBe("done");
  });

  /** The one that must never happen. A dead session's screen stops being
   *  repainted, so a frozen hint could outlive the process — and no reading of
   *  a screen may outrank a process that is gone. */
  it("never brings an ended session back to life", async () => {
    const { report, session, tile, interrupt } = await deckWithASession();
    report(session, "ended");

    interrupt();

    expect(tile.state).toBe("ended");
  });

  it("leaves an idle session alone", async () => {
    const { session, tile, interrupt } = await deckWithASession();
    expect(tile.state).toBe("idle");

    interrupt();

    expect(tile.state).toBe("idle");
    expect(announced(session)).toBe("idle");
  });

  /** The state is `Stop`'s; the notification is not. A `done` from a hook may be
   *  the first a person hears that a turn is over — this one follows a key they
   *  just pressed themselves, at the tile they pressed it in. */
  it("says nothing to the desktop about a key the person just pressed", async () => {
    const { report, session, tile, interrupt } = await deckWithASession();
    report(session, "working");
    vi.mocked(sendNotification).mockClear();

    interrupt();

    expect(tile.state).toBe("done");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  /** The other half of the same rule, so a `notify: false` that leaked onto the
   *  reported path would fail here rather than going quietly unnoticed. */
  it("still notifies for a turn that ended on its own", async () => {
    const { report, session } = await deckWithASession();
    vi.mocked(sendNotification).mockClear();

    report(session, "done");

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  /** A command tile runs one command rather than an agent: no turns, no hint of
   *  its own, and its real ending is its exit. The string can still reach its
   *  screen as ordinary output — `git log` on this branch prints it — so the
   *  panel is never given anything to report with. */
  it("does not watch a command tile for interrupts at all", async () => {
    const { deck } = await deckWithASession();
    await deck.openCommandTile("gh auth login", "gh auth login", "/p");
    const tiles = (deck as unknown as { tiles: Map<string, Tile & { kind?: string }> }).tiles;
    const command = [...tiles.values()].find((t) => t.kind === "command");

    expect(command).toBeDefined();
    expect(command!.panel.onInterrupt).toBeNull();
  });
});
