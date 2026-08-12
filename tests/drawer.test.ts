// @vitest-environment jsdom
//
// The terminal drawer: tabs, the banner line, and the two questions a shell
// raises that a claude session never did — "is something running in here" and
// "what identity is this thing carrying".
import { describe, it, expect, vi, beforeEach } from "vitest";

/** The panels the drawer built, in order, and the hook that decides what their
 *  `startShell` does — both hoisted, because a `vi.mock` factory runs before the
 *  file's own top-level statements. */
const { panels, shell } = vi.hoisted(() => ({
  panels: [] as any[],
  shell: {
    impl: (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ auth: { account: null, degraded: null }, identity: null, program: "zsh" }),
  },
}));

vi.mock("../src/terminal", () => {
  class MockPanel {
    written: (string | Uint8Array)[] = [];
    focused = 0;
    disposed = false;
    startShell = vi.fn((cwd: string, ws: string | null) => shell.impl(cwd, ws));
    constructor(
      readonly session: string,
      readonly mount: HTMLElement,
      readonly keepsRenameKey = false,
    ) {
      panels.push(this);
    }
    write(d: string | Uint8Array) { this.written.push(d); }
    focus() { this.focused++; }
    fit() {}
    dispose() { this.disposed = true; }
    /** Everything the drawer wrote, as one string, for the banner assertions. */
    text() { return this.written.filter((w) => typeof w === "string").join(""); }
  }
  return { TerminalPanel: MockPanel };
});

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  describeExit: vi.fn().mockReturnValue(null),
  closeSession: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: "main", dirty: false }),
  loadTerminals: vi.fn().mockResolvedValue({ items: [], active: {}, open: [] }),
  saveTerminals: vi.fn().mockResolvedValue(undefined),
  saveUiState: vi.fn().mockResolvedValue(undefined),
  sessionJobs: vi.fn().mockResolvedValue(0),
  startShellSession: vi.fn(),
}));
vi.mock("../src/modal", () => ({
  confirmModal: vi.fn().mockResolvedValue(true),
  promptModal: vi.fn().mockResolvedValue(null),
}));

import { TerminalDrawer, bannerLine, drawerHeightPx, rowsForHeight, DEFAULT_TERMINAL_ROWS } from "../src/drawer";
import {
  loadTerminals, saveTerminals, saveUiState, sessionJobs, closeSession, gitStatus, onOutput, onExit,
} from "../src/ipc";
import { confirmModal, promptModal } from "../src/modal";

const WS = { id: "w1", name: "api", path: "/repos/api" };

const WS2 = { id: "w2", name: "web", path: "/repos/web" };
const ALL = [{ id: "w1" }, { id: "w2" }];

/** A drawer already showing `ctx`'s workspace — which is the state the app is
 *  always in, since `activateWorkspace` tells it before anything else can. */
function makeDrawer(ctx: typeof WS = WS, all: { id: string }[] = ALL) {
  const el = document.createElement("div");
  document.body.append(el);
  let active = ctx;
  const drawer = new TerminalDrawer(el, () => active, () => all);
  drawer.setWorkspace(active.id);
  /** Switch the workspace the way the app does: the context provider follows. */
  const switchTo = (ws: typeof WS | null) => {
    active = ws ?? { id: null as unknown as string, name: null as unknown as string, path: "." };
    drawer.setWorkspace(ws?.id ?? null);
  };
  return { el, drawer, switchTo };
}

/** The tabs actually on screen. A tab belonging to another workspace is in the
 *  DOM — its terminal is still running — but hidden, so a test that counted
 *  every `.term-tab-name` would be blind to the whole of the scoping. */
const tabNames = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>(".term-tab")]
    .filter((t) => !t.hidden)
    .map((t) => t.querySelector(".term-tab-name")!.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  panels.length = 0;
  document.body.innerHTML = "";
  vi.mocked(gitStatus).mockResolvedValue({ branch: "main", dirty: false });
  vi.mocked(loadTerminals).mockResolvedValue({ items: [], active: {}, open: [] });
  vi.mocked(sessionJobs).mockResolvedValue(0);
  vi.mocked(confirmModal).mockResolvedValue(true);
  shell.impl = () =>
    Promise.resolve({ auth: { account: null, degraded: null }, identity: null, program: "zsh" });
});

