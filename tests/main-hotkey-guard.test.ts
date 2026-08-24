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
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
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
  getCurrentWindow: () => ({ label: "main", unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn() }),
}));

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** `Cmd+N` on a Mac, which is `new-session` — the cheapest hotkey to observe,
 *  since a session that was spawned leaves a tile behind. */
const newSessionKey = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent("keydown", {
    code: "KeyN", key: "n", metaKey: true, bubbles: true, cancelable: true,
  }));

// The cases share one booted app and run in sequence. That used to be forced —
// `main.ts` was a side-effect module and imports once per file — and is now a
// choice: `startApp(role)` is a function, and `tests/app-singletons.test.ts`
// boots it four times in one file.
describe("the window hotkey handler and text entry", () => {
  it("ignores a hotkey typed into a text field, and fires it inside a terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    document.body.innerHTML =
      '<div id="app"><nav id="viewbar"></nav><div id="stage">'
      + '<div id="sidebar"></div><main id="deck"></main><div id="terminals"></div>'
      + '<div id="board" class="hidden"></div></div></div>';

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
});
