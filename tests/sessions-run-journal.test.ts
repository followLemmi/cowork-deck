// @vitest-environment jsdom
//
// The frontend's whole share of the run journal: saying which scenario a launch
// came from, and remembering the record so a restart can chain to it. Nothing
// here writes a journal line — every one of those is written in Rust.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScenarioLaunch, SessionEntry } from "../src/ipc";

const panelSessions: string[] = [];
/** Every `panel.start` call, in order, so a test can ask what the backend was
 *  told about a launch. */
const starts: {
  session: string;
  resume: boolean;
  scenario: ScenarioLaunch | null;
}[] = [];

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) {
      this.session = session;
      panelSessions.push(session);
    }
    start = vi.fn(
      async (
        _cwd: string, _wsId: string | null, _prompt: string | null, _taskId: string | null,
        resume = false, scenario: ScenarioLaunch | null = null,
      ) => {
        starts.push({ session: this.session, resume, scenario });
        return { account: null, degraded: null };
      },
    );
    startCommand = vi.fn().mockResolvedValue(undefined);
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
    clear = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck, serializeTiles } from "../src/sessions";
import { saveLayout } from "../src/ipc";

const WS = { id: "w", name: "P", path: "/p", color: "#61afef" };
const SKILL = { id: "s1", name: "Nightly review", icon: "▶", prompt: "review", workspaceId: null };

async function makeDeck() {
  panelSessions.length = 0;
  starts.length = 0;
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  const deck = new Deck(deckEl, listEl, () => [WS as never]);
  await deck.wireEvents();
  return { deck, deckEl };
}

/** The last layout the deck asked to be saved. */
function lastSavedLayout(): SessionEntry[] {
  const calls = vi.mocked(saveLayout).mock.calls;
  return calls[calls.length - 1][0];
}

describe("what a launch tells the run journal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("marks a scenario click as a manual run and carries its parameter values", async () => {
    const { deck } = await makeDeck();
    await deck.launch(WS as never, { ...SKILL, prompt: "review dev" } as never, { branch: "dev" });

    expect(starts).toHaveLength(1);
    expect(starts[0].scenario).toMatchObject({
      skillId: "s1", trigger: "manual", params: { branch: "dev" },
    });
    // Minted here, beside the session id, so it can be persisted immediately —
    // that link is the only way a resumed tile can chain to what it continues.
    expect(starts[0].scenario!.runId).toBeTruthy();
  });

  // The journal answers "what did my scenarios do", not "what did I run
  // yesterday": everything else has to stay out of it.
  it("sends no record for a bare session", async () => {
    const { deck } = await makeDeck();
    await deck.launch(WS as never, null);
    expect(starts[0].scenario).toBeNull();
  });

  it("sends no record for a session launched from a card", async () => {
    const { deck } = await makeDeck();
    await deck.launchOnWorktree("/wt", "w", "⑂ #7", "work on it", "7");
    expect(starts[0].scenario).toBeNull();
  });

  // Splitting scheduled runs off into a journal of their own would be an
  // artificial line, so both are recorded — and told apart, so the screen can
  // filter one out.
  it("tells a scheduled fire from a hand-pressed one", async () => {
    const { deck } = await makeDeck();
    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");
    expect(starts[0].scenario).toMatchObject({ skillId: "s1", trigger: "schedule" });

    starts.length = 0;
    await deck.launchScheduled(WS as never, SKILL as never, "review", "runNow");
    expect(starts[0].scenario).toMatchObject({ trigger: "runNow" });
  });

  it("records a scheduled run's defaults as the values it ran with", async () => {
    const { deck } = await makeDeck();
    const scheduled = {
      ...SKILL,
      schedule: { preset: { kind: "daily", hour: 9, minute: 0 }, defaults: { branch: "main" }, enabled: true },
    };
    await deck.launchScheduled(WS as never, scheduled as never, "review main", "schedule");
    expect(starts[0].scenario!.params).toEqual({ branch: "main" });
  });

  it("persists the scenario and the record so a restart can find them", async () => {
    const { deck } = await makeDeck();
    await deck.launch(WS as never, SKILL as never, { branch: "dev" });

    const entry = lastSavedLayout()[0];
    expect(entry.skillId).toBe("s1");
    expect(entry.runId).toBe(starts[0].scenario!.runId);
  });
});

