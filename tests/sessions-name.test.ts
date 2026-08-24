// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../src/ipc";

const startMock = vi.fn();
const { confirmMock, notifyMock, onStateMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  notifyMock: vi.fn(),
  onStateMock: vi.fn(),
}));

vi.mock("../src/terminal", () => ({
  TerminalPanel: class {
    session: string;
    mount: HTMLElement;
    constructor(session: string, mount: HTMLElement) {
      this.session = session;
      this.mount = mount;
    }
    start = startMock;
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    fit = vi.fn();
  },
}));

vi.mock("../src/ipc", () => ({
  onState: onStateMock,
  onExit: vi.fn().mockResolvedValue(() => {}),
  closeSession: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  gitStatus: vi.fn().mockResolvedValue({ branch: null, dirty: false }),
  sessionSnapshots: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/modal", () => ({ confirmModal: confirmMock }));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: notifyMock,
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { Deck, normaliseName, resolveTileName, type TileNames } from "../src/sessions";
import { gitStatus, saveLayout, sessionSnapshots } from "../src/ipc";

const WS = { id: "w", name: "relay", path: "/p", color: "#fff" };

const names = (over: Partial<TileNames> = {}): TileNames => ({
  context: null, placeholder: "session · relay", auto: null, user: null, ...over,
});

/** The truth table, row by row. Each case is named for the decision it pins, not
 *  for the shape of the input. */
describe("resolveTileName", () => {
  it("shows the placeholder while nothing else has a name", () => {
    expect(resolveTileName(names())).toBe("session · relay");
  });

  it("shows the transcript title once one arrives", () => {
    expect(resolveTileName(names({ auto: "Trace the retry budget" })))
      .toBe("Trace the retry budget");
  });

  it("keeps a context name when an auto title arrives", () => {
    // The row that carries the whole precedence decision: `☑ <card>` is already
    // meaningful, and it is how the board says which card a session belongs to.
    expect(resolveTileName(names({ context: "☑ Fix the pill counter", auto: "Pill counter bug" })))
      .toBe("☑ Fix the pill counter");
  });

  it("shows a hand-typed name over a context name", () => {
    expect(resolveTileName(names({ context: "⚡ Daily digest", user: "do not close" })))
      .toBe("do not close");
  });

  it("shows a hand-typed name over a transcript title", () => {
    expect(resolveTileName(names({ auto: "Trace the retry budget", user: "the noisy one" })))
      .toBe("the noisy one");
  });

  it("falls back to the transcript title when a hand-typed name is cleared", () => {
    // Clearing the field is the entire undo story, so the slot below has to be
    // reachable again rather than merely overridden.
    expect(resolveTileName(names({ auto: "Trace the retry budget", user: "" })))
      .toBe("Trace the retry budget");
  });

  it("treats an empty or whitespace-only auto title as absent", () => {
    expect(resolveTileName(names({ auto: "   " }))).toBe("session · relay");
    expect(resolveTileName(names({ auto: "" }))).toBe("session · relay");
  });

  it("trims every slot before showing it", () => {
    expect(resolveTileName(names({ user: "  spaced  " }))).toBe("spaced");
    expect(resolveTileName(names({ auto: "\tTrace it\n" }))).toBe("Trace it");
  });
});

describe("normaliseName", () => {
  it("collapses a multi-line paste into one line", () => {
    // The editor never sees a newline — a text input strips CR and LF itself —
    // but this is the function that has to be right if it ever does, and it is
    // where a tab or a doubled space is dealt with.
    expect(normaliseName("first line\nsecond\tline")).toBe("first line second line");
  });
  it("caps by code point, so a name is never cut mid-character", () => {
    const capped = normaliseName("я".repeat(300));
    expect([...capped].length).toBe(120);
  });
  it("is empty for whitespace only, which is what clears a name", () => {
    expect(normaliseName("   \t ")).toBe("");
  });
});

describe("the displayed name is the one the deck speaks with", () => {
  let stateCb: ((session: string, state: SessionState) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    stateCb = null;
    onStateMock.mockImplementation(async (cb: (s: string, st: SessionState) => void) => {
      stateCb = cb;
      return () => {};
    });
  });

  /** A restored tile whose hand-typed name differs from its launch name — the
   *  cheapest way to make "displayed" and "launched" two different strings. */
  async function deckWithRenamedTile() {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    const deck = new Deck(deckEl, listEl, () => [WS as never]);
    await deck.wireEvents();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder", userName: "the one I must not close",
    }]);
    return { deck, deckEl, listEl };
  }

  it("writes the name into the header and its tooltip together", async () => {
    const { deckEl } = await deckWithRenamedTile();
    const el = deckEl.querySelector<HTMLElement>(".tile-name")!;
    expect(el.textContent).toBe("the one I must not close");
    expect(el.title).toBe("the one I must not close");
  });

  it("asks to close using the displayed name", async () => {
    const { deck } = await deckWithRenamedTile();
    stateCb!("s1", "working");
    confirmMock.mockResolvedValue(false);
    await deck.closeActive();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("the one I must not close"),
    );
  });

  it("sends the notification with the displayed name as its body", async () => {
    await deckWithRenamedTile();
    stateCb!("s1", "waitingInput");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: "the one I must not close" }),
    );
  });

  it("carries the displayed name into the sidebar row and its aria-label", async () => {
    const { listEl } = await deckWithRenamedTile();
    const row = listEl.querySelector<HTMLElement>(".sess-row")!;
    expect(row.textContent).toContain("the one I must not close");
    expect(row.getAttribute("aria-label")).toContain("the one I must not close");
  });
});

