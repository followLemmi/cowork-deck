// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { taskForm } from "../src/forms";

describe("taskForm", () => {
  // Селекторы по классам, а не по [name]: в forms.ts у полей нет атрибута
  // name — там используются классы вида .form-name / .form-path.
  const ov = () => document.querySelector(".modal-overlay")!;

  it("returns the draft that was filled in", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "Пилюля мигает";
    ov().querySelector<HTMLTextAreaElement>(".tk-f-body")!.value = "Репро: три воркспейса.";
    ov().querySelector<HTMLButtonElement>("button[data-kind=bug]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();

    await expect(p).resolves.toEqual({
      title: "Пилюля мигает", kind: "bug", body: "Репро: три воркспейса.",
    });
  });

  it("defaults to kind=task when nothing is picked", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "Просто задача";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const draft = await p;
    expect(draft?.kind).toBe("task");
  });

  it("resolves null on cancel", async () => {
    const p = taskForm();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("closes on a backdrop click, like the other forms", async () => {
    const p = taskForm();
    const overlay = ov() as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it("refuses an empty title instead of creating a nameless card", async () => {
    const p = taskForm();
    ov().querySelector<HTMLInputElement>(".tk-f-title")!.value = "   ";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    // Модалка осталась открытой, промис не разрешён.
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("does not nest the kind buttons in a label", async () => {
    const p = taskForm();
    const btn = ov().querySelector("button[data-kind=bug]")!;
    expect(btn.closest("label")).toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });
});
