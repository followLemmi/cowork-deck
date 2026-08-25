// @vitest-environment jsdom
/** The polling lifecycle of the pull request view, driven through `main.ts`
 *  itself — the wiring is what this guards, and none of it is reachable from a
 *  smaller module. A leaked timer here means the app keeps asking GitHub about
 *  a screen nobody is looking at, which is exactly the failure no unit test of
 *  `pr.ts` or `pr-view.ts` can catch. */
import { describe, it, expect, vi } from "vitest";

const prListMock = vi.fn().mockResolvedValue([]);
const listTasksMock = vi.fn().mockResolvedValue([]);
const WS = {
  id: "w", name: "P", path: "/p", color: "#fff",
  github: { account: "a", host: "github.com" },
};
/** The same workspace with a GitHub tracker configured, so the board's interval
 *  can be read through `sourceOf` rather than asserted about in isolation. */
const WS_GH = { ...WS, tracker: { providers: [{ type: "github" as const }] } };
/** Which workspace the panel reports. Mutable so one imported `main.ts` can be
 *  walked through both sources — the module is a side-effect module and imports
 *  once per file. */
let active: typeof WS | typeof WS_GH = WS;

const CAPS = {
  canCreate: true, canResolve: true, statuses: ["open", "done"],
  board: {
    v: 1,
    steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
    kinds: [],
  },
  boardError: null, boardEditable: true,
};

// Only what `main.ts` reaches for during boot and while the view is open; the
// rest of the real module is kept so every other importer of ./ipc still sees
// the shape it expects.
vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  prList: prListMock,
  claudeAvailable: vi.fn().mockResolvedValue(true),
  loadLayout: vi.fn().mockResolvedValue([]),
  onScheduledFire: vi.fn().mockResolvedValue(() => {}),
  onSchedulerBroken: vi.fn().mockResolvedValue(() => {}),
  onTasksChanged: vi.fn().mockResolvedValue(() => {}),
  scheduleAck: vi.fn().mockResolvedValue(undefined),
  schedulerReady: vi.fn().mockResolvedValue(undefined),
  taskWatchSync: vi.fn().mockResolvedValue(undefined),
  taskOpenCounts: vi.fn().mockResolvedValue({}),
  // Real capabilities and an empty list, so the board's own read is the thing
  // counted: `refreshBoard` never calls `listTasks` while `caps` is null.
  taskCapabilities: vi.fn().mockResolvedValue(CAPS),
  listTasks: listTasksMock,
  taskMigrationStatus: vi.fn().mockResolvedValue(null),
}));

// A workspace with an account bound, so the view has something to poll for. The
// panel's first constructor argument is `main.ts`'s "a workspace was selected"
// callback, kept here so a test can fire the switch the real sidebar fires.
let onSelect: ((ws: typeof active) => void) | null = null;
vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    constructor(_mount: HTMLElement, select: (ws: typeof active) => void) { onSelect = select; }
    get active() { return active; }
    get all() { return [active]; }
    load = vi.fn().mockResolvedValue(undefined);
    setCounts = vi.fn();
    setSkillsSource = vi.fn();
    // The tree's half of the panel: the workspace row is this panel's and the
    // sessions under it are the deck's, so `startApp` hands each the other.
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
  getCurrentWindow: () => ({ label: "main", onCloseRequested: async () => () => {}, destroy: async () => {}, unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn() }),
}));

/** Let the promise chain behind a click or a tick settle. */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// One test, not five: `main.ts` is a side-effect module and imports once per
// file, so every phase of the lifecycle is walked in sequence.
describe("pull request polling", () => {
  it("polls only while the view is open and the window focused", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      // Mirrors index.html. `#rail` is not optional: `app.ts` mounts the rail
      // switch into it and asserts it exists, so a harness missing it throws
      // before any of the polling under test here can run.
      '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div></div><main id="deck"></main><div id="terminals"></div>'
      + '<div id="board" class="hidden"></div></div></div>';
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    // A rail of icons names itself for a reader rather than for the eye, so the
    // accessible name is what there is to assert — and the fifth entry is the
    // scenario list, which used to be a sidebar block belonging to one screen.
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Workspaces and sessions", "Board", "Pull requests", "Journal", "Scenarios",
    ]);
    const [termBtn, , prBtn] = buttons;

    // Opening the view reads once, then once per interval. Nothing is running,
    // so the interval is the slow one from `pollIntervalMs` — a minute brings
    // exactly one more read, not four.
    prBtn.click();
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(2);

    // Leaving for the terminals stops it. Ten minutes of silence is the point:
    // a cleared timeout, not a slower one.
    termBtn.click();
    await flush();
    const afterLeave = prListMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(afterLeave);

    // Losing focus stops it too, without leaving the view.
    prBtn.click();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    const beforeBlur = prListMock.mock.calls.length;
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(beforeBlur);

    // Coming back refreshes at once rather than at the next tick.
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(beforeBlur + 1);

    // Opening the view while the window is unfocused reads once — the click is
    // a deliberate act — and schedules nothing after it.
    termBtn.click();
    await flush();
    hasFocus.mockReturnValue(false);
    prBtn.click();
    await flush();
    const afterUnfocusedEntry = prListMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(prListMock).toHaveBeenCalledTimes(afterUnfocusedEntry);

    vi.useRealTimers();
  });
});

