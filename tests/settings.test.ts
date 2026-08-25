// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { settingsDialog, type SettingsSection } from "../src/settings";
import {
  applyScale, currentScale, DEFAULT_SCALE, rootFontPx, SCALE_STEPS, scaleLabel,
} from "../src/ui-scale";

/* The rail's dot reads the real sync state, and the config section mounts the real
   renderer. Both are somebody else's contract here: what this file is about is the
   WINDOW — that a section is one row and one pane, that everything applies as it is
   touched, and that a live section is torn down when the window goes. */
const summary = vi.fn().mockResolvedValue({
  on: false, remote: null, machine: { id: "m", label: "this mac" },
  state: { lastPull: null, lastPush: null, fault: null },
});
const questions = vi.fn().mockResolvedValue([]);
vi.mock("../src/ipc", () => ({
  syncSummary: () => summary(),
  syncQuestions: () => questions(),
}));
let mounted = 0;
let disposed = 0;
vi.mock("../src/sync-dialog", () => ({
  mountSync: (body: HTMLElement) => {
    mounted += 1;
    body.append(document.createTextNode("the sync section"));
    return { dispose: () => { disposed += 1; } };
  },
}));

const sizes = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-size")];
const pick = (scale: number) => sizes().find((b) => Number(b.dataset.scale) === scale)!;
const checked = () => sizes().filter((b) => b.getAttribute("aria-checked") === "true");
const click = (sel: string) => document.querySelector<HTMLButtonElement>(sel)!.click();
const navItem = (id: SettingsSection) =>
  document.querySelector<HTMLButtonElement>(`.set-nav-item[data-section="${id}"]`)!;
const go = (id: SettingsSection) => navItem(id).click();
const showing = () =>
  [...document.querySelectorAll<HTMLElement>(".set-body")].filter((b) => !b.hidden);

const OTHER = SCALE_STEPS.find((s) => s !== DEFAULT_SCALE)!;

/** What the window shows that it does not own. The dialog reads none of this
 *  itself — the paths come from Rust, the workspace from the panel — so a fixture
 *  here is the whole of its input. */
const PATHS = {
  dir: "/home/dev/.config/cowork-deck",
  files: [
    { name: "workspaces.json", exists: true },
    { name: "skills.json", exists: false },
  ],
};
const WS = {
  id: "w", name: "relay", path: "/home/dev/code/relay", color: "#fff",
  github: { host: "github.com", login: "acme-dev" },
};
let revealed: string[] = [];
let edited = 0;
let scaled: number[] = [];
const open = (over: Partial<Parameters<typeof settingsDialog>[0]> = {}) =>
  settingsDialog({
    paths: PATHS, workspace: WS as never, taskSource: "cards in .cowork/tasks",
    onReveal: (p) => revealed.push(p),
    onEditWorkspace: () => { edited += 1; },
    onScale: (s) => scaled.push(s),
    ...over,
  });

beforeEach(() => {
  revealed = [];
  edited = 0;
  scaled = [];
  mounted = 0;
  disposed = 0;
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  applyScale(DEFAULT_SCALE, document.documentElement);
});

/** The shape of the window, which is the part that has to survive sections being
 *  added: a row in the rail, a pane beside it, one of them showing. */
