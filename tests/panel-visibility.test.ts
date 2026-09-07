// @vitest-environment jsdom
/** Whose decision the left panel's visibility is, driven through `startApp`.
 *
 *  The answer is: the person's, and nobody else's. It was the zoom's as well
 *  until #480 — zooming a session collapsed the panel and un-zooming brought it
 *  back unless the person had collapsed it themselves — and the flag that
 *  arbitrated that was asymmetric. Collapsing by hand latched "leave this
 *  alone"; OPENING by hand only cleared the latch, which read as "the app may
 *  take it away again". So there was no state meaning "I want the panel while
 *  zoomed", and every later transition back INTO zoom collapsed it once more: an
 *  un-zoom and a zoom of another tile, or a workspace switch, since a zoom is
 *  remembered per workspace and arriving at a workspace that had one zooms again.
 *
 *  Booted through the whole app rather than unit-tested, because the defect was
 *  wiring: the class, the deck's zoom listener, and the store all had to agree,
 *  and no one of them is where it lived. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bootIpc, UI_STATE } from "./helpers/boot-ipc";
import { saveUiState, loadUiState, type Workspace } from "../src/ipc";

/* Hoisted, because both `vi.mock` factories below read them and a factory runs
   above this file's own top-level statements.

   Two workspaces, and TWO sessions in each: `zoomParticipants` refuses a zoom
   with nothing to zoom past, so a workspace holding one tile has no zoom to
   enter. And two workspaces because one of the transitions under test is
   arriving at a workspace whose zoom is remembered. */
const { WS, WS2, LAYOUT } = vi.hoisted(() => {
  const WS = { id: "w1", name: "One", path: "/one", color: "#fff" };
  const WS2 = { id: "w2", name: "Two", path: "/two", color: "#fff" };
  return {
    WS, WS2,
    LAYOUT: [
      { sessionId: "s1", cwd: "/one", name: "a", workspaceId: WS.id },
      { sessionId: "s2", cwd: "/one", name: "a2", workspaceId: WS.id },
      { sessionId: "s3", cwd: "/two", name: "b", workspaceId: WS2.id },
      { sessionId: "s4", cwd: "/two", name: "b2", workspaceId: WS2.id },
    ],
  };
});

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig() as object),
  ...bootIpc({
    listWorkspaces: vi.fn().mockResolvedValue([WS, WS2]),
    loadLayout: vi.fn().mockResolvedValue(LAYOUT),
    memoryCaptureOffer: vi.fn().mockResolvedValue({ available: false }),
  }),
}));

/** The panel itself is not what is under test, so it is stood in for — but its
 *  `onSelect` callback IS: a workspace switch is one of the four transitions
 *  that used to move the panel, and the app hears about one through here. */
const { selected } = vi.hoisted(() => ({ selected: { fn: null as null | ((ws: Workspace) => void) } }));
vi.mock("../src/workspaces", () => ({
  WorkspacesPanel: class {
    private current: Workspace = WS;
    constructor(_mount: HTMLElement, onSelect: (ws: Workspace) => void) {
      selected.fn = (ws) => { this.current = ws; onSelect(ws); };
    }
    get active() { return this.current; }
    get all() { return [WS, WS2]; }
    load = vi.fn().mockResolvedValue(undefined);
    setSkillsSource = vi.fn();
    setSessionsSource = vi.fn();
    setTreeHooks = vi.fn();
    setDetached = vi.fn();
    pinTo = vi.fn();
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
  emitTo: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main", onCloseRequested: async () => () => {}, destroy: async () => {},
    unminimize: vi.fn(), show: vi.fn(), setFocus: vi.fn(),
  }),
}));

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

/** Mirrors `index.html`, `#mark` included — the crumb and its door are inserted
 *  after the wordmark, and the app optional-chains a fixture without one. */
function mount(): void {
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
}

const sidebar = () => document.querySelector<HTMLElement>("#sidebar")!;
const collapsed = () => sidebar().classList.contains("is-collapsed");
const shut = () => document.querySelector<HTMLButtonElement>("#panel-shut")!;

/** The tile for a session, by the name its header shows. */
function tile(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("#deck .tile")]
    .find((t) => t.querySelector(".tile-name")?.textContent === name);
  if (!found) throw new Error(`no tile named ${name}`);
  return found;
}

/** A row of the panel's session list, by the name it shows. Pressing one is what
 *  "switch to another session" means in this app. */
function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("#sidebar .sess-row")]
    .find((r) => r.getAttribute("aria-label")?.startsWith(`${name} —`));
  if (!found) throw new Error(`no session row named ${name}`);
  return found;
}

/** Zoom or leave zoom the way a person does with a pointer: a double-click on
 *  the tile's header. Deliberately not a method on the deck — the point is that
 *  no route into zoom moves the panel, and a test that called `toggleZoom` would
 *  be asserting about one of the five. */
async function dblclickHead(name: string): Promise<void> {
  tile(name).querySelector(".tile-head")!
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await flush();
}

