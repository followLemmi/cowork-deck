// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BoardView, emptyStateMessage } from "../src/board";
import type { BoardConfig, MigrationOffer, ProviderCapabilities, Task } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }, { id: "idea", label: "idea" }],
};

const handlers = {
  onLaunch: vi.fn(), onResolve: vi.fn(), onNew: vi.fn(), onConfigure: vi.fn(),
  onMigrate: vi.fn(), onDismissMigration: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(), onEditBoard: vi.fn(),
  onFixUnavailable: vi.fn(), onShowMore: vi.fn(),
};

function card(over: Partial<Task> = {}): Task {
  return {
    id: "01AAA", title: "The pill keeps blinking", kind: "bug", status: "open", project: "deck",
    created: "2026-07-27T10:00:00Z", resolved: null, origin: "human", session: null,
    body: "body", path: "/r/01AAA-pill.md", damaged: null, conflict: false, labels: [], ...over,
  };
}

describe("emptyStateMessage", () => {
  it("invites configuration when no tracker is set up — that is not an error", () => {
    const m = emptyStateMessage(null, null);
    expect(m.text).toContain("No task tracker is configured");
    expect(m.canConfigure).toBe(true);
  });

  it("shows the failing path verbatim so a typo is findable", () => {
    const m = emptyStateMessage(
      { canCreate: true, canResolve: true, statuses: [], board: CFG, boardError: null, boardEditable: true },
      "the task folder is unreachable: /home/u/typo");
    expect(m.text).toContain("/home/u/typo");
  });
});

describe("BoardView", () => {
  const caps = {
    canCreate: true, canResolve: true, statuses: ["open", "done"], board: CFG, boardError: null,
    boardEditable: true,
  };

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
    // p.tk-warn is gone (task 6): both reasons now live on .tk-warn-glyph's
    // aria-label/title rather than in the card's visible text. This card is
    // both damaged and conflicting, so it is the only place the conflict
    // message is asserted — keep both checks, not just the damaged one.
    const v = new BoardView({ ...handlers });
    v.render({
      project: "deck", caps, error: null, links: [],
      tasks: [card({ damaged: "no status field", conflict: true })],
    });
    const el = v.mount.querySelector(".tk-card")!;
    expect(el.classList.contains("damaged")).toBe(true);
    const warn = el.querySelector(".tk-warn-glyph")!.getAttribute("aria-label")!;
    expect(warn).toContain("no status field"); // the damaged reason
    // The only instruction the person gets for a state they must resolve by
    // hand — it has to name the id, not just say "a conflict exists".
    expect(warn).toContain("more than one file carries id 01AAA — fix it by hand");
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
      project: "deck",
      caps: {
        canCreate: false, canResolve: false, statuses: [], board: CFG, boardError: null,
        boardEditable: true,
      },
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

  it("opens the card when its title is clicked", () => {
    let opened: string | null = null;
    const v = new BoardView({ ...handlers, onOpen: (t) => { opened = t.id; } });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    const btn = v.mount.querySelector<HTMLButtonElement>(".tk-card-title")!;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-label")).toBe(`Open card: ${card().title}`);
    btn.click();
    expect(opened).toBe("01AAA");
  });

  it("does not open the card when an action button is clicked", () => {
    const onOpen = vi.fn();
    const v = new BoardView({ ...handlers, onOpen });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [card()] });
    v.mount.querySelector<HTMLButtonElement>(".tk-run")!.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  // A regression pin, and it passes against the code as it stands: the point is
  // that it keeps passing. A failure with nothing left to show must not become
  // empty columns plus "No tasks." — that reads as a folder with no cards in it,
  // and it would also drop the one button that can fix an unreachable root.
  // Task 21 stops `error` returning early so a GitHub board can keep its last
  // good list; a board with no list at all keeps this screen.
  it("shows the error and the way out when a failure leaves nothing to draw", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps, error: "the task folder is unreachable: /home/u/typo",
               links: [], tasks: [] });
    expect(v.mount.querySelector(".tk-empty")!.textContent).toContain("/home/u/typo");
    expect(v.mount.querySelector(".tk-configure")).not.toBeNull();
    expect(v.mount.querySelector(".tk-cols")).toBeNull();
  });

  // Not "only once a tracker is configured" — that stopped being the rule when the
  // GitHub source arrived: a GitHub tracker *is* configured and still gets no ⚙,
  // because there is no board.json behind it. The rule is `caps.boardEditable`, and
  // `caps: null` fails it for the plainer reason that there is no board at all.
  it("withholds ⚙ when there is no board to edit", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps: null, error: null, tasks: [], links: [] });
    expect(v.mount.querySelector(".tk-board-edit")).toBeNull();
  });

  it("wires ⚙ to onEditBoard, named by aria-label since its glyph is not one", () => {
    const onEditBoard = vi.fn();
    const v = new BoardView({ ...handlers, onEditBoard });
    v.render({ project: "deck", caps, error: null, links: [], tasks: [] });
    const btn = v.mount.querySelector<HTMLButtonElement>(".tk-board-edit")!;
    expect(btn.getAttribute("aria-label")).toBe("Configure the board");
    btn.click();
    expect(onEditBoard).toHaveBeenCalledTimes(1);
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

describe("BoardView columns from configuration", () => {
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

  function capsWith(cfg: BoardConfig): ProviderCapabilities {
    return {
      canCreate: true, canResolve: true, statuses: cfg.steps.map((s) => s.id), board: cfg,
      boardError: null, boardEditable: true,
    };
  }

  let view: BoardView;
  beforeEach(() => { view = new BoardView({ ...handlers }); });

  it("renders one column per step plus the unknown column only when it has cards", () => {
    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "todo" })], links: [] });
    expect(view.mount.querySelectorAll(".tk-col")).toHaveLength(4);
    expect(view.mount.querySelector(".tk-col-unknown")).toBeNull();

    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "legacy" })], links: [] });
    expect(view.mount.querySelectorAll(".tk-col")).toHaveLength(5);
    expect(view.mount.querySelector(".tk-col-unknown")).not.toBeNull();
    // Not a configured step: a drop on it must not be indistinguishable from a
    // drop on a real column through the same attribute (task 8's drop target).
    expect(view.mount.querySelector(".tk-col-unknown")!.hasAttribute("data-step")).toBe(false);
  });

  it("gives every card a meta row and an action row whatever its content", () => {
    // This is what makes the fixed height hold: the rows are always there, so
    // they sit at the same offset in a short card and a long one.
    view.render({ project: "deck", caps: capsWith(CFG4), error: null, tasks: [
      card({ id: "short", title: "T", status: "todo" }),
      card({ id: "long", title: "A ".repeat(60), status: "todo", damaged: "no created field" }),
    ], links: [] });
    for (const el of view.mount.querySelectorAll(".tk-card")) {
      expect(el.querySelector(".tk-meta")).not.toBeNull();
      expect(el.querySelector(".tk-acts")).not.toBeNull();
    }
  });

  it("shows damage as a glyph on the card, not as a paragraph", () => {
    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "todo", damaged: "no created field" })], links: [] });
    const warn = view.mount.querySelector(".tk-warn-glyph")!;
    expect(warn.getAttribute("aria-label")).toContain("no created field");
    expect(view.mount.querySelector("p.tk-warn")).toBeNull();
    // A generic span's aria-label is not reliably announced without a role.
    expect(warn.getAttribute("role")).toBe("img");
  });

  it("names the path in a conflict-only card's glyph, since it must be opened by hand", () => {
    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "todo", conflict: true })], links: [] });
    const warn = view.mount.querySelector(".tk-warn-glyph")!;
    expect(warn.getAttribute("aria-label")).toContain(card().path);
  });

  it("marks a card left in the working step with no session", () => {
    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "doing" })], links: [] });
    expect(view.mount.querySelector(".tk-stale")!.textContent).toBe("no live session");
  });

  it("omits the kind chip for a card that does not name a kind", () => {
    view.render({ project: "deck", caps: capsWith(CFG4), error: null,
                  tasks: [card({ status: "todo", kind: "" })], links: [] });
    expect(view.mount.querySelector(".tk-kind")).toBeNull();
  });
});