describe("the settings window's sections", () => {
  it("gives every section one row and one pane, and shows exactly one", () => {
    void open();
    const rows = document.querySelectorAll(".set-nav-item");
    const panes = document.querySelectorAll(".set-body");
    expect(rows.length).toBe(panes.length);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(showing()).toHaveLength(1);
  });

  it("marks the row whose pane is showing, and only that one", () => {
    void open();
    for (const id of ["appearance", "config", "files"] as SettingsSection[]) {
      go(id);
      const current = [...document.querySelectorAll(".set-nav-item")]
        .filter((b) => b.getAttribute("aria-current") === "page");
      expect(current).toEqual([navItem(id)]);
      expect(showing()).toHaveLength(1);
    }
  });

  it("lands on the section it was asked for", () => {
    void open({ section: "files" });
    expect(navItem("files").getAttribute("aria-current")).toBe("page");
    // The palette opens the window straight at the config repository, which is the
    // reason this argument exists at all.
    document.body.innerHTML = "";
    void open({ section: "config" });
    expect(navItem("config").getAttribute("aria-current")).toBe("page");
  });

  /** A pane is filled on its first visit and not again. The config section
   *  subscribes to a live feed, so re-filling on every visit would leave one
   *  subscription per visit behind — and this is the assertion that says so. */
  it("fills a pane once, however often it is visited", () => {
    void open();
    go("config");
    go("files");
    go("config");
    expect(mounted).toBe(1);
  });

  it("tears a live section down when the window closes", async () => {
    const p = open({ section: "config" });
    expect(mounted).toBe(1);
    expect(disposed).toBe(0);
    click(".modal-ok");
    await p;
    expect(disposed).toBe(1);
  });

  it("does not mount a section nobody opened", async () => {
    const p = open();
    click(".modal-ok");
    await p;
    expect(mounted).toBe(0);
    expect(disposed).toBe(0);
  });

  it("names itself for a reader", () => {
    void open();
    const box = document.querySelector<HTMLElement>(".modal-box")!;
    const title = document.querySelector<HTMLElement>("#settings-title")!;
    expect(box.getAttribute("aria-labelledby")).toBe(title.id);
    expect(box.getAttribute("role")).toBe("dialog");
    expect(document.querySelector(".set-rail")?.getAttribute("aria-label"))
      .toBe("Settings sections");
  });
});

