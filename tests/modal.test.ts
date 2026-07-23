// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { promptModal, confirmModal } from "../src/modal";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("promptModal", () => {
  it("resolves with the entered value on OK", async () => {
    const p = promptModal("Имя пространства");
    const input = document.querySelector<HTMLInputElement>(".modal-input")!;
    input.value = "проект-1";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toBe("проект-1");
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("resolves null on cancel", async () => {
    const p = promptModal("Имя");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("prefills the initial value", () => {
    promptModal("Значок (эмодзи)", "▶");
    const input = document.querySelector<HTMLInputElement>(".modal-input")!;
    expect(input.value).toBe("▶");
  });
});

describe("confirmModal", () => {
  it("resolves true on OK", async () => {
    const p = confirmModal("Удалить?");
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toBe(true);
  });

  it("resolves false on cancel", async () => {
    const p = confirmModal("Удалить?");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBe(false);
  });
});
