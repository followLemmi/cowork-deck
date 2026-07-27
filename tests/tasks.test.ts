import { describe, it, expect } from "vitest";
import {
  taskPrompt, derivedStatus, liveSessionForTask, boardColumns, kindLabel,
  type TaskSessionLink,
} from "../src/tasks";
import type { Task } from "../src/ipc";

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
    const p = taskPrompt(card());
    expect(p).toContain("The pill keeps blinking");
    expect(p).toContain("bug");
    expect(p).toContain("Repro: three workspaces.");
    expect(p).toContain("01AAA");
    expect(p).toContain("COWORK_TASK_BIN");
  });

  it("works for a card with no body", () => {
    const p = taskPrompt(card({ body: "" }));
    expect(p).toContain("The pill keeps blinking");
    expect(p).not.toContain("undefined");
    expect(p.trim().endsWith(" ")).toBe(false);
  });
});

describe("derivedStatus", () => {
  const links = (l: Partial<TaskSessionLink>[]): TaskSessionLink[] =>
    l.map((x) => ({ session: "s", taskId: "01AAA", state: "working", ...x }));

  it("is working while a session launched from the card is alive", () => {
    expect(derivedStatus(card(), links([{ state: "working" }]))).toBe("working");
    expect(derivedStatus(card(), links([{ state: "waitingInput" }]))).toBe("working");
  });

  it("falls back to open when that session died", () => {
    expect(derivedStatus(card(), links([{ state: "ended" }]))).toBe("open");
    expect(derivedStatus(card(), links([{ state: "error" }]))).toBe("open");
    expect(derivedStatus(card(), [])).toBe("open");
  });

  it("ignores sessions belonging to other cards", () => {
    expect(derivedStatus(card(), links([{ taskId: "01OTHER", state: "working" }]))).toBe("open");
    expect(derivedStatus(card(), links([{ taskId: undefined, state: "working" }]))).toBe("open");
  });

  it("done always wins — a stray live session cannot reopen a closed card", () => {
    expect(derivedStatus(card({ status: "done" }), links([{ state: "working" }]))).toBe("done");
  });

  it("is working if any of several linked sessions is alive", () => {
    const l = links([{ session: "a", state: "ended" }, { session: "b", state: "working" }]);
    expect(derivedStatus(card(), l)).toBe("working");
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
  it("splits open and done, newest first", () => {
    const cards = [
      card({ id: "a", created: "2026-07-01T00:00:00Z" }),
      card({ id: "b", created: "2026-07-05T00:00:00Z" }),
      card({ id: "c", status: "done", resolved: "2026-07-02T00:00:00Z" }),
      card({ id: "d", status: "done", resolved: "2026-07-06T00:00:00Z" }),
    ];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["b", "a"]);
    expect(b.done.map((t) => t.id)).toEqual(["d", "c"]);
    expect(b.doneHidden).toBe(0);
  });

  it("caps the done column and reports how many are hidden", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      card({ id: `d${i}`, status: "done", resolved: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const b = boardColumns(many, "deck", 20);
    expect(b.done).toHaveLength(20);
    expect(b.doneHidden).toBe(5);
  });

  it("lists foreign projects instead of hiding those cards without a trace", () => {
    const cards = [card({ id: "a" }), card({ id: "x", project: "other" }), card({ id: "y", project: "other" })];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["a"]);
    expect(b.foreign).toEqual([{ project: "other", count: 2 }]);
  });

  it("keeps damaged cards in the open column whatever their project says", () => {
    const cards = [card({ id: "bad", project: "", damaged: "no project field" })];
    const b = boardColumns(cards, "deck");
    expect(b.open.map((t) => t.id)).toEqual(["bad"]);
    expect(b.foreign).toEqual([]);
  });

  it("sorts cards with no timestamp last instead of throwing", () => {
    const cards = [card({ id: "a", created: "" }), card({ id: "b", created: "2026-07-05T00:00:00Z" })];
    expect(boardColumns(cards, "deck").open.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("kindLabel", () => {
  it("is Russian, matching the rest of the UI", () => {
    expect(kindLabel("bug")).toBe("bug");
    expect(kindLabel("task")).toBe("task");
    expect(kindLabel("idea")).toBe("idea");
  });
});
