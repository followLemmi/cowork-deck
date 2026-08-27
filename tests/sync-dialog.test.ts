// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  syncSummary: vi.fn(),
  syncPreflight: vi.fn(),
  syncProbe: vi.fn(),
  syncCreate: vi.fn(),
  syncConnect: vi.fn(),
  syncDisconnect: vi.fn(),
  syncNow: vi.fn(),
  syncQuestions: vi.fn(),
  syncMergeWorkspaces: vi.fn(),
  syncKeepDistinct: vi.fn(),
  listWorkspaces: vi.fn(),
  saveWorkspace: vi.fn(),
  onSyncState: vi.fn(),
}));
vi.mock("../src/ipc", () => m);
const picker = vi.hoisted(() => ({ pickFolder: vi.fn() }));
vi.mock("../src/dialog", () => picker);

import { syncDialog, DEFAULT_REPO_NAME } from "../src/sync-dialog";

const acc = (login = "followLemmi") => ({
  host: "github.com", login, active: false, scopes: ["repo"], state: "success",
});

const off = { on: false, remote: null, state: { lastPull: null, lastPush: null, fault: null }, machine: { id: "m-1", label: "laptop" } };
const on = { on: true, remote: "https://github.com/me/mem.git", state: { lastPull: 1, lastPush: 2, fault: null }, machine: { id: "m-1", label: "laptop" } };

