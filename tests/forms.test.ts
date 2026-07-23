// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickFolderMock } = vi.hoisted(() => ({ pickFolderMock: vi.fn() }));
vi.mock("../src/dialog", () => ({ pickFolder: pickFolderMock }));

import { workspaceForm, skillForm } from "../src/forms";

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
    expect(res!.icon).toBe("▶"); // default when empty
  });
});
