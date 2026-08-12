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
  loadTerminals: vi.fn().mockResolvedValue({ items: [], active: null }),
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

function makeDrawer(ctx = WS) {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, drawer: new TerminalDrawer(el, () => ctx) };
}

const tabNames = (el: HTMLElement) =>
  [...el.querySelectorAll(".term-tab-name")].map((n) => n.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  panels.length = 0;
  document.body.innerHTML = "";
  vi.mocked(gitStatus).mockResolvedValue({ branch: "main", dirty: false });
  vi.mocked(loadTerminals).mockResolvedValue({ items: [], active: null });
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

  it("remembers whether it was up", async () => {
    const { drawer } = makeDrawer();
    await drawer.toggle();
    expect(saveUiState).toHaveBeenCalledWith({ terminalsOpen: true });
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
      active: "t2",
    });
    const { el, drawer } = makeDrawer();
    await drawer.restore({ open: true, rows: 20 });

    expect(panels.map((p) => p.session)).toEqual(["t1", "t2"]);
    expect(panels[0].startShell).toHaveBeenCalledWith("/repos/api", "w1");
    expect(panels[1].startShell).toHaveBeenCalledWith("/repos/web", "w2");
    // A person's own names outlive the shell that had them; the auto-name
    // rewrite must not touch one.
    expect(tabNames(el)).toEqual(["api", "web build"]);
    expect(el.querySelector(".term-tab.is-active .term-tab-name")?.textContent).toBe("web build");
    expect(drawer.isOpen()).toBe(true);
  });

  it("stays shut, and opens nothing, when it was shut", async () => {
    const { drawer } = makeDrawer();
    await drawer.restore({ open: false, rows: DEFAULT_TERMINAL_ROWS });
    expect(drawer.isOpen()).toBe(false);
    expect(panels).toHaveLength(0);
  });

  // The file is the drawer's, and a damaged one must not take the app with it.
  it("survives a read that fails", async () => {
    vi.mocked(loadTerminals).mockRejectedValue(new Error("no"));
    const { drawer } = makeDrawer();
    await expect(drawer.restore({ open: true, rows: 14 })).resolves.toBeUndefined();
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
    expect(saved.active).toBe(panels[0].session);
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
