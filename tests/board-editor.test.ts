// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { applyBoardEdit, openBoardEditor, validateDraft } from "../src/board-editor";
import type { BoardEditIo } from "../src/board-editor";
import type { BoardConfig, RewriteReport, StepUsage } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

// Every case below ends by closing its dialog, but a case that *fails* before
// reaching that line does not — and the next case then queries the stale
// overlay, so one defect reads as half a dozen failures plus a timeout. Tear
// down whatever is left instead, so a real regression names itself.
afterEach(() => {
  for (const overlay of document.querySelectorAll(".modal-overlay")) overlay.remove();
});

describe("validateDraft", () => {
  it("accepts a good draft", () => expect(validateDraft(CFG)).toBeNull());
  it("rejects a draft with no terminal step", () =>
    expect(validateDraft({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, terminal: false })) }))
      .toMatch(/terminal/));
  it("rejects two working steps", () =>
    expect(validateDraft({ ...CFG, steps: CFG.steps.map((s) => ({ ...s, working: true })) }))
      .toMatch(/working/));
  it("rejects a duplicate id", () =>
    expect(validateDraft({ ...CFG, steps: [...CFG.steps, CFG.steps[0]] })).toMatch(/todo|backlog/));
  it("rejects whitespace in an id", () =>
    expect(validateDraft({ ...CFG, steps: [{ id: "in progress", label: "X", terminal: true }] }))
      .toMatch(/whitespace/));
  it("rejects an empty step list and an empty kind list", () => {
    expect(validateDraft({ ...CFG, steps: [] })).toMatch(/step/);
    expect(validateDraft({ ...CFG, kinds: [] })).toMatch(/kind/);
  });
});

