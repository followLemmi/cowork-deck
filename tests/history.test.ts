// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { RunRecord, Skill } from "../src/ipc";
import { HistoryView, type HistoryState } from "../src/history";

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = new Date(2026, 7, 9, 12, 0).getTime();

function rec(o: Partial<RunRecord> & Pick<RunRecord, "runId">): RunRecord {
  return {
    startedAt: NOW - HOUR, closedAt: NOW - HOUR + 5 * MIN, trigger: "manual", status: "ended",
    skillId: "s1", name: "Nightly review", icon: "shield", workspaceId: "w1",
    cwd: "/p", branch: "main", sessionId: "sess", params: {}, prompt: "go",
    continuesRunId: null, transcriptPath: "/t/a.jsonl", cleared: false,
    result: "all green", reason: null, tokens: null, resultSource: "transcript",
    ...o,
  };
}

const SKILLS: Skill[] = [
  { id: "s1", name: "Nightly review", icon: "shield", prompt: "go", workspaceId: null },
];

function state(o: Partial<HistoryState> = {}): HistoryState {
  return {
    runs: [], anyRuns: true, workspaceName: "relay", recording: true,
    filters: { skillId: null, trigger: null }, skills: SKILLS,
    liveSessions: [], workspaceIds: ["w1"],
    ...o,
  };
}

function mount(o: Partial<HistoryState> = {}, handlers = {}) {
  const view = new HistoryView({
    onFilter: () => {}, onJump: () => {}, onRerun: () => {},
    onReveal: () => {}, onDeleteHistory: () => {}, onRefused: () => {}, ...handlers,
  });
  document.body.replaceChildren(view.mount);
  view.render(state(o), NOW);
  return view;
}

const text = () => document.body.textContent ?? "";

