// @vitest-environment jsdom
/** The sessions of a workspace that has been pulled into its own window stay
 *  listed here, as proxies.
 *
 *  This is what keeps `focusNextWaiting` — "who is blocked on me", the one
 *  command whose whole purpose is that question — reaching the other monitor.
 *  It also answers the smaller thing the owner asked for: a workspace pulled out
 *  should not look like a workspace you have lost. Part of #244. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) { this.session = session; }
    start = vi.fn().mockResolvedValue(undefined);
    write = vi.fn(); focus = vi.fn(); dispose = vi.fn(); fit = vi.fn();
    // What a hand-off copies out of a panel that is being given up.
    serialize = vi.fn().mockReturnValue("");
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
import { closeSession } from "../src/ipc";

const WS = { id: "w", name: "P", path: "/p", color: "#61afef" };

function makeDeck() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  return { deck: new Deck(deckEl, listEl, () => [WS as never]), listEl };
}

const remote = (state: "waitingInput" | "working") => [
  { session: "far", name: "Far session", state, workspaceId: "w", label: "workspace-w" },
];

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("sessions held by another window", () => {
  it("are listed under their workspace, not in a section of their own", () => {
    const { deck, listEl } = makeDeck();
    deck.setRemoteSessions(remote("working"));
    // One heading — the workspace's — and the proxy under it.
    expect(listEl.querySelectorAll(".sess-group-head").length).toBe(1);
    expect(listEl.querySelector(".sess-group-name")?.textContent).toBe("P");
    expect(listEl.querySelectorAll(".sess-row.remote").length).toBe(1);
  });

  /** The whole point: the badge that says how many are waiting has to count the
   *  ones on the other monitor, or it answers for one window while looking like
   *  it answers for the workspace. */
  it("are counted by the waiting badge on their workspace", () => {
    const { deck, listEl } = makeDeck();
    deck.setRemoteSessions(remote("waitingInput"));
    expect(listEl.querySelector(".sess-group-badge")?.textContent).toBe("1 waiting");
  });

  /** Clicking one is a request to the window that has it — this window has no
   *  tile to focus and must not pretend otherwise. */
  it("ask their own window to raise itself when clicked", () => {
    const { deck, listEl } = makeDeck();
    const onRemoteFocus = vi.fn();
    deck.setRemoteFocus(onRemoteFocus);
    deck.setRemoteSessions(remote("working"));
    listEl.querySelector<HTMLElement>(".sess-row.remote")!.click();
    expect(onRemoteFocus).toHaveBeenCalledWith("workspace-w", "far");
  });

  /** A dimmed row tells a sighted reader it is elsewhere and tells a screen
   *  reader nothing, so the accessible name carries it. Not `aria-disabled`:
   *  the row is not disabled, it does something different. */
  it("say in their accessible name that they are elsewhere", () => {
    const { deck, listEl } = makeDeck();
    deck.setRemoteSessions(remote("waitingInput"));
    const row = listEl.querySelector<HTMLElement>(".sess-row.remote")!;
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.getAttribute("aria-label")).toContain("another window");
  });

  /** A window that has gone stops reporting, and its proxies go with it rather
   *  than staying on screen for ever as sessions nobody can reach. */
  it("disappear when their window stops reporting", () => {
    const { deck, listEl } = makeDeck();
    deck.setRemoteSessions(remote("working"));
    expect(listEl.querySelectorAll(".sess-row.remote").length).toBe(1);
    deck.setRemoteSessions([]);
    expect(listEl.querySelectorAll(".sess-row.remote").length).toBe(0);
  });
});

/** Giving a session up is not ending it. Closing a workspace window returns its
 *  workspace and never costs a session — PTYs die on app exit only — so an
 *  accidental Cmd+W has to cost nothing but a window. Part of #245. */
describe("giving a tile up", () => {
  it("never ends the session behind it", async () => {
    const { deck, listEl } = makeDeck();
    await deck.launch(WS as never, null);
    const session = listEl.querySelector<HTMLElement>(".sess-row")!
      .dataset.focusKey!.replace("session:", "");

    deck.releaseTile(session);

    expect(closeSession).not.toHaveBeenCalled();
    expect(listEl.querySelectorAll(".sess-row").length).toBe(0);
  });

  /** A hand-off carries one workspace's tiles. Carrying another's would move
   *  sessions the person never asked to move, into a window pinned to something
   *  else. */
  it("hands over only the workspace being moved", async () => {
    const { deck } = makeDeck();
    await deck.launch(WS as never, null);
    expect(deck.handOffPayload(WS.id).length).toBe(1);
    expect(deck.handOffPayload("some-other-workspace")).toEqual([]);
  });
});
