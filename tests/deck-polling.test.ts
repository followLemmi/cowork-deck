// @vitest-environment jsdom
/** The deck's polling lifecycle, driven through `startApp` — the sibling of
 *  `tests/pr-polling.test.ts`, and for the same reason: the gate is wiring. The
 *  board and the pull requests are gated on a view *and* focus; the deck has no
 *  view to be on, so focus is its only gate, and whether the `blur` and `focus`
 *  handlers actually reach it is a fact about `app.ts` that no unit test of
 *  `sessions.ts` can see.
 *
 *  What a leaked chain costs here is worse than a wasted GraphQL call: every tick
 *  is a `git_status` per unique directory plus a `session_snapshots` that reads
 *  and parses every open transcript from disk, twelve times a minute, in every
 *  window — minimised ones included. See #251. */
import { describe, it, expect, vi } from "vitest";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

/** One session in the stored layout, so a boot has something to poll for
 *  without a launch: `startApp` restores it, and the restore is what starts the
 *  poll. */
const LAYOUT = [{
  sessionId: "s1", cwd: "/p", name: "session · P", workspaceId: "w",
  nameKind: "placeholder" as const,
}];

const snapshotsMock = vi.fn().mockResolvedValue({});
const gitStatusMock = vi.fn().mockResolvedValue({ branch: "main", dirty: false });

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  prList: vi.fn().mockResolvedValue([]),
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue(LAYOUT),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn(),
  gitStatus: gitStatusMock,
  sessionSnapshots: snapshotsMock,
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
  onScheduledFire: vi.fn().mockResolvedValue(() => {}),
  onSchedulerBroken: vi.fn().mockResolvedValue(() => {}),
  onTasksChanged: vi.fn().mockResolvedValue(() => {}),
  scheduleAck: vi.fn().mockResolvedValue(undefined),
  schedulerReady: vi.fn().mockResolvedValue(undefined),
  taskWatchSync: vi.fn().mockResolvedValue(undefined),
  taskOpenCounts: vi.fn().mockResolvedValue({}),
  taskCapabilities: vi.fn().mockResolvedValue(null),
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
  listTasks: vi.fn().mockResolvedValue([]),
  // Not this test's subject, but both are on timers of their own and an
  // unmocked one fills the run with stack traces from `invoke`.
  usageSnapshot: vi.fn().mockResolvedValue([]),
  loadTerminals: vi.fn().mockResolvedValue({ items: [], active: {}, open: [] }),
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
    load = vi.fn().mockResolvedValue(undefined);
    setCounts = vi.fn();
    setSkillsSource = vi.fn();
    setTreeHooks = vi.fn();
    sessionHost = vi.fn().mockReturnValue(null);
    showWaiting = vi.fn();
    showExpanded = vi.fn();
    focusActive = vi.fn();
    activate = vi.fn().mockReturnValue(true);
  },
}));
vi.mock("../src/skills", () => ({
  SkillsPanel: class {
    all = [];
    load = vi.fn().mockResolvedValue(undefined);
    refreshRuns = vi.fn().mockResolvedValue(undefined);
    find = vi.fn();
  },
}));
vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    start = vi.fn().mockResolvedValue(undefined);
    write = vi.fn(); focus = vi.fn(); dispose = vi.fn(); fit = vi.fn(); clear = vi.fn();
    activate = vi.fn(); replay = vi.fn(); attach = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
  onAction: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main", onCloseRequested: async () => () => {}, destroy: async () => {},
    unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn(),
  }),
}));

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** `session_snapshots` is the tick's signature: it is the deck's poll and
 *  nothing else in the app calls it, whereas `git_status` is also the terminal
 *  drawer's. */
const ticks = () => snapshotsMock.mock.calls.length;

// One test, not five: `startApp` installs the window's `focus` and `blur`
// handlers, so a second boot in one file would leave two decks answering one
// event and every count below would be doubled. The lifecycle is walked in
// sequence instead.
describe("the deck's poll", () => {
  it("runs only while the window is focused, and reads once on the way back", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      // Mirrors index.html — `#rail` and `#workarea` are not optional: `app.ts`
      // mounts into both and asserts they exist.
      '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div><div id="limits"></div></div>'
      + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
      + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
      + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
      + '</div></div>';
    // Booted **unfocused**, which is how a second window arrives: it is created
    // behind whatever the person is looking at.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    // The restored tile is read exactly once, focus or no focus: that read is what
    // fills its branch, its context count and its transcript title, and those are
    // in every other window's session list too. What must not follow it is a
    // chain — ten minutes of an unfocused window is ten minutes of silence.
    expect(ticks()).toBe(1);
    expect(gitStatusMock).toHaveBeenCalledWith("/p");
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(ticks()).toBe(1);

    // Focus reads at once rather than at the next tick — the whole point of
    // pausing — and re-arms the chain, which then runs at five seconds.
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(ticks()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(ticks()).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(ticks()).toBe(4);

    // One tick ahead and no more: the chain is a single timer re-armed after each
    // read, not an interval, so a slow read cannot queue the next one behind it.
    // Fifteen seconds of a tick that never returns is one read, not three.
    let settle: (v: Record<string, never>) => void = () => {};
    snapshotsMock.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(ticks()).toBe(5);
    settle({});
    await flush();

    // Blur stops it, without anything else changing: no view was left, no tile
    // was closed.
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    const beforeBlur = ticks();
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(ticks()).toBe(beforeBlur);

    // And coming back a second time resumes, so the pause is a pause rather than
    // a one-way stop.
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(ticks()).toBe(beforeBlur + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(ticks()).toBe(beforeBlur + 2);

    vi.useRealTimers();
  });
});
