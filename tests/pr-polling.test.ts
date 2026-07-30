// @vitest-environment jsdom
/** The polling lifecycle of the pull request view, driven through `main.ts`
 *  itself — the wiring is what this guards, and none of it is reachable from a
 *  smaller module. A leaked timer here means the app keeps asking GitHub about
 *  a screen nobody is looking at, which is exactly the failure no unit test of
 *  `pr.ts` or `pr-view.ts` can catch. */
import { describe, it, expect, vi } from "vitest";

const prListMock = vi.fn().mockResolvedValue([]);
const WS = {
  id: "w", name: "P", path: "/p", color: "#fff",
  github: { account: "a", host: "github.com" },
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
  taskCapabilities: vi.fn().mockResolvedValue(null),
}));

// A workspace with an account bound, so the view has something to poll for.
vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    active = WS;
    all = [WS];
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