const body = () => document.querySelector(".sync-body") as HTMLElement;
const text = () => body()?.textContent ?? "";
const button = (label: RegExp) =>
  [...document.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

/** The dialog renders across two awaits: the summary, then the preflight. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  document.body.replaceChildren();
  for (const fn of Object.values(m)) fn.mockReset();
  m.onSyncState.mockResolvedValue(() => {});
  m.syncSummary.mockResolvedValue(off);
  m.syncPreflight.mockResolvedValue({ blocked: null, accounts: [acc()], error: null });
  m.syncQuestions.mockResolvedValue([]);
  picker.pickFolder.mockReset();
});

describe("switching sync on", () => {
  it("says what it publishes before anyone agrees to it", async () => {
    void syncDialog();
    await settle();
    expect(text()).toMatch(/private GitHub repository/i);
    // And what does not travel, which is the half people assume wrong.
    expect(text()).toMatch(/stay on this machine/i);
  });

  it("offers connecting an existing repository as prominently as creating one", async () => {
    void syncDialog();
    await settle();
    // Connecting is what every machine after the first one does. A wizard that
    // only creates leaves the second machine with a second repository.
    expect(button(/^Connect$/)).toBeTruthy();
    expect(button(new RegExp(DEFAULT_REPO_NAME))).toBeTruthy();
  });

  it("says the repository is private on the button itself", async () => {
    void syncDialog();
    await settle();
    expect(button(new RegExp(DEFAULT_REPO_NAME))?.textContent).toMatch(/private/i);
  });

  it("does not switch sync on when Enter is pressed", async () => {
    void syncDialog();
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    // Publishing a person's session history is not something a stray keystroke
    // gets to do.
    expect(m.syncCreate).not.toHaveBeenCalled();
    expect(m.syncConnect).not.toHaveBeenCalled();
  });

  it("refuses to connect a repository that is not ours, and says why", async () => {
    m.syncProbe.mockResolvedValue({ kind: "foreign" });
    void syncDialog();
    await settle();
    (document.querySelector(".form-input") as HTMLInputElement).value = "someone/their-project";
    button(/^Connect$/)?.click();
    await settle();

    expect(m.syncConnect).not.toHaveBeenCalled();
    expect(text()).toMatch(/session history/i);
  });

  it("connects when the repository is one of ours", async () => {
    m.syncProbe.mockResolvedValue({ kind: "ours", format: 1 });
    m.syncConnect.mockResolvedValue(undefined);
    void syncDialog();
    await settle();
    (document.querySelector(".form-input") as HTMLInputElement).value = "me/mem";
    button(/^Connect$/)?.click();
    await settle();

    expect(m.syncConnect).toHaveBeenCalledWith(
      "github.com", "followLemmi", "me/mem", "https://github.com/me/mem.git",
    );
  });

  it("asks which account when there is more than one", async () => {
    m.syncPreflight.mockResolvedValue({
      blocked: null, accounts: [acc("followLemmi"), acc("EvgenyKh_jvl")], error: null,
    });
    void syncDialog();
    await settle();
    const select = document.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.options.length).toBe(2);
  });

  it("routes a missing gh to the existing fix rather than a new sentence", async () => {
    m.syncPreflight.mockResolvedValue({ blocked: "no-gh", accounts: [], error: null });
    void syncDialog();
    await settle();
    expect(text()).toMatch(/gh command-line tool is not installed/i);
    expect(button(/^Connect$/)).toBeFalsy();
  });

  it("shows a failed account listing as a fault, not as having no accounts", async () => {
    // Telling someone with two accounts that they have none is its own bug.
    m.syncPreflight.mockResolvedValue({
      blocked: null, accounts: [], error: "unknown flag: --json",
    });
    void syncDialog();
    await settle();
    expect(text()).toMatch(/could not be read/i);
    expect(text()).not.toMatch(/no GitHub account/i);
  });
});

describe("while sync is running", () => {
  it("shows how long ago it last sent, without anyone having to look for it", async () => {
    m.syncSummary.mockResolvedValue(on);
    void syncDialog();
    await settle();
    expect(text()).toMatch(/Last sent/i);
    expect(text()).toMatch(/last received/i);
  });

  it("names the conflicting files and offers no automatic resolution", async () => {
    m.syncSummary.mockResolvedValue({
      ...on,
      state: { lastPull: 1, lastPush: 2, fault: { kind: "conflict", files: ["ws-1/Facts.md"] } },
    });
    void syncDialog();
    await settle();
    expect(text()).toContain("ws-1/Facts.md");
    expect(button(/resolve|merge/i)).toBeFalsy();
  });

  it("says stopping leaves the repository alone", async () => {
    m.syncSummary.mockResolvedValue(on);
    void syncDialog();
    await settle();
    expect(button(/Stop syncing/)).toBeTruthy();
    expect(text()).toMatch(/leaves the repository and everything in it alone/i);
  });
});

/** #348: the questions a pull raises were collected and shown nowhere. The
 *  settings rail counted them into an amber dot and named none of them. */
describe("the questions a pull raised", () => {
  const duplicate = {
    kind: "duplicate", arrivingId: "ws-a", localId: "ws-b", name: "cowork-deck",
  } as const;

  beforeEach(() => {
    m.syncSummary.mockResolvedValue(on);
  });

  it("says nothing at all when there is nothing outstanding", async () => {
    void syncDialog();
    await settle();
    expect(document.querySelector(".sync-ask")).toBeFalsy();
    expect(text()).not.toMatch(/to answer/i);
  });

  it("names the project a duplicate is about, rather than only counting it", async () => {
    m.syncQuestions.mockResolvedValue([duplicate]);
    void syncDialog();
    await settle();
    expect(text()).toContain("cowork-deck");
    expect(text()).toMatch(/same repository/i);
  });

  it("offers both answers and takes neither on its own", async () => {
    m.syncQuestions.mockResolvedValue([duplicate]);
    void syncDialog();
    await settle();
    // Merging loses one of two memories under its own id. Never automatic.
    expect(button(/^Same project$/)).toBeTruthy();
    expect(button(/^Different projects$/)).toBeTruthy();
    expect(m.syncMergeWorkspaces).not.toHaveBeenCalled();
    expect(m.syncKeepDistinct).not.toHaveBeenCalled();
  });

  it("folds the arriving record into the local one, which is the located one", async () => {
    m.syncQuestions.mockResolvedValue([duplicate]);
    m.syncMergeWorkspaces.mockResolvedValue([]);
    void syncDialog();
    await settle();
    button(/^Same project$/)?.click();
    await settle();
    expect(m.syncMergeWorkspaces).toHaveBeenCalledWith("ws-a", "ws-b");
  });

  it("records a decline so the question does not come back every tick", async () => {
    m.syncQuestions.mockResolvedValue([duplicate]);
    m.syncKeepDistinct.mockResolvedValue(undefined);
    void syncDialog();
    await settle();
    button(/^Different projects$/)?.click();
    await settle();
    expect(m.syncKeepDistinct).toHaveBeenCalledWith("ws-a", "ws-b");
    expect(m.syncMergeWorkspaces).not.toHaveBeenCalled();
  });

  it("locates a workspace that came from another machine", async () => {
    m.syncQuestions.mockResolvedValue([
      { kind: "needs-path", workspaceId: "ws-a", name: "deck", cloneFrom: null },
    ]);
    m.listWorkspaces.mockResolvedValue([{ id: "ws-a", name: "deck", path: "", color: "#fff" }]);
    m.saveWorkspace.mockResolvedValue([]);
    picker.pickFolder.mockResolvedValue("/here/deck");
    void syncDialog();
    await settle();
    button(/^Locate…$/)?.click();
    await settle();
    expect(m.saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-a", path: "/here/deck" }),
    );
  });

  it("names the repository a record came from, so it can be cloned first", async () => {
    m.syncQuestions.mockResolvedValue([
      {
        kind: "needs-path", workspaceId: "ws-a", name: "deck",
        cloneFrom: "https://github.com/me/deck.git",
      },
    ]);
    void syncDialog();
    await settle();
    expect(text()).toContain("https://github.com/me/deck.git");
  });

  it("records nothing when the folder picker is cancelled", async () => {
    m.syncQuestions.mockResolvedValue([
      { kind: "needs-path", workspaceId: "ws-a", name: "deck", cloneFrom: null },
    ]);
    picker.pickFolder.mockResolvedValue(null);
    void syncDialog();
    await settle();
    button(/^Locate…$/)?.click();
    await settle();
    expect(m.saveWorkspace).not.toHaveBeenCalled();
  });

  it("points a board whose folder was on the other machine at one here", async () => {
    m.syncQuestions.mockResolvedValue([
      { kind: "needs-board-path", workspaceId: "ws-a", name: "deck" },
    ]);
    m.listWorkspaces.mockResolvedValue([
      { id: "ws-a", name: "deck", path: "/here/deck", color: "#fff" },
    ]);
    m.saveWorkspace.mockResolvedValue([]);
    picker.pickFolder.mockResolvedValue("/here/vault");
    void syncDialog();
    await settle();
    button(/^Locate the board…$/)?.click();
    await settle();
    expect(m.saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        tracker: { providers: [{ type: "fs", root: { kind: "path", path: "/here/vault" } }] },
      }),
    );
  });

  it("shows a refusal in the row that caused it, and keeps the question", async () => {
    m.syncQuestions.mockResolvedValue([duplicate]);
    m.syncMergeWorkspaces.mockRejectedValue("a workspace cannot be merged into itself");
    void syncDialog();
    await settle();
    button(/^Same project$/)?.click();
    await settle();
    // Doing nothing silently would read as "answered", which is the one thing a
    // failed merge must not look like.
    expect(text()).toContain("cannot be merged into itself");
    expect(button(/^Same project$/)).toBeTruthy();
  });

  it("keeps the rest of the panel honest when the questions cannot be read", async () => {
    m.syncQuestions.mockRejectedValue(new Error("store lock"));
    void syncDialog();
    await settle();
    expect(text()).toMatch(/Last sent/i);
    expect(document.querySelector(".sync-ask")).toBeFalsy();
  });
});
