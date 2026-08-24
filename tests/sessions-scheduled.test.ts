// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

const panelSessions: string[] = [];

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) {
      this.session = session;
      panelSessions.push(session);
    }
    start = vi.fn().mockResolvedValue(undefined);
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck } from "../src/sessions";
import { onState, closeSession } from "../src/ipc";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { emit } from "@tauri-apps/api/event";

const WS = { id: "w", name: "P", path: "/p", color: "#61afef" };
const SKILL = { id: "s1", name: "Nightly review", icon: "▶", prompt: "review", workspaceId: null };

/** Boots a deck with events wired and hands back a way to drive session state
 *  the way the Rust listener would. */
async function makeDeck() {
  panelSessions.length = 0;
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  const deck = new Deck(deckEl, listEl, () => [WS as never]);
  await deck.wireEvents();
  const emitState = vi.mocked(onState).mock.calls[0][0] as (s: string, st: SessionState) => void;
  return { deck, deckEl, emitState };
}

describe("Deck.launchScheduled — overlap with a finished run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  // An interactive `claude` does not exit after finishing its task: it returns
  // to the prompt, which reports as `done`. The previous guard read that as an
  // active run, so a daily schedule fired once and then went silent forever.
  it("launches the next run once the previous one has finished", async () => {
    const { deck, emitState } = await makeDeck();

    expect(await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule")).toBe(true);
    const first = panelSessions[0];
    emitState(first, "done");

    expect(await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule")).toBe(true);
    expect(panelSessions).toHaveLength(2);
  });

  // One tile per scheduled scenario: yesterday's finished run is closed rather
  // than left to pile up, one tile per day.
  it("closes the finished tile instead of accumulating one per run", async () => {
    const { deck, deckEl, emitState } = await makeDeck();

    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");
    const first = panelSessions[0];
    emitState(first, "done");
    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");

    expect(vi.mocked(closeSession)).toHaveBeenCalledWith(first);
    expect(deckEl.querySelectorAll(".tile")).toHaveLength(1);
  });

  // Finishing a task used to arrive as `waitingInput`, which was in NOTIFY_ON.
  // Splitting the states must not cost the user that notification — it is the
  // whole point of running something unattended.
  it("notifies when a run finishes its task", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");

    emitState(panelSessions[0], "done");

    expect(vi.mocked(sendNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendNotification).mock.calls[0][0]).toMatchObject({
      title: "cowork-deck · done",
      body: "▶ Nightly review", // the clock is its own icon now, not part of the name
    });
  });

  // The pill answers "how many sessions are blocked on me", so a finished run
  // must not inflate it. The notification above is what reports completion.
  it("does not count a finished run as waiting for input", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");

    emitState(panelSessions[0], "done");

    expect(vi.mocked(emit)).toHaveBeenCalledWith("pill://count", { n: 0 });
  });

  // Auto-restore brings yesterday's scheduled tile back, but the link from
  // scenario to session used not to survive: the guard saw nothing, and a
  // catch-up fire seconds later raised a second copy of the same scenario in
  // the same folder.
  it("keeps the guard aware of a restored scheduled run", async () => {
    const { deck, emitState } = await makeDeck();
    await deck.restore([
      { sessionId: "yesterday", cwd: "/p", name: "⏰ ▶ Nightly review", workspaceId: "w", scheduledSkillId: "s1" },
    ]);
    emitState("yesterday", "working");

    expect(await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule")).toBe(false);
  });

  // Unattended work must not yank the user out of what they are typing. The
  // notification and the pill are how a scheduled run announces itself.
  it("does not take keyboard focus when a schedule fires", async () => {
    const { deck, deckEl } = await makeDeck();
    await deck.launch(WS as never, null);
    const manual = deckEl.querySelector<HTMLElement>(".tile")!;

    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");

    expect(manual.classList.contains("is-active")).toBe(true);
  });

  // A tile belonging to another workspace used to appear in whatever deck was
  // on screen and vanish again at the next workspace switch.
  it("hides a scheduled tile that belongs to another workspace", async () => {
    const { deck, deckEl } = await makeDeck();
    deck.setActiveWorkspace("other");

    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");

    expect(deckEl.querySelector(".tile")!.classList.contains("ws-hidden")).toBe(true);
  });

  // The guard still earns its keep: a run blocked on a permission prompt is
  // genuinely active, and stacking a second one on top of it would be worse
  // than skipping.
  it("still skips while the previous run waits for a decision", async () => {
    const { deck, deckEl, emitState } = await makeDeck();

    await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule");
    emitState(panelSessions[0], "waitingInput");

    expect(await deck.launchScheduled(WS as never, SKILL as never, "review", "schedule")).toBe(false);
    expect(vi.mocked(closeSession)).not.toHaveBeenCalled();
    expect(deckEl.querySelectorAll(".tile")).toHaveLength(1);
  });
});