describe("appearance", () => {
  it("reflects the scale in force when it opened", () => {
    applyScale(OTHER, document.documentElement);
    void open();
    expect(checked()).toEqual([pick(OTHER)]);
    expect(pick(OTHER).classList.contains("selected")).toBe(true);
  });

  it("offers every step, labelled with the percentage and the pixels", () => {
    void open();
    expect(sizes()).toHaveLength(SCALE_STEPS.length);
    for (const s of SCALE_STEPS) expect(pick(s).textContent).toBe(scaleLabel(s));
  });

  it("applies live, so a person sees the size rather than imagining it", () => {
    void open();
    pick(OTHER).click();
    expect(document.documentElement.style.fontSize).toBe(`${rootFontPx(OTHER)}px`);
    expect(currentScale()).toBe(OTHER);
    expect(checked()).toEqual([pick(OTHER)]);
  });

  /** The window has no OK, so the pick itself is what has to reach the app. This
   *  is the seam that persists it: the scale is written and every terminal refitted
   *  by the caller, neither of which is a preferences window's business. */
  it("reports every pick to the caller as it happens", () => {
    void open();
    pick(OTHER).click();
    pick(DEFAULT_SCALE).click();
    expect(scaled).toEqual([OTHER, DEFAULT_SCALE]);
  });

  /** What replaced Cancel. The old window previewed and put the size back if you
   *  changed your mind, which worked for a text size and could not work for the
   *  section beside it: connecting a repository is not undone by closing a window.
   *  One rule for the whole window beats one rule per section. */
  it("keeps what was picked when the window is closed, whichever way", async () => {
    const byButton = open();
    pick(OTHER).click();
    click(".modal-ok");
    await byButton;
    expect(currentScale()).toBe(OTHER);

    const byEscape = open();
    pick(DEFAULT_SCALE).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await byEscape;
    expect(currentScale()).toBe(DEFAULT_SCALE);
  });

  it("has no OK and no Cancel, because there is nothing to confirm", () => {
    void open();
    expect(document.querySelector(".modal-cancel")).toBeNull();
    const out = document.querySelectorAll(".set-foot button");
    expect([...out].map((b) => b.textContent)).toEqual(["Done"]);
  });

  it("is a radiogroup, so the selection reaches a reader and not only the ring", () => {
    void open();
    const group = document.querySelector<HTMLElement>(".settings-sizes")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(sizes().every((b) => b.getAttribute("role") === "radio")).toBe(true);
  });

  it("closes the overlay", async () => {
    const p = open();
    click(".modal-ok");
    await p;
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("settles once, so a second click cannot resolve it again", async () => {
    const p = open();
    const ok = document.querySelector<HTMLButtonElement>(".modal-ok")!;
    pick(OTHER).click();
    ok.click();
    // The button is detached with the overlay, but a queued event or a double click
    // must not run the teardown twice.
    ok.click();
    await p;
    expect(currentScale()).toBe(OTHER);
  });
});

/** Not a preference — an answer. "Where is my configuration, and what is this
 *  workspace bound to" was answerable before only by reading the source or opening
 *  the form that changes it. */
describe("files", () => {
  const kv = (label: string) =>
    [...document.querySelectorAll(".set-kv")]
      .find((r) => r.querySelector(".set-kv-label")?.textContent === label);

  it("names the directory the app keeps its own files in", () => {
    void open({ section: "files" });
    expect(kv("Directory")?.querySelector(".set-kv-value")?.textContent).toBe(PATHS.dir);
  });

  it("lists every file, and marks the ones not written yet", () => {
    void open({ section: "files" });
    const chips = [...document.querySelectorAll(".set-file")];
    expect(chips.map((c) => c.textContent)).toEqual(["workspaces.json", "skills.json"]);
    // Absent is a fact, not a row to drop: a person looking for a file they have
    // never saved needs to be told it is not there.
    expect(chips[0].classList.contains("set-file--absent")).toBe(false);
    expect(chips[1].classList.contains("set-file--absent")).toBe(true);
  });

  /** Two owners, said apart. Conflating them is how "where is my config" gets
   *  answered with a path that turns out to be one project's. */
  it("keeps the app's files and the workspace's bindings in separate groups", () => {
    void open({ section: "files" });
    const heads = [...document.querySelectorAll(".set-head")].map((h) => h.textContent);
    expect(heads).toEqual(["The app's own files", "This workspace · relay"]);
  });

  it("says which account a push from this workspace goes out as", () => {
    void open({ section: "files" });
    expect(kv("Pushes as")?.querySelector(".set-kv-value")?.textContent)
      .toBe("acme-dev · github.com");
  });

  it("says so plainly when nothing is bound", () => {
    void open({ section: "files", workspace: { ...WS, github: null } as never, taskSource: null });
    expect(kv("Pushes as")?.querySelector(".set-kv-value")?.textContent).toBe("no account bound");
    expect(kv("Tasks come from")?.querySelector(".set-kv-value")?.textContent)
      .toBe("nothing configured");
  });

  it("reveals a path rather than opening it, and only when asked", () => {
    void open({ section: "files" });
    expect(revealed).toEqual([]);
    document.querySelectorAll<HTMLButtonElement>(".set-kv-act")[0].click();
    expect(revealed).toEqual([PATHS.dir]);
  });

  /** Editing is somebody else's job: the workspace form owns these fields, and a
   *  second editor for them is a second thing to keep in step. Handing over closes
   *  this window, because two modals on one subject is a stack nobody asked for. */
  it("hands the bindings to the form that owns them, and gets out of the way", async () => {
    const p = open({ section: "files" });
    const act = [...document.querySelectorAll<HTMLButtonElement>(".set-kv-act")]
      .find((b) => b.textContent === "Edit workspace…")!;
    act.click();
    expect(edited).toBe(1);
    await p;
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("says there is nothing bound to show when no workspace is active", () => {
    void open({ section: "files", workspace: null, taskSource: null });
    expect(document.body.textContent).toContain("No workspace is active");
  });
});
