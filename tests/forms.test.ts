// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock("../src/dialog", () => ({ pickFolder: pickFolderMock }));
vi.mock("@tauri-apps/api/core");

import { workspaceForm, skillForm, placeholderForm, mergeForm, closeIssueModal } from "../src/forms";
import { closeConfirmText } from "../src/issues";
import type { TrackerConfig } from "../src/ipc";
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

  /** `#rrggbb` as jsdom reports an inline `background`, so the assertion below can
   *  compare a resolved colour against the swatch that produced it. */
  const asRgb = (hex: string) => {
    const n = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    return `rgb(${r}, ${g}, ${b})`;
  };

  it("keeps the chosen color when the color label area is clicked", async () => {
    const p = workspaceForm();
    const swatches = [...document.querySelectorAll<HTMLButtonElement>(".form-swatch")];
    // Read from the DOM, never named. This assertion used to be
    // `expect(res.color).not.toBe("#61afef")` with "not reset to the first swatch"
    // beside it — and when the palette moved, that literal stopped referring to any
    // swatch at all, so the test passed without testing anything. Asserting the
    // positive against the swatch that was clicked cannot rot the same way.
    expect(swatches[0].getAttribute("aria-checked")).toBe("true");

    swatches[1].click(); // choose the second color
    const colorRow = [...document.querySelectorAll<HTMLElement>(".form-row")]
      .find((r) => r.querySelector(".form-swatches"))!;
    (colorRow.querySelector(".form-label") as HTMLElement).click(); // click label area
    (document.querySelector(".form-name") as HTMLInputElement).value = "n";
    (document.querySelector(".form-path") as HTMLInputElement).value = "/p";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;

    expect(asRgb(res!.color)).toBe(swatches[1].style.background);
    expect(asRgb(res!.color)).not.toBe(swatches[0].style.background);
    expect(swatches[1].getAttribute("aria-checked")).toBe("true");
    expect(swatches[0].getAttribute("aria-checked")).toBe("false");
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
    // Не «ни одного вызова»: форма спрашивает `gh_status` при открытии, чтобы
    // заполнить список аккаунтов. Молчать должен именно предпросмотр.
    expect(invoke).not.toHaveBeenCalledWith("tracker_root_preview", expect.anything());
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

  it("clears a preview already on screen when the next call fails", async () => {
    // What the failure path actually has to do is retract a path it has already
    // promised: a stale root left standing after the call that would have
    // corrected it failed is worse than no line at all. Starting from an empty
    // form would assert nothing, because nothing is rendered either way.
    vi.mocked(invoke).mockResolvedValueOnce({
      root: "/vault/cowork-deck-tasks/deck", creating: [], baseMissing: false,
    });
    void workspaceForm();
    fillTracker("/vault");
    await settle();
    expect(document.querySelector(".tk-f-preview-path")).not.toBeNull();

    vi.mocked(invoke).mockRejectedValueOnce(new Error("nope"));
    const tp = document.querySelector(".tk-f-path") as HTMLInputElement;
    tp.value = "/other";
    tp.dispatchEvent(new Event("input"));
    await settle();

    expect(document.querySelector(".tk-f-preview-path")).toBeNull();
    // And an explanatory line is still not worth failing a form over.
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

  // The preview explains the path field, so it belongs to that block's
  // visibility. Emptying it in the guard happens to have the same effect today;
  // only hiding it with the row makes the structure say so.
  it("hides the preview together with the tracker path block", () => {
    workspaceForm();
    const preview = () => ov().querySelector<HTMLElement>(".tk-f-preview")!;
    expect(preview().classList.contains("tk-hidden")).toBe(true);
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=path]")!.click();
    expect(preview().classList.contains("tk-hidden")).toBe(false);
    ov().querySelector<HTMLInputElement>(".tk-f-root[value=project]")!.click();
    expect(preview().classList.contains("tk-hidden")).toBe(true);
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
  });

  // A path that changes while you type is exactly the kind of update a screen
  // reader has to be told about, and exactly the kind it must not be
  // interrupted for.
  it("announces the preview politely rather than assertively", () => {
    workspaceForm();
    const preview = ov().querySelector<HTMLElement>(".tk-f-preview")!;
    expect(preview.getAttribute("aria-live")).toBe("polite");
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

  // A placeholder name is whatever somebody typed between braces, and the regex
  // takes any letters. An unguarded `prefill[n]` reaches through the prototype
  // and opens the field holding `function Object() { [native code] }`, which
  // goes into the prompt sent to claude if it is accepted unread. Ordinary
  // launches pass no prefill at all, so `{}` has to be as safe as a real one.
  it("does not prefill a field from Object.prototype", async () => {
    const p = placeholderForm(["constructor", "toString"]);
    const inputs = document.querySelectorAll<HTMLInputElement>(".form-ph");
    expect([...inputs].map((i) => i.value)).toEqual(["", ""]);
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });

  it("prefills from a recorded value of that name, though", async () => {
    const p = placeholderForm(["constructor"], { constructor: "v2" } as Record<string, string>);
    expect(document.querySelector<HTMLInputElement>(".form-ph")!.value).toBe("v2");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });
});

describe("mergeForm", () => {
  const pr = {
    number: 7, title: "fix the thing", headRefName: "fix/thing",
    baseRefName: "main", headRefOid: "abc1234def",
  } as never;

  it("offers only the strategies the repository allows", () => {
    void mergeForm(pr, {
      strategies: ["squash", "rebase"], default: "squash", repoDeletesBranch: false,
    });
    const values = [...document.querySelectorAll<HTMLInputElement>(".mg-strategy")]
      .map((i) => i.value);
    expect(values).toEqual(["squash", "rebase"]);
  });

  it("preselects the repository's default strategy", () => {
    void mergeForm(pr, {
      strategies: ["merge", "squash", "rebase"], default: "rebase", repoDeletesBranch: false,
    });
    const checked = [...document.querySelectorAll<HTMLInputElement>(".mg-strategy")]
      .filter((i) => i.checked).map((i) => i.value);
    expect(checked).toEqual(["rebase"]);
  });

  // What is being merged has to be identifiable from the dialog alone.
  it("shows the branch pair and the pinned commit", () => {
    void mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: false });
    const text = document.querySelector(".modal-box")!.textContent!;
    expect(text).toContain("fix/thing → main");
    expect(text).toContain("abc1234");
  });

  // The title comes off the network, so it is set as text and never parsed.
  it("shows the title as text, not markup", () => {
    void mergeForm(
      { ...(pr as object), title: "<img src=x onerror=alert(1)>" } as never,
      { strategies: ["squash"], default: "squash", repoDeletesBranch: false },
    );
    const box = document.querySelector(".modal-box")!;
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("states the repository's behaviour instead of offering a box that lies", () => {
    void mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: true });
    expect(document.querySelector(".mg-delete")).toBeNull();
    expect(document.querySelector(".mg-delete-note")!.textContent).toContain("deletes");
  });

  it("resolves the chosen strategy on OK", async () => {
    const p = mergeForm(pr, {
      strategies: ["merge", "squash"], default: "merge", repoDeletesBranch: false,
    });
    document.querySelectorAll<HTMLInputElement>(".mg-strategy")[1].checked = true;
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toEqual({ strategy: "squash", deleteBranch: false });
  });

  it("passes the branch deletion on when the box is ticked", async () => {
    const p = mergeForm(pr, {
      strategies: ["squash"], default: "squash", repoDeletesBranch: false,
    });
    document.querySelector<HTMLInputElement>(".mg-delete")!.checked = true;
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toEqual({ strategy: "squash", deleteBranch: true });
  });

  it("resolves null on cancel", async () => {
    const p = mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: false });
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });

  it("resolves null on Escape, leaving nothing merged", async () => {
    const p = mergeForm(pr, { strategies: ["squash"], default: "squash", repoDeletesBranch: false });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBeNull();
    expect(document.querySelector(".modal-box")).toBeNull();
  });
});