describe("the left panel is the person's to hide", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(loadUiState).mockResolvedValue(UI_STATE);
    vi.resetModules();
    mount();
    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();
  });

  it("leaves the panel open through a zoom, an un-zoom and another zoom", async () => {
    expect(collapsed()).toBe(false);

    await dblclickHead("a");
    expect(tile("a").classList.contains("zoomed")).toBe(true);
    // The line the issue was filed about. Zoom takes the deck's width; it does
    // not get to take the panel's.
    expect(collapsed()).toBe(false);

    await dblclickHead("a");
    expect(collapsed()).toBe(false);

    // And the transition that re-collapsed it after the person had opened it by
    // hand: leaving zoom and entering it again is a fresh `false → true` edge.
    await dblclickHead("a");
    expect(collapsed()).toBe(false);
  });

  it("leaves the panel collapsed through the same three, once a person has collapsed it", async () => {
    shut().click();
    await flush();
    expect(collapsed()).toBe(true);

    await dblclickHead("a");
    expect(collapsed()).toBe(true);
    // Nothing restores it, which is the other half of the same rule: the app did
    // not take it away, so the app has nothing to give back.
    await dblclickHead("a");
    expect(collapsed()).toBe(true);
  });

  it("keeps the panel a person opened while zoomed, across a workspace switch", async () => {
    await dblclickHead("a");
    expect(tile("a").classList.contains("zoomed")).toBe(true);
    // Collapsed by hand while zoomed, then opened again by hand — the second
    // decision the old flag threw away.
    shut().click();
    await flush();
    shut().click();
    await flush();
    expect(collapsed()).toBe(false);

    /* Away and back. A zoom is remembered per workspace, so arriving at this one
       zooms again — the edge that collapsed the panel for the third time. */
    selected.fn!(WS2);
    await flush();
    expect(collapsed()).toBe(false);

    selected.fn!(WS);
    await flush();
    expect(tile("a").classList.contains("zoomed")).toBe(true);
    expect(collapsed()).toBe(false);
  });

  /* Step 4 of the issue's reproduction, and the one that made the defect
     inescapable: opening a session from the panel's own list. Within a workspace
     it moves a zoom without leaving it; into another workspace it is a switch,
     which restores that workspace's remembered zoom. */
  it("leaves the panel alone when another session is opened from the list", async () => {
    await dblclickHead("a");
    expect(collapsed()).toBe(false);

    row("a2").click();
    await flush();
    expect(tile("a2").classList.contains("zoomed")).toBe(true);
    expect(collapsed()).toBe(false);

    // A session in the workspace that is not on screen: a switch, and a zoom
    // entered from the far side of one.
    row("b").click();
    await flush();
    expect(collapsed()).toBe(false);
  });

  /** The state is stored because it is now a preference: one kind of writer, and
   *  it is a person. Storing it while a zoom could set it would have meant a
   *  restart restoring the last zoom's doing under the name of a choice. */
  it("remembers what the person chose, and nothing else", async () => {
    expect(vi.mocked(saveUiState).mock.calls.flatMap((c) => Object.keys(c[0])))
      .not.toContain("panelCollapsed");

    shut().click();
    await flush();
    expect(saveUiState).toHaveBeenCalledWith({ panelCollapsed: true });

    shut().click();
    await flush();
    expect(saveUiState).toHaveBeenCalledWith({ panelCollapsed: false });

    // A zoom writes nothing at all, because it decides nothing.
    vi.mocked(saveUiState).mockClear();
    await dblclickHead("a");
    expect(vi.mocked(saveUiState).mock.calls.flatMap((c) => Object.keys(c[0])))
      .not.toContain("panelCollapsed");
  });
});

describe("the stored state is what a restart opens on", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it("opens collapsed for somebody who left it collapsed", async () => {
    vi.mocked(loadUiState).mockResolvedValue({ ...UI_STATE, panelCollapsed: true });
    mount();
    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    expect(collapsed()).toBe(true);
    // Restoring is reading the answer, not giving one: a boot that wrote it back
    // would be the app claiming a decision it did not make.
    expect(vi.mocked(saveUiState).mock.calls.flatMap((c) => Object.keys(c[0])))
      .not.toContain("panelCollapsed");
    // And the button still says which way it goes.
    expect(shut().getAttribute("aria-label")).toBe("Show the panel");
  });

  it("opens showing for somebody who left it showing", async () => {
    vi.mocked(loadUiState).mockResolvedValue({ ...UI_STATE, panelCollapsed: false });
    mount();
    await import("../src/app").then((m) => m.startApp({ kind: "main" }));
    await flush();

    expect(collapsed()).toBe(false);
  });

  /** A pinned workspace window has no rail and hides the shut button, so the
   *  panel is its only navigation — see `shutBtn`. A stored `true`, written from
   *  the main window, must not reach it: that would be a window with nothing to
   *  press. */
  it("ignores a stored collapse in a window pinned to one workspace", async () => {
    vi.mocked(loadUiState).mockResolvedValue({ ...UI_STATE, panelCollapsed: true });
    mount();
    await import("../src/app")
      .then((m) => m.startApp({ kind: "workspace", workspaceId: WS.id }));
    await flush();

    expect(collapsed()).toBe(false);
  });
});
