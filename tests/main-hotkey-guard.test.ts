// @vitest-environment jsdom
/** The window hotkey handler's guard, driven through `startApp` itself — the
 *  guard is wiring, and no unit test of `commands.ts` can see whether it was
 *  installed. Until this existed, `Cmd+N` spawned a session and `Cmd+W` closed
 *  the tile while the caret sat in a tile's search box or the broadcast bar.
 *
 *  The precedent for standing `main.ts` up in jsdom is tests/pr-polling.test.ts. */
import { describe, it, expect, vi } from "vitest";

const startSessionMock = vi.fn().mockResolvedValue({ account: null, degraded: null });
const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue([]),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  onScheduledFire: vi.fn().mockResolvedValue(() => {}),
  onSchedulerBroken: vi.fn().mockResolvedValue(() => {}),
  onTasksChanged: vi.fn().mockResolvedValue(() => {}),
  scheduleAck: vi.fn().mockResolvedValue(undefined),
  schedulerReady: vi.fn().mockResolvedValue(undefined),
  taskWatchSync: vi.fn().mockResolvedValue(undefined),
  taskOpenCounts: vi.fn().mockResolvedValue({}),
  taskCapabilities: vi.fn().mockResolvedValue(null),
  listTasks: vi.fn().mockResolvedValue([]),
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
  // The limits block reads at boot and listens for a limit signal. Both are
  // mocked here for the reason every other `on*` above is: an unmocked listener
  // returns a promise nothing resolves, and a boot step that never settles is a
  // boot that never reaches `releaseScheduler` — which is precisely what this
  // file asserts about.
  usageSnapshot: vi.fn().mockResolvedValue([]),
  onUsageChanged: vi.fn().mockResolvedValue(() => {}),
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
    start = startSessionMock;
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

/** `Cmd+N` on a Mac, which is `new-session` — the cheapest hotkey to observe,
 *  since a session that was spawned leaves a tile behind. */
const newSessionKey = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent("keydown", {
    code: "KeyN", key: "n", metaKey: true, bubbles: true, cancelable: true,
  }));

/** `Cmd+Enter`, which is `zoom`. It reaches the window handler from inside a
 *  terminal too: the panel's `attachCustomKeyEventHandler` asks `matchHotkey`
 *  first and returns false for anything it claims, which is what makes this the
 *  keyboard way out of a zoom now that Escape is the program's. */
const zoomKey = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent("keydown", {
    code: "Enter", key: "Enter", metaKey: true, bubbles: true, cancelable: true,
  }));

const escapeKey = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent("keydown", {
    code: "Escape", key: "Escape", bubbles: true, cancelable: true,
  }));

// The cases share one booted app and run in sequence. That used to be forced —
// `main.ts` was a side-effect module and imports once per file — and is now a
// choice: `startApp(role)` is a function, and `tests/app-singletons.test.ts`
// boots it four times in one file.
describe("the window hotkey handler and text entry", () => {
  it("ignores a hotkey typed into a text field, and fires it inside a terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    document.body.innerHTML =
      '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div><div id="limits"></div></div>'
      // `#workarea` stacks the deck and the terminal drawer; the note reader
      // covers it, as `.term-drawer.is-full` does. On all four real bodies —
      // `page-bodies.test.ts` — and it was missing from this fixture.
      + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
      + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
    + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
    + '</div></div>';

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    const deckEl = document.querySelector<HTMLElement>("#deck")!;
    const tiles = () => deckEl.querySelectorAll(".tile").length;

    // A plain input — the tile search box and the broadcast bar are both this.
    const field = document.createElement("input");
    field.className = "tile-search-input";
    document.body.append(field);
    field.focus();
    const before = tiles();
    newSessionKey(field);
    await flush();
    expect(tiles()).toBe(before);

    // The terminal's own hidden textarea is the exception: exempting it would
    // disable every hotkey inside a terminal, which is the whole app.
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    document.body.append(helper);
    helper.focus();
    newSessionKey(helper);
    await flush();
    expect(tiles()).toBe(before + 1);
  });

  /** `Escape` belongs to whatever has the keyboard (#269).
   *
   *  In the real app xterm never lets this listener see an Escape typed into a
   *  focused terminal — it writes the byte to the pty and stops the event dead.
   *  The guard is what keeps that true of anything else focusable inside `.xterm`,
   *  and of the next person to move this handler somewhere it fires first; a
   *  synthetic keydown is the only way to reach it, which is what this dispatches.
   *
   *  `isTerminalCaret` has two clauses and both are driven below, because in
   *  production only the second can ever be the sole one that matches: xterm always
   *  nests its hidden textarea inside `.xterm`, so the class check alone would prove
   *  nothing about the container check that the guard is actually written for. */
  it("does not unzoom the deck on an Escape that came from a terminal", async () => {
    const deckEl = document.querySelector<HTMLElement>("#deck")!;
    // Two visible tiles: zooming the only tile there is has nothing to minimize
    // and is a no-op by design. One is left over from the case above.
    newSessionKey(document.body);
    await flush();
    expect(deckEl.querySelectorAll(".tile").length).toBeGreaterThan(1);

    /* The terminal's own shape, which the mocked `TerminalPanel` does not build:
       xterm renders `.xterm` around both its hidden input and its screen. Built
       here rather than borrowed from the case above — that one leaves a bare
       textarea on `<body>`, which is outside any `.xterm` and would leave the
       clause this guard exists for untested, and reaching for it across cases
       makes the order of the two an unwritten requirement. */
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    // Focusable, inside `.xterm`, and not the helper: this is the clause that is
    // the app's own rule rather than a restatement of xterm's class name.
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.tabIndex = 0;
    term.append(helper, screen);
    deckEl.querySelector<HTMLElement>(".tile .tile-body")!.append(term);

    zoomKey(helper);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    // The program's key, not the deck's — from the hidden input...
    escapeKey(helper);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    // ...and from anything else the terminal contains.
    escapeKey(screen);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);

    // Anywhere else it still means "leave zoom" — and the zoom key is the way out
    // from inside a terminal.
    escapeKey(document.body);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(false);

    zoomKey(helper);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(true);
    zoomKey(helper);
    await flush();
    expect(deckEl.classList.contains("is-zoomed")).toBe(false);
  });
});