describe("workspaceForm — the github source", () => {
  const ov = () => document.querySelector<HTMLElement>(".modal-overlay")!;
  const overlays = () => [...document.querySelectorAll<HTMLElement>(".modal-overlay")];
  /// The confirmation opens *over* the form, so it is the last overlay. Scoped
  /// rather than taken by index from the front: `ov()` must keep meaning the form.
  const asked = () => { const all = overlays(); return all[all.length - 1]; };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const fill = () => {
    ov().querySelector<HTMLInputElement>(".form-name")!.value = "deck";
    ov().querySelector<HTMLInputElement>(".form-path")!.value = "/p";
  };
  const GH: TrackerConfig = { providers: [{ type: "github" }] };
  const FS_PATH: TrackerConfig = {
    providers: [{ type: "fs", root: { kind: "path", path: "/v/T" } }],
  };
  const editing = (tracker: TrackerConfig | null) =>
    ({ id: "w1", name: "deck", path: "/p", color: "#61afef", tracker });
  const radio = (value: string) =>
    ov().querySelector<HTMLInputElement>(`.tk-f-root[value=${value}]`)!;

  it("offers a third source and saves it as a github provider", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    radio("github").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)?.tracker).toEqual({ providers: [{ type: "github" }] });
  });

  /// Prefill, so editing a workspace's name does not silently drop its source.
  it("preselects github for a workspace already using it", async () => {
    const p = workspaceForm(editing(GH));
    expect(ov().querySelector<HTMLInputElement>(".tk-f-on")!.checked).toBe(true);
    expect(radio("github").checked).toBe(true);
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  /// **The defect this task exists to fix.** The prefill used to key on the
  /// presence of a `root`, which a GitHub provider has none of, so the checkbox
  /// came up unchecked and `submit` returned `tracker: null` — every edit, name
  /// and colour included, silently unconfigured the board.
  it("keeps a source it cannot show a folder for when only the name is edited", async () => {
    const p = workspaceForm(editing(GH));
    ov().querySelector<HTMLInputElement>(".form-name")!.value = "renamed";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const res = await p;
    expect(res?.name).toBe("renamed");
    expect(res?.tracker).toEqual({ providers: [{ type: "github" }] });
  });

  /// #117's whole purpose, one layer up: the store now keeps a source this build
  /// cannot read, and this form must not be the thing that deletes it. Returned
  /// as it arrived — including the fields this build knows nothing about — because
  /// reconstructing it would mean guessing what a newer build meant.
  it("carries a source this build does not recognise through untouched", async () => {
    const future = { providers: [{ type: "jira", board: 7 }] } as unknown as TrackerConfig;
    const p = workspaceForm(editing(future));
    // There is a tracker, so the checkbox is on…
    expect(ov().querySelector<HTMLInputElement>(".tk-f-on")!.checked).toBe(true);
    // …but no radio can represent it, so none is checked and the form says why.
    expect([...ov().querySelectorAll<HTMLInputElement>(".tk-f-root")].some((r) => r.checked))
      .toBe(false);
    expect(ov().querySelector(".tk-f-unknown")).not.toBeNull();
    ov().querySelector<HTMLInputElement>(".form-name")!.value = "renamed";
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)?.tracker).toEqual(future);
  });

  /// The path row and its preview belong to the folder choice alone: a GitHub
  /// tracker has no folder, and a picker for one would be a control that does
  /// nothing.
  it("hides the folder picker and the preview when github is chosen", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    radio("path").click();
    const row = ov().querySelector<HTMLElement>(".tk-f-path")!.closest(".form-pathrow")!;
    const preview = ov().querySelector<HTMLElement>(".tk-f-preview")!;
    expect(row.classList.contains("tk-hidden")).toBe(false);
    radio("github").click();
    expect(row.classList.contains("tk-hidden")).toBe(true);
    expect(preview.classList.contains("tk-hidden")).toBe(true);
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  /// Raised before the save. Afterwards the deck no longer knows the old root,
  /// and the sentence could not name it.
  it("warns with the card count and the full old path before switching away from a folder", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string) =>
      cmd === "tracker_open_count"
        ? Promise.resolve(3)
        : Promise.resolve({ root: "/v/T/deck", creating: [], baseMissing: false })) as never);
    const p = workspaceForm(editing(FS_PATH));
    await settle();               // the preview resolves the *old* root
    radio("github").click();      // which must not clear what it resolved
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    const text = asked().querySelector(".modal-title")!.textContent!;
    expect(text).toContain("3 open cards");
    expect(text).toContain("/v/T/deck");
    // The two halves that make it a decision rather than a scare: nothing is
    // deleted, and nothing is copied to GitHub either.
    expect(text).toContain("untouched");
    expect(text).toContain("nothing will copy");
    asked().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)?.tracker).toEqual({ providers: [{ type: "github" }] });
  });

  /// The path in the sentence is the *old* root, resolved from the workspace as
  /// stored. The preview on screen follows the editable name and path fields, so on
  /// a form where either was touched before the switch it names where the cards
  /// would have gone — and the warning would send the person to a folder that has
  /// none of them.
  it("names the folder the cards are in, not the one the form was last previewing", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string, args: { pickedPath?: string }) => {
      if (cmd === "tracker_open_count") return Promise.resolve(2);
      return Promise.resolve({
        root: `${args.pickedPath}/deck`, creating: [], baseMissing: false,
      });
    }) as never);
    const p = workspaceForm(editing(FS_PATH));
    await settle();
    // The person retargets the folder and then changes their mind about the whole
    // source — the preview has resolved /elsewhere by now.
    const tp = ov().querySelector<HTMLInputElement>(".tk-f-path")!;
    tp.value = "/elsewhere";
    tp.dispatchEvent(new Event("input"));
    await settle();
    expect(ov().querySelector(".tk-f-preview-path")!.textContent).toBe("/elsewhere/deck");
    radio("github").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    const text = asked().querySelector(".modal-title")!.textContent!;
    expect(text).toContain("/v/T/deck");
    expect(text).not.toContain("/elsewhere");
    asked().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await settle();
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  /// "any cards there" rather than a number: the count needs a directory read,
  /// and a read that fails must not block the save. The same is true of the path.
  it("says 'any cards there' and names no path when neither can be read", async () => {
    vi.mocked(invoke).mockImplementation((() => Promise.reject(new Error("nope"))) as never);
    const p = workspaceForm(editing(FS_PATH));
    await settle();
    radio("github").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    const text = asked().querySelector(".modal-title")!.textContent!;
    expect(text).toContain("any cards there");
    expect(text).toContain("its previous folder");
    asked().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)?.tracker).toEqual({ providers: [{ type: "github" }] });
  });

  /// Switching the other way needs no warning: there is nothing on GitHub that a
  /// folder-backed board could abandon.
  it("does not warn when switching from github to a folder", async () => {
    vi.mocked(invoke).mockImplementation((() =>
      Promise.resolve({ root: "/p/.cowork/tasks", creating: [], baseMissing: false })) as never);
    const p = workspaceForm(editing(GH));
    radio("project").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    expect(overlays().length).toBe(0);        // nothing was asked, the form closed
    expect(invoke).not.toHaveBeenCalledWith("tracker_open_count", expect.anything());
    expect((await p)?.tracker).toEqual({ providers: [{ type: "fs", root: { kind: "project" } }] });
  });

  /// And a new workspace has no folder to abandon either, so it is not asked.
  it("asks nothing when there was no folder in the first place", async () => {
    const p = workspaceForm();
    fill();
    ov().querySelector<HTMLInputElement>(".tk-f-on")!.click();
    radio("github").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    expect(overlays().length).toBe(0);
    expect(invoke).not.toHaveBeenCalledWith("tracker_open_count", expect.anything());
    await p;
  });

  /// Cancelling the confirmation leaves the form open with the source still
  /// selected, so the person can change their mind about the radio rather than
  /// starting over.
  it("keeps the form open when the confirmation is declined", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string) =>
      cmd === "tracker_open_count"
        ? Promise.resolve(1)
        : Promise.resolve({ root: "/v/T/deck", creating: [], baseMissing: false })) as never);
    const p = workspaceForm(editing(FS_PATH));
    await settle();
    radio("github").click();
    ov().querySelector<HTMLButtonElement>(".modal-ok")!.click();
    await settle();
    // One card, not "1 open cards".
    expect(asked().querySelector(".modal-title")!.textContent).toContain("1 open card in");
    asked().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await settle();
    expect(overlays().length).toBe(1);        // the form is still there…
    expect(radio("github").checked).toBe(true);  // …with the choice still made
    ov().querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });
});

