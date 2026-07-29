// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { openBoardEditor, validateDraft } from "../src/board-editor";
import type { BoardConfig, StepUsage } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "backlog", label: "Backlog" },
    { id: "todo", label: "To do", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

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

  function stepRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".tk-e-step-row")];
  }
  function stepIds(): string[] {
    return stepRows().map((r) => r.querySelector<HTMLInputElement>(".tk-e-step-id")!.value);
  }
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