/** The five-second tick already reads the transcript for token counts; these
 *  cover it reading the name out of the same bytes. */
describe("the poll tick names a tile from its transcript", () => {
  const snapshots = vi.mocked(sessionSnapshots);
  const git = vi.mocked(gitStatus);
  const save = vi.mocked(saveLayout);

  const tokens = {
    context: 1_234, subagents: 0,
    spend: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 },
  };
  const snap = (title: string | null) => ({ tokens, title, titleSource: title ? "ai" : null });

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    startMock.mockResolvedValue(undefined);
    git.mockResolvedValue({ branch: null, dirty: false });
    save.mockResolvedValue(undefined);
    snapshots.mockResolvedValue({});
    vi.spyOn(crypto, "randomUUID").mockReturnValue("s1" as never);
  });

  /** `pollOnce` is private and fires on its own timer; a test drives it directly
   *  rather than waiting five seconds for the interval that already exists. */
  const tick = (deck: Deck) =>
    (deck as unknown as { pollOnce(): Promise<void> }).pollOnce();
  const persist = (deck: Deck) =>
    (deck as unknown as { persistLayout(): Promise<void> }).persistLayout();

  function mount() {
    const deckEl = document.createElement("div");
    const listEl = document.createElement("div");
    document.body.append(deckEl, listEl);
    return { deckEl, listEl, deck: new Deck(deckEl, listEl, () => [WS as never]) };
  }
  const shown = (deckEl: HTMLElement) => deckEl.querySelector<HTMLElement>(".tile-name")!;

  it("renames a plainly launched tile to the transcript title", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    expect(shown(deckEl).textContent).toBe("session · relay");

    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    expect(shown(deckEl).title).toBe("Trace the retry budget");
  });

  it("carries the new name into the sidebar row and its aria-label", async () => {
    const { deck, listEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    const row = listEl.querySelector<HTMLElement>(".sess-row")!;
    expect(row.textContent).toContain("Trace the retry budget");
    expect(row.getAttribute("aria-label")).toContain("Trace the retry budget");
  });

  it("never overwrites a name from a tracker card", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([
      { sessionId: "s1", cwd: "/p", name: "☑ Fix the pill counter", workspaceId: "w" },
    ]);
    snapshots.mockResolvedValue({ s1: snap("Pill counter bug") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("☑ Fix the pill counter");
  });

  it("never overwrites a scheduled scenario's name", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "⚡ Daily digest", workspaceId: "w",
      scheduledSkillId: "sk-digest",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Summarise yesterday") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("⚡ Daily digest");
  });

  it("follows the latest transcript title while no hand-typed name exists", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("First topic") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("First topic");

    snapshots.mockResolvedValue({ s1: snap("Second topic") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("Second topic");
  });

  it("leaves the name alone when the snapshot call fails", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);

    snapshots.mockRejectedValue(new Error("ipc down"));
    git.mockResolvedValue({ branch: "main", dirty: false });
    await tick(deck);

    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    // The halves of the tick are isolated: the git badge still filled in.
    expect(deckEl.querySelector(".tile-git")!.classList.contains("hidden")).toBe(false);
  });

  it("does not write to a tile removed while the call was in flight", async () => {
    const { deck, deckEl } = mount();
    await deck.launch(WS as never, null);
    const el = shown(deckEl);
    snapshots.mockImplementation(async () => {
      (deck as unknown as { remove(s: string): void }).remove("s1");
      return { s1: snap("Trace the retry budget") } as never;
    });
    await tick(deck);
    expect(el.textContent).toBe("session · relay");
  });

  it("does not persist the layout when only the transcript title changed", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    save.mockClear();
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(save).not.toHaveBeenCalled();
  });

  it("skips saving when the serialized layout has not changed", async () => {
    const { deck } = mount();
    await deck.launch(WS as never, null);
    expect(save).toHaveBeenCalledTimes(1);
    // The spawn, restart and remove bursts all end in this call; only the first
    // of them has anything to write.
    await persist(deck);
    await persist(deck);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("stays dirty when the write fails, so the next attempt tries again", async () => {
    const { deck } = mount();
    save.mockRejectedValueOnce(new Error("disk full"));
    await deck.launch(WS as never, null);
    expect(save).toHaveBeenCalledTimes(1);
    await persist(deck);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("restores a hand-typed name and keeps it against a new transcript title", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder", userName: "the one I must not close",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("the one I must not close");
  });

  it("restores a legacy entry's name as a context name", async () => {
    // Nothing on disk tells `☑ <card>` from `session · foo` in a file written
    // before `nameKind` existed, and leaving a recognised name alone is the
    // safer of the two mistakes.
    const { deck, deckEl } = mount();
    await deck.restore([{ sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w" }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("session · relay");
  });

  /* --- the inline editor ------------------------------------------------- */

  const editor = (deckEl: HTMLElement) =>
    deckEl.querySelector<HTMLInputElement>(".tile-name-input");
  const pencil = (deckEl: HTMLElement) =>
    deckEl.querySelector<HTMLButtonElement>('[data-action="pencil"]')!;
  const key = (input: HTMLInputElement, k: string) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  async function tileToRename() {
    const m = mount();
    await m.deck.launch(WS as never, null);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(m.deck);
    save.mockClear();
    return m;
  }

  it("the pencil opens the editor on the name that is showing", async () => {
    const { deckEl } = await tileToRename();
    expect(editor(deckEl)).toBeNull();
    pencil(deckEl).click();
    expect(editor(deckEl)!.value).toBe("Trace the retry budget");
    expect(editor(deckEl)!.getAttribute("aria-label")).toBe("Session name");
    expect(editor(deckEl)!.maxLength).toBe(120);
  });

  it("commits on Enter and persists at once", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "the noisy one";
    key(input, "Enter");

    expect(editor(deckEl)).toBeNull();
    expect(shown(deckEl).textContent).toBe("the noisy one");
    expect(shown(deckEl).title).toBe("the noisy one");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0][0]).toMatchObject({ userName: "the noisy one" });
  });

  it("cancels on Escape, leaving the name and the file alone", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "typed but not meant";
    key(input, "Escape");

    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    expect(save).not.toHaveBeenCalled();
  });

  it("commits on blur — clicking a terminal must not discard the typing", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "committed by blur";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(shown(deckEl).textContent).toBe("committed by blur");
  });

  it("does not commit twice when blur follows Enter", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "once";
    key(input, "Enter");
    input.dispatchEvent(new FocusEvent("blur"));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("opening a second editor commits the first", async () => {
    const m = mount();
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("s1" as never)
      .mockReturnValueOnce("s2" as never);
    await m.deck.launch(WS as never, null);
    await m.deck.launch(WS as never, null);
    const [first, second] = [...m.deckEl.querySelectorAll<HTMLElement>(".tile")];

    first.querySelector<HTMLButtonElement>('[data-action="pencil"]')!.click();
    first.querySelector<HTMLInputElement>(".tile-name-input")!.value = "the first one";
    second.querySelector<HTMLButtonElement>('[data-action="pencil"]')!.click();

    expect(first.querySelector(".tile-name-input")).toBeNull();
    expect(first.querySelector(".tile-name")!.textContent).toBe("the first one");
    expect(second.querySelector(".tile-name-input")).not.toBeNull();
  });

  it("stores a 120-character single-line name for a 300-character paste", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    // Past `maxlength`, which a paste or an IME can be. A newline cannot appear
    // here at all \u2014 a text input's own value sanitisation strips CR and LF
    // before anything of ours sees them \u2014 so the tab is what stands in for it,
    // and `normaliseName` covers the rest below.
    input.value = "\u0434\u0432\u0430\t\u0441\u043b\u043e\u0432\u0430 " + "\u044f".repeat(300);
    key(input, "Enter");

    const name = shown(deckEl).textContent!;
    expect([...name].length).toBe(120);
    expect(/\s\s|[\r\n\t]/.test(name)).toBe(false);
    expect(name.startsWith("\u0434\u0432\u0430 \u0441\u043b\u043e\u0432\u0430 ")).toBe(true);
  });

  it("clearing the field restores the automatic name", async () => {
    // The entire undo story: there is no other way back, and none is needed.
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const first = editor(deckEl)!;
    first.value = "the noisy one";
    key(first, "Enter");
    expect(shown(deckEl).textContent).toBe("the noisy one");
    // `persistLayout` records what it wrote only once the write resolves, and
    // nothing in the app renames a tile twice inside one microtask.
    await Promise.resolve();

    pencil(deckEl).click();
    const second = editor(deckEl)!;
    second.value = "   ";
    key(second, "Enter");
    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    const last = save.mock.calls[save.mock.calls.length - 1];
    expect(last[0][0]).not.toHaveProperty("userName");
  });

  it("typing the automatic name stores no hand-typed name", async () => {
    const { deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "Trace the retry budget";
    key(input, "Enter");
    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
    // Nothing was stored, so there is nothing to write: the layout is byte for
    // byte what it already was.
    expect(save).not.toHaveBeenCalled();
  });

  it("renameActive opens the editor on the tile holding the keyboard", async () => {
    const m = mount();
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("s1" as never)
      .mockReturnValueOnce("s2" as never);
    await m.deck.launch(WS as never, null);
    await m.deck.launch(WS as never, null);
    const [first, second] = [...m.deckEl.querySelectorAll<HTMLElement>(".tile")];
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    m.deck.renameActive();
    expect(first.querySelector(".tile-name-input")).not.toBeNull();
    expect(second.querySelector(".tile-name-input")).toBeNull();
  });

  it("renameActive with no active session does nothing", async () => {
    const { deck, deckEl } = mount();
    expect(() => deck.renameActive()).not.toThrow();
    expect(deckEl.querySelector(".tile-name-input")).toBeNull();
  });

  it("a tick arriving mid-edit does not repaint the input, but is visible after", async () => {
    const { deck, deckEl } = await tileToRename();
    pencil(deckEl).click();
    const input = editor(deckEl)!;
    input.value = "half-typed";

    snapshots.mockResolvedValue({ s1: snap("A newer topic") } as never);
    await tick(deck);
    expect(input.value).toBe("half-typed");

    key(input, "Escape");
    expect(shown(deckEl).textContent).toBe("A newer topic");
  });

  it("restores a placeholder-marked entry so the transcript title can take over", async () => {
    const { deck, deckEl } = mount();
    await deck.restore([{
      sessionId: "s1", cwd: "/p", name: "session · relay", workspaceId: "w",
      nameKind: "placeholder",
    }]);
    snapshots.mockResolvedValue({ s1: snap("Trace the retry budget") } as never);
    await tick(deck);
    expect(shown(deckEl).textContent).toBe("Trace the retry budget");
  });
});
