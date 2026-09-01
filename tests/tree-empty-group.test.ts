// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

const startMock = vi.fn();
const { onStateMock } = vi.hoisted(() => ({ onStateMock: vi.fn() }));

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
  onState: onStateMock,
  onExit: vi.fn().mockResolvedValue(() => {}),
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
  closeSession: vi.fn(),
  memoryCaptureOffer: vi.fn().mockResolvedValue({ available: false }),
  saveUiState: vi.fn().mockResolvedValue(undefined),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
}));

vi.mock("../src/modal", () => ({ confirmModal: vi.fn().mockResolvedValue(true) }));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck } from "../src/sessions";

let stateCb: ((session: string, state: SessionState) => void) | null = null;

const A = { id: "a", name: "A", path: "/a", color: "#fff" };
const B = { id: "b", name: "B", path: "/b", color: "#fff" };

/** Let the close's own promises run out: it asks whether the session leaves a
 *  note behind, and that answer arrives a microtask later than the click. */
const settled = () => new Promise((r) => setTimeout(r, 0));

/** A deck wired to hosts the way the sidebar wires them: one container per
 *  workspace, kept across renders, because the panel that owns those rows is
 *  not re-rendered when a session closes. That persistence is the whole point —
 *  a host the deck never visits keeps whatever the last render left in it. */
function treeDeck() {
  document.body.innerHTML = "";
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  const hosts = new Map<string, HTMLElement>(
    [A, B].map((w) => [w.id, document.createElement("div")]),
  );
  document.body.append(deckEl, listEl, ...hosts.values());
  const waiting = vi.fn();
  const deck = new Deck(deckEl, listEl, () => [A, B] as never);
  void deck.wireEvents();
  deck.setTree({
    host: (id) => hosts.get(id) ?? null,
    waiting,
    expanded: () => {},
    newSession: () => {},
    activate: () => {},
  });
  const rows = (id: string) => hosts.get(id)!.querySelectorAll(".sess-row").length;
  const closeTile = async (i: number) => {
    deckEl.querySelectorAll<HTMLButtonElement>('.tile [title="Close session"]')[i].click();
    await settled();
  };
  return { deck, hosts, waiting, rows, closeTile };
}

beforeEach(() => {
  vi.clearAllMocks();
  startMock.mockResolvedValue(undefined);
  stateCb = null;
  onStateMock.mockImplementation(async (cb: (s: string, st: SessionState) => void) => {
    stateCb = cb;
    return () => {};
  });
});

describe("a workspace whose last session closes", () => {
  it("empties its host in the tree, not just on the way to the last sibling", async () => {
    const { deck, rows, closeTile } = treeDeck();
    await deck.launch(A as never, null);
    await deck.launch(A as never, null);
    expect(rows(A.id)).toBe(2);

    await closeTile(0);
    expect(rows(A.id)).toBe(1);

    // The one the deck used to leave behind: with no tiles the workspace makes no
    // group, so nothing cleared the host it had filled the render before.
    await closeTile(0);
    expect(rows(A.id)).toBe(0);
  });

  it("keeps the create row, so the emptied workspace can be started in again", async () => {
    const { deck, hosts, closeTile } = treeDeck();
    await deck.launch(A as never, null);
    await closeTile(0);
    expect(hosts.get(A.id)!.querySelector(".sess-add")).not.toBeNull();
  });

  it("leaves the other workspaces' rows alone", async () => {
    const { deck, rows, closeTile } = treeDeck();
    await deck.launch(A as never, null);
    await deck.launch(B as never, null);
    await closeTile(0);
    expect(rows(A.id)).toBe(0);
    expect(rows(B.id)).toBe(1);
  });

  /* The same emptying by the other route the issue asked about: the session is
     not closed, it is taken over by another window, and this deck gives up its
     tile. `releaseTile` ends in the same render, so it stands or falls with the
     close — which is the reason to hold it here. */
  it("empties its host when the last session is torn out to another window", async () => {
    const { deck, rows } = treeDeck();
    await deck.launch(A as never, null);
    deck.releaseTile(deck.liveSessions()[0]);
    expect(rows(A.id)).toBe(0);
  });

  it("tells the workspace row its waiting count is now zero", async () => {
    const { deck, waiting, closeTile } = treeDeck();
    await deck.launch(A as never, null);
    // The count has to have something to go stale from, so the session is
    // waiting for a decision when it is closed.
    stateCb!(deck.liveSessions()[0], "waitingInput");
    expect(waiting).toHaveBeenCalledWith(A.id, 1);
    waiting.mockClear();

    await closeTile(0);
    // Nobody else is left to say so: the badge is written from the group loop,
    // and the emptied workspace no longer has a group in it.
    const forA = waiting.mock.calls.filter((c) => c[0] === A.id);
    expect(forA[forA.length - 1]).toEqual([A.id, 0]);
  });
});

/* Restoring keyboard focus across a render is not new — `renderList` has done it
   since the rows became buttons — but its capture was scoped to `listEl`, and
   with a tree every focusable row goes into a workspace's host instead. So the
   restore never fired for the rows a person actually tabs through, and the poll
   dropped their focus every five seconds. The create row is the one this branch
   put at risk: it used to be built once and then skipped, and is now rebuilt on
   every pass like everything else. */
describe("keyboard focus on a row inside a workspace's host", () => {
  it("survives a render, on a session row", async () => {
    const { deck, hosts } = treeDeck();
    await deck.launch(A as never, null);
    const session = deck.liveSessions()[0];
    hosts.get(A.id)!.querySelector<HTMLElement>(".sess-row")!.focus();

    // Any state change re-renders the list; the poll produces one unprompted.
    stateCb!(session, "waitingInput");

    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`session:${session}`);
  });

  it("survives a render, on the create row of a workspace with nothing in it", async () => {
    const { deck, hosts } = treeDeck();
    // A carries the session whose state change drives the render; B is the empty
    // workspace whose create row that render now rebuilds.
    await deck.launch(A as never, null);
    hosts.get(B.id)!.querySelector<HTMLElement>(".sess-add")!.focus();

    stateCb!(deck.liveSessions()[0], "waitingInput");

    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`add:${B.id}`);
  });
});
