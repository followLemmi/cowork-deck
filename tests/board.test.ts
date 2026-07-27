// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { BoardView, emptyStateMessage } from "../src/board";
import type { Task } from "../src/ipc";

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "Пилюля мигает", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "тело", path: "/r/01AAA-pill.md", damaged: null, conflict: false, ...over,
  };
}

describe("emptyStateMessage", () => {
  it("invites configuration when no tracker is set up — that is not an error", () => {
    const m = emptyStateMessage(null, null);
    expect(m.text).toContain("не настроен");
    expect(m.canConfigure).toBe(true);
  });

  it("shows the failing path verbatim so a typo is findable", () => {
    const m = emptyStateMessage({ canCreate: true, canResolve: true, statuses: [] },
      "каталог задач недоступен: /home/u/опечатка");
    expect(m.text).toContain("/home/u/опечатка");
  });
});

describe("BoardView", () => {
  const caps = { canCreate: true, canResolve: true, statuses: ["open", "done"] };

  it("renders titles as text, never as markup", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ title: "<img src=x onerror=alert(1)>" })],
    });
    expect(v.mount.querySelector("img")).toBeNull();
    expect(v.mount.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("marks a card whose session is alive as в работе", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null,
      links: [{ session: "s1", taskId: "01AAA", state: "working" }],
      tasks: [card()],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("working")).toBe(true);
    expect(el.querySelector(".tk-run")).toBeNull(); // повторный запуск не предлагаем
  });

  it("flags a bot-filed card so agent work is never silent", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ origin: "session" })] });
    expect(v.mount.querySelector(".tk-card")!.textContent).toContain("сессия");
  });

  it("shows damaged and conflicting cards with their reason", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "нет поля status", conflict: true })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("damaged")).toBe(true);
    expect(el.textContent).toContain("нет поля status");
    expect(el.textContent).toContain("id");
    expect(el.querySelector(".tk-done")).toBeNull(); // закрывать конфликтную нельзя
  });

  it("hides create and close when the provider says it cannot", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps: { canCreate: false, canResolve: false, statuses: [] },
      error: null, links: [], tasks: [card()],
    });
    expect(v.mount.querySelector(".tk-new")).toBeNull();
    expect(v.mount.querySelector(".tk-done")).toBeNull();
  });

  it("reports foreign-project cards instead of hiding them", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ project: "other" })] });
    expect(v.mount.textContent).toContain("other");
  });

  it("calls back with the card when ▶ is clicked", () => {
    let launched: string | null = null;
    const v = new BoardView({
      onLaunch: (t) => { launched = t.id; }, onResolve: () => {}, onNew: () => {}, onConfigure: () => {},
    });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    v.mount.querySelector<HTMLButtonElement>(".tk-run")!.click();
    expect(launched).toBe("01AAA");
  });

  // Fix round 1: name-from-content wins over `title` for a button with visible
  // glyph content, so assistive tech would announce "▶"/"✓" without this.
  it("gives ▶ and ✓ an aria-label, since their visible glyph is not a name", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    expect(v.mount.querySelector(".tk-run")!.getAttribute("aria-label")).toBe("Запустить сессию из задачи");
    expect(v.mount.querySelector(".tk-done")!.getAttribute("aria-label")).toBe("Закрыть задачу");
  });
});
