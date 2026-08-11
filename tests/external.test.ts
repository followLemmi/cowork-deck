// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { externalUrl, openExternal, wireExternal } from "../src/external";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const anchor = () => document.createElement("a");

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("externalUrl", () => {
  it("accepts http and https", () => {
    expect(externalUrl("https://github.com/cli/cli#installation"))
      .toBe("https://github.com/cli/cli#installation");
    expect(externalUrl("http://localhost:1420/x?y=1")).toBe("http://localhost:1420/x?y=1");
  });

  // Each of these is a scheme the OS would act on if it were handed one.
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.test",
    "tel:+15550100",
    "vscode://file/etc/passwd",
  ])("refuses %s", (raw) => {
    expect(externalUrl(raw)).toBeNull();
  });

  // A description's `[see](../CONTRIBUTING.md)` is relative to a repository
  // nothing on this side knows: there is no base to resolve it against.
  it("refuses a relative link rather than guessing a base", () => {
    expect(externalUrl("../CONTRIBUTING.md")).toBeNull();
    expect(externalUrl("#anchor")).toBeNull();
    expect(externalUrl("")).toBeNull();
  });

  it("normalises what it accepts", () => {
    expect(externalUrl("https://example.test")).toBe("https://example.test/");
  });
});

describe("openExternal", () => {
  it("hands an http(s) URL to the opener plugin", () => {
    openExternal("https://example.test/pr/7");
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://example.test/pr/7"]]);
  });

  // The point of the gate: a refused scheme must never reach the OS.
  it("never calls the plugin for a scheme it refuses", () => {
    openExternal("file:///etc/passwd");
    expect(openUrl).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("survives the plugin failing", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no browser"));
    expect(() => openExternal("https://example.test/")).not.toThrow();
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("wireExternal", () => {
  it("keeps the anchor a link and drops target", () => {
    const a = anchor();
    expect(wireExternal(a, "https://example.test/pr/7")).toBe(true);
    expect(a.href).toBe("https://example.test/pr/7");
    expect(a.rel).toBe("noreferrer");
    expect(a.target).toBe("");
  });

  // The bug this fixes: the click used to navigate (or rather, be dropped).
  it("opens on click instead of navigating", () => {
    const a = anchor();
    wireExternal(a, "https://example.test/pr/7");
    const e = new MouseEvent("click", { cancelable: true, bubbles: true });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://example.test/pr/7"]]);
  });

  // Middle click arrives as `auxclick`, and asks for a window this webview
  // cannot open. Same destination, same helper.
  it("opens on middle click", () => {
    const a = anchor();
    wireExternal(a, "https://example.test/pr/7");
    a.dispatchEvent(new MouseEvent("auxclick", { button: 1, cancelable: true, bubbles: true }));
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("ignores a right click", () => {
    const a = anchor();
    wireExternal(a, "https://example.test/pr/7");
    a.dispatchEvent(new MouseEvent("auxclick", { button: 2, cancelable: true, bubbles: true }));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves the anchor untouched when the URL is refused", () => {
    const a = anchor();
    expect(wireExternal(a, "javascript:alert(1)")).toBe(false);
    expect(a.getAttribute("href")).toBeNull();
    a.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
