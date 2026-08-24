// @vitest-environment jsdom
/** What the board draws in the seconds before its first answer arrives — driven
 *  through `main.ts`, because the decision is `main.ts`'s.
 *
 *  A file of its own, and that is not tidiness. `main.ts` is a side-effect module
 *  and imports once per file, and "has this board ever been drawn" is module state,
 *  so a test that needs a board nobody has visited cannot share a file with tests
 *  that visit one. `tests/pr-polling.test.ts` holds the other half — that a *later*
 *  read keeps what is on screen rather than blanking it.
 *
 *  The bug being pinned: a GitHub board's first read is a repository lookup and a
 *  page per state, and until now the first render came after all of it — so opening
 *  the board left an empty pane for however long that took, with nothing to say
 *  whether it was working or broken.
 *
 *  The second assertion guards the shape of the fix rather than the bug: a loading
 *  state carries no tasks, so whoever draws it has to sit ahead of the branch that
 *  reads "no tasks and no capabilities" as "No task tracker is configured for this
 *  workspace" — which is false here, and the one sentence a person acts on by going
 *  to check a setting that was already right. */
import { describe, it, expect, vi } from "vitest";

/** Never resolves: the screen stays at whatever the read left drawn. */
const listTasksMock = vi.fn().mockReturnValue(new Promise(() => {}));
/** Resolves, and quickly — which is the honest model of it: `tasks_capabilities`
 *  runs no `gh`, and the seconds this test is about are all in the call above. */
const capsMock = vi.fn();

const WS_GH = {
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

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  prList: vi.fn().mockResolvedValue([]),
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue([]),
  onScheduledFire: vi.fn().mockResolvedValue(() => {}),
  onSchedulerBroken: vi.fn().mockResolvedValue(() => {}),
  onTasksChanged: vi.fn().mockResolvedValue(() => {}),
  scheduleAck: vi.fn().mockResolvedValue(undefined),
  schedulerReady: vi.fn().mockResolvedValue(undefined),
  taskWatchSync: vi.fn().mockResolvedValue(undefined),
  taskOpenCounts: vi.fn().mockResolvedValue({}),
  taskCapabilities: capsMock,
  listTasks: listTasksMock,
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS_GH; }
    get all() { return [WS_GH]; }
    load = vi.fn().mockResolvedValue(undefined);
    setCounts = vi.fn();
    setSkillsSource = vi.fn();
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

/** Let the promise chain behind a click settle. */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe("a GitHub board's first read", () => {
  it("draws skeleton rows, and never claims no tracker is configured", async () => {
    capsMock.mockResolvedValue(CAPS);
    document.body.innerHTML =
      // Mirrors index.html — `main.ts` mounts the view switch into `#viewbar`.
      '<div id="app"><nav id="viewbar"></nav><div id="stage">'
      + '<div id="sidebar"></div><main id="deck"></main><div id="terminals"></div>'
      + '<div id="board" class="hidden"></div></div></div>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    const [, boardBtn] = document.querySelectorAll<HTMLButtonElement>(".tk-views button");
    boardBtn.click();
    await flush();

    const board = document.querySelector("#board")!;
    expect(board.querySelectorAll(".tk-skeleton-row").length).toBeGreaterThan(0);
    expect(board.textContent).not.toContain("No task tracker is configured");
    // The one control that must survive it: a board nobody can read yet is not a
    // board with nothing to say, and "never loaded" is the honest age.
    expect(board.querySelector(".tk-age")?.textContent).toBe("never loaded");
    // And the read really is still in flight — otherwise this test would pass on a
    // board that had simply come back empty.
    expect(listTasksMock).toHaveBeenCalled();
  });
});