/** The board's poll, which Task 22 turns from a blind five-second `setInterval`
 *  into the same gated chain the view above uses. Driven through `main.ts` for the
 *  same reason: the gates are wiring, and no unit test of `issues.ts` can see
 *  whether they were installed. `tests/issues.test.ts` already pins what the
 *  interval *is*; this pins that the board obeys it, stops on blur and resumes.
 *
 *  It also covers the **file** board, which is not this feature and whose
 *  behaviour this change alters: the file board used to poll a hidden-but-blurred
 *  window forever. */
describe("board polling", () => {
  it("polls the file board on its own interval, only while open and focused", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    active = WS;
    listTasksMock.mockClear();

    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    // Opening reads once, then once per interval — and exactly once, which a
    // chain gives and an interval left armed beside it would not.
    boardBtn.click();
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(2);

    // Leaving the screen stops it. Ten minutes of silence, not a slower tick.
    termBtn.click();
    await flush();
    const afterLeave = listTasksMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(afterLeave);

    // The behaviour change to a board that already shipped: losing focus stops it
    // without leaving the view. This is what manual check 4 re-checks by hand.
    boardBtn.click();
    await flush();
    const beforeBlur = listTasksMock.mock.calls.length;
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(beforeBlur);

    // Coming back reads at once rather than at the next tick — and re-arms the
    // chain. Without the second half the board would refresh once on return and
    // then stay still until the view was left and re-entered, which is worse than
    // the interval it replaced.
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(beforeBlur + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(beforeBlur + 2);

    vi.useRealTimers();
  });

  it("polls a github board every thirty seconds, not every five", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    // Re-entered after the switch, so the interval is chosen from the workspace
    // as it now stands.
    termBtn.click();
    await flush();
    active = WS_GH;
    listTasksMock.mockClear();
    boardBtn.click();
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(1);

    // The file board's cadence must not be what a GitHub board gets: at five
    // seconds one workspace would spend 14.4% of the hourly GraphQL budget.
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(2);

    termBtn.click();
    await flush();
    active = WS;
    vi.useRealTimers();
  });

  /// A switch while the board is open re-arms the chain, so the interval belongs
  /// to the workspace now on screen. Without it the tick already in flight keeps
  /// the *previous* source's interval: a GitHub board handed over to a file board
  /// would sit still for thirty seconds, and the person switching cannot tell that
  /// from a board that is simply not updating.
  it("re-arms at the new source's interval when the workspace changes", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    // Open the board on the GitHub workspace, so a thirty-second tick is armed.
    termBtn.click();
    await flush();
    active = WS_GH;
    boardBtn.click();
    await flush();
    // The armed tick is the GitHub one: five seconds bring nothing.
    listTasksMock.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(0);

    // Now the sidebar hands over to the file-backed workspace, exactly as a click
    // in it does.
    active = WS;
    listTasksMock.mockClear();
    onSelect!(active);
    await flush();
    // The switch itself reads once — the board on screen belongs to the workspace
    // that was active a moment ago.
    expect(listTasksMock).toHaveBeenCalledTimes(1);

    // And the next read is five seconds later, not thirty — the interval belongs
    // to the workspace now on screen.
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(listTasksMock).toHaveBeenCalledTimes(2);

    termBtn.click();
    await flush();
    vi.useRealTimers();
  });
});

/** The last-good list, which lives in `main.ts` and nowhere else. The board's own
 *  suite can only be shown a `BoardState` that already has cards in it — that a
 *  failed tick is what puts them there, and that a file board never gets them, is
 *  wiring, and no test looked at either direction until now.
 *
 *  Both are asserted against the *same* workspace id, because that is the real
 *  path in: switching a workspace's source is a first-class action with its own
 *  confirmation, and it leaves the GitHub list behind in memory under that id. */
