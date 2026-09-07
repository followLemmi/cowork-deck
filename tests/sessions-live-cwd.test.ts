// @vitest-environment jsdom
/** Every per-session display follows the directory its session is in, rather
 *  than the one the tile was constructed with (#508).
 *
 *  The bug this covers was not a stale read — it was the wrong question. A tile
 *  recorded `workspacePath` once and the git badge, the sidebar row's branch and
 *  the whole tools panel read that value forever, so they described the launch
 *  directory however far the session had moved. What is asserted here is
 *  therefore about *which directory each reading is of*, and about the identity
 *  fields that must NOT follow it: a session belongs to the workspace it was
 *  launched in, restarts there, and is persisted there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const startMock = vi.fn();

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    cols = 200;
    constructor(public session: string, public mount: HTMLElement) {}
    start = startMock;
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
    serialize = vi.fn().mockReturnValue("");
  },
}));

vi.mock("../src/ipc", () => ({
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
  closeSession: vi.fn(),
  memoryCaptureOffer: vi.fn().mockResolvedValue({ available: false }),
  saveUiState: vi.fn().mockResolvedValue(undefined),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  updateTask: vi.fn(),
  gitStatus: vi.fn(),
  sessionCwds: vi.fn(),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
  sessionActivity: vi.fn().mockResolvedValue({ calls: [] }),
  worktreeFiles: vi.fn().mockResolvedValue([]),
  gitChanges: vi.fn().mockResolvedValue({ branch: null, files: [] }),
  revealPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck, serializeTiles, tileCwd } from "../src/sessions";
import { gitStatus, sessionCwds, worktreeFiles } from "../src/ipc";

/** The workspace a session is launched in, and the worktree it walks into: a
 *  sibling of the workspace on another branch, which is the case the issue's own
 *  reproduction uses. */
const WS = { id: "w", name: "P", path: "/p/deck", color: "#fff" };
const ELSEWHERE = "/p/deck-issue/508-a-bug";

/** Launch one tile and hand back the deck, the tile and its session id. */
async function deckWithOneTile() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  const deck = new Deck(deckEl, listEl, () => [WS as never]);
  await deck.launch(WS as never, null);
  const session = [...(deck as never as { tiles: Map<string, unknown> }).tiles.keys()][0];
  const tile = (deck as never as { tiles: Map<string, Record<string, never>> })
    .tiles.get(session)!;
  return { deck: deck as never as { pollOnce(): Promise<void> }, deckEl, session, tile };
}

/** What the session says when asked, for every session at once. */
function reports(where: Record<string, string>) {
  vi.mocked(sessionCwds).mockResolvedValue(where);
}

describe("tileCwd", () => {
  it("prefers what the session says over where it was launched", () => {
    expect(tileCwd({ liveCwd: ELSEWHERE, workspacePath: "/p/deck" })).toBe(ELSEWHERE);
  });

  /** Not a stopgap: a session that has reported nothing has said nothing to
   *  contradict the directory it was started in, and that is a real place. */
  it("falls back to the launch directory while nothing has been said", () => {
    expect(tileCwd({ liveCwd: null, workspacePath: "/p/deck" })).toBe("/p/deck");
  });
});

