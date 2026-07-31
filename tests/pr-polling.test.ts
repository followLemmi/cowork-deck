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
  getCurrentWindow: () => ({ unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn() }),
}));

/** Let the promise chain behind a click or a tick settle. */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// One test, not five: `main.ts` is a side-effect module and imports once per
// file, so every phase of the lifecycle is walked in sequence.
describe("pull request polling", () => {
  it("polls only while the view is open and the window focused", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div id="app"><div id="sidebar"></div><main id="deck"></main>'
      + '<div id="board" class="hidden"></div></div>';
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await import("../src/main");
    await flush();

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tk-views button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Terminals", "Board", "Pull requests"]);
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

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tk-views button")];
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
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tk-views button")];
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
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tk-views button")];
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
