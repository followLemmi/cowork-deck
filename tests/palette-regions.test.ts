// @vitest-environment jsdom
/** Both directions of region cycling, listed in the palette.
 *
 *  The palette is this app's only answer to "what can I press", so a binding it
 *  omits may as well not exist. `Shift+F6` was bound and unlisted — found while
 *  #225 was being fixed, and left to #270 — which is why this asserts the pair
 *  rather than the one entry that was missing: the next omission is as likely to
 *  be the other half.
 *
 *  Driven through `startApp` because that is where the list lives, and a unit
 *  test of `palette.ts` cannot see what was put into it. The mock block and the
 *  fixture body follow tests/main-hotkey-guard.test.ts. */
import { describe, it, expect, vi } from "vitest";

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
  usageSnapshot: vi.fn().mockResolvedValue([]),
  onUsageChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return WS; }
    get all() { return [WS]; }
    load = vi.fn().mockResolvedValue(undefined);
    setCounts = vi.fn();
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

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe("the palette and region cycling", () => {
  it("lists both directions, each with its key", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    document.body.innerHTML =
      '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
      + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div><div id="limits"></div></div>'
      + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
      + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
      + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
      + '</div></div>';

    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    // Through the hotkey rather than by calling `paletteCommands`, which is not
    // exported: the palette a person opens is the list under test.
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      code: "KeyK", key: "k", metaKey: true, bubbles: true, cancelable: true,
    }));
    await flush();

    const rows = [...document.querySelectorAll(".palette-item")].map((el) => ({
      title: el.firstElementChild?.textContent ?? "",
      key: el.querySelector(".palette-key")?.textContent ?? null,
    }));
    const region = rows.filter((r) => /region/i.test(r.title));

    expect(region).toEqual([
      { title: "Go to next region (F6)", key: "F6" },
      { title: "Go to previous region (Shift+F6)", key: "Shift+F6" },
    ]);
  });
});
