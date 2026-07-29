// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computePatch, openCardModal, type CardFormValues } from "../src/card-modal";
import type { BoardConfig, Task } from "../src/ipc";

const original: Task = {
  id: "1", title: "Original", kind: "task", status: "todo", project: "p",
  created: "2026-07-01T00:00:00Z", resolved: null, origin: "human", session: null,
  body: "Body.\n", path: "/t/1.md", damaged: null, conflict: false,
};
const same = (): CardFormValues =>
  ({ title: "Original", kind: "task", status: "todo", body: "Body.\n" });

// Used by the DOM tests in step 7. This file is new, so it declares its own.
const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

describe("computePatch", () => {
  it("is empty when nothing was touched", () => {
    expect(computePatch(original, same())).toEqual({});
  });

  it("carries only the field that changed", () => {
    expect(computePatch(original, { ...same(), title: "Renamed" })).toEqual({ title: "Renamed" });
    expect(computePatch(original, { ...same(), status: "done" })).toEqual({ status: "done" });
  });

  it("carries several changes together", () => {
    expect(computePatch(original, { ...same(), kind: "bug", body: "New.\n" }))
      .toEqual({ kind: "bug", body: "New.\n" });
  });

  it("does not send a step the person never touched", () => {
    // The point of the whole exercise: an agent may have moved the card while
    // the modal was open, and sending the step back would undo that.
    const patch = computePatch(original, { ...same(), title: "Renamed" });
    expect(patch.status).toBeUndefined();
  });

  it("treats a trimmed-to-identical title as untouched", () => {
    expect(computePatch(original, { ...same(), title: "  Original  " })).toEqual({});
  });

  it("sends an emptied body as an empty string, not as untouched", () => {
    expect(computePatch(original, { ...same(), body: "" })).toEqual({ body: "" });
  });
});

describe("openCardModal", () => {
  it("offers a card's unknown step as the selected option", () => {
    // Rendered, not resolved: the modal is how an unknown-step card gets out,
    // and it must not silently pick a different step on the way.
    const p = openCardModal({ ...original, status: "legacy" }, CFG, true);
    const step = document.querySelector<HTMLSelectElement>(".tk-c-step")!;
    expect(step.value).toBe("legacy");
    expect(step.options[0].textContent).toContain("not in board.json");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });

  it("disables everything and offers no Save for a damaged card", () => {
    const p = openCardModal({ ...original, damaged: "no created field" }, CFG, false);
    expect(document.querySelector<HTMLInputElement>(".tk-c-title")!.disabled).toBe(true);
    expect(document.querySelector(".tk-c-broken")!.textContent).toContain("no created field");
    expect(document.querySelector(".modal-ok")).toBeNull();
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });
});
