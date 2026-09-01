// @vitest-environment jsdom
/** Which sessions the delete question is allowed to name — the deck's half of
 *  #250.
 *
 *  `describeDeleteImpact` is handed a list of names and asks no questions about
 *  where they came from. This is where "the sessions running in THIS workspace"
 *  is actually decided, and the three things it has to get right are: a session
 *  placed by its directory rather than by an id, a session in another window,
 *  and a tile that is nothing but scrollback. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionEntry, SessionState } from "../src/ipc";

const { onStateMock } = vi.hoisted(() => ({ onStateMock: vi.fn() }));

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) { this.session = session; }
    start = vi.fn().mockResolvedValue(undefined);
    write = vi.fn(); focus = vi.fn(); dispose = vi.fn(); fit = vi.fn();
    serialize = vi.fn().mockReturnValue("");
  },
}));

vi.mock("../src/ipc", () => ({
  onState: onStateMock,
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

const WS = { id: "w", name: "relay", path: "/p", color: "#fff" };
const OTHER = { id: "w2", name: "harbor", path: "/q", color: "#000" };

describe("Deck.liveSessionNamesIn", () => {
  let stateCb: ((session: string, state: SessionState) => void) | null = null;

  async function makeDeck() {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS, OTHER] as never);
    await deck.wireEvents();
    return deck;
  }

  /* `userName` rather than `name` alone: what a person typed outranks everything,
     so this is the one slot that fixes what `resolveTileName` will return. */
  const tile = (sessionId: string, name: string, cwd: string, workspaceId?: string): SessionEntry =>
    ({ sessionId, cwd, name, userName: name, workspaceId });

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    stateCb = null;
    onStateMock.mockImplementation(async (cb: (s: string, st: SessionState) => void) => {
      stateCb = cb;
      return () => {};
    });
  });

  it("names this workspace's sessions and no other workspace's", async () => {
    const deck = await makeDeck();
    await deck.restore([tile("s1", "alpha", "/p", "w"), tile("s2", "beta", "/q", "w2")]);
    expect(deck.liveSessionNamesIn("w")).toEqual(["alpha"]);
  });

  /* The same rule the sidebar groups by: a session that names no workspace still
     belongs to the one whose directory it is running in. Deleting that workspace
     cuts it loose exactly as much as it does the others. */
  it("places a session by its directory when it names no workspace", async () => {
    const deck = await makeDeck();
    await deck.restore([tile("s1", "alpha", "/p")]);
    expect(deck.liveSessionNamesIn("w")).toEqual(["alpha"]);
  });

  /* Deleting a workspace closes the window pinned to it and hands its sessions
     back as orphans — so the question has to have counted them. */
  it("counts the sessions held by another window", async () => {
    const deck = await makeDeck();
    await deck.restore([tile("s1", "alpha", "/p", "w")]);
    deck.setRemoteSessions([
      { session: "far", name: "gamma", state: "working", workspaceId: "w", label: "workspace-w" },
    ]);
    expect(deck.liveSessionNamesIn("w")).toEqual(["alpha", "gamma"]);
  });

  /* An `ended` tile is scrollback and no process. There is nothing in it left to
     cut loose, and naming it would inflate the number the person is deciding on. */
  it("leaves out tiles that hold nothing but scrollback", async () => {
    const deck = await makeDeck();
    await deck.restore([tile("s1", "alpha", "/p", "w"), tile("s2", "beta", "/p", "w")]);
    stateCb!("s2", "ended");
    expect(deck.liveSessionNamesIn("w")).toEqual(["alpha"]);
    stateCb!("s1", "error");
    expect(deck.liveSessionNamesIn("w")).toEqual([]);
  });
});
