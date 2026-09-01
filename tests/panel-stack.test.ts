// @vitest-environment jsdom
/** Which stack each page is a page OF, asserted through `startApp`.
 *
 *  The window has two page stacks and the split is the app's whole shape: the tree,
 *  the journal and the scenarios are the APP's and live in `#panel-stack` behind the
 *  rail; the board and the pull requests are one repository's and live in
 *  `#wsp-body`, on the other side of the deck.
 *
 *  This exists because the journal was in the wrong one. It was inserted relative to
 *  `#pr` — correct while all five pages shared one stack, and silently wrong from the
 *  moment the board moved to `#wspanel` and took `#pr` with it. What a person got was
 *  a Journal button that un-hid a page inside a panel hidden by default: nothing on
 *  screen, and with the workspace panel open, the journal on the wrong side of the
 *  window. Nothing failed, because nothing asked where the pages were.
 *
 *  Parentage rather than geometry, deliberately: jsdom computes no layout, and the
 *  defect was structural — the page was in the wrong box, not the wrong place in the
 *  right box. */
import { describe, it, expect, vi } from "vitest";
import { PANEL_TITLE } from "../src/view";

const WS = {
  id: "w", name: "P", path: "/p", color: "#fff",
  github: { account: "a", host: "github.com", login: "octo" },
  tracker: { providers: [{ type: "github" as const }] },
};

const CAPS = {
  canCreate: true, canResolve: true, statuses: ["open", "closed"],
  board: { v: 1, steps: [{ id: "open", label: "Open" }], kinds: [] },
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
  listRuns: vi.fn().mockResolvedValue([]),
  memoryNotes: vi.fn().mockResolvedValue([]),
  memoryWarm: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
    load = vi.fn().mockResolvedValue(undefined);
    setSkillsSource = vi.fn();
    setSessionsSource = vi.fn();
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

describe("which stack each page belongs to", () => {
  it("puts the app's four behind the rail and the repository's two beside the deck", async () => {
    document.body.innerHTML =
      '<div id="app"><header class="topbar"><div id="mark"></div>'
      + '<div id="ledger"></div><div id="topbar-actions"></div></header>'
      + '<div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div><div id="limits"></div></div>'
      + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
      + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
      + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
      + '</div></div>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    const parentOf = (id: string) =>
      document.querySelector(`#${id}`)?.parentElement?.id ?? "(nowhere)";

    // The rail's four.
    expect(parentOf("ws-page")).toBe("panel-stack");
    expect(parentOf("history")).toBe("panel-stack");
    expect(parentOf("sk-page")).toBe("panel-stack");
    expect(parentOf("mem-page")).toBe("panel-stack");
    // The workspace panel's two.
    expect(parentOf("board")).toBe("wsp-body");
    expect(parentOf("pr")).toBe("wsp-body");

    /* The order the keyboard walks them in, which is the order the rail lists them:
       the pages overlap in one grid cell, so nothing else makes this visible. */
    expect([...document.querySelectorAll("#panel-stack > .panel-page")].map((e) => e.id))
      .toEqual(["ws-page", "history", "sk-page", "mem-page"]);
  });

  /** Each of the three is a raised surface, and the journal was the odd one out —
   *  loose rows on the column's own ground. The class is what makes it one, and
   *  `startApp` is what puts the class on: the tree and the scenarios are mocked
   *  here, so their own `h3` is their module's business, but where their mount sits
   *  and what it is called is this file's. */
  it("gives every page in the stack an island of its own", async () => {
    for (const id of ["ws-page", "history", "sk-page", "mem-page"]) {
      expect(document.querySelector(`#${id} .island`), id).not.toBeNull();
    }
  });

  /** #389. A search is 6 ms with the model in memory and two seconds without,
   *  and opening this page is the clearest signal anybody is about to search —
   *  so the warm-up overlaps with reading the list rather than landing on the
   *  first query. Not at launch: it costs 1.7 s and holds 1.6 GB, and paying
   *  that on every start charges every person who never searches. */
  it("warms the model when the memory page is opened, and not before", async () => {
    const { memoryWarm } = await import("../src/ipc");
    expect(memoryWarm).not.toHaveBeenCalled();

    document.querySelector<HTMLElement>('#rail .rail-btn[data-page="memory"]')!.click();
    await flush();
    expect(memoryWarm).toHaveBeenCalled();
  });

  /** The journal's head, which is real code rather than a mock: it says the name the
   *  rail and the palette say, and it says it VISIBLY. It used to be an `h2` clipped
   *  to a pixel, because the panel's head above stated the name instead — and that
   *  head no longer states it, so a clipped title would leave the page unnamed. */
  it("names the journal in its own head, and nowhere above it", async () => {
    // The page renders when it is opened, not at boot: `setPanel` is what reads the
    // records. So this presses the rail's Journal button, which is the route a person
    // takes and the one that was broken.
    document.querySelector<HTMLElement>('#rail .rail-btn[data-page="history"]')!.click();
    await flush();
    const h3 = document.querySelector<HTMLElement>("#history .island > h3");
    expect(h3).not.toBeNull();
    expect(h3!.textContent).toBe(PANEL_TITLE.history);
    // The clip that hid it is off this element and still on the workspace's name,
    // which the head one line up does state.
    expect(h3!.className).toBe("");
    expect(document.querySelector(".panel-title")).toBeNull();
    expect(document.querySelector("#panel-head .panel-scope")).not.toBeNull();
  });
});
