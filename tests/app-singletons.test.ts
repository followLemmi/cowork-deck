// @vitest-environment jsdom
/** The whole duplicate-launch class, in one assertion per role.
 *
 *  This test is the argument for `startApp(role)` being a function rather than a
 *  handful of inline `if (isMain)` branches. The singletons are spread over a
 *  dozen places in a 1600-line file; asserting each one where it sits would mean
 *  a dozen tests that pass individually while the class as a whole regresses the
 *  moment somebody adds a thirteenth. One boundary, one assertion.
 *
 *  What "singleton" means here: something the backend does once, or something a
 *  person should be asked once. A screen, a hotkey, a palette or a poll is
 *  per-window and deliberately absent from these lists.
 *
 *  The mock surface is the one `tests/main-hotkey-guard.test.ts` established for
 *  standing the app up in jsdom. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue([]),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  onScheduledFire: vi.fn().mockResolvedValue(() => {}),
  onSchedulerBroken: vi.fn().mockResolvedValue(() => {}),
  onQuitBlocked: vi.fn().mockResolvedValue(() => {}),
  onTasksChanged: vi.fn().mockResolvedValue(() => {}),
  onRunsChanged: vi.fn().mockResolvedValue(() => {}),
  scheduleAck: vi.fn().mockResolvedValue(undefined),
  schedulerReady: vi.fn().mockResolvedValue(undefined),
  taskWatchSync: vi.fn().mockResolvedValue(undefined),
  taskOpenCounts: vi.fn().mockResolvedValue({}),
  taskCapabilities: vi.fn().mockResolvedValue(null),
  listTasks: vi.fn().mockResolvedValue([]),
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/updater", () => ({ offerUpdateIfAvailable: vi.fn().mockResolvedValue(undefined) }));

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
    start = vi.fn().mockResolvedValue({ account: null, degraded: null });
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

import {
  claudeAvailable, loadLayout, onScheduledFire, onSchedulerBroken, onQuitBlocked,
  schedulerReady, taskWatchSync,
} from "../src/ipc";
import { offerUpdateIfAvailable } from "../src/updater";
import { listen } from "@tauri-apps/api/event";
import type { WindowRole } from "../src/window-role";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Now that the bootstrap is a function, a test file can boot it more than once
 *  — which is the whole reason this file can exist. It was a side-effect module,
 *  and a side-effect module imports once per file. */
async function boot(role: WindowRole) {
  document.body.innerHTML =
    '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
    + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div></div><main id="deck"></main><div id="terminals"></div>'
    + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
    + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
    + '</div></div>';
  const { startApp } = await import("../src/app");
  startApp(role);
  await flush();
}

/** Everything that must happen once for the app, and what a second copy costs. */
const ONCE_PER_APP = () => [
  ["a scheduled fire is launched and acknowledged once", onScheduledFire],
  ["one alert for one broken scheduler", onSchedulerBroken],
  ["one quit question, whose first answer decides it", onQuitBlocked],
  ["one prompt about a missing claude", claudeAvailable],
  ["one update prompt, and one downloadAndInstall racing one relaunch", offerUpdateIfAvailable],
  ["one release of the scheduler's first catch-up tick", schedulerReady],
  ["one re-point of the backend's tracker watchers", taskWatchSync],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the singletons a second window must not run", () => {
  it("wires every one of them in the main window", async () => {
    await boot({ kind: "main" });
    for (const [what, fn] of ONCE_PER_APP()) {
      expect(fn, what).toHaveBeenCalled();
    }
  });

  it("wires none of them in a window pinned to a workspace", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    for (const [what, fn] of ONCE_PER_APP()) {
      expect(fn, what).not.toHaveBeenCalled();
    }
  });

  /** One click on the pill used to raise every window, each focusing its own
   *  next waiting tile. The main window is the only participant that can answer
   *  properly — it sees its own sessions, the orphans, and the proxy rows for
   *  detached workspaces (#243, #244). */
  it("answers the pill in the main window and nowhere else", async () => {
    await boot({ kind: "main" });
    expect(vi.mocked(listen).mock.calls.map(([e]) => e)).toContain("pill://focus-next");

    vi.clearAllMocks();
    await boot({ kind: "workspace", workspaceId: "w" });
    expect(vi.mocked(listen).mock.calls.map(([e]) => e)).not.toContain("pill://focus-next");
  });

  /** A window going away is invisible from inside another one, so Rust says it.
   *  Without the main window listening, its picture of what the other windows
   *  hold outlives them — and a workspace brought back by closing its window
   *  stays marked as elsewhere, unselectable, answering a click with nothing. */
  it("listens for a window going away, in the main window", async () => {
    await boot({ kind: "main" });
    expect(vi.mocked(listen).mock.calls.map(([e]) => e)).toContain("window://gone");
  });

  /** Deliberately **not** a singleton, and the one entry on the issue's list
   *  that changed. Restoring the layout used to fork a second `claude --resume`
   *  onto every live conversation in a second window — but `load_layout` now
   *  answers with the tiles belonging to the asking window and nobody else's
   *  (#238), so a workspace window restoring its own is correct rather than
   *  duplicate. Asserted so that a future reading of the issue's table does not
   *  quietly gate it. */
  it("restores its own layout in either kind of window", async () => {
    await boot({ kind: "main" });
    expect(loadLayout).toHaveBeenCalled();

    vi.clearAllMocks();
    await boot({ kind: "workspace", workspaceId: "w" });
    expect(loadLayout).toHaveBeenCalled();
  });
});
