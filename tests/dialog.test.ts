// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { pickFolder } from "../src/dialog";

describe("pickFolder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the selected directory path", async () => {
    openMock.mockResolvedValueOnce("/Users/me/proj");
    expect(await pickFolder()).toBe("/Users/me/proj");
    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it("returns null when cancelled", async () => {
    openMock.mockResolvedValueOnce(null);
    expect(await pickFolder()).toBeNull();
  });
});
