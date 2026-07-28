// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { BoardView, emptyStateMessage } from "../src/board";
import type { BoardConfig, MigrationOffer, Task } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }, { id: "idea", label: "idea" }],
};

const handlers = {
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(),
};

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
    const m = emptyStateMessage({ canCreate: true, canResolve: true, statuses: [], board: CFG, boardError: null },
      "the task folder is unreachable: /home/u/typo");
    expect(m.text).toContain("/home/u/typo");
  });
});

describe("BoardView", () => {
  const caps = { canCreate: true, canResolve: true, statuses: ["open", "done"], board: CFG, boardError: null };

  it("renders titles as text, never as markup", () => {
    const v = new BoardView({ ...handlers });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ title: "<img src=x onerror=alert(1)>" })],
    });
    expect(v.mount.querySelector("img")).toBeNull();
    expect(v.mount.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("marks a card whose session is alive as in progress", () => {
    const v = new BoardView({ ...handlers });
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
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ origin: "session" })] });
    expect(v.mount.querySelector(".tk-card")!.textContent).toContain("session");
  });

  it("shows damaged and conflicting cards with their reason", () => {
    const v = new BoardView({ ...handlers });
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
    const v = new BoardView({ ...handlers });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "no project field", conflict: false })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.querySelector(".tk-done")).toBeNull();
    expect(el.querySelector(".tk-run")).toBeNull();
  });

  it("hides create and close when the provider says it cannot", () => {
    const v = new BoardView({ ...handlers });
    v.render({
      project: "deck", caps: { canCreate: false, canResolve: false, statuses: [], board: CFG, boardError: null },
      error: null, links: [], tasks: [card()],
    });
    expect(v.mount.querySelector(".tk-new")).toBeNull();
    expect(v.mount.querySelector(".tk-done")).toBeNull();
  });

  it("reports foreign-project cards instead of hiding them", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card({ project: "other" })] });
    expect(v.mount.textContent).toContain("other");
  });

  it("calls back with the card when ▶ is clicked", () => {
    let launched: string | null = null;
    const v = new BoardView({ ...handlers, onLaunch: (t) => { launched = t.id; } });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    v.mount.querySelector<HTMLButtonElement>(".tk-run")!.click();
    expect(launched).toBe("01AAA");
  });

  // Fix round 1: name-from-content wins over `title` for a button with visible
  // glyph content, so assistive tech would announce "▶"/"✓" without this.
  it("gives ▶ and ✓ an aria-label, since their visible glyph is not a name", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    expect(v.mount.querySelector(".tk-run")!.getAttribute("aria-label")).toBe("Start a session from this task");
    expect(v.mount.querySelector(".tk-done")!.getAttribute("aria-label")).toBe("Close this task");
  });
});

describe("BoardView migration banner", () => {
  const offer = (over: Partial<MigrationOffer> = {}): MigrationOffer => ({
    from: "/home/u/vault/Tasks",
    to: "/home/u/vault/cowork-deck",
    moving: 7,
    leavingForeign: 0,
    leavingDamaged: 0,
    renamingProject: false,
    ...over,
  });

  const state = (migration: MigrationOffer | null) => ({
    project: "deck",
    caps: { canCreate: true, canResolve: true, statuses: ["open", "done"], board: CFG, boardError: null },
    error: null,
    tasks: [],
    links: [],
    migration,
  });

  it("says how many cards are at the old location, and where it is", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer()) as never);
    const banner = v.mount.querySelector(".tk-migrate")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("7");
    expect(banner.textContent).toContain("/home/u/vault/Tasks");
  });

  it("spells out that leaving them hides them, because it is not obvious", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer()) as never);
    // Dismissing does not delete anything, but the cards do stop being visible.
    // A button that only says "Leave them" would not convey that.
    expect(v.mount.querySelector(".tk-migrate-consequence")).not.toBeNull();
  });

  it("mentions other projects' cards only when some are staying", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(offer({ leavingForeign: 2 })) as never);
    expect(v.mount.querySelector(".tk-migrate-foreign")!.textContent).toContain("2");

    const v2 = new BoardView({ ...handlers });
    v2.render(state(offer()) as never);
    expect(v2.mount.querySelector(".tk-migrate-foreign")).toBeNull();
  });

  it("has no banner when there is nothing to move", () => {
    const v = new BoardView({ ...handlers });
    v.render(state(null) as never);
    expect(v.mount.querySelector(".tk-migrate")).toBeNull();
  });

  it("renders the banner even when the destination is unreachable", () => {
    // The two explain each other: the destination does not exist because its
    // parent does not.
    //
    // `caps` stays non-null on purpose. `tasks_capabilities` returns null only
    // for "no tracker configured" — it never touches the disk — so a configured
    // root that cannot be read yields real capabilities plus an error from
    // `tasks_list`. Setting caps to null here would test the no-tracker state
    // instead, where `emptyStateMessage` never reaches the error at all.
    const v = new BoardView({ ...handlers });
    v.render({ ...state(offer()), error: "the task folder is unreachable: /x" } as never);
    expect(v.mount.querySelector(".tk-migrate")).not.toBeNull();
    expect(v.mount.textContent).toContain("unreachable");
  });

  it("wires the two buttons to their handlers", () => {
    const onMigrate = vi.fn();
    const onDismissMigration = vi.fn();
    const v = new BoardView({ ...handlers, onMigrate, onDismissMigration });
    v.render(state(offer()) as never);
    v.mount.querySelector<HTMLButtonElement>(".tk-migrate-go")!.click();
    v.mount.querySelector<HTMLButtonElement>(".tk-migrate-skip")!.click();
    expect(onMigrate).toHaveBeenCalledTimes(1);
    expect(onDismissMigration).toHaveBeenCalledTimes(1);
  });
});
