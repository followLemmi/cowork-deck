// @vitest-environment jsdom
/** The crumb's door to the workspace's two pages, driven through `startApp`.
 *
 *  It exists because the other door does not survive a zoom: the
 *  `board · PRs · journal` chip is on a row in the tree, a zoomed tile collapses
 *  the panel that tree lives in, and that left the palette as the only route to
 *  the board from the state a person spends most of their day in. The crumb is
 *  what stays, so the second door is on it.
 *
 *  Driven through the app rather than through a unit, because every part of this
 *  is wiring: which element it is beside, whether it toggles, and whether
 *  `aria-expanded` still describes the panel after the panel was closed by
 *  something else. */
import { describe, it, expect, vi } from "vitest";

const WS = {
  id: "w", name: "P", path: "/p", color: "#fff",
  github: { account: "a", host: "github.com", login: "octo" },
  tracker: { providers: [{ type: "github" as const }] },
};

const CAPS = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  board: {
    v: 1,
    steps: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed", terminal: true }],
    kinds: [],
  },
  boardError: null, boardEditable: false,
};

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
  listTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
    load = vi.fn().mockResolvedValue(undefined);
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

describe("the crumb's board · PRs door", () => {
  it("opens the panel, and closes it again", async () => {
    document.body.innerHTML =
      // Mirrors index.html, `#mark` included: the crumb and its door are inserted
      // after the wordmark, so a fixture without one has neither — which is why
      // the app-level tests that do not care about the bar never saw this.
      '<div id="app"><header class="topbar"><div id="mark"></div>'
      + '<div id="ledger"></div><div id="topbar-actions"></div></header>'
      + '<div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div></div>'
      + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
      + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
      + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
      + '</div></div>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    const door = document.querySelector<HTMLButtonElement>("#crumb-pages")!;
    const panel = document.querySelector<HTMLElement>("#wspanel")!;
    expect(door).not.toBeNull();
    // Beside the name of the thing it opens, which is the whole reason it is here
    // rather than in the rail.
    expect(door.previousElementSibling?.id).toBe("crumb");
    expect(panel.hidden).toBe(true);
    expect(door.getAttribute("aria-expanded")).toBe("false");
    expect(door.getAttribute("aria-controls")).toBe("wspanel");

    door.click();
    await flush();
    expect(panel.hidden).toBe(false);
    expect(document.querySelector("#board")!.classList.contains("hidden")).toBe(false);
    expect(door.getAttribute("aria-expanded")).toBe("true");

    door.click();
    await flush();
    expect(panel.hidden).toBe(true);
    expect(door.getAttribute("aria-expanded")).toBe("false");
  });

  /** The state has three writers — this door, the chip's route in, and the panel's
   *  own ✕ — and the one that is easy to get wrong is the one that did not press
   *  the door. A control claiming `aria-expanded="true"` over a closed panel is
   *  worse than one claiming nothing. */
  it("says the panel is closed when something else closed it", async () => {
    const door = document.querySelector<HTMLButtonElement>("#crumb-pages")!;
    const panel = document.querySelector<HTMLElement>("#wspanel")!;
    door.click();
    await flush();
    expect(door.getAttribute("aria-expanded")).toBe("true");

    document.querySelector<HTMLButtonElement>("#wsp-head button")!.click();
    await flush();
    expect(panel.hidden).toBe(true);
    expect(door.getAttribute("aria-expanded")).toBe("false");
  });
});