describe("openBoardEditor", () => {
  // "todo" is the one step with cards on it; "backlog" and "done" have none —
  // that split is what lets the remove/rename tests below tell the two paths
  // (plain vs. destination-demanding) apart.
  const usage: StepUsage[] = [
    { step: "backlog", count: 0 }, { step: "todo", count: 3 }, { step: "done", count: 0 },
  ];

  // Two steps with cards on them, which is what the sequences below need: one
  // removal's destination can then be another removal's source.
  const usageTwo: StepUsage[] = [
    { step: "backlog", count: 2 }, { step: "todo", count: 3 }, { step: "done", count: 0 },
  ];
  // "todo" and "done" both occupied — a swap of their ids moves cards both ways.
  const usageBoth: StepUsage[] = [
    { step: "backlog", count: 0 }, { step: "todo", count: 3 }, { step: "done", count: 2 },
  ];

  function stepRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".tk-e-step-row")];
  }
  function kindRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".tk-e-kind-row")];
  }
  function stepIds(): string[] {
    return stepRows().map((r) => r.querySelector<HTMLInputElement>(".tk-e-step-id")!.value);
  }
  function kindIds(): string[] {
    return kindRows().map((r) => r.querySelector<HTMLInputElement>(".tk-e-kind-id")!.value);
  }
  const errorText = () => document.querySelector(".form-error")!.textContent ?? "";
  const saveIsDisabled = () => document.querySelector<HTMLButtonElement>(".modal-ok")!.disabled;
  /** Type into an input the way a person does: through the element, one event. */
  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }
  /** Answer a removal's destination select. */
  function chooseDest(row: HTMLElement, to: string): void {
    const dest = row.querySelector<HTMLSelectElement>(".tk-e-step-dest")!;
    dest.value = to;
    dest.dispatchEvent(new Event("change"));
  }
  const remove = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".tk-e-step-remove")!.click();
  const cancel = () => document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
  const save = () => document.querySelector<HTMLButtonElement>(".modal-ok")!.click();

  it("renders one row per step and one per kind", async () => {
    const p = openBoardEditor(CFG, usage);
    expect(stepRows()).toHaveLength(3);
    expect(document.querySelectorAll(".tk-e-kind-row")).toHaveLength(2);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("names every glyph button, since its visible content is not a name", async () => {
    const p = openBoardEditor(CFG, usage);
    for (const sel of [".tk-e-step-up", ".tk-e-step-down", ".tk-e-step-remove", ".tk-e-kind-remove"]) {
      for (const btn of document.querySelectorAll(sel)) expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
    expect(document.querySelector(".tk-e-add-step")!.getAttribute("aria-label")).toBe("Add a step");
    expect(document.querySelector(".tk-e-add-kind")!.getAttribute("aria-label")).toBe("Add a kind");
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("appends an empty editable row on + step and + kind", async () => {
    const p = openBoardEditor(CFG, usage);
    document.querySelector<HTMLButtonElement>(".tk-e-add-step")!.click();
    expect(stepRows()).toHaveLength(4);
    const ids = stepIds();
    expect(ids[ids.length - 1]).toBe("");
    document.querySelector<HTMLButtonElement>(".tk-e-add-kind")!.click();
    expect(document.querySelectorAll(".tk-e-kind-row")).toHaveLength(3);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("reorders steps when an arrow is pressed, and disables the arrow at each end", async () => {
    const p = openBoardEditor(CFG, usage);
    expect(stepIds()).toEqual(["backlog", "todo", "done"]);
    expect(stepRows()[0].querySelector<HTMLButtonElement>(".tk-e-step-up")!.disabled).toBe(true);
    expect(stepRows()[2].querySelector<HTMLButtonElement>(".tk-e-step-down")!.disabled).toBe(true);
    stepRows()[0].querySelector<HTMLButtonElement>(".tk-e-step-down")!.click();
    expect(stepIds()).toEqual(["todo", "backlog", "done"]);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("keeps only one working step checked, radio-fashion", async () => {
    const p = openBoardEditor(CFG, usage); // "todo" starts as the working step
    expect(stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-working")!.checked).toBe(true);
    stepRows()[0].querySelector<HTMLInputElement>(".tk-e-step-working")!.click();
    expect(stepRows()[0].querySelector<HTMLInputElement>(".tk-e-step-working")!.checked).toBe(true);
    expect(stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-working")!.checked).toBe(false);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("removes a step with no cards immediately, asking nothing", async () => {
    const p = openBoardEditor(CFG, usage); // "backlog" has no cards
    stepRows()[0].querySelector<HTMLButtonElement>(".tk-e-step-remove")!.click();
    expect(stepIds()).toEqual(["todo", "done"]);
    expect(document.querySelector(".tk-e-step-dest")).toBeNull();
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("demands a destination to remove a step with cards, and disables Save until it is chosen", async () => {
    const p = openBoardEditor(CFG, usage); // "todo" has 3 cards
    stepRows()[1].querySelector<HTMLButtonElement>(".tk-e-step-remove")!.click();
    expect(document.querySelector<HTMLButtonElement>(".modal-ok")!.disabled).toBe(true);
    const dest = document.querySelector<HTMLSelectElement>(".tk-e-step-dest")!;
    // The step being removed must not be offered as its own destination.
    expect([...dest.options].map((o) => o.value)).not.toContain("todo");
    dest.value = "done";
    dest.dispatchEvent(new Event("change"));
    expect(stepIds()).toEqual(["backlog", "done"]);
    expect(document.querySelector<HTMLButtonElement>(".modal-ok")!.disabled).toBe(false);
    save();
    const result = await p;
    expect(result!.rewrites).toContainEqual({ from: "todo", to: "done" });
    expect(result!.config.steps.some((s) => s.id === "todo")).toBe(false);
  });

  it("shows an inline note and records a rewrite when a used step's id changes", async () => {
    const p = openBoardEditor(CFG, usage); // "todo" has 3 cards
    const idInput = stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-id")!;
    idInput.value = "in-progress";
    idInput.dispatchEvent(new Event("input"));
    const note = stepRows()[1].querySelector(".tk-e-note")!;
    expect(note.textContent).toBe('3 card(s) will be updated to say "in-progress"');
    save();
    const result = await p;
    expect(result!.rewrites).toContainEqual({ from: "todo", to: "in-progress" });
  });

  it("records no rewrite and shows no note when an unused step's id changes", async () => {
    const p = openBoardEditor(CFG, usage); // "backlog" has no cards
    const idInput = stepRows()[0].querySelector<HTMLInputElement>(".tk-e-step-id")!;
    idInput.value = "inbox";
    idInput.dispatchEvent(new Event("input"));
    expect(stepRows()[0].querySelector(".tk-e-note")).toBeNull();
    save();
    const result = await p;
    expect(result!.rewrites.some((r) => r.from === "backlog")).toBe(false);
  });

  it("removes a kind immediately — a kind carries no destination step to ask for", async () => {
    const p = openBoardEditor(CFG, usage);
    document.querySelector<HTMLButtonElement>(".tk-e-kind-remove")!.click();
    expect(document.querySelectorAll(".tk-e-kind-row")).toHaveLength(1);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("disables Save and shows validateDraft's message for an invalid draft", async () => {
    const p = openBoardEditor(CFG, usage);
    stepRows()[2].querySelector<HTMLInputElement>(".tk-e-step-terminal")!.click(); // unchecks the only terminal step
    expect(document.querySelector<HTMLButtonElement>(".modal-ok")!.disabled).toBe(true);
    expect(document.querySelector(".form-error")!.textContent).toMatch(/terminal/);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("resolves null on Cancel", async () => {
    const p = openBoardEditor(CFG, usage);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  // --- A chosen destination has to stay valid, not merely have been valid once.
  // Each of these three reaches Save with a rewrite aimed at a step the saved
  // configuration would not contain; the backend refuses the card write and
  // reports the cards as skipped, which is not an error, so nothing downstream
  // stops the configuration from being written.

  it("refuses to remove a step that a pending removal is sending its cards to", async () => {
    const p = openBoardEditor(CFG, usage);
    remove(stepRows()[1]);                       // "todo", 3 cards
    chooseDest(stepRows()[1], "done");           // they go to "done"
    expect(stepIds()).toEqual(["backlog", "done"]);
    remove(stepRows()[1]);                       // ✕ on "done", which has no cards
    expect(stepIds()).toEqual(["backlog", "done"]); // still there, and said so
    expect(errorText()).toMatch(/"done" has to stay/);
    expect(saveIsDisabled()).toBe(false);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("disables Save when a pending removal's destination is renamed away", async () => {
    const p = openBoardEditor(CFG, usage);
    remove(stepRows()[1]);
    chooseDest(stepRows()[1], "done");
    type(stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-id")!, "closed");
    expect(saveIsDisabled()).toBe(true);
    expect(errorText()).toMatch(/"todo".*"done".*no longer has/);
    save();                                      // a disabled Save must not resolve
    expect(document.querySelector(".modal-ok")).not.toBeNull();
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("disables Save when one removal's destination is itself removed onwards", async () => {
    const p = openBoardEditor(CFG, usageTwo);    // "backlog" 2 cards, "todo" 3
    remove(stepRows()[0]);
    remove(stepRows()[1]);                       // both await a destination
    chooseDest(stepRows()[0], "todo");           // backlog → todo
    chooseDest(stepRows()[0], "done");           // todo → done, so backlog's is gone
    expect(stepIds()).toEqual(["done"]);
    expect(saveIsDisabled()).toBe(true);
    expect(errorText()).toMatch(/"backlog".*"todo".*no longer has/);
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("disables Save when two renames cross, rather than merging both steps' cards", async () => {
    const p = openBoardEditor(CFG, usageBoth);   // "todo" 3 cards, "done" 2
    type(stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-id")!, "done");
    type(stepRows()[2].querySelector<HTMLInputElement>(".tk-e-step-id")!, "todo");
    expect(stepIds()).toEqual(["backlog", "done", "todo"]); // a legal draft on its own
    expect(validateDraft({ ...CFG, steps: [
      { id: "backlog", label: "Backlog" }, { id: "done", label: "To do", working: true },
      { id: "todo", label: "Done", terminal: true }] })).toBeNull();
    expect(saveIsDisabled()).toBe(true);
    expect(errorText()).toMatch(/"todo" sends its cards to "done", which sends them on to "todo"/);
    save();
    expect(document.querySelector(".modal-ok")).not.toBeNull();
    cancel();
    await expect(p).resolves.toBeNull();
  });

  // --- Typing must not rebuild the row that owns the caret.

  it("keeps the focus in a step's Id field while it is being typed into", async () => {
    const p = openBoardEditor(CFG, usage);
    const idInput = stepRows()[1].querySelector<HTMLInputElement>(".tk-e-step-id")!;
    idInput.focus();
    type(idInput, "i");
    // Still the very same element, still focused: a rebuilt section would have
    // detached this input, which blurs it, and nothing refocuses the copy.
    expect(stepRows()[1].querySelector(".tk-e-step-id")).toBe(idInput);
    expect(document.activeElement).toBe(idInput);
    type(idInput, "in-progress");
    expect(document.activeElement).toBe(idInput);
    expect(stepRows()[1].querySelector(".tk-e-note")!.textContent)
      .toBe('3 card(s) will be updated to say "in-progress"');
    cancel();
    await expect(p).resolves.toBeNull();
  });

  it("keeps the focus on the Working checkbox and on a pressed arrow", async () => {
    const p = openBoardEditor(CFG, usage);
    const working = stepRows()[0].querySelector<HTMLInputElement>(".tk-e-step-working")!;
    working.focus();
    working.click();
    expect(document.activeElement).toBe(working);
    // ↓ twice in a row on the same step: focus follows the row that moved.
    const down = stepRows()[0].querySelector<HTMLButtonElement>(".tk-e-step-down")!;
    down.focus();
    down.click();
    expect(stepIds()).toEqual(["todo", "backlog", "done"]);
    const nowFocused = document.activeElement as HTMLElement;
    expect(nowFocused.className).toBe("tk-e-step-down");
    expect(stepRows()[1].contains(nowFocused)).toBe(true); // the moved row, not the old seat
    nowFocused.click();
    expect(stepIds()).toEqual(["todo", "done", "backlog"]);
    // Last row now: ↓ is disabled, so focus lands on the arrow still usable.
    expect((document.activeElement as HTMLElement).className).toBe("tk-e-step-up");
    cancel();
    await expect(p).resolves.toBeNull();
  });

  // --- Kinds are ordered too: this list is the order of the new-card form's
  // kind buttons, so it has to be changeable in place.

  it("reorders kinds with ↑/↓, and names both buttons", async () => {
    const p = openBoardEditor(CFG, usage);
    expect(kindIds()).toEqual(["bug", "task"]);
    expect(kindRows()[0].querySelector<HTMLButtonElement>(".tk-e-kind-up")!.disabled).toBe(true);
    expect(kindRows()[1].querySelector<HTMLButtonElement>(".tk-e-kind-down")!.disabled).toBe(true);
    for (const sel of [".tk-e-kind-up", ".tk-e-kind-down"]) {
      for (const btn of document.querySelectorAll(sel)) expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
    kindRows()[1].querySelector<HTMLButtonElement>(".tk-e-kind-up")!.click();
    expect(kindIds()).toEqual(["task", "bug"]);
    save();
    const result = await p;
    expect(result!.config.kinds.map((k) => k.id)).toEqual(["task", "bug"]);
  });

  it("resolves with the edited configuration and no rewrites when nothing affected is touched", async () => {
    const p = openBoardEditor(CFG, usage);
    const label = stepRows()[0].querySelector<HTMLInputElement>(".tk-e-step-label")!;
    label.value = "Backlog!";
    label.dispatchEvent(new Event("input"));
    save();
    const result = await p;
    expect(result!.config.steps[0]).toEqual({ id: "backlog", label: "Backlog!" });
    expect(result!.rewrites).toEqual([]);
  });
});

describe("applyBoardEdit", () => {
  const NOTHING_SKIPPED: RewriteReport = { rewritten: 3, skipped: [] };
  const ONE_SKIPPED: RewriteReport = {
    rewritten: 2, skipped: [{ fileName: "note.md", reason: "no frontmatter" }],
  };

  function io(over: Partial<BoardEditIo> = {}) {
    const calls = { rewrite: [] as { from: string; to: string }[], saved: [] as BoardConfig[],
                    alerts: [] as string[], confirms: [] as string[] };
    const base: BoardEditIo = {
      rewrite: async (from, to) => { calls.rewrite.push({ from, to }); return NOTHING_SKIPPED; },
      save: async (config) => { calls.saved.push(config); },
      alert: async (message) => { calls.alerts.push(message); },
      confirm: async (message) => { calls.confirms.push(message); return true; },
    };
    return { io: { ...base, ...over }, calls };
  }
  const RESULT = { config: CFG, rewrites: [{ from: "todo", to: "in-progress" }] };

  it("rewrites first, then saves", async () => {
    const { io: deps, calls } = io();
    await expect(applyBoardEdit(RESULT, deps)).resolves.toBe(true);
    expect(calls.rewrite).toEqual([{ from: "todo", to: "in-progress" }]);
    expect(calls.saved).toEqual([CFG]);
    expect(calls.confirms).toEqual([]); // nothing was skipped, so nothing to ask
  });

  it("asks before saving when a rewrite skipped cards, and does not save if declined", async () => {
    const asked: string[] = [];
    const { io: deps, calls } = io({
      rewrite: async () => ONE_SKIPPED,
      confirm: async (message) => { asked.push(message); return false; },
    });
    await expect(applyBoardEdit(RESULT, deps)).resolves.toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("note.md: no frontmatter");
    expect(asked[0]).toContain("Save the new configuration anyway?");
    // The point of the whole finding: a skipped card is not an error, so the
    // configuration used to be written regardless.
    expect(calls.saved).toEqual([]);
  });

  it("saves when the skipped cards are accepted", async () => {
    const { io: deps, calls } = io({ rewrite: async () => ONE_SKIPPED });
    await expect(applyBoardEdit(RESULT, deps)).resolves.toBe(true);
    expect(calls.confirms).toHaveLength(1);
    expect(calls.saved).toEqual([CFG]);
  });

  it("leaves the configuration alone when a rewrite throws", async () => {
    const { io: deps, calls } = io({ rewrite: async () => { throw new Error("locked"); } });
    await expect(applyBoardEdit(RESULT, deps)).resolves.toBe(false);
    expect(calls.saved).toEqual([]);
    expect(calls.alerts[0]).toContain('Could not update the cards in "todo"');
  });
});