describe("the history screen", () => {
  it("says which workspace it is the history of", () => {
    mount({ runs: [rec({ runId: "r" })] });
    expect(document.querySelector(".hist-where")!.textContent).toBe("relay");
  });

  // The whole reason a record stores a name rather than a `skillId` to look one
  // up by: a run of a scenario that has since been deleted still reads
  // correctly, under the name it was launched with.
  it("renders a deleted scenario's run under its snapshot name", () => {
    mount({ runs: [rec({ runId: "r", skillId: "gone", name: "Tidy the changelog" })], skills: SKILLS });
    expect(document.querySelector(".hist-name")!.textContent).toContain("Tidy the changelog");
    // And the filter can still reach it, or those rows would be unfindable.
    const options = [...document.querySelectorAll<HTMLOptionElement>('[data-fk="filter-skill"] option')];
    expect(options.map((o) => o.value)).toContain("gone");
    expect(options.find((o) => o.value === "gone")!.textContent).toContain("deleted");
  });

  it("puts every status on its own chip and its own rail", () => {
    mount({
      runs: [
        rec({ runId: "a", status: "running" }),
        rec({ runId: "b", status: "ended" }),
        rec({ runId: "c", status: "error" }),
        rec({ runId: "d", status: "interrupted" }),
        rec({ runId: "e", status: "failed-to-launch" }),
      ],
    });
    const rails = [...document.querySelectorAll<HTMLElement>(".hist-row")].map((r) => r.dataset.status);
    expect(rails).toEqual(["running", "ended", "error", "interrupted", "failed-to-launch"]);
    const chips = [...document.querySelectorAll(".run-state")].map((c) => c.className);
    expect(new Set(chips).size).toBe(5);
  });

  // The run happening and the run producing nothing are different facts, and a
  // blank space says the second while meaning the first.
  it("reads a null result as an explicit sentence, never as an empty box", () => {
    mount({ runs: [rec({ runId: "r", result: null, resultSource: "none", transcriptPath: null })] });
    expect(document.querySelector(".hist-result")).toBeNull();
    expect(document.querySelector(".hist-noresult")!.textContent).toContain("No transcript");
  });

  // Presenting the tail of a conversation as the whole of it is the one lie the
  // marker exists to prevent.
  it("says out loud when a result is only the tail after a /clear", () => {
    mount({ runs: [rec({ runId: "r", cleared: true, result: "the last thing" })] });
    expect(document.querySelector(".hist-cleared")!.textContent).toContain("/clear");
    expect(document.querySelector(".hist-result")!.textContent).toBe("the last thing");
  });

  it("clamps a result and expands it in place", () => {
    mount({ runs: [rec({ runId: "r", result: "a\nb\nc\nd\ne" })] });
    const body = document.querySelector(".hist-result")!;
    const toggle = document.querySelector<HTMLButtonElement>(".hist-expand")!;
    expect(body.classList.contains("hist-result--clamped")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(body.classList.contains("hist-result--clamped")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  // A restart is one piece of work continued, not two unrelated runs. A flat
  // list would show three rows in reverse order with nothing saying so.
  it("draws a chain as one chain", () => {
    mount({
      runs: [
        rec({ runId: "new", startedAt: NOW - MIN, continuesRunId: "old", trigger: "resume" }),
        rec({ runId: "old", startedAt: NOW - HOUR }),
        rec({ runId: "unrelated", startedAt: NOW - 2 * HOUR }),
      ],
    });
    const chains = [...document.querySelectorAll(".hist-chain")];
    expect(chains).toHaveLength(2);
    expect(chains[0].querySelectorAll(".hist-row")).toHaveLength(2);
    expect(chains[0].classList.contains("hist-chain--multi")).toBe(true);
    expect(chains[0].textContent).toContain("2 runs");
    // The earlier link is drawn quieter so the newest run is where the eye lands.
    expect(chains[0].querySelectorAll(".hist-row")[1].classList.contains("hist-row--continued"))
      .toBe(true);
    expect(chains[1].classList.contains("hist-chain--multi")).toBe(false);
  });

  it("filters by scenario and by trigger through the handler", () => {
    const onFilter = vi.fn();
    mount({ runs: [rec({ runId: "r" })] }, { onFilter });

    const bySkill = document.querySelector<HTMLSelectElement>('[data-fk="filter-skill"]')!;
    bySkill.value = "s1";
    bySkill.onchange!(new Event("change"));
    expect(onFilter).toHaveBeenCalledWith({ skillId: "s1", trigger: null });

    const byTrigger = document.querySelector<HTMLSelectElement>('[data-fk="filter-trigger"]')!;
    byTrigger.value = "schedule";
    byTrigger.onchange!(new Event("change"));
    expect(onFilter).toHaveBeenCalledWith({ skillId: null, trigger: "schedule" });
  });

  it("arrives with the scenario filter already applied when it was opened from one", () => {
    mount({
      runs: [rec({ runId: "r" })],
      filters: { skillId: "s1", trigger: null },
    });
    expect(document.querySelector<HTMLSelectElement>('[data-fk="filter-skill"]')!.value).toBe("s1");
  });

  /** An empty journal with recording silently off is a bug report waiting to happen,
   *  so the page says which of the two it is. The switch itself is no longer here —
   *  a setting living above the records it governs looked like a third filter in a
   *  280px column, and it is going to the settings window. The sentence stays,
   *  because it is the only thing that explains an empty page that is not empty for
   *  the ordinary reason. */
  it("states that recording is off rather than leaving an unexplained void", () => {
    mount({ runs: [], recording: false });
    expect(text()).toContain("not being recorded");
    expect(document.querySelector('[data-fk="record-toggle"]')).toBeNull();
  });

  it("tells a new journal from a workspace with nothing in it", () => {
    mount({ runs: [], anyRuns: false });
    expect(text()).toContain("No scenario runs yet");
    mount({ runs: [], anyRuns: true });
    expect(text()).toContain("No scenario runs in relay");
  });

  // The list is rebuilt whenever a record opens or closes. Losing an expanded
  // result on every scheduled fire would make the screen unreadable while
  // anything is running.
  it("keeps an expanded result expanded across a repaint", () => {
    const view = mount({ runs: [rec({ runId: "r", result: "a\nb\nc\nd" })] });
    document.querySelector<HTMLButtonElement>(".hist-expand")!.click();
    view.render(state({ runs: [rec({ runId: "r", result: "a\nb\nc\nd" })] }), NOW);
    expect(document.querySelector(".hist-result")!.classList.contains("hist-result--clamped"))
      .toBe(false);
  });
});

describe("the row actions", () => {
  const action = (kind: string, runId: string) =>
    document.querySelector<HTMLButtonElement>(`[data-fk="${kind}-${runId}"]`);

  it("offers the jump wherever the session still has a tile", () => {
    const onJump = vi.fn();
    mount({
      runs: [
        rec({ runId: "live", status: "running", sessionId: "s1", closedAt: null }),
        // The tile is deliberately kept after the session ends, for scrollback —
        // so the way back to it is offered for as long as it is there.
        rec({ runId: "read", status: "ended", sessionId: "s2" }),
        rec({ runId: "over", status: "ended", sessionId: "s3" }),
      ],
      liveSessions: ["s1", "s2"],
    }, { onJump });
    expect(action("jump", "live")).not.toBeNull();
    expect(action("jump", "read")).not.toBeNull();
    expect(action("jump", "over")).toBeNull();
    action("jump", "live")!.click();
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ runId: "live" }));
  });

  // Re-run is offered as a form, never as a launch: the ellipsis is the promise
  // and the handler is what keeps it.
  it("hands a re-run its scenario as it stands now", () => {
    const onRerun = vi.fn();
    mount({ runs: [rec({ runId: "r" })] }, { onRerun });
    action("rerun", "r")!.click();
    expect(onRerun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r" }),
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("refuses the re-run of a deleted scenario, with the reason on the control", () => {
    const onRerun = vi.fn();
    mount({ runs: [rec({ runId: "r", skillId: "gone" })] }, { onRerun });
    const btn = action("rerun", "r")!;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toContain("deleted");
    // A reader gets the reason too, not only a mouse.
    expect(btn.getAttribute("aria-label")).toContain("deleted");
    btn.click();
    expect(onRerun).not.toHaveBeenCalled();
  });

  // The refusals are `aria-disabled`, never `disabled`: a `disabled` button
  // leaves the tab order, and the sentence saying why would then be reachable by
  // hovering a mouse and by nothing else. Activating one says it out loud.
  it("keeps a refused control reachable, and it explains itself when pressed", () => {
    const onRefused = vi.fn();
    mount({ runs: [rec({ runId: "r", skillId: "gone", transcriptPath: null })] }, { onRefused });
    for (const kind of ["rerun", "reveal"]) {
      const btn = action(kind, "r")!;
      expect(btn.disabled).toBe(false);
      btn.focus();
      expect(document.activeElement).toBe(btn);
      btn.click();
    }
    expect(onRefused).toHaveBeenCalledTimes(2);
    expect(onRefused.mock.calls[0][0]).toContain("deleted");
    expect(onRefused.mock.calls[1][0]).toContain("No transcript");
  });

  it("refuses the re-run of a scenario whose workspace is gone", () => {
    mount({
      runs: [rec({ runId: "r" })],
      skills: [{ id: "s1", name: "N", icon: "shield", prompt: "go", workspaceId: "w-deleted" }],
      workspaceIds: ["w1"],
    });
    expect(action("rerun", "r")!.getAttribute("aria-disabled")).toBe("true");
    expect(action("rerun", "r")!.title).toContain("workspace was deleted");
  });

  it("refuses the reveal when there is no transcript to reveal", () => {
    const onReveal = vi.fn();
    mount({ runs: [rec({ runId: "r", transcriptPath: null })] }, { onReveal });
    const btn = action("reveal", "r")!;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.title).toContain("No transcript");
    btn.click();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("reveals the transcript when there is one", () => {
    const onReveal = vi.fn();
    mount({ runs: [rec({ runId: "r" })] }, { onReveal });
    action("reveal", "r")!.click();
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ runId: "r" }));
  });

  // History is immutable. Erasing exists at one granularity only, and it is
  // offered only while the screen is narrowed to the scenario it would erase.
  it("offers the erase only when narrowed to one scenario", () => {
    const onDeleteHistory = vi.fn();
    mount({ runs: [rec({ runId: "r" })] }, { onDeleteHistory });
    expect(document.querySelector('[data-fk="delete-history"]')).toBeNull();

    mount({
      runs: [rec({ runId: "r" })], filters: { skillId: "s1", trigger: null },
    }, { onDeleteHistory });
    document.querySelector<HTMLButtonElement>('[data-fk="delete-history"]')!.click();
    expect(onDeleteHistory).toHaveBeenCalledWith("s1", "Nightly review");
  });

  // The confirmation is the last thing between a person and a file with no
  // second copy, so it names the scenario as it is *now*: a record's snapshot
  // name would have it ask about something the reader no longer has.
  it("names the erase after the scenario's current name, not the record's", () => {
    const onDeleteHistory = vi.fn();
    mount({
      runs: [rec({ runId: "r", name: "Nightly review" })],
      skills: [{ id: "s1", name: "Nightly triage", icon: "shield", prompt: "go", workspaceId: null }],
      filters: { skillId: "s1", trigger: null },
    }, { onDeleteHistory });
    document.querySelector<HTMLButtonElement>('[data-fk="delete-history"]')!.click();
    expect(onDeleteHistory).toHaveBeenCalledWith("s1", "Nightly triage");
  });

  // Erasing rewrites the journal, and rewriting an open record out of it means
  // the run is never journalled at all — not even when it finishes.
  it("refuses the erase while one of that scenario's runs is still going", () => {
    const onDeleteHistory = vi.fn();
    const onRefused = vi.fn();
    mount({
      runs: [
        rec({ runId: "live", status: "running", closedAt: null }),
        rec({ runId: "done" }),
      ],
      filters: { skillId: "s1", trigger: null },
    }, { onDeleteHistory, onRefused });
    const erase = document.querySelector<HTMLButtonElement>('[data-fk="delete-history"]')!;
    expect(erase.getAttribute("aria-disabled")).toBe("true");
    expect(erase.title).toContain("still going");
    erase.click();
    expect(onDeleteHistory).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith(expect.stringContaining("still going"));
  });

  // The erase reaches exactly the rows on screen, so with none on screen there
  // is nothing for it to do.
  it("does not offer the erase in a workspace holding none of that scenario's runs", () => {
    mount({ runs: [], filters: { skillId: "s1", trigger: null } });
    expect(document.querySelector('[data-fk="delete-history"]')).toBeNull();
  });

  // No path in the UI edits or deletes an individual record: a row is a
  // snapshot of what ran, and a journal whose rows can be revised answers
  // nothing.
  it("offers no way to edit or delete a single record", () => {
    mount({ runs: [rec({ runId: "r" })] });
    const labels = [...document.querySelectorAll(".hist-row button")]
      .map((b) => (b.textContent ?? "").toLowerCase());
    expect(labels.some((l) => l.includes("delete") || l.includes("edit"))).toBe(false);
  });
});