// The banner exists for one reason: `GIT_AUTHOR_*` in the environment beats
// `.git/config`, so `git config user.email` inside the shell reports the value
// that loses. This is the only place the truth is stated.
describe("the banner line", () => {
  it("names the directory, the branch, the account and the identity", () => {
    expect(bannerLine({
      cwd: "/repos/api", branch: "main", account: "followLemmi",
      degraded: null, identity: "Evgeny <e@example.com>",
    })).toBe("/repos/api · main · followLemmi · Evgeny <e@example.com>");
  });

  it("leaves out what there is nothing to say about", () => {
    expect(bannerLine({
      cwd: "/tmp", branch: null, account: null, degraded: null, identity: null,
    })).toBe("/tmp");
  });

  // A degraded shell still commits and still pushes over ssh; what it cannot do
  // is talk to `gh`. Unsaid, that reads as a broken app rather than a binding
  // that did not resolve.
  it("says so when the account could not be resolved", () => {
    const line = bannerLine({
      cwd: "/repos/api", branch: "main", account: "followLemmi",
      degraded: "gh did not answer in time", identity: null,
    });
    expect(line).toContain("gh unavailable: gh did not answer in time");
  });
});

// Rows rather than pixels, for the reason `prDiffCols` is columns: the thing
// being sized is a grid of characters.
describe("the drawer's height is a row count", () => {
  it("survives the round trip through pixels", () => {
    for (const rows of [4, 14, 30]) {
      expect(rowsForHeight(drawerHeightPx(rows, 1, 40), 1, 40)).toBe(rows);
    }
  });

  it("means the same number of rows at a different text size", () => {
    const small = drawerHeightPx(14, 1, 40);
    const large = drawerHeightPx(14, 1.45, 40);
    expect(large).toBeGreaterThan(small);
    expect(rowsForHeight(large, 1.45, 40)).toBe(14);
  });

  it("refuses a drag past what is still a terminal", () => {
    expect(rowsForHeight(0, 1, 40)).toBe(4);
    expect(rowsForHeight(100_000, 1, 40)).toBe(30);
  });
});

describe("opening a terminal", () => {
  it("puts a tab up, starts a shell in the active workspace, and says what it carries", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();

    expect(panels).toHaveLength(1);
    expect(panels[0].startShell).toHaveBeenCalledWith("/repos/api", "w1");
    expect(panels[0].text()).toContain("/repos/api · main");
    // A shell is where a full-screen TUI runs, so F2 stays the program's.
    expect(panels[0].keepsRenameKey).toBe(true);
    expect(el.hidden).toBe(false);
    expect(tabNames(el)).toEqual(["zsh · api"]);
  });

  // The tab is named after the shell that actually opened. "shell · api" is a
  // guess made before the backend answered; "zsh · api" is a fact.
  it("renames the tab to the shell that actually opened", async () => {
    panels.length = 0;
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();
    (panels[0].startShell as ReturnType<typeof vi.fn>).mockClear();
    expect(tabNames(el)[0]).toBe("zsh · api");
  });

  // The banner explains the shell it is above. A prompt that got there first
  // would push it below the thing it explains, so output is held until the line
  // is in.
  it("writes the banner above output that arrived before it", async () => {
    let holdStart: (v: unknown) => void = () => {};
    const { drawer } = makeDrawer();
    await drawer.wireEvents();
    const onOutputCb = vi.mocked(onOutput).mock.calls[0][0];

    // A shell whose spawn has not answered yet, already writing.
    const gate = new Promise((res) => { holdStart = res as (v: unknown) => void });
    shell.impl = () => gate;
    const opening = drawer.newTerminal();
    await vi.waitFor(() => expect(panels).toHaveLength(1));
    onOutputCb(panels[0].session, new TextEncoder().encode("$ "));
    holdStart({ auth: { account: null, degraded: null }, identity: null, program: "zsh" });
    await opening;

    const first = panels[0].written[0];
    expect(typeof first === "string" && first.includes("/repos/api")).toBe(true);
  });

  it("keeps a tab whose shell refused to start, and says why", async () => {
    const { el, drawer } = makeDrawer();
    // The one refusal a person can act on.
    shell.impl = () => Promise.reject(new Error("terminal-limit:8"));
    await drawer.newTerminal();
    expect(tabNames(el)).toHaveLength(1);
    expect(panels[0].text()).toContain("8 terminals is the limit");
  });
});

