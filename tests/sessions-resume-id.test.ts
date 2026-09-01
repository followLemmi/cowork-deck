// @vitest-environment jsdom
//
// #199. The deck knows a session by the id it launched it with, and `/clear`
// mints a new one — so `claude --resume <launch-id>` does not fail, it brings
// back the conversation the person cleared away and orphans the one they were
// working in. The backend decides what to resume; what these cover is the one
// thing only the frontend can do, which is keep the fact alive across a restart:
// the poll tick learns the current conversation and `sessions.json` remembers it.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
    serialize = vi.fn().mockReturnValue("scrollback");
  },
}));

vi.mock("../src/ipc", () => ({
  onState: vi.fn(),
  onExit: vi.fn().mockResolvedValue(() => {}),
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck } from "../src/sessions";
import { gitStatus, saveLayout, sessionSnapshots, type SessionEntry } from "../src/ipc";

const WS = { id: "w", name: "relay", path: "/p", color: "#fff" };

const tokens = {
  context: 1_234, subagents: 0,
  spend: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 },
};
/** What one poll tick answers for one session. `resumeId` is `null` for a
 *  session still in the conversation it was launched with, which is every
 *  session until somebody types `/clear`. */
const snap = (resumeId: string | null = null) => ({
  tokens, title: null, titleSource: null, calls: 0, resumeId,
});

const snapshots = vi.mocked(sessionSnapshots);
const save = vi.mocked(saveLayout);

/** `pollOnce` is private and fires on its own five-second timer; a test drives
 *  it directly rather than waiting for the interval. */
const tick = (deck: Deck) => (deck as unknown as { pollOnce(): Promise<void> }).pollOnce();
const persist = (deck: Deck) =>
  (deck as unknown as { persistLayout(): Promise<void> }).persistLayout();

/** The entries of the last accepted write, which is what the next launch of the
 *  app would restore from. */
const lastSaved = (): SessionEntry[] => save.mock.calls[save.mock.calls.length - 1][0];

function mount() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  return { deckEl, listEl, deck: new Deck(deckEl, listEl, () => [WS as never]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  startMock.mockResolvedValue(undefined);
  vi.mocked(gitStatus).mockResolvedValue({ branch: null, dirty: false });
  save.mockResolvedValue(undefined);
  snapshots.mockResolvedValue({});
  vi.spyOn(crypto, "randomUUID").mockReturnValue("s1" as never);
});

describe("the conversation a tile resumes", () => {
  it("writes nothing about it for a session that has not been cleared", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap() } as never);
    await tick(deck);

    // Not `undefined` under a key that says the launch id is wrong: no key.
    expect(Object.keys(lastSaved()[0])).not.toContain("resumeId");
  });

  it("persists the new conversation when a clear reports one", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    save.mockClear();

    snapshots.mockResolvedValue({ s1: snap("after-the-clear") } as never);
    await tick(deck);

    // The tile's own identity is untouched — it is the pty key and the key every
    // hook event is attributed by.
    expect(lastSaved()[0].sessionId).toBe("s1");
    expect(lastSaved()[0].resumeId).toBe("after-the-clear");
  });

  it("writes once per clear rather than once per tick", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("after-the-clear") } as never);
    await tick(deck);
    save.mockClear();

    // The same answer, four times over: the tick is documented as one that does
    // not write `sessions.json`, and a save every five seconds per session would
    // make that false.
    await tick(deck);
    await tick(deck);
    await tick(deck);
    expect(save).not.toHaveBeenCalled();

    // A second `/clear` in the same session does write.
    snapshots.mockResolvedValue({ s1: snap("cleared-again") } as never);
    await tick(deck);
    expect(lastSaved()[0].resumeId).toBe("cleared-again");
  });

  it("saves once for a tick that clears several sessions at a time", async () => {
    // Broadcast types one thing into several sessions at once, so two tiles
    // reporting a new conversation in the same tick is a gesture rather than a
    // coincidence. `persistLayout` serialises the tiles it can see when it runs:
    // a call per tile put two saves in flight carrying different pictures, and
    // the one that landed last won. With the in-memory copy already updated the
    // guard above would never fire again, so a lost id stayed lost.
    const { deck } = mount();
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("s1" as never);
    await deck.launch(WS as never, null);
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("s2" as never);
    await deck.launch(WS as never, null);
    save.mockClear();

    snapshots.mockResolvedValue({
      s1: snap("s1-after-the-clear"),
      s2: snap("s2-after-the-clear"),
    } as never);
    await tick(deck);

    expect(save).toHaveBeenCalledTimes(1);
    const saved = lastSaved();
    expect(saved.find((e) => e.sessionId === "s1")?.resumeId).toBe("s1-after-the-clear");
    expect(saved.find((e) => e.sessionId === "s2")?.resumeId).toBe("s2-after-the-clear");
  });

  it("keeps a restored id against a tick that reports none", async () => {
    // The backend answers `null` for the whole of a restored tile's life until
    // its first hook arrives: its record of the fact is in memory and did not
    // survive the restart. Taking the stored id away on that would put the
    // pre-clear conversation back at the next close.
    const { deck } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      resumeId: "after-the-clear",
    }]);
    snapshots.mockResolvedValue({ s1: snap(null) } as never);
    await tick(deck);
    await persist(deck);

    expect(lastSaved()[0].resumeId).toBe("after-the-clear");
  });

  it("carries a restored id back into the layout, so it survives the next restart", async () => {
    const { deck } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      resumeId: "after-the-clear",
    }]);
    await persist(deck);

    expect(lastSaved()).toEqual([expect.objectContaining({
      sessionId: "s1", resumeId: "after-the-clear",
    })]);
  });

  it("hands the id to the window taking the session over", async () => {
    // Or that window persists an entry which has forgotten the clear, and the
    // next restart resumes what the person cleared away.
    const { deck } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      resumeId: "after-the-clear",
    }]);

    const payload = deck.handOffPayload("w");
    expect(payload[0].resumeId).toBe("after-the-clear");

    const { deck: other } = mount();
    await other.receive(payload);
    save.mockClear();
    await persist(other);
    expect(lastSaved()[0].resumeId).toBe("after-the-clear");
  });
});
