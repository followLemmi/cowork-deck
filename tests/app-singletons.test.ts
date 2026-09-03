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
import { bootIpc } from "./helpers/boot-ipc";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

/** What the workspaces panel answers with, this boot.
 *
 *  Mutable because the store's workspace list is: a pull can fold or delete a
 *  record while a window pinned to it is open, which is the whole of #369. Reset
 *  by `boot`. */
let panelItems: (typeof WS)[] = [WS];
/** Which of them is active, held separately from the list for the reason the real
 *  panel holds it separately: a pull can take the active record out of the list
 *  without naming a replacement, and `active` is then null while `all` is not
 *  empty. A mock that derived `active` from `panelItems[0]` could not express
 *  that, which is the state `startApp` falls back to the first workspace in. */
let panelActiveId: string | null = WS.id;
/** What the panel was asked to activate. The fallback names a workspace rather
 *  than clearing the active one, so the assertion is on the argument. */
const activateSpy = vi.hoisted(() => vi.fn((id: string) => id));
/** Set to make the next `load()` reject, the way `listWorkspaces` does for a
 *  `workspaces.json` it cannot read — which is not the same answer as a list
 *  without this workspace in it. Reset by `boot`. */
let loadRejects: Error | null = null;

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  ...bootIpc(),
}));

vi.mock("../src/updater", () => ({ offerUpdateIfAvailable: vi.fn().mockResolvedValue(undefined) }));

/** The tree hooks `startApp` hands the workspaces panel — the app's only route
 *  to a workspace's own board and pull requests now that neither is in the rail. */
let treeHooks: { openPage: (id: string, page: "board" | "pr") => void } | null = null;
/** Which workspace the panel was pinned to, per boot — see the pinned-window
 *  describe at the foot of this file. Reset by `boot`, not by `clearAllMocks`:
 *  the panel is a fresh class instance every time and its `vi.fn` goes with it. */
const pinnedCalls: string[] = [];

vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    get active() { return panelItems.find((w) => w.id === panelActiveId) ?? null; }
    get all() { return panelItems; }
    load = vi.fn(() => (loadRejects ? Promise.reject(loadRejects) : Promise.resolve(undefined)));
    setCounts = vi.fn();
    setSkillsSource = vi.fn();
    setSessionsSource = vi.fn();
    // The tree's half of the panel: the workspace row is this panel's and the
    // sessions under it are the deck's, so `startApp` hands each the other.
    /* Captured, because the board and the pull requests are opened through this
       seam now: they left the rail for the tree, where each is a child of the
       workspace it belongs to, so there is no app-wide button to click. */
    setTreeHooks = vi.fn((h: never) => { treeHooks = h; });
    // A window pinned to a workspace narrows this panel to it — the mock only
    // has to accept the call and record it; the narrowing itself is asserted in
    // `tests/workspaces.test.ts`, against the real panel.
    pinTo = vi.fn((id: string) => { pinnedCalls.push(id); });
    sessionHost = vi.fn().mockReturnValue(null);
    showWaiting = vi.fn();
    showExpanded = vi.fn();
    focusActive = vi.fn();
    activate = vi.fn((id: string) => { activateSpy(id); panelActiveId = id; return true; });
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
/** The label of the window being booted. Varied by `boot`, because a window's
 *  own label is what narrows its addressed listeners — see the third describe. */
let currentLabel = "main";
/** `close()` on this window. A window pinned to a workspace the store has lost
 *  closes rather than living on pinned to nothing — see the last describe. */
const closeSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: currentLabel, onCloseRequested: async () => () => {}, destroy: async () => {}, close: closeSpy, unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn() }),
}));

import {
  claudeAvailable, loadLayout, onScheduledFire, onSchedulerBroken, onQuitBlocked,
  schedulerReady, taskWatchSync,
} from "../src/ipc";
import { offerUpdateIfAvailable } from "../src/updater";
import { listen } from "@tauri-apps/api/event";
import type { WindowRole } from "../src/window-role";

/** Drain the boot chain.
 *
 *  A fixed count of microtasks is not enough on its own: every `await` inside
 *  `runBoot` adds ticks, so the number had to grow every time a step was added
 *  and the failure it produced named the LAST assertion in the list rather than
 *  the step that had lengthened the chain. Yielding a macrotask at the end
 *  drains whatever is left, whatever the length. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** Now that the bootstrap is a function, a test file can boot it more than once
 *  — which is the whole reason this file can exist. It was a side-effect module,
 *  and a side-effect module imports once per file. */