describe("the last good list", () => {
  const issue = (id: string) => ({
    id, title: `Issue ${id}`, kind: "", status: "open", project: "P",
    created: "2026-07-01T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "", path: `https://github.com/o/n/issues/${id}`, damaged: null, conflict: false,
    labels: [],
  });
  // Two selectors, because the two sources draw two layouts: an issue source is one
  // list of rows and a folder keeps its columns of cards. Counting only one of them
  // would make "the file board kept nothing" pass for the wrong reason.
  const rows = () => document.querySelectorAll("#board .tk-row").length;
  const cards = () => document.querySelectorAll("#board .tk-card").length;

  it("keeps a github board's cards through a failed tick, and never a file board's", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    active = WS_GH;
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([issue("41"), issue("42")]);
    boardBtn.click();
    await flush();
    expect(rows()).toBe(2);

    // Offline, rate-limited, a missing scope: a blip in front of data that is
    // still true, so the rows stay with the error beside them.
    listTasksMock.mockRejectedValue(new Error("HTTP 502"));
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(document.querySelector("#board .tk-error")?.textContent).toContain("HTTP 502");
    expect(rows()).toBe(2);

    // Now the same workspace is switched to a folder and the folder cannot be
    // read. Keeping the issues would put phantom cards on a board whose root is
    // gone, and — because a non-empty list skips the empty screen — would withhold
    // `Configure`, the only way back in the app.
    active = WS;
    listTasksMock.mockRejectedValue(new Error("the task folder is unreachable: /p/tasks"));
    onSelect!(active);
    await flush();
    expect(cards() + rows()).toBe(0);
    expect(document.querySelector("#board .tk-configure")).not.toBeNull();
    expect(document.querySelector("#board .tk-count")).toBeNull();

    termBtn.click();
    await flush();
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([]);
    vi.useRealTimers();
  });

  /// The screen a first-run user without `gh` sees, and nothing tested it: an
  /// unreadable source drawn as an empty board is indistinguishable from a
  /// repository with no open issues. It has to win over the kept list too — cards
  /// under "gh is not installed" would invite actions that cannot work.
  it("draws the unavailable screen when gh is missing, never a board", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    active = WS_GH;
    listTasksMock.mockReset();
    // As it arrives: a GitHub failure reaches the frontend through `TaskError::Io`,
    // whose Display prefixes "filesystem error: ".
    listTasksMock.mockRejectedValue(new Error("filesystem error: gh-not-found"));
    boardBtn.click();
    await flush();

    expect(document.querySelector("#board .tk-unavailable")).not.toBeNull();
    expect(document.querySelector("#board .tk-cols")).toBeNull();
    expect(document.querySelector("#board .tk-fix")?.textContent).toBe("Set up gh");

    termBtn.click();
    await flush();
    active = WS;
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([]);
    vi.useRealTimers();
  });
});

/** Which read keeps what is already on screen. The other half — that a *first* read
 *  paints a skeleton at all — needs a `main.ts` that has never drawn this board, so
 *  it lives in `tests/board-loading.test.ts`: this file's earlier tests have already
 *  visited it, and the module is imported once.
 *
 *  Wiring, and `main.ts`'s alone: the views draw a skeleton whenever they are told
 *  to, and deciding when to tell them is the whole of the bug. */
describe("the loading state", () => {
  const issue = (id: string) => ({
    id, title: `Issue ${id}`, kind: "", status: "open", project: "P",
    created: "2026-07-01T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "", path: `https://github.com/o/n/issues/${id}`, damaged: null, conflict: false,
    labels: [],
  });

  /// A poll tick over a list that is already there keeps it: the age line says how
  /// old it is, and grey boxes every 30 s would be a flicker rather than feedback.
  it("never skeletons over a board that already has rows", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, boardBtn] = buttons;

    active = WS_GH;
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([issue("41"), issue("42")]);
    boardBtn.click();
    await flush();
    expect(document.querySelectorAll("#board .tk-row").length).toBe(2);

    // Still reading, and this one never comes back.
    listTasksMock.mockReset();
    listTasksMock.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(document.querySelector("#board .tk-skeleton")).toBeNull();
    expect(document.querySelectorAll("#board .tk-row").length).toBe(2);

    termBtn.click();
    await flush();
    active = WS;
    listTasksMock.mockReset();
    listTasksMock.mockResolvedValue([]);
    vi.useRealTimers();
  });

  /// The case that made a second variable necessary. A first read that fails leaves
  /// no rows and no `fetchedAt`, so anything keyed on "have we ever fetched" would go
  /// on treating every tick as a first read — blanking the box, and with it the only
  /// button that fixes it, for grey rows and then putting it back. Every 15 s.
  it("keeps a failed pull request read on screen instead of skeletoning over it", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#rail .rail-btn")];
    const [termBtn, , prBtn] = buttons;

    active = WS;
    prListMock.mockReset();
    prListMock.mockRejectedValue(new Error("gh-not-found"));
    prBtn.click();
    await flush();
    expect(document.querySelector("#pr .pr-unavailable")).not.toBeNull();

    // The read is still failing and still slow. The box stays.
    prListMock.mockReset();
    prListMock.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(document.querySelector("#pr .pr-skeleton")).toBeNull();
    expect(document.querySelector("#pr .pr-unavailable")).not.toBeNull();

    termBtn.click();
    await flush();
    prListMock.mockReset();
    prListMock.mockResolvedValue([]);
    vi.useRealTimers();
  });
});
