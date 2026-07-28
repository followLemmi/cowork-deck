// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock("../src/dialog", () => ({ pickFolder: pickFolderMock }));
vi.mock("@tauri-apps/api/core");

import { workspaceForm, skillForm, placeholderForm } from "../src/forms";
import { invoke } from "@tauri-apps/api/core";

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("workspaceForm", () => {
  it("collects name/path/color and resolves on OK", async () => {
    const p = workspaceForm();
    (document.querySelector(".form-name") as HTMLInputElement).value = "proj";
    (document.querySelector(".form-path") as HTMLInputElement).value = "/p";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res).toMatchObject({ name: "proj", path: "/p" });
    expect(typeof res!.color).toBe("string");
  });

  it("fills the path via pickFolder button", async () => {
    pickFolderMock.mockResolvedValueOnce("/picked");
    const p = workspaceForm();
    document.querySelector<HTMLButtonElement>(".form-pick")!.click();
    await Promise.resolve();
    expect((document.querySelector(".form-path") as HTMLInputElement).value).toBe("/picked");
    (document.querySelector(".form-name") as HTMLInputElement).value = "n";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)!.path).toBe("/picked");
  });

  it("prefills initial values when editing", () => {
    workspaceForm({ name: "old", path: "/old", color: "#61afef" });
    expect((document.querySelector(".form-name") as HTMLInputElement).value).toBe("old");
    expect((document.querySelector(".form-path") as HTMLInputElement).value).toBe("/old");
  });

  it("resolves null on cancel", async () => {
    const p = workspaceForm();
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });

  it("keeps the chosen color when the color label area is clicked", async () => {
    const p = workspaceForm();
    const swatches = document.querySelectorAll<HTMLButtonElement>(".form-swatch");
    swatches[1].click(); // choose the second color
    const colorRow = [...document.querySelectorAll<HTMLElement>(".form-row")]
      .find((r) => r.querySelector(".form-swatches"))!;
    (colorRow.querySelector(".form-label") as HTMLElement).click(); // click label area
    (document.querySelector(".form-name") as HTMLInputElement).value = "n";
    (document.querySelector(".form-path") as HTMLInputElement).value = "/p";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res!.color).not.toBe("#61afef"); // not reset to the first swatch
  });

  /** The form debounces nothing, but it does await IPC — let the microtasks run. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  const fillTracker = (path: string, wsName = "deck") => {
    (document.querySelector(".form-name") as HTMLInputElement).value = wsName;
    document.querySelector<HTMLInputElement>(".tk-f-on")!.checked = true;
    const pathRadio = document.querySelector<HTMLInputElement>("input[value='path']")!;
    pathRadio.checked = true;
    pathRadio.dispatchEvent(new Event("change"));
    const tp = document.querySelector(".tk-f-path") as HTMLInputElement;
    tp.value = path;
    tp.dispatchEvent(new Event("input"));
  };

  it("names the folders it will create before the save", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck",
      creating: ["cowork-deck-tasks", "deck"],
      baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    expect(document.querySelector(".tk-f-preview-path")!.textContent)
      .toBe("/vault/cowork-deck-tasks/deck");
    const made = document.querySelector(".tk-f-preview-creating")!.textContent!;
    expect(made).toContain("cowork-deck-tasks/");
    expect(made).toContain("deck/");
  });

  it("says nothing about creating when both folders are already there", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    expect(document.querySelector(".tk-f-preview-path")).not.toBeNull();
    expect(document.querySelector(".tk-f-preview-creating")).toBeNull();
  });

  it("warns instead of promising folders when the picked path does not exist", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vualt/cowork-deck-tasks/deck", creating: [], baseMissing: true,
    });
    void workspaceForm();
    fillTracker("/vualt");
    await settle();
    expect(document.querySelector(".tk-f-preview-warn")).not.toBeNull();
    expect(document.querySelector(".tk-f-preview-creating")).toBeNull();
  });

  it("asks nothing while the workspace name is blank", async () => {
    // slugify("") is "task", so a preview here would promise a folder that will
    // never exist.
    void workspaceForm();
    fillTracker("/vault", "");
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
  });

  it("recomputes when the name changes, because the folder is named after it", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    const before = vi.mocked(invoke).mock.calls.length;
    const nameInput = document.querySelector(".form-name") as HTMLInputElement;
    nameInput.value = "renamed";
    nameInput.dispatchEvent(new Event("input"));
    await settle();
    expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(before);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
      "tracker_root_preview", { workspaceName: "renamed", pickedPath: "/vault" },
    );
  });

  it("keeps the form usable when the preview call fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    // An explanatory line is not worth failing a form over.
    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
    expect(document.querySelector(".modal-ok")).not.toBeNull();
  });

  it("a stale success cannot resurrect the preview after a guard clears it", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    void workspaceForm();
    fillTracker("/vault");
    // The request fired by fillTracker's path input is still in flight.
    // Blanking the name now must clear the preview immediately, and that
    // clear must not be undone once the earlier request finally answers.
    const nameInput = document.querySelector(".form-name") as HTMLInputElement;
    nameInput.value = "";
    nameInput.dispatchEvent(new Event("input"));
    release({ root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false });
    await settle();
    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
  });
});

describe("workspaceForm — tracker", () => {
  const ov = () => document.querySelector(".modal-overlay")!;
  const fill = () => {
    ov().querySelector<HTMLInputElement>(".form-name")!.value = "deck";
    ov().querySelector<HTMLInputElement>(".form-path")!.value = "/p";
  };

  it("off by default for a new workspace", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker ?? null).toBeNull();
  });

  it("in-project root produces a project provider", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=project]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker).toEqual({ providers: [{ type: "fs", root: { kind: "project" } }] });
  });

  it("external root carries the path the user typed", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-path")!.value = "/home/u/vault/Tasks";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker).toEqual({
      providers: [{ type: "fs", root: { kind: "path", path: "/home/u/vault/Tasks" } }],
    });
  });

  it("an external root with an empty path keeps the modal open", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    // An empty path is a typo, not "off": the form stays open.
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("fills the tracker root via its own pickFolder button", async () => {
    pickFolderMock.mockResolvedValueOnce("/home/u/vault/Tasks");
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    ov().querySelector<HTMLButtonElement>(".tk-f-pick")!.click();
    await Promise.resolve();
    expect(ov().querySelector<HTMLInputElement>(".tk-f-path")!.value).toBe("/home/u/vault/Tasks");
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.tracker).toEqual({
      providers: [{ type: "fs", root: { kind: "path", path: "/home/u/vault/Tasks" } }],
    });
  });

  // The pick button sits beside the field inside one row. Toggling visibility on
  // the field alone left the button stranded on an otherwise empty line.
  it("hides the pick button together with the tracker path field", () => {
    workspaceForm();
    const row = () => ov().querySelector<HTMLElement>(".tk-f-path")!.closest(".form-pathrow")!;
    expect(row().classList.contains("tk-hidden")).toBe(true);
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    expect(row().classList.contains("tk-hidden")).toBe(false);
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=project]")!.click();
    expect(row().classList.contains("tk-hidden")).toBe(true);
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
  });

  it("pre-fills from an existing workspace so editing does not wipe the config", async () => {
    const p = workspaceForm({
      name: "deck", path: "/p", color: "#61afef",
      tracker: { providers: [{ type: "fs", root: { kind: "path", path: "/v/T" } }] },
    });
    expect(ov().querySelector<HTMLInputElement>(".tk-f-on")!.checked).toBe(true);
    expect(ov().querySelector<HTMLInputElement>(".tk-f-path")!.value).toBe("/v/T");
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });

  it("still returns name/path/color unchanged", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.name).toBe("deck");
    expect(res?.path).toBe("/p");
    expect(typeof res?.color).toBe("string");
  });
});

describe("skillForm", () => {
  it("collects fields incl. multiline prompt and scope", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Fix";
    (document.querySelector(".form-prompt") as HTMLTextAreaElement).value = "line1\nline2";
    (document.querySelector(".form-scope") as HTMLInputElement).checked = true; // bind to workspace
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res).toMatchObject({ name: "Fix", prompt: "line1\nline2", workspaceId: "ws-1" });
    // An icon name now, not a glyph: the field is a picker over the sprite.
  expect(res!.icon).toBe("play");
  });

  it("returns schedule: null when “on a schedule” is off", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Fix";
    (document.querySelector(".form-prompt") as HTMLTextAreaElement).value = "go";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)!.schedule).toBeNull();
  });

  it("collects a weekly schedule with placeholder defaults", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Report";
    const prompt = document.querySelector(".form-prompt") as HTMLTextAreaElement;
    prompt.value = "status for {{branch}}";
    prompt.dispatchEvent(new Event("input")); // rebuilds the defaults sub-form
    (document.querySelector(".form-sched-enabled") as HTMLInputElement).checked = true;
    (document.querySelector(".form-sched-kind") as HTMLSelectElement).value = "weekly";
    (document.querySelector(".form-sched-weekday") as HTMLSelectElement).value = "1";
    (document.querySelector(".form-sched-hour") as HTMLInputElement).value = "8";
    (document.querySelector(".form-sched-minute") as HTMLInputElement).value = "30";
    (document.querySelector(".form-sched-def") as HTMLInputElement).value = "main";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res!.schedule).toEqual({
      preset: { kind: "weekly", weekday: 1, hour: 8, minute: 30 },
      defaults: { branch: "main" },
      enabled: true,
    });
  });

  it("blocks OK when an enabled schedule has a placeholder without a default", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Report";
    const prompt = document.querySelector(".form-prompt") as HTMLTextAreaElement;
    prompt.value = "status for {{branch}}";
    prompt.dispatchEvent(new Event("input"));
    (document.querySelector(".form-sched-enabled") as HTMLInputElement).checked = true;
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const err = document.querySelector(".form-sched-error") as HTMLElement;
    expect(err.style.display).toBe("");
    expect(err.textContent).toContain("branch");
    // Form is still open — resolve it so the promise doesn't dangle.
    (document.querySelector(".form-sched-def") as HTMLInputElement).value = "main";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)!.schedule!.defaults).toEqual({ branch: "main" });
  });

  it("prefills the schedule section when editing", async () => {
    const p = skillForm("ws-1", {
      name: "Report", icon: "▶", prompt: "go", workspaceId: "ws-1",
      schedule: { preset: { kind: "daily", hour: 7, minute: 15 }, defaults: {}, enabled: true },
    });
    expect((document.querySelector(".form-sched-enabled") as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector(".form-sched-kind") as HTMLSelectElement).value).toBe("daily");
    expect((document.querySelector(".form-sched-hour") as HTMLInputElement).value).toBe("7");
    expect((document.querySelector(".form-sched-minute") as HTMLInputElement).value).toBe("15");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });
});

describe("placeholderForm", () => {
  it("collects one value per name and resolves on OK", async () => {
    const p = placeholderForm(["branch", "ticket"]);
    const inputs = document.querySelectorAll<HTMLInputElement>(".form-ph");
    inputs[0].value = "feat/x";
    inputs[1].value = "JIRA-1";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toEqual({ branch: "feat/x", ticket: "JIRA-1" });
  });

  it("resolves null on cancel", async () => {
    const p = placeholderForm(["branch"]);
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });
});
