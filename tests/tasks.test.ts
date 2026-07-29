import { describe, it, expect } from "vitest";
import {
  taskPrompt, derivedStatus, liveSessionForTask, boardColumns, isStale, kindLabel,
  type TaskSessionLink,
} from "../src/tasks";
import type { BoardConfig, Task } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }, { id: "idea", label: "idea" }],
};

const CFG4: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "The pill keeps blinking", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "Repro: three workspaces.", path: "/r/01AAA-pill.md", damaged: null, conflict: false,
    ...over,
  };
}

describe("taskPrompt", () => {
  it("carries title, kind, body and the close instruction", () => {
    const p = taskPrompt(card(), CFG);
    expect(p).toContain("The pill keeps blinking");
    expect(p).toContain("bug");
    expect(p).toContain("Repro: three workspaces.");
    expect(p).toContain("01AAA");
    expect(p).toContain("COWORK_TASK_BIN");
  });

  it("works for a card with no body", () => {
    const p = taskPrompt(card({ body: "" }), CFG);
    expect(p).toContain("The pill keeps blinking");
    expect(p).not.toContain("undefined");
    expect(p.trim().endsWith(" ")).toBe(false);
  });

  it("names the current step, lists the configured steps, and still closes with done", () => {
    const p = taskPrompt(card({ status: "doing" }), CFG4);
    expect(p).toContain('"doing"');
    expect(p).toContain("backlog, todo, doing, done");
    expect(p).toContain(`"$COWORK_TASK_BIN" done 01AAA`);
  });

  it("omits the steps line entirely for a configuration with no steps", () => {
    const noSteps: BoardConfig = { v: 1, steps: [], kinds: CFG.kinds };
    const p = taskPrompt(card(), noSteps);
    expect(p).not.toContain("steps are");
    expect(p).toContain(`"$COWORK_TASK_BIN" done 01AAA`);
  });
});

describe("derivedStatus", () => {
  const links = (l: Partial<TaskSessionLink>[]): TaskSessionLink[] =>
    l.map((x) => ({ session: "s", taskId: "01AAA", state: "working", ...x }));

  it("is working while a session launched from the card is alive", () => {
    expect(derivedStatus(card(), links([{ state: "working" }]), CFG)).toBe("working");
    expect(derivedStatus(card(), links([{ state: "waitingInput" }]), CFG)).toBe("working");
  });

  it("falls back to open when that session died", () => {
    expect(derivedStatus(card(), links([{ state: "ended" }]), CFG)).toBe("open");
    expect(derivedStatus(card(), links([{ state: "error" }]), CFG)).toBe("open");
    expect(derivedStatus(card(), [], CFG)).toBe("open");
  });

  it("ignores sessions belonging to other cards", () => {
    expect(derivedStatus(card(), links([{ taskId: "01OTHER", state: "working" }]), CFG)).toBe("open");
    expect(derivedStatus(card(), links([{ taskId: undefined, state: "working" }]), CFG)).toBe("open");
  });

  it("done always wins — a stray live session cannot reopen a closed card", () => {
    expect(derivedStatus(card({ status: "done" }), links([{ state: "working" }]), CFG)).toBe("done");
  });

  it("is working if any of several linked sessions is alive", () => {
    const l = links([{ session: "a", state: "ended" }, { session: "b", state: "working" }]);
    expect(derivedStatus(card(), l, CFG)).toBe("working");
  });
});

describe("liveSessionForTask", () => {
  it("finds an idle session too — it is alive and must not be duplicated", () => {
    const l: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "idle" }];
    expect(liveSessionForTask("01AAA", l)).toBe("s1");
  });

  it("ignores dead sessions so the card can be launched again", () => {
    const l: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "ended" }];
    expect(liveSessionForTask("01AAA", l)).toBeNull();
  });
});

describe("launch guard", () => {
  it("an alive session for the card means focus, not a second launch", () => {
    const links: TaskSessionLink[] = [{ session: "s1", taskId: "01AAA", state: "waitingInput" }];
    expect(liveSessionForTask("01AAA", links)).toBe("s1");
  });
});