async function boot(role: WindowRole, items: (typeof WS)[] = [WS]) {
  document.body.innerHTML =
    '<div id="app"><div id="ledger"></div><div id="stage"><nav id="rail"></nav>'
    // `#workarea` stacks the deck and the terminal drawer, and is what the note
    // reader covers — the same box `.term-drawer.is-full` covers. It is on all
    // four real bodies (`page-bodies.test.ts`), and was missing here.
    + '<div id="sidebar"><div id="panel-head"></div><div id="panel-stack"></div><div id="limits"></div></div>'
    + '<div id="workarea"><main id="deck"></main><div id="terminals"></div></div>'
    + '<aside id="wspanel" hidden><div id="wsp-head"></div>'
    + '<div id="wsp-body"><div id="board" class="panel-page hidden"></div></div></aside>'
    + '</div></div>';
  pinnedCalls.length = 0;
  panelItems = items;
  panelActiveId = WS.id;
  loadRejects = null;
  currentLabel = role.kind === "main" ? "main" : `workspace-${role.workspaceId}`;
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

/** The other half of the role, and a different class from the one above: not
 *  "what may this window do once" but "what is this window ABOUT".
 *
 *  A window pulled out to hold one workspace is that workspace's, so the app's own
 *  navigation is not built in it — the rail carries the journal, the scenarios, the
 *  corpus of notes and the settings, and all four are about the app. The confusion this ends is a
 *  concrete one: the settings opened from inside a project window read as that
 *  project's settings, and they are not.
 */
describe("the shape of a window pinned to one workspace", () => {
  const rail = () => document.querySelector<HTMLElement>("#rail")!;

  it("builds the rail in the main window", async () => {
    await boot({ kind: "main" });
    expect(rail().hidden).toBe(false);
    expect([...rail().querySelectorAll(".rail-btn")].map((b) => b.getAttribute("title")))
      .toEqual(["Workspaces and sessions", "Journal", "Scenarios", "Memory", "Settings"]);
  });

  /* Not built rather than hidden: a control that exists is one the palette can
     still reach and the keyboard can still land on. The element itself stays —
     one body, four windows, `page-bodies.test.ts` — so what is asserted is that
     it is empty AND out of the layout. */
  it("builds none of it in a pinned window", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    expect(rail().hidden).toBe(true);
    expect(rail().querySelectorAll("button")).toHaveLength(0);
  });

  /* Collapsing takes the panel to zero width, its head and this button with it.
     In the main window the rail is what you press to bring it back; here there is
     no rail, so the control that could strand the window is not offered. */
  it("keeps the panel: no collapse control where there is no rail", async () => {
    await boot({ kind: "main" });
    expect(document.querySelector<HTMLElement>("#panel-shut")!.hidden).toBe(false);

    await boot({ kind: "workspace", workspaceId: "w" });
    expect(document.querySelector<HTMLElement>("#panel-shut")!.hidden).toBe(true);
  });

  /* The rule under the tree is about choosing between workspaces, over a choice a
     pinned window does not offer. */
  it("drops the tree's rule about choosing a workspace", async () => {
    await boot({ kind: "main" });
    expect(document.querySelector<HTMLElement>(".panel-hint")!.hidden).toBe(false);

    await boot({ kind: "workspace", workspaceId: "w" });
    expect(document.querySelector<HTMLElement>(".panel-hint")!.hidden).toBe(true);
  });

  /** The panel is narrowed to this window's workspace by the panel itself — this
   *  is the call that tells it which, and without it the window lists every
   *  workspace and opens on whichever one `ui_state.json` names. */
  it("pins the workspaces panel, and only in a pinned window", async () => {
    await boot({ kind: "main" });
    expect(pinnedCalls).toEqual([]);

    await boot({ kind: "workspace", workspaceId: "w" });
    expect(pinnedCalls).toEqual(["w"]);
  });
});

/** The third thing this boundary decides: which events this window is allowed to
 *  act on.
 *
 *  Here rather than in a file of its own because it is the same seam the two
 *  describes above hold — what `startApp(role)` wires — and because standing the
 *  app up in jsdom costs the two hundred lines of mocks at the top of this file.
 *
 *  The defect (#349): `listen` registers with `EventTarget::Any` by default, and
 *  Tauri delivers every addressed emit to an `Any` listener whatever label it was
 *  addressed to. So `emitTo(workspaceLabel(id), "workspace://gone")` reached the
 *  main window too, whose handler closes the window it is in — deleting a
 *  workspace took the main window with it, with no error anywhere and a process
 *  left running behind the floating status pill, which nothing ever destroyed.
 *  The pill is gone (#394); a workspace window left up does the same thing.
 */
