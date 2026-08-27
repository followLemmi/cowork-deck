// @vitest-environment jsdom
// The tile's half of the activity panel: the two ways in, the count on the
// button, and the rule that costs the most to get wrong — that the extra reads
// happen only while a panel is on screen.
import { describe, it, expect, vi, beforeEach } from "vitest";

const startMock = vi.fn();
const { onStateMock } = vi.hoisted(() => ({ onStateMock: vi.fn() }));

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    constructor(session: string) { this.session = session; }
    start = startMock;
    write = vi.fn();
    focus = vi.fn();
    clear = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onState: onStateMock,
  onExit: vi.fn().mockResolvedValue(() => {}),
  prepareWorkspace: vi.fn().mockResolvedValue({ account: null, degraded: null }),
  describeExit: vi.fn().mockReturnValue(null),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
  sessionActivity: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/modal", () => ({ confirmModal: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck } from "../src/sessions";
import { sessionActivity, sessionSnapshots } from "../src/ipc";
import type { ActivityRoll, SessionSnapshot } from "../src/ipc";

const WS = { id: "w", name: "relay", path: "/p", color: "#fff" };
const activity = sessionActivity as unknown as ReturnType<typeof vi.fn>;
const snapshots = sessionSnapshots as unknown as ReturnType<typeof vi.fn>;

function roll(calls: number): ActivityRoll {
  return {
    cli: "claude",
    agents: [{
      id: "main", kind: "main", agentType: null, description: null,
      depth: 0, spawnedBy: null, calls, tools: [],
    }],
    tools: [{ native: "Bash", category: "run", server: null, calls, errors: 0, denials: 0 }],
    calls,
    capabilities: { outcomes: true, agents: true },
    readAt: 1_700_000_000,
    unavailable: null,
    truncated: null,
  };
}

function snap(calls: number | null): SessionSnapshot {
  return { tokens: null, title: null, titleSource: null, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  startMock.mockResolvedValue(undefined);
  snapshots.mockResolvedValue({});
  activity.mockResolvedValue({});
  onStateMock.mockResolvedValue(() => {});
  vi.spyOn(crypto, "randomUUID").mockReturnValue("s1" as never);
});

const tick = (deck: Deck) => (deck as unknown as { pollOnce(): Promise<void> }).pollOnce();

function mount() {
  const deckEl = document.createElement("div");
  const listEl = document.createElement("div");
  document.body.append(deckEl, listEl);
  return { deckEl, listEl, deck: new Deck(deckEl, listEl, () => [WS as never]) };
}

async function tileWithPanelClosed() {
  const m = mount();
  await m.deck.launch(WS as never, null);
  return m;
}

const overlay = () => document.querySelector(".modal-overlay");

describe("the two ways in", () => {
  it("the button opens the panel", async () => {
    const { deckEl } = await tileWithPanelClosed();
    expect(overlay()).toBeNull();
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    expect(overlay()).toBeTruthy();
    expect(document.querySelector(".act-box")).toBeTruthy();
  });

  // The badge is already there and already about this session's measurements,
  // and its tooltip is the only home the spend has. A tooltip is where
  // information goes to be missed.
  it("the token badge opens the same dialog", async () => {
    const { deckEl } = await tileWithPanelClosed();
    deckEl.querySelector<HTMLElement>(".tile-tokens")!.click();
    expect(document.querySelectorAll(".act-box").length).toBe(1);
  });

  it("the badge is reachable from the keyboard, since it is a control now", async () => {
    const { deckEl } = await tileWithPanelClosed();
    const badge = deckEl.querySelector<HTMLElement>(".tile-tokens")!;
    expect(badge.tabIndex).toBe(0);
    expect(badge.getAttribute("role")).toBe("button");
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(overlay()).toBeTruthy();
  });

  it("Escape closes it", async () => {
    const { deckEl } = await tileWithPanelClosed();
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay()).toBeNull();
  });

  it("pressing the button again closes it rather than stacking a second", async () => {
    const { deckEl } = await tileWithPanelClosed();
    const btn = deckEl.querySelector<HTMLButtonElement>(".tile-activity")!;
    btn.click();
    btn.click();
    expect(overlay()).toBeNull();
    btn.click();
    expect(document.querySelectorAll(".act-box").length).toBe(1);
  });
});

describe("the count on the button", () => {
  it("rides the snapshot batch rather than a second command", async () => {
    const { deck, deckEl } = await tileWithPanelClosed();
    snapshots.mockResolvedValue({ s1: snap(148) });
    await tick(deck);
    expect(deckEl.querySelector(".tile-activity-count")!.textContent).toBe("148");
    // And no activity read happened: no panel is open.
    expect(activity).not.toHaveBeenCalled();
  });

  it("is hidden when there is no reading, and shown when the reading is zero", async () => {
    const { deck, deckEl } = await tileWithPanelClosed();
    const count = () => deckEl.querySelector<HTMLElement>(".tile-activity-count")!;

    snapshots.mockResolvedValue({ s1: snap(null) });
    await tick(deck);
    expect(count().classList.contains("hidden")).toBe(true);

    snapshots.mockResolvedValue({ s1: snap(0) });
    await tick(deck);
    expect(count().classList.contains("hidden")).toBe(false);
    expect(count().textContent).toBe("0");
  });
});

describe("what the tick costs", () => {
  // The whole cost argument for not putting the breakdown on the poll: the
  // heaviest transcript measured is 3.1 MB over 1728 lines, and 47 files are
  // past 1 MB.
  it("makes no activity call at all while no panel is open", async () => {
    const { deck } = await tileWithPanelClosed();
    await tick(deck);
    await tick(deck);
    expect(activity).not.toHaveBeenCalled();
  });

  it("re-reads on the tick while a panel is open, once per tick", async () => {
    const { deck, deckEl } = await tileWithPanelClosed();
    activity.mockResolvedValue({ s1: roll(9) });
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1));

    await tick(deck);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLElement>(".act-row")!.dataset.tool).toBe("Bash");
  });

  it("stops re-reading the moment the panel closes", async () => {
    const { deck, deckEl } = await tileWithPanelClosed();
    activity.mockResolvedValue({ s1: roll(9) });
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(deck);
    await tick(deck);
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it("closes the panel with the tile, so nothing outlives the session", async () => {
    const { deck, deckEl } = await tileWithPanelClosed();
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    expect(overlay()).toBeTruthy();
    (deck as unknown as { remove(s: string): void }).remove("s1");
    expect(overlay()).toBeNull();
  });
});

describe("a command tile", () => {
  // Not an agent session and never will have a log. The frontend is where a
  // tile's kind is known, so the sentence is decided here rather than by asking
  // the backend to look for a transcript that cannot exist.
  it("says so, and asks the backend nothing", async () => {
    const { deck, deckEl } = mount();
    await deck.openCommandTile("gh auth login", "gh auth login", "/p");
    deckEl.querySelector<HTMLButtonElement>(".tile-activity")!.click();
    const empty = document.querySelector<HTMLElement>(".act-empty")!;
    expect(empty.dataset.state).toBe("notAnAgent");
    expect(empty.textContent).toContain("command");
    expect(activity).not.toHaveBeenCalled();
  });
});