describe("BoardView board configuration error", () => {
  const errCaps: ProviderCapabilities = {
    canCreate: true, canResolve: true, statuses: ["open", "done"], board: CFG,
    boardError: "steps[1]: missing id", boardEditable: true,
  };

  it("shows the fallback message when caps.boardError is set", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps: errCaps, error: null, tasks: [], links: [] });
    const banner = v.mount.querySelector("p.tk-board-error")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("board.json could not be used");
    expect(banner.textContent).toContain("steps[1]: missing id");
    // The part that stops a person trusting the columns while the fallback is
    // active — the opening words alone would not.
    expect(banner.textContent).toContain("so cards may appear in the wrong column. The file was left alone.");
    // The whole sentence, punctuation included. A second sender now shares this
    // field (the GitHub source's own message, which takes no wrapper at all), so
    // the file board's wording is only "unchanged" if something checks the join
    // between the message and the wrapper — three `toContain`s above cannot see
    // a lost full stop.
    expect(banner.textContent).toBe(
      "board.json could not be used: steps[1]: missing id. The default two-step board is shown "
      + "instead, so cards may appear in the wrong column. The file was left alone.");
  });

  it("still renders the columns underneath the board-error banner", () => {
    const v = new BoardView({ ...handlers });
    v.render({ project: "deck", caps: errCaps, error: null, tasks: [card()], links: [] });
    expect(v.mount.querySelector("p.tk-board-error")).not.toBeNull();
    expect(v.mount.querySelectorAll(".tk-col").length).toBeGreaterThan(0);
  });
});