describe("closeIssueModal", () => {
  /// The two literal strings `gh issue close -r` accepts, and nothing else:
  /// `gh_issues::close_reason` drops anything it does not recognise, so a third
  /// option here would be a close that silently lost its reason.
  it("offers exactly the two reasons gh accepts, with completed chosen", async () => {
    const p = closeIssueModal(42, "Sidebar badge sticks");
    const reasons = [...document.querySelectorAll<HTMLInputElement>(".ci-reason")];
    expect(reasons.map((r) => r.value)).toEqual(["completed", "not planned"]);
    expect(reasons.find((r) => r.checked)?.value).toBe("completed");
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toBe("completed");
  });

  it("returns the other reason when it is the one chosen", async () => {
    const p = closeIssueModal(42, "Sidebar badge sticks");
    document.querySelector<HTMLInputElement>(".ci-reason[value='not planned']")!.checked = true;
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect(await p).toBe("not planned");
  });

  /// The sentence is `closeConfirmText`'s, not a second copy: the rule's own test
  /// pins the wording, and this pins that the modal asks with it. Two copies of a
  /// warning drift, and this one is the only place the person is told the close is
  /// public.
  it("asks with the shared sentence, naming the issue and who sees it", async () => {
    const p = closeIssueModal(42, "Sidebar badge sticks");
    const asked = document.querySelector(".modal-title")!.textContent!;
    expect(asked).toBe(closeConfirmText(42, "Sidebar badge sticks"));
    expect(asked).toContain("#42");
    expect(asked).toContain("everyone in the repository");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    expect(await p).toBeNull();
  });

  /// Null, never a default reason: an unanswered confirmation must not close
  /// anything, and Escape is how a person says no to a dialog.
  it("resolves null on Escape, closing nothing", async () => {
    const p = closeIssueModal(7, "t");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBeNull();
    expect(document.querySelector(".modal-box")).toBeNull();
  });

  /// A title is the repository's text. Set with textContent like every other
  /// dialog's — `.modal-title` is built by `modal.ts`'s `title()` for the shared
  /// dialogs and here by hand, so it is worth an assertion rather than a reading.
  it("renders a title carrying markup as text", async () => {
    const p = closeIssueModal(9, "<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".modal-title")!.textContent)
      .toContain("<img src=x onerror=alert(1)>");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await p;
  });
});
