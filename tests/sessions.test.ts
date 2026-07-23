// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const writeSpy = vi.fn();
const startMock = vi.fn();

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    mount: HTMLElement;
    constructor(session: string, mount: HTMLElement) {
      this.session = session;
      this.mount = mount;
    }
    start = startMock;
    write = writeSpy;
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onOutput: vi.fn().mockResolvedValue(() => {}),
  onState: vi.fn().mockResolvedValue(() => {}),
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

import { Deck } from "../src/sessions";

const WS = { id: "w", name: "P", path: "/p", color: "#fff" };

describe("Deck.launch error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("marks the tile as error when start rejects", async () => {
    startMock.mockRejectedValueOnce(new Error("claude-not-found"));
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    const deck = new Deck(deckEl, listEl);

    await deck.launch(WS as any, null);

    const label = deckEl.querySelector(".tile-state")!;
    expect(label.className).toContain("state-error");
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("claude не найден"));
  });
});