describe("the events a window may act on", () => {
  /** Every event one window addresses to another, and what each would do in a
   *  window it was not meant for. */
  const ADDRESSED = [
    ["workspace://gone", "closes the window it is in"],
    ["session://focus", "raises the window and steals the keyboard"],
    ["workspace://take", "adopts tiles belonging to somebody else"],
  ] as const;

  const targetOf = (event: string) =>
    vi.mocked(listen).mock.calls.find(([e]) => e === event)?.[2]?.target;

  it("narrows every addressed one to this window, in the main window", async () => {
    await boot({ kind: "main" });
    for (const [event, harm] of ADDRESSED) {
      expect(targetOf(event), `${event} would otherwise ${harm}`)
        .toEqual({ kind: "Window", label: "main" });
    }
  });

  /** The same in a pinned window, and with its own label: a narrowing that named
   *  the wrong window would be worse than none — the listener would go deaf to
   *  what is genuinely addressed to it. */
  it("narrows them to the pinned window's own label", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    for (const [event] of ADDRESSED) {
      expect(targetOf(event), event).toEqual({ kind: "Window", label: "workspace-w" });
    }
  });

  /** And the other direction, which the narrowing must not touch. A broadcast is
   *  addressed to nobody, and Tauri delivers it to every listener whatever its
   *  target — so these stay unnarrowed to say plainly that they are broadcasts,
   *  and a future narrowing of one would be a window that stops hearing the app.
   */
  it("leaves the broadcasts alone", async () => {
    await boot({ kind: "main" });
    for (const event of ["session://waiting", "window://gone", "ui://scale"]) {
      expect(targetOf(event), event).toBeUndefined();
    }
  });
});

/** #369: a window pinned to a workspace the store no longer has.
 *
 *  The list is read once, during boot, and until this it was the only read there
 *  ever was — so a pull that deleted a workspace record, or carried the answer
 *  somebody gave to a duplicate question on the other machine, left the window
 *  pinned to an id nothing answers for. Its sessions collected under "Other", the
 *  heading for a session whose workspace was deleted, and with no workspace row
 *  there was no "New session in …" row either: the window could not be given work
 *  at all.
 *
 *  Here rather than in a file of its own for the reason the two describes above
 *  are: this is `startApp(role)`'s boundary again — what a window does about its
 *  own workspace disappearing is decided by which kind of window it is.
 */
describe("a workspace that leaves the store", () => {
  /** The announcement, delivered the way Tauri would. `onWorkspacesChanged`
   *  wraps the handler and drops the payload, so the argument is a formality. */
  const announce = () => {
    const call = vi.mocked(listen).mock.calls.find(([e]) => e === "workspaces://changed");
    expect(call, "nothing listens for the store's workspace list changing").toBeDefined();
    (call![1] as (e: unknown) => void)({ event: "workspaces://changed", id: 0, payload: null });
  };

  /* Both kinds of window: the row to drop is the main window's business and the
     window to close is the pinned one's, and neither can be decided by whichever
     side wrote the file. */
  it("is listened for in either kind of window", async () => {
    await boot({ kind: "main" });
    expect(vi.mocked(listen).mock.calls.map(([e]) => e)).toContain("workspaces://changed");

    vi.clearAllMocks();
    await boot({ kind: "workspace", workspaceId: "w" });
    expect(vi.mocked(listen).mock.calls.map(([e]) => e)).toContain("workspaces://changed");
  });

  it("closes a pinned window whose workspace has gone", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    panelItems = []; // the pull took it
    announce();
    await flush();
    expect(closeSpy).toHaveBeenCalled();
  });

  /* The common case, and the one a close would be a disaster in: the list changed
     because something else in it did. */
  it("keeps a pinned window whose workspace is still there", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    announce();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  /* The main window is not pinned to anything, so there is nothing it can be
     pinned to nothing about — and it is where the sessions of a window that did
     close land. */
  it("never closes the main window, whatever the store lost", async () => {
    await boot({ kind: "main" });
    panelItems = [];
    announce();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  /* The announcement can arrive before the window that needs it exists.
     `open_workspace_window` refuses an id the store does not have, but it answers
     before the window is built — so a pull landing in that gap leaves a window
     whose first read is already of a list without it, with nothing further coming
     to tell it. Asked once at boot for exactly that. */
  it("closes a pinned window whose workspace was already gone at boot", async () => {
    await boot({ kind: "workspace", workspaceId: "w" }, []);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("boots the main window normally with an empty store", async () => {
    await boot({ kind: "main" }, []);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  /* The other state a stale list hid, and the one the main window is in when the
     record that went was the one it was showing: the panel has no active
     workspace while the deck goes on filtering its tiles to an id nothing answers
     for. The fallback is the first workspace there is — not a close, and not
     nothing. */
  it("falls back to the first workspace when the active one has gone", async () => {
    await boot({ kind: "main" });
    panelItems = [{ id: "w2", name: "Q", path: "/q", color: "#eee" }];
    announce();
    await flush();
    expect(activateSpy).toHaveBeenCalledWith("w2");
    expect(closeSpy).not.toHaveBeenCalled();
  });

  /* A list that could not be read is not a list without the workspace in it.
     `list_workspaces` refuses rather than answering "none" (#369), and the refusal
     has to stop the close: a store that would not parse deleted nothing. */
  it("keeps a pinned window when the list could not be read", async () => {
    await boot({ kind: "workspace", workspaceId: "w" });
    loadRejects = new Error("workspaces.json is not readable as JSON");
    panelItems = []; // what a best-effort read would have answered instead
    announce();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