describe("the drawer as a surface", () => {
  // A strip with a `+` and nothing in it is a worse answer to "give me a
  // terminal" than a terminal.
  it("opens a terminal when it is toggled open empty", async () => {
    const { drawer } = makeDrawer();
    await drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
    expect(panels).toHaveLength(1);
  });

  it("does not open another one when it is toggled shut and back", async () => {
    const { drawer } = makeDrawer();
    await drawer.toggle();
    await drawer.toggle();
    expect(drawer.isOpen()).toBe(false);
    await drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
    expect(panels).toHaveLength(1);
  });

  // Per workspace, and stored with the tabs rather than in the ui state: the
  // drawer being up is a fact about a project, not about the window.
  it("remembers which workspaces it was up in", async () => {
    const { drawer } = makeDrawer();
    await drawer.toggle();
    const calls = vi.mocked(saveTerminals).mock.calls;
    expect(calls[calls.length - 1][0].open).toEqual(["w1"]);
  });
});

describe("closing a terminal", () => {
  it("goes without a question when nothing is running in it", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();
    const session = panels[0].session;

    await drawer.close(session);
    expect(confirmModal).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith(session);
    expect(panels[0].disposed).toBe(true);
    expect(tabNames(el)).toEqual([]);
  });

  // A shell has no hooks, so its chip would say `idle` four minutes into a
  // release build. The process table is the only honest answer.
  it("asks when a job is running, and leaves it alone on no", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();
    vi.mocked(sessionJobs).mockResolvedValue(2);
    vi.mocked(confirmModal).mockResolvedValue(false);

    await drawer.close(panels[0].session);
    expect(confirmModal).toHaveBeenCalledWith(expect.stringContaining("2 jobs"));
    expect(closeSession).not.toHaveBeenCalled();
    expect(tabNames(el)).toHaveLength(1);
  });

  it("closes it on yes", async () => {
    const { drawer } = makeDrawer();
    await drawer.newTerminal();
    vi.mocked(sessionJobs).mockResolvedValue(1);
    vi.mocked(confirmModal).mockResolvedValue(true);

    await drawer.close(panels[0].session);
    expect(confirmModal).toHaveBeenCalledWith(expect.stringContaining("a job"));
    expect(closeSession).toHaveBeenCalled();
  });

  it("shuts the drawer when the last tab goes, rather than leaving chrome around nothing", async () => {
    const { drawer } = makeDrawer();
    await drawer.newTerminal();
    await drawer.close(panels[0].session);
    expect(drawer.isOpen()).toBe(false);
  });

  it("hands the front to a surviving tab", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();
    await drawer.newTerminal();
    await drawer.close(panels[1].session);
    expect(tabNames(el)).toHaveLength(1);
    expect(el.querySelector(".term-tab.is-active .term-tab-name")?.textContent).toBe("zsh · api");
  });
});