describe("a session's displays follow the directory it is in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    reports({});
    vi.mocked(gitStatus).mockResolvedValue({ branch: "dev", dirty: false });
  });

  it("reads the branch of the folder the session is in now, not the launch one", async () => {
    const { deck, deckEl, session, tile } = await deckWithOneTile();

    reports({ [session]: ELSEWHERE });
    vi.mocked(gitStatus).mockImplementation(async (cwd: string) =>
      ({ branch: cwd === ELSEWHERE ? "issue-508" : "dev", dirty: false }));
    await deck.pollOnce();

    expect(vi.mocked(gitStatus).mock.calls.map((c) => c[0])).toContain(ELSEWHERE);
    expect(tile.branch).toBe("issue-508");
    expect(deckEl.querySelector(".tile-git")?.textContent).toContain("issue-508");
  });

  /** The criterion the issue states last, and the one a naive fix misses: a
   *  folder that is no repository must be handled the way it already is on
   *  launch — the badge gone — rather than left wearing the branch of where the
   *  session came from. */
  it("hides the badge when the session has moved somewhere that is not a checkout", async () => {
    const { deck, deckEl, session, tile } = await deckWithOneTile();
    await deck.pollOnce();
    expect(deckEl.querySelector(".tile-git")?.classList.contains("hidden")).toBe(false);

    reports({ [session]: "/tmp/scratch" });
    vi.mocked(gitStatus).mockResolvedValue({ branch: null, dirty: false });
    await deck.pollOnce();

    expect(tile.branch).toBeNull();
    expect(deckEl.querySelector(".tile-git")?.classList.contains("hidden")).toBe(true);
  });

  /** The tools panel's whole scope — its file list, its diff, its scope line and
   *  the path a click reveals — is one read of `host.cwd()`, so this is the
   *  reading that stands for all four. */
  it("reads the tools panel's files from the folder the session is in", async () => {
    const { deck, session, tile } = await deckWithOneTile();
    reports({ [session]: ELSEWHERE });
    await deck.pollOnce();

    await (tile.tools as never as { show(t: unknown): Promise<void> })
      .show({ id: "files", icon: "folder", name: "Files" });

    expect(worktreeFiles).toHaveBeenCalledWith(ELSEWHERE);
  });

  /** A panel already open when the session moves must not keep showing the old
   *  checkout until somebody closes and reopens it. */
  it("re-reads an open tools panel when the session moves", async () => {
    const { deck, session, tile } = await deckWithOneTile();
    const refresh = vi.spyOn(tile.tools as never as { refresh(): void }, "refresh");

    reports({ [session]: ELSEWHERE });
    await deck.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);

    // And not on every tick afterwards: the session has not moved again, and
    // re-reading a checkout twelve times a minute per tile is the cost #251
    // exists to keep off this path.
    await deck.pollOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /** The common case, and the one that must cost nothing: an agent session
   *  reports the directory it was launched in, on every hook, forever — Claude
   *  Code pins its working directory. Nothing on screen would read differently,
   *  so nothing is re-read. */
  it("does not call a session reporting its launch directory a move", async () => {
    const { deck, session, tile } = await deckWithOneTile();
    const refresh = vi.spyOn(tile.tools as never as { refresh(): void }, "refresh");

    reports({ [session]: "/p/deck" });
    await deck.pollOnce();

    expect(tile.liveCwd).toBe("/p/deck");
    expect(refresh).not.toHaveBeenCalled();
  });

  /** The identity half of the same fact. Where a session *is* changes; which
   *  workspace it belongs to, where a restart puts it and what the layout
   *  records do not — all three are the directory it was launched in. */
  it("leaves the launch directory alone, because four other things read it", async () => {
    const { deck, session, tile } = await deckWithOneTile();
    reports({ [session]: ELSEWHERE });
    await deck.pollOnce();

    expect(tile.workspacePath).toBe("/p/deck");
    expect(serializeTiles([tile as never])[0].cwd).toBe("/p/deck");
  });

  /** A backend that could not answer leaves every tile exactly where this
   *  feature found it, rather than blanking a badge that had a branch on it. */
  it("falls back to the launch directory when the deck cannot be asked", async () => {
    const { deck, deckEl, session, tile } = await deckWithOneTile();
    reports({ [session]: ELSEWHERE });
    await deck.pollOnce();
    expect(tile.liveCwd).toBe(ELSEWHERE);

    vi.mocked(sessionCwds).mockRejectedValue(new Error("no such command"));
    vi.mocked(gitStatus).mockResolvedValue({ branch: "issue-508", dirty: true });
    await deck.pollOnce();

    // The last answer stands rather than being torn down by a failed read.
    expect(tile.liveCwd).toBe(ELSEWHERE);
    expect(deckEl.querySelector(".tile-git")?.textContent).toContain("issue-508");
  });

  /** An id missing from the answer is "nothing has said", which is how a session
   *  that never reports one keeps its launch directory. */
  it("keeps the launch directory for a session the answer does not mention", async () => {
    const { deck, session, tile } = await deckWithOneTile();
    reports({ "some-other-session": ELSEWHERE });
    await deck.pollOnce();

    expect(tile.liveCwd).toBeNull();
    expect(vi.mocked(gitStatus).mock.calls.map((c) => c[0])).not.toContain(ELSEWHERE);
    expect(session).toBeTruthy();
  });
});