describe("boardColumns", () => {
  it("returns one column per configured step, in configuration order", () => {
    const cols = boardColumns([], "deck", CFG4);
    expect(cols.columns.map((c) => c.step.id)).toEqual(["backlog", "todo", "doing", "done"]);
  });

  it("places each card in the column its status names", () => {
    const cols = boardColumns(
      [card({ id: "a", status: "backlog" }), card({ id: "b", status: "doing" })], "deck", CFG4);
    const at = (id: string) => cols.columns.find((c) => c.step.id === id)!.tasks.map((t) => t.id);
    expect(at("backlog")).toEqual(["a"]);
    expect(at("doing")).toEqual(["b"]);
    expect(at("todo")).toEqual([]);
  });

  it("collects a card whose step the configuration does not know", () => {
    const cols = boardColumns([card({ id: "x", status: "legacy" })], "deck", CFG4);
    expect(cols.unknown.map((t) => t.id)).toEqual(["x"]);
    // Not silently dropped into some column: it would look like it moved.
    expect(cols.columns.every((c) => c.tasks.length === 0)).toBe(true);
  });

  it("caps a terminal column and counts what it hid", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      card({ id: `d${i}`, status: "done", resolved: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const done = boardColumns(many, "deck", CFG4, 20).columns.find((c) => c.step.id === "done")!;
    expect(done.tasks).toHaveLength(20);
    expect(done.hidden).toBe(5);
  });

  it("never caps a non-terminal column", () => {
    const many = Array.from({ length: 25 }, (_, i) => card({ id: `t${i}`, status: "todo" }));
    const todo = boardColumns(many, "deck", CFG4, 20).columns.find((c) => c.step.id === "todo")!;
    // A card in `todo` hidden behind a limit is a lost task.
    expect(todo.tasks).toHaveLength(25);
    expect(todo.hidden).toBe(0);
  });

  it("sorts a card with no timestamp last instead of throwing", () => {
    // Carried over from the block this one replaces: `byTimeDesc` survives the
    // rewrite, and so must its empty-timestamp case.
    const cols = boardColumns(
      [card({ id: "a", status: "todo", created: "" }),
       card({ id: "b", status: "todo", created: "2026-07-05T00:00:00Z" })], "deck", CFG4);
    expect(cols.columns.find((c) => c.step.id === "todo")!.tasks.map((t) => t.id))
      .toEqual(["b", "a"]);
  });

  it("sorts a terminal column by resolved and the others by created, newest first", () => {
    const cols = boardColumns([
      card({ id: "old", status: "todo", created: "2026-01-01T00:00:00Z" }),
      card({ id: "new", status: "todo", created: "2026-07-01T00:00:00Z" }),
      card({ id: "r1", status: "done", resolved: "2026-01-01T00:00:00Z" }),
      card({ id: "r2", status: "done", resolved: "2026-07-01T00:00:00Z" }),
    ], "deck", CFG4);
    const at = (id: string) => cols.columns.find((c) => c.step.id === id)!.tasks.map((t) => t.id);
    expect(at("todo")).toEqual(["new", "old"]);
    expect(at("done")).toEqual(["r2", "r1"]);
  });

  it("counts other projects' cards instead of showing them", () => {
    // Two of one project, plus a local card: the count is the only trace a card
    // in a shared vault leaves when it is not shown, so the aggregation has to
    // be asserted, not just the presence of a name.
    const cols = boardColumns([
      card({ id: "f1", project: "other" }), card({ id: "f2", project: "other" }),
      card({ id: "mine", status: "todo" }),
    ], "deck", CFG4);
    expect(cols.foreign).toEqual([{ project: "other", count: 2 }]);
    expect(cols.columns.find((c) => c.step.id === "todo")!.tasks.map((t) => t.id)).toEqual(["mine"]);
  });

  it("keeps a damaged card whatever its project says", () => {
    // It may be damaged *because* the project field is missing.
    const cols = boardColumns(
      [card({ id: "d", project: "", status: "todo", damaged: "no project field" })], "deck", CFG4);
    expect(cols.columns.find((c) => c.step.id === "todo")!.tasks.map((t) => t.id)).toEqual(["d"]);
    // And is not *also* counted as foreign: it renders, so a banner saying a card
    // named a different project would be a second, false statement about it.
    expect(cols.foreign).toEqual([]);
  });
});

describe("isStale", () => {
  it("is true for a card in the working step with no live session", () => {
    expect(isStale(card({ id: "a", status: "doing" }), [], CFG4)).toBe(true);
  });
  it("is false while a session is alive on it", () => {
    expect(isStale(card({ id: "a", status: "doing" }),
      [{ session: "s", taskId: "a", state: "working" }], CFG4)).toBe(false);
  });
  it("is false for a card outside the working step", () => {
    expect(isStale(card({ id: "a", status: "todo" }), [], CFG4)).toBe(false);
  });
  it("is false when no step is marked working", () => {
    const cfg = { ...CFG4, steps: CFG4.steps.map((s) => ({ ...s, working: false })) };
    expect(isStale(card({ id: "a", status: "doing" }), [], cfg)).toBe(false);
  });
});

describe("kindLabel", () => {
  it("re-exports the board-config reader, so the board has one import", () => {
    expect(kindLabel(CFG, "bug")).toBe("bug");
    expect(kindLabel(CFG, "task")).toBe("task");
    expect(kindLabel(CFG, "idea")).toBe("idea");
  });
});
