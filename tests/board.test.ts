// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { BoardView, emptyStateMessage } from "../src/board";
import type { Task } from "../src/ipc";

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "The pill keeps blinking", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "body", path: "/r/01AAA-pill.md", damaged: null, conflict: false, ...over,
  };
}

describe("emptyStateMessage", () => {
  it("invites configuration when no tracker is set up — that is not an error", () => {
    const m = emptyStateMessage(null, null);
    expect(m.text).toContain("No task tracker is configured");
    expect(m.canConfigure).toBe(true);
  });

  it("shows the failing path verbatim so a typo is findable", () => {
    const m = emptyStateMessage({ canCreate: true, canResolve: true, statuses: [] },
      "the task folder is unreachable: /home/u/typo");
    expect(m.text).toContain("/home/u/typo");
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

  it("marks a card whose session is alive as in progress", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null,
      links: [{ session: "s1", taskId: "01AAA", state: "working" }],
      tasks: [card()],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("working")).toBe(true);
    expect(el.querySelector(".tk-run")).toBeNull(); // no offer to launch it a second time
  });

  it("flags a bot-filed card so agent work is never silent", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ origin: "session" })] });
    expect(v.mount.querySelector(".tk-card")!.textContent).toContain("session");
  });

  it("shows damaged and conflicting cards with their reason", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "no status field", conflict: true })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("damaged")).toBe(true);
    expect(el.textContent).toContain("no status field");
    expect(el.textContent).toContain("id");
    expect(el.querySelector(".tk-done")).toBeNull(); // a conflicting card must not be closed
  });

  // C1: an ordinary Obsidian note can carry an `id:` for unrelated reasons and
  // parse as "damaged" (title from the filename, status defaulted to open).
  // Clicking ✓ on it would rewrite the user's own file — see fs.rs::resolve.
  it("never renders ✓ (or ▶) for a damaged card, even without a conflict", () => {
    const v = new BoardView({ onLaunch: () => {}, onResolve: () => {}, onNew: () => {}, onConfigure: () => {} });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "no project field", conflict: false })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.querySelector(".tk-done")).toBeNull();
    expect(el.querySelector(".tk-run")).toBeNull();
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
    expect(v.mount.querySelector(".tk-run")!.getAttribute("aria-label")).toBe("Start a session from this task");
    expect(v.mount.querySelector(".tk-done")!.getAttribute("aria-label")).toBe("Close this task");
  });
});
