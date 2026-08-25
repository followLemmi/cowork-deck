// @vitest-environment jsdom
/** ▶ on a GitHub issue card, driven through `main.ts`. The order of the two steps
 *  behind that button — prepare a worktree, then launch — is wiring, and no unit
 *  test of `sessions.ts` can see it: `Deck.launchOnWorktree` is only reached once
 *  the worktree call has already succeeded. */
import { describe, it, expect, vi } from "vitest";

const listTasksMock = vi.fn();
const issueWorktreeAddMock = vi.fn();
const startMock = vi.fn().mockResolvedValue(undefined);

/** GitHub-backed, so `launchFromTask` takes the issue branch. */
const WS = {
  id: "w", name: "P", path: "/p", color: "#fff",
  github: { account: "a", host: "github.com" },
  tracker: { providers: [{ type: "github" as const }] },
};

const CAPS = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  board: {
    v: 1,
    steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
    kinds: [{ id: "issue", label: "Issue" }],
  },
  boardError: null, boardEditable: false,
};

const issue = (id: string) => ({
  id, title: `Issue ${id}`, kind: "", status: "open", project: "P",
  created: "2026-07-01T10:00:00Z", resolved: null, origin: "human", session: null,
  body: "", path: `https://github.com/o/n/issues/${id}`, damaged: null, conflict: false,
  labels: [],
});

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  prList: vi.fn().mockResolvedValue([]),
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue([]),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn(),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
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
  taskCapabilities: vi.fn().mockResolvedValue(CAPS),
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
  listTasks: listTasksMock,
  issueWorktreeAdd: issueWorktreeAddMock,
}));

/** The tree hooks `startApp` hands the workspaces panel — the app's only route
 *  to a workspace's own board and pull requests now that neither is in the rail. */
let treeHooks: { openPage: (id: string, page: "board" | "pr") => void } | null = null;

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
    load = vi.fn().mockResolvedValue(undefined);
    setCounts = vi.fn();
    setSkillsSource = vi.fn();
    // The tree's half of the panel: the workspace row is this panel's and the
    // sessions under it are the deck's, so `startApp` hands each the other.
    /* Captured, because the board and the pull requests are opened through this
       seam now: they left the rail for the tree, where each is a child of the
       workspace it belongs to, so there is no app-wide button to click. */
    setTreeHooks = vi.fn((h: never) => { treeHooks = h; });
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
    start = startMock;
    write = vi.fn(); focus = vi.fn(); dispose = vi.fn(); fit = vi.fn(); clear = vi.fn();
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
  getCurrentWindow: () => ({ label: "main", onCloseRequested: async () => () => {}, destroy: async () => {}, unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn() }),
}));

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe("▶ on a github issue", () => {
  /** The duplicate-session check has to come *first*, before the worktree call —
   *  the shape `Deck.launchFromTask` has always had on the file path. Behind a
   *  fallible IPC call it is unreachable exactly when it matters: `gh` resolving
   *  the default branch offline, the directory removed by hand, a locked index.
   *  The person is then told the worktree could not be prepared while a session on
   *  that very issue is running two tiles away. */
  it("focuses the session it already has without preparing a worktree again", async () => {
    document.body.innerHTML =
      // Mirrors index.html — `app.ts` mounts the rail into `#rail` and the panel's pages into `#panel-stack`.
      '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div></div><main id="deck"></main><div id="terminals"></div>'
      + '<div id="board" class="hidden"></div></div></div>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    listTasksMock.mockResolvedValue([issue("42")]);
    issueWorktreeAddMock.mockResolvedValue("/p-wt/42-issue");

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    treeHooks!.openPage(WS.id, "board");
    await flush();

    const run = document.querySelector<HTMLButtonElement>("#board .tk-run")!;
    run.click();
    await flush();
    expect(issueWorktreeAddMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("#deck .tile").length).toBe(1);

    // The second click, with the worktree call now failing. The session is idle,
    // so ▶ is still on screen — that is the case this guards.
    issueWorktreeAddMock.mockRejectedValue(new Error("could not resolve the default branch"));
    run.click();
    await flush();

    // Not reached at all: the guard answered before any side effect.
    expect(issueWorktreeAddMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("#deck .tile").length).toBe(1);
    expect(startMock).toHaveBeenCalledTimes(1);
    // And no apology for a failure that never had to happen.
    expect(document.querySelector(".modal-box")).toBeNull();
  });
});
