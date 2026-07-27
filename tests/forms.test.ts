// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock("../src/dialog", () => ({ pickFolder: pickFolderMock }));

import { workspaceForm, skillForm, placeholderForm } from "../src/forms";

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

  it("returns schedule: null when «по расписанию» is off", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Fix";
    (document.querySelector(".form-prompt") as HTMLTextAreaElement).value = "go";
    document.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    expect((await p)!.schedule).toBeNull();
  });

  it("collects a weekly schedule with placeholder defaults", async () => {
    const p = skillForm("ws-1");
    (document.querySelector(".form-name") as HTMLInputElement).value = "Отчёт";
    const prompt = document.querySelector(".form-prompt") as HTMLTextAreaElement;
    prompt.value = "статус по {{branch}}";
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
    (document.querySelector(".form-name") as HTMLInputElement).value = "Отчёт";
    const prompt = document.querySelector(".form-prompt") as HTMLTextAreaElement;
    prompt.value = "статус по {{branch}}";
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
      name: "Отчёт", icon: "▶", prompt: "go", workspaceId: "ws-1",
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