describe("what survives a restart", () => {
  it("reopens each tab in its own directory and puts the stored one in front", async () => {
    vi.mocked(loadTerminals).mockResolvedValue({
      items: [
        { sessionId: "t1", cwd: "/repos/api", name: "api", workspaceId: "w1" },
        { sessionId: "t2", cwd: "/repos/web", name: "web build", workspaceId: "w2" },
      ],
      active: { w1: "t1" },
      open: ["w1"],
    });
    const { el, drawer } = makeDrawer();
    await drawer.restore({ rows: 20 });
    drawer.setWorkspace("w1");

    // Both shells are started — a terminal in another workspace keeps running,
    // it is only off screen.
    expect(panels.map((p) => p.session)).toEqual(["t1", "t2"]);
    expect(panels[0].startShell).toHaveBeenCalledWith("/repos/api", "w1");
    expect(panels[1].startShell).toHaveBeenCalledWith("/repos/web", "w2");
    // But only this workspace's is on screen. A person's own name outlives the
    // shell that had it; the auto-name rewrite must not touch one.
    expect(tabNames(el)).toEqual(["api"]);
    expect(el.querySelector(".term-tab.is-active .term-tab-name")?.textContent).toBe("api");
    expect(drawer.isOpen()).toBe(true);
  });

  it("stays shut, and opens nothing, when it was shut", async () => {
    const { drawer } = makeDrawer();
    await drawer.restore({ rows: DEFAULT_TERMINAL_ROWS });
    expect(drawer.isOpen()).toBe(false);
    expect(panels).toHaveLength(0);
  });

  // The file is the drawer's, and a damaged one must not take the app with it.
  it("survives a read that fails", async () => {
    vi.mocked(loadTerminals).mockRejectedValue(new Error("no"));
    const { drawer } = makeDrawer();
    await expect(drawer.restore({ rows: 14 })).resolves.toBeUndefined();
    expect(drawer.isOpen()).toBe(false);
  });

  it("writes the tabs and the active one down as they change", async () => {
    const { drawer } = makeDrawer();
    await drawer.newTerminal();
    const calls = vi.mocked(saveTerminals).mock.calls;
    const saved = calls[calls.length - 1][0];
    expect(saved.items).toEqual([
      { sessionId: panels[0].session, cwd: "/repos/api", name: "zsh · api", workspaceId: "w1" },
    ]);
    expect(saved.active).toEqual({ w1: panels[0].session });
    expect(saved.open).toEqual(["w1"]);
  });
});

describe("a shell that ends", () => {
  it("marks its tab and leaves the scrollback where it is", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.wireEvents();
    await drawer.newTerminal();
    const onExitCb = vi.mocked(onExit).mock.calls[0][0];

    onExitCb(panels[0].session, { ok: true, code: 0, signal: null, unknown: false });
    expect(el.querySelector(".term-tab.is-dead")).not.toBeNull();
    // The tab stays: its scrollback is the only record of what it was doing.
    expect(tabNames(el)).toHaveLength(1);
    expect(panels[0].text()).toContain("shell exited");
  });
});

describe("naming", () => {
  it("answers for its own sessions and nobody else's", async () => {
    const { drawer } = makeDrawer();
    await drawer.newTerminal();
    expect(drawer.nameOf(panels[0].session)).toBe("zsh · api");
    expect(drawer.nameOf("a-deck-tile")).toBeNull();
    expect(drawer.has("a-deck-tile")).toBe(false);
  });

  it("takes a name a person typed, and keeps it", async () => {
    const { el, drawer } = makeDrawer();
    await drawer.newTerminal();
    vi.mocked(promptModal).mockResolvedValue("release build");
    el.querySelector<HTMLElement>(".term-tab-name")!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }));
    await vi.waitFor(() => expect(tabNames(el)).toEqual(["release build"]));
    const calls = vi.mocked(saveTerminals).mock.calls;
    expect(calls[calls.length - 1][0].items[0].name).toBe("release build");
  });
});

