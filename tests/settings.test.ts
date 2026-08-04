// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { settingsDialog } from "../src/settings";
import {
  applyScale, currentScale, DEFAULT_SCALE, rootFontPx, SCALE_STEPS, scaleLabel,
} from "../src/ui-scale";

const sizes = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-size")];
const pick = (scale: number) => sizes().find((b) => Number(b.dataset.scale) === scale)!;
const checked = () => sizes().filter((b) => b.getAttribute("aria-checked") === "true");
const click = (sel: string) => document.querySelector<HTMLButtonElement>(sel)!.click();

const OTHER = SCALE_STEPS.find((s) => s !== DEFAULT_SCALE)!;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  applyScale(DEFAULT_SCALE, document.documentElement);
});

describe("the text size dialog", () => {
  it("reflects the scale in force when it opened", () => {
    applyScale(OTHER, document.documentElement);
    void settingsDialog();
    expect(checked()).toEqual([pick(OTHER)]);
    expect(pick(OTHER).classList.contains("selected")).toBe(true);
  });

  it("offers every step, labelled with the percentage and the pixels", () => {
    void settingsDialog();
    expect(sizes()).toHaveLength(SCALE_STEPS.length);
    for (const s of SCALE_STEPS) expect(pick(s).textContent).toBe(scaleLabel(s));
  });

  it("previews live, so a person sees the size rather than imagining it", () => {
    void settingsDialog();
    pick(OTHER).click();
    expect(document.documentElement.style.fontSize).toBe(`${rootFontPx(OTHER)}px`);
    expect(currentScale()).toBe(OTHER);
    expect(checked()).toEqual([pick(OTHER)]);
  });

  it("puts the preview back on Cancel and resolves null", async () => {
    const p = settingsDialog();
    pick(OTHER).click();
    click(".modal-cancel");
    // The whole reason Cancel has work to do here: the preview already changed the
    // document, so cancelling has to undo it rather than merely close.
    expect(await p).toBeNull();
    expect(currentScale()).toBe(DEFAULT_SCALE);
    expect(document.documentElement.style.fontSize).toBe(`${rootFontPx(DEFAULT_SCALE)}px`);
  });

  it("puts the preview back on Escape too", async () => {
    const p = settingsDialog();
    pick(OTHER).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBeNull();
    expect(currentScale()).toBe(DEFAULT_SCALE);
  });

  it("resolves the chosen scale on OK and leaves it applied", async () => {
    const p = settingsDialog();
    pick(OTHER).click();
    click(".modal-ok");
    expect(await p).toBe(OTHER);
    expect(currentScale()).toBe(OTHER);
  });

  it("resolves the unchanged scale when OK is pressed without picking", async () => {
    applyScale(OTHER, document.documentElement);
    const p = settingsDialog();
    click(".modal-ok");
    expect(await p).toBe(OTHER);
  });

  it("closes the overlay either way", async () => {
    const cancelled = settingsDialog();
    click(".modal-cancel");
    await cancelled;
    expect(document.querySelector(".modal-overlay")).toBeNull();

    const accepted = settingsDialog();
    click(".modal-ok");
    await accepted;
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("settles once, so a second click cannot resolve it again", async () => {
    const p = settingsDialog();
    const ok = document.querySelector<HTMLButtonElement>(".modal-ok")!;
    pick(OTHER).click();
    ok.click();
    // The button is detached with the overlay, but a queued event or a double click
    // must not reopen the question — and must not revert the applied scale.
    ok.click();
    expect(await p).toBe(OTHER);
    expect(currentScale()).toBe(OTHER);
  });

  it("names itself for a reader", () => {
    void settingsDialog();
    const box = document.querySelector<HTMLElement>(".modal-box")!;
    const title = document.querySelector<HTMLElement>("#settings-title")!;
    expect(box.getAttribute("aria-labelledby")).toBe(title.id);
    expect(box.getAttribute("role")).toBe("dialog");
    // A radiogroup, like the colour and icon pickers: the selection has to reach AT,
    // not only the CSS ring.
    const group = document.querySelector<HTMLElement>(".settings-sizes")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(sizes().every((b) => b.getAttribute("role") === "radio")).toBe(true);
  });
});