describe("resuming a scenario run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  // A run is one launched PTY. Auto-restore opens a **new** record chained to
  // the one it continues, because a record spanning an app restart could never
  // say which side of the crash a result came from.
  it("opens a new record chained to the one the layout remembered", async () => {
    const { deck } = await makeDeck();
    await deck.restore([{
      sessionId: "yesterday", cwd: "/p", name: "▶ Nightly review", workspaceId: "w",
      skillId: "s1", runId: "run-of-yesterday",
    }]);

    expect(starts[0].resume).toBe(true);
    expect(starts[0].scenario).toMatchObject({
      skillId: "s1", trigger: "resume", continuesRunId: "run-of-yesterday",
    });
    expect(starts[0].scenario!.runId).not.toBe("run-of-yesterday");
  });

  // `resume` records are written only for tiles that were themselves launched
  // from a scenario.
  it("writes nothing for a restored card or bare session", async () => {
    const { deck } = await makeDeck();
    await deck.restore([
      { sessionId: "card", cwd: "/p", name: "☑ Fix it", workspaceId: "w", taskId: "01A" },
      { sessionId: "bare", cwd: "/p", name: "session · P", workspaceId: "w", nameKind: "placeholder" },
    ]);
    expect(starts.map((s) => s.scenario)).toEqual([null, null]);
  });

  // A tile restored from a layout written before the journal existed has a
  // scenario but no record to chain to. That is not an error — it is the first
  // run after an upgrade.
  it("chains to nothing when the layout predates the journal", async () => {
    const { deck } = await makeDeck();
    await deck.restore([{
      sessionId: "old", cwd: "/p", name: "▶ Nightly review", workspaceId: "w", skillId: "s1",
    }]);
    expect(starts[0].scenario).toMatchObject({ trigger: "resume", continuesRunId: null });
  });

  it("the tile's ⟳ opens a new record too", async () => {
    const { deck, deckEl } = await makeDeck();
    await deck.launch(WS as never, SKILL as never);
    const first = starts[0].scenario!.runId;

    const restart = deckEl.querySelector<HTMLButtonElement>('.tile-close[title="Restart session"]')!;
    restart.click();
    await vi.waitFor(() => expect(starts).toHaveLength(2));

    expect(starts[1].resume).toBe(true);
    expect(starts[1].scenario).toMatchObject({ skillId: "s1", trigger: "resume" });
    expect(starts[1].scenario!.runId).not.toBe(first);
    // The predecessor is not named here: the backend still has it open under
    // this same session id, and closing plus chaining is its business.
    expect(starts[1].scenario!.continuesRunId).toBeNull();
    // And the layout now points at the new record, not the finished one.
    expect(lastSavedLayout()[0].runId).toBe(starts[1].scenario!.runId);
  });
});

describe("serializeTiles and the two new fields", () => {
  it("omits both for a tile that is not a scenario run", () => {
    const [entry] = serializeTiles([
      { session: "s", workspacePath: "/p", name: "session · P" },
    ]);
    expect("skillId" in entry).toBe(false);
    expect("runId" in entry).toBe(false);
  });

  // `scheduledSkillId` keeps meaning the narrower thing its comment says —
  // "this tile was raised by a schedule" — and is read by the overlap guard.
  // Widening it to every scenario launch would silently break that guard, which
  // is why the new field sits beside it rather than replacing it.
  it("keeps the schedule's own key separate from the scenario link", () => {
    const [entry] = serializeTiles([{
      session: "s", workspacePath: "/p", name: "▶ Nightly",
      scheduledSkillId: "s1", skillId: "s1", runId: "r1",
    }]);
    expect(entry.scheduledSkillId).toBe("s1");
    expect(entry.skillId).toBe("s1");
    expect(entry.runId).toBe("r1");
  });
});
