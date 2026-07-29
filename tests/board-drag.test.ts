// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BoardView } from "../src/board";
import type { BoardConfig, ProviderCapabilities, StepId, Task } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "backlog" },
    { id: "todo", label: "todo" },
    { id: "doing", label: "doing", working: true },
    { id: "done", label: "done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }],
};

const caps: ProviderCapabilities = {
  canCreate: true, canResolve: true, statuses: ["backlog", "todo", "doing", "done"], board: CFG, boardError: null,
};

// The title doubles as the id: a plain, unique string that cardEl() can find
// again without the code under test having to expose ids in the DOM.
function card(over: Partial<Task> = {}): Task {
  const id = over.id ?? "a";
  return {
    id, title: id, kind: "task", status: "todo", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "body", path: `/r/${id}.md`, damaged: null, conflict: false, ...over,
  };
}

const onMove = vi.fn();
const handlers = {
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(), onOpen: vi.fn(), onMove,
};

let view: BoardView;

beforeEach(() => {
  onMove.mockClear();
  view = new BoardView({ ...handlers });
});

function render(tasks: Task[]) {
  view.render({ project: "deck", caps, error: null, links: [], tasks });
}

function cardEl(id: string): HTMLElement {
  const open = [...view.mount.querySelectorAll<HTMLElement>(".tk-card-open")]
    .find((b) => b.textContent === id)!;
  return open.closest<HTMLElement>(".tk-card")!;
}

function btn(id: string, sel: string): HTMLElement | null {
  return cardEl(id).querySelector<HTMLElement>(sel);
}

// jsdom has no DataTransfer, so a minimal stub over a Map stands in for it —
// and no DragEvent either, so a plain Event carries it instead.
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { store.set(type, value); },
    getData: (type: string) => store.get(type) ?? "",
  } as unknown as DataTransfer;
}

function fireDrag(type: string, target: HTMLElement, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
  event.dataTransfer = dataTransfer;
  target.dispatchEvent(event);
}

function dragCardToElement(id: string, target: HTMLElement) {
  const dt = makeDataTransfer();
  fireDrag("dragstart", cardEl(id), dt);
  fireDrag("dragover", target, dt);
  fireDrag("drop", target, dt);
}

function dragCardTo(id: string, step: StepId) {
  dragCardToElement(id, view.mount.querySelector<HTMLElement>(`.tk-col[data-step="${step}"]`)!);
}

describe("BoardView — dragging and the keyboard equivalent", () => {
  it("gives a card in a known step both arrows in the middle of the board", () => {
    render([card({ id: "a", status: "todo" })]);
    expect(btn("a", ".tk-prev")!.getAttribute("aria-label")).toBe("Move to the previous step");
    expect(btn("a", ".tk-next")!.getAttribute("aria-label")).toBe("Move to the next step");
  });

  it("omits the back arrow in the first step and the forward arrow in the last", () => {
    render([card({ id: "a", status: "backlog" }), card({ id: "z", status: "done" })]);
    expect(btn("a", ".tk-prev")).toBeNull();
    expect(btn("a", ".tk-next")).not.toBeNull();
    expect(btn("z", ".tk-next")).toBeNull();
    expect(btn("z", ".tk-prev")).not.toBeNull();
  });

  it("gives a card in an unknown step no arrows at all", () => {
    // It has no neighbours: the modal's select is how it moves.
    render([card({ id: "x", status: "legacy" })]);
    expect(btn("x", ".tk-prev")).toBeNull();
    expect(btn("x", ".tk-next")).toBeNull();
  });

  it("asks for the neighbouring step when an arrow is pressed", () => {
    render([card({ id: "a", status: "todo" })]);
    btn("a", ".tk-next")!.click();
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "doing");
    btn("a", ".tk-prev")!.click();
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "backlog");
  });

  it("makes cards draggable and columns drop targets carrying their step", () => {
    render([card({ id: "a", status: "todo" })]);
    expect(cardEl("a").draggable).toBe(true);
    const cols = [...view.mount.querySelectorAll<HTMLElement>(".tk-col[data-step]")];
    expect(cols.map((c) => c.dataset.step)).toEqual(["backlog", "todo", "doing", "done"]);
  });

  it("moves the card on a drop into another column", () => {
    render([card({ id: "a", status: "todo" })]);
    dragCardTo("a", "done");
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "done");
  });

  it("ignores a drop into the column the card is already in", () => {
    render([card({ id: "a", status: "todo" })]);
    dragCardTo("a", "todo");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("does not accept a drop into the unknown column", () => {
    render([card({ id: "a", status: "todo" }), card({ id: "x", status: "legacy" })]);
    const unknown = view.mount.querySelector<HTMLElement>(".tk-col-unknown")!;
    expect(unknown.dataset.step).toBeUndefined();
    dragCardToElement("a", unknown);
    expect(onMove).not.toHaveBeenCalled();
  });
});