// The rule the whole surface hangs on: a terminal belongs to a workspace the way
// a deck tile does. Switching projects switches terminals — it does not carry
// one project's shell, standing in one project's directory under one project's
// account, into another.
describe("a terminal belongs to its workspace", () => {
  it("goes off screen with its workspace and comes back with it", async () => {
    const { el, drawer, switchTo } = makeDrawer();
    await drawer.newTerminal();
    const first = panels[0].session;
    expect(tabNames(el)).toEqual(["zsh · api"]);

    switchTo(WS2);
    // Nothing was closed — the shell is still running, it is simply not this
    // project's.
    expect(drawer.isOpen()).toBe(false);
    expect(el.hidden).toBe(true);
    expect(tabNames(el)).toEqual([]);
    expect(panels[0].disposed).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();

    switchTo(WS);
    expect(drawer.isOpen()).toBe(true);
    expect(tabNames(el)).toEqual(["zsh · api"]);
    expect(el.querySelector(".term-tab.is-active .term-tab-name")?.textContent).toBe("zsh · api");
    // The same panel, so the scrollback came back with it.
    expect(panels).toHaveLength(1);
    expect(panels[0].session).toBe(first);
  });

  it("opens the new one in the workspace on screen", async () => {
    const { el, drawer, switchTo } = makeDrawer();
    await drawer.newTerminal();
    switchTo(WS2);
    await drawer.newTerminal();

    expect(tabNames(el)).toEqual(["zsh · web"]);
    expect(panels[1].startShell).toHaveBeenCalledWith("/repos/web", "w2");
    switchTo(WS);
    expect(tabNames(el)).toEqual(["zsh · api"]);
  });

  // Each workspace keeps its own front tab: coming back to a project should put
  // you where you were in it, not where you were somewhere else.
  it("remembers which tab was in front, per workspace", async () => {
    const { el, drawer, switchTo } = makeDrawer();
    /** The session whose terminal is the one on screen. */
    const front = () =>
      el.querySelector<HTMLElement>(".term-body:not(.hidden)")?.dataset.session;

    await drawer.newTerminal();
    await drawer.newTerminal();
    const [apiFirst, apiSecond] = [panels[0].session, panels[1].session];
    drawer.activate(apiFirst, { focus: false });
    expect(front()).toBe(apiFirst);

    switchTo(WS2);
    await drawer.newTerminal();
    expect(front()).toBe(panels[2].session);

    // Back to the first project: the tab *it* was left on, not the one the
    // other project is showing, and not merely the last one opened anywhere.
    switchTo(WS);
    expect(front()).toBe(apiFirst);
    expect(front()).not.toBe(apiSecond);
  });

  // Up in one project and shut in another, and staying that way.
  it("keeps being up a per-workspace answer", async () => {
    const { drawer, switchTo } = makeDrawer();
    await drawer.newTerminal();
    switchTo(WS2);
    await drawer.newTerminal();
    await drawer.toggle();                       // shut it here
    expect(drawer.isOpen()).toBe(false);

    switchTo(WS);
    expect(drawer.isOpen()).toBe(true);          // still up there
    switchTo(WS2);
    expect(drawer.isOpen()).toBe(false);         // still shut here
  });

  // A workspace that was deleted cannot be switched to, so a terminal bound to
  // one would be unreachable — and it is still running. Same rule the deck keeps
  // for an orphaned tile.
  it("keeps a terminal whose workspace is gone reachable from everywhere", async () => {
    vi.mocked(loadTerminals).mockResolvedValue({
      items: [{ sessionId: "orphan", cwd: "/gone", name: "leftover", workspaceId: "deleted" }],
      active: {},
      open: ["deleted"],
    });
    const { el, drawer, switchTo } = makeDrawer();
    await drawer.restore({ rows: 14 });
    drawer.setWorkspace("w1");
    expect(tabNames(el)).toEqual(["leftover"]);
    switchTo(WS2);
    expect(tabNames(el)).toEqual(["leftover"]);
  });

  // Closing the last one in a project takes that project's drawer with it, and
  // leaves the other project's alone.
  it("shuts only the workspace whose last terminal went", async () => {
    const { drawer, switchTo } = makeDrawer();
    await drawer.newTerminal();
    switchTo(WS2);
    await drawer.newTerminal();
    await drawer.close(panels[1].session);
    expect(drawer.isOpen()).toBe(false);
    switchTo(WS);
    expect(drawer.isOpen()).toBe(true);
  });
});

// There is deliberately no test here for a tab of another workspace being off
// the *screen* rather than merely marked `hidden`, and the reason is worth
// keeping: jsdom resolves `[hidden]` to `display: none` even against a
// `display: flex` rule that outranks it, so it agrees with the app whether or
// not the app is right. A real browser does not — `.term-tab { display: flex }`
// wins over the UA sheet's bare `[hidden]`, and every other workspace's tabs
// stayed visible while `el.hidden` read `true`. The fix is the explicit
// `.term-tab[hidden]` rule in `styles.css`, the same shape `.term-drawer[hidden]`
// already had; the check is `harness/` in a browser, and no assertion this file
// could make would have caught it.
