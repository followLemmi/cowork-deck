/** The `ipc` surface a boot-through test has to stand in for, in one place.
 *
 *  Ten test files boot the whole app, and each one carried its own
 *  `vi.mock("../src/ipc", …)` listing between eleven and twenty-four exports by
 *  hand. That is not merely repetition: the lists had drifted apart, so what a
 *  boot did depended on which file was booting it, and the *consequence* was
 *  twenty-one stack traces per suite run — `syncSummary` was in none of the ten,
 *  so `maybeOfferSync` reached an unmocked bridge and `console.debug`'d a
 *  `TypeError` from `invoke` on every boot (#463). Noise that arrives on every
 *  run is noise nobody reads, which is the whole cost: a real failure printed
 *  beside it looks like more of the same.
 *
 *  **What belongs here and what does not.** Everything the boot sequence itself
 *  touches, with the emptiest answer that lets it finish — no workspaces, no
 *  tasks, no runs, a listener that unsubscribes to nothing. What a test asserts
 *  on does NOT belong here: pass it in `overrides` and keep it beside the
 *  assertion, where a reader can see what the test made true.
 *
 *  Two shapes are load-bearing rather than arbitrary:
 *
 *  - Every `on*` resolves to an unsubscribe function. `listen` is asynchronous,
 *    and an unmocked listener returns a promise nothing settles — a boot step
 *    that never settles is a boot that never finishes, which is a hang rather
 *    than a failure.
 *  - `describeExit` returns a value, not a promise: it is the one pure function
 *    on this surface, and mocking it as async makes a tile's epitaph a
 *    `[object Promise]`.
 */
import { vi } from "vitest";
import type { GhStatus, HostPlatform, SyncSummary, UiState } from "../../src/ipc";

/** `load_ui_state`'s answer with nothing set. Every required field is present,
 *  because the Rust side fills each from a `serde` default — a partial object
 *  here would let a reader treat a field as possibly-absent when it cannot be. */
export const UI_STATE: UiState = {
  activeWorkspaceId: null,
  uiScale: 1,
  prDiffCols: 96,
  syncOfferDismissed: false,
  recordScenarioRuns: true,
  terminalRows: 24,
  usageReported: true,
};

/** `gh` present with no account connected. Not "gh missing": the app has a
 *  documented degradation for that and a test that booted into it would be
 *  asserting against the unavailable screen without saying so. */
export const GH_NO_ACCOUNT: GhStatus = {
  path: "/usr/bin/gh",
  version: "2.60.0",
  accounts: [],
  error: null,
};

/** macOS, which is the platform that offers every gesture — so a boot mocked
 *  this way exercises the code paths a boot on Linux would skip. */
export const HOST: HostPlatform = { os: "macos", distro: null, placesWindows: true };

/** Sync switched off and never used, which is what a fresh machine reports. */
export const SYNC_OFF: SyncSummary = {
  on: false,
  remote: null,
  state: { lastPull: null, lastPush: null, fault: null },
  machine: { id: "test-machine", label: "this machine" },
};

/** The mock object for `vi.mock("../src/ipc", …)`, with `overrides` last.
 *
 *      vi.mock("../src/ipc", async (orig) => ({
 *        ...(await orig() as object),
 *        ...bootIpc({ listWorkspaces: vi.fn().mockResolvedValue([WS]) }),
 *      }));
 *
 *  The spread of the real module stays in the caller: `vi.mock`'s factory is
 *  what has access to `orig`, and a helper that took it as an argument would be
 *  one more thing every file writes identically.
 */
export function bootIpc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const listener = () => vi.fn().mockResolvedValue(() => {});
  return {
    // Discovery and the layout the deck restores.
    claudeAvailable: vi.fn().mockResolvedValue(true),
    loadLayout: vi.fn().mockResolvedValue([]),
    saveLayout: vi.fn().mockResolvedValue(undefined),
    loadTerminals: vi.fn().mockResolvedValue({ items: [], active: {}, open: [] }),

    // The store.
    listWorkspaces: vi.fn().mockResolvedValue([]),
    loadUiState: vi.fn().mockResolvedValue(UI_STATE),
    saveUiState: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),

    // Sessions: the two listeners, the pure formatter, and the two calls the
    // deck's own poll makes.
    onState: listener(),
    onExit: listener(),
    describeExit: vi.fn().mockReturnValue(null),
    prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
    closeSession: vi.fn(),
    gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
    sessionSnapshots: vi.fn().mockResolvedValue({}),

    // The scheduler. `schedulerReady` is what releases the first catch-up tick,
    // so a boot that never calls it is a boot that hangs waiting to be released.
    onScheduledFire: listener(),
    onSchedulerBroken: listener(),
    onQuitBlocked: listener(),
    scheduleAck: vi.fn().mockResolvedValue(undefined),
    schedulerReady: vi.fn().mockResolvedValue(undefined),
    loadScheduleState: vi.fn().mockResolvedValue({}),

    // The board, which polls on a timer of its own.
    onTasksChanged: listener(),
    taskWatchSync: vi.fn().mockResolvedValue(undefined),
    taskOpenCounts: vi.fn().mockResolvedValue({}),
    taskCapabilities: vi.fn().mockResolvedValue(null),
    taskMigrationStatus: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    trackerOpenCount: vi.fn().mockResolvedValue(0),

    // Pull requests, on a poll that is almost a copy of the board's.
    prList: vi.fn().mockResolvedValue([]),

    // The journal and the memory page.
    onRunsChanged: listener(),
    listRuns: vi.fn().mockResolvedValue([]),
    memoryNotes: vi.fn().mockResolvedValue([]),
    memoryWarm: vi.fn().mockResolvedValue(true),

    // The limits block: one read at boot and one listener, both on timers of
    // their own.
    usageSnapshot: vi.fn().mockResolvedValue([]),
    onUsageChanged: listener(),

    // The account a push goes out as, and what the window may do about window
    // placement. Both are read once at boot, and both were unmocked in every one
    // of these files — 32 and 33 stack traces a run, more than the `syncSummary`
    // ones this file was written for.
    ghStatus: vi.fn().mockResolvedValue(GH_NO_ACCOUNT),
    hostPlatform: vi.fn().mockResolvedValue(HOST),

    // The sync offer. The reason this file exists — see the note at the top.
    syncSummary: vi.fn().mockResolvedValue(SYNC_OFF),

    ...overrides,
  };
}
