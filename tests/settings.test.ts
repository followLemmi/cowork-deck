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

/** What the window shows that it does not own. The dialog reads none of this
 *  itself — the paths come from Rust, the workspace from the panel — so a fixture
 *  here is the whole of its input. */
const PATHS = {
  dir: "/home/dev/.config/cowork-deck",
  files: [
    { name: "workspaces.json", exists: true },
    { name: "skills.json", exists: false },
  ],
};
const WS = {
  id: "w", name: "relay", path: "/home/dev/code/relay", color: "#fff",
  github: { host: "github.com", login: "acme-dev" },
};
let revealed: string[] = [];
let edited = 0;
const open = (over: Partial<Parameters<typeof settingsDialog>[0]> = {}) =>
  settingsDialog({
    paths: PATHS, workspace: WS as never, taskSource: "cards in .cowork/tasks",
    onReveal: (p) => revealed.push(p),
    onEditWorkspace: () => { edited += 1; },
    ...over,
  });

beforeEach(() => {
  revealed = [];
  edited = 0;
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  applyScale(DEFAULT_SCALE, document.documentElement);
});

describe("the settings window", () => {
  it("reflects the scale in force when it opened", () => {
    applyScale(OTHER, document.documentElement);
    void open();
    expect(checked()).toEqual([pick(OTHER)]);
    expect(pick(OTHER).classList.contains("selected")).toBe(true);
  });

  it("offers every step, labelled with the percentage and the pixels", () => {
    void open();
    expect(sizes()).toHaveLength(SCALE_STEPS.length);
    for (const s of SCALE_STEPS) expect(pick(s).textContent).toBe(scaleLabel(s));
  });

  it("previews live, so a person sees the size rather than imagining it", () => {
    void open();
    pick(OTHER).click();
    expect(document.documentElement.style.fontSize).toBe(`${rootFontPx(OTHER)}px`);
    expect(currentScale()).toBe(OTHER);
    expect(checked()).toEqual([pick(OTHER)]);
  });

  it("puts the preview back on Cancel and resolves null", async () => {
    const p = open();
    pick(OTHER).click();
    click(".modal-cancel");
    // The whole reason Cancel has work to do here: the preview already changed the
    // document, so cancelling has to undo it rather than merely close.
    expect(await p).toBeNull();
    expect(currentScale()).toBe(DEFAULT_SCALE);
    expect(document.documentElement.style.fontSize).toBe(`${rootFontPx(DEFAULT_SCALE)}px`);
  });

  it("puts the preview back on Escape too", async () => {
    const p = open();
    pick(OTHER).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBeNull();
    expect(currentScale()).toBe(DEFAULT_SCALE);
  });

  it("resolves the chosen scale on OK and leaves it applied", async () => {
    const p = open();
    pick(OTHER).click();
    click(".modal-ok");
    expect(await p).toBe(OTHER);
    expect(currentScale()).toBe(OTHER);
  });

  it("resolves the unchanged scale when OK is pressed without picking", async () => {
    applyScale(OTHER, document.documentElement);
    const p = open();
    click(".modal-ok");
    expect(await p).toBe(OTHER);
  });

  it("closes the overlay either way", async () => {
    const cancelled = open();
    click(".modal-cancel");
    await cancelled;
    expect(document.querySelector(".modal-overlay")).toBeNull();

    const accepted = open();
    click(".modal-ok");
    await accepted;
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("settles once, so a second click cannot resolve it again", async () => {
    const p = open();
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
    void open();
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

/** The second section is not a preference — it is an answer. "Where is my
 *  configuration, and what is this workspace bound to" was answerable before only
 *  by reading the source or opening the form that changes it. */
describe("what the settings window says about where things are kept", () => {
  const kv = (label: string) =>
    [...document.querySelectorAll(".set-kv")]
      .find((r) => r.querySelector(".set-kv-label")?.textContent === label);

  it("names the directory the app keeps its own files in", () => {
    void open();
    expect(kv("The app's own files")?.querySelector(".set-kv-value")?.textContent)
      .toBe(PATHS.dir);
  });

  it("lists every file, and marks the ones not written yet", () => {
    void open();
    const chips = [...document.querySelectorAll(".set-file")];
    expect(chips.map((c) => c.textContent)).toEqual(["workspaces.json", "skills.json"]);
    // Absent is a fact, not a row to drop: a person looking for a file they have
    // never saved needs to be told it is not there.
    expect(chips[0].classList.contains("set-file--absent")).toBe(false);
    expect(chips[1].classList.contains("set-file--absent")).toBe(true);
  });

  it("says which account a push from this workspace goes out as", () => {
    void open();
    expect(kv("Pushes as")?.querySelector(".set-kv-value")?.textContent)
      .toBe("acme-dev · github.com");
  });

  /** The one this window exists for: it was answerable only inside the form that
   *  changes it, so a person who merely wanted to KNOW had to open an editor. */
  it("says so plainly when nothing is bound", () => {
    void open({ workspace: { ...WS, github: null } as never, taskSource: null });
    expect(kv("Pushes as")?.querySelector(".set-kv-value")?.textContent)
      .toBe("no account bound");
    expect(kv("Tasks come from")?.querySelector(".set-kv-value")?.textContent)
      .toBe("nothing configured");
  });

  it("reveals a path rather than opening it, and only when asked", () => {
    void open();
    expect(revealed).toEqual([]);
    document.querySelectorAll<HTMLButtonElement>(".set-kv-act")[0].click();
    expect(revealed).toEqual([PATHS.dir]);
  });

  /** Editing is somebody else's job: the workspace form owns these fields, and a
   *  second editor for them is a second thing to keep in step. Handing over closes
   *  this window, because two modals on one subject is a stack nobody asked for. */
  it("hands the bindings to the form that owns them", async () => {
    const p = open();
    const act = [...document.querySelectorAll<HTMLButtonElement>(".set-kv-act")]
      .find((b) => b.textContent === "Edit workspace…")!;
    act.click();
    expect(edited).toBe(1);
    expect(await p).toBe(DEFAULT_SCALE);
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("says there is nothing bound to show when no workspace is active", () => {
    void open({ workspace: null, taskSource: null });
    expect(document.body.textContent).toContain("No workspace is active");
  });
});
