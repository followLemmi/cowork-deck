// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { taskForm } from "../src/forms";
import type { BoardConfig } from "../src/ipc";

const CFG: BoardConfig = {
  v: 1,
  steps: [{ id: "open", label: "open" }, { id: "done", label: "done", terminal: true }],
  kinds: [{ id: "bug", label: "bug" }, { id: "task", label: "task" }, { id: "idea", label: "idea" }],
};

describe("taskForm", () => {
  // Selected by class, not by [name]: the fields in forms.ts carry no name
  // attribute — it uses classes like .form-name / .form-path instead.
  const ov = () => document.querySelector(".modal-overlay")!;

  it("returns the draft that was filled in", async () => {
    const p = taskForm(CFG);
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "The pill keeps blinking";
    ov().querySelector<HTMLTextAreaElement>(".tk-f-body")!.value = "Repro: three workspaces.";
    ov().querySelector<HTMLButtonElement>("button[data-kind=bug]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();

    await expect(p).resolves.toEqual({
      title: "The pill keeps blinking", kind: "bug", body: "Repro: three workspaces.",
    });
  });

  it("defaults to the first configured kind when nothing is picked", async () => {
    // There is no privileged "task" kind any more: taskForm builds one button
    // per configured kind and preselects the first, whichever id that is. CFG
    // above lists bug first, so that is what a board with this configuration
    // must default to.
    const p = taskForm(CFG);
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "Just a task";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const draft = await p;
    expect(draft?.kind).toBe("bug");
  });

  it("resolves null on cancel", async () => {
    const p = taskForm(CFG);
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("closes on a backdrop click, like the other forms", async () => {
    const p = taskForm(CFG);
    const overlay = ov() as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it("refuses an empty title instead of creating a nameless card", async () => {
    const p = taskForm(CFG);
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "   ";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    // The modal stayed open and the promise is unresolved.
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("does not nest the kind buttons in a label", async () => {
    const p = taskForm(CFG);
    const btn = ov().querySelector("button[data-kind=bug]")!;
    expect(btn.closest("label")).toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });
});
