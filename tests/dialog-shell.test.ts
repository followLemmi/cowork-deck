// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDialog } from "../src/dialog-shell";

beforeEach(() => { document.body.innerHTML = ""; });

const press = (key: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("openDialog", () => {
  it("marks itself up as a modal dialog", () => {
    const { box } = openDialog({ onCancel: () => {}, onAccept: () => {} });
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-modal")).toBe("true");
  });

  // Escape closed none of the six dialogs before this: the global handler bows
  // out while an overlay is open, and no dialog had one of its own.
  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    openDialog({ onCancel, onAccept: () => {} });
    press("Escape");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("accepts on Enter", () => {
    const onAccept = vi.fn();
    openDialog({ onCancel: () => {}, onAccept });
    press("Enter");
    expect(onAccept).toHaveBeenCalledOnce();
  });

  // Enter inside a textarea belongs to the textarea — a prompt is multi-line.
  it("leaves Enter alone inside a textarea", () => {
    const onAccept = vi.fn();
    const { box } = openDialog({ onCancel: () => {}, onAccept });
    const ta = document.createElement("textarea");
    box.append(ta);
    press("Enter", ta);
    expect(onAccept).not.toHaveBeenCalled();
  });

  // Tab used to walk out of the overlay into the sidebar and the terminal
  // underneath, where keystrokes went into a PTY the user could not see.
  it("keeps Tab inside the dialog", () => {
    const { box, close } = openDialog({ onCancel: () => {}, onAccept: () => {} });
    const first = document.createElement("button");
    const last = document.createElement("button");
    box.append(first, last);
    last.focus();

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(document.activeElement).toBe(first);
    close();
  });

  it("wraps backwards too", () => {
    const { box, close } = openDialog({ onCancel: () => {}, onAccept: () => {} });
    const first = document.createElement("button");
    const last = document.createElement("button");
    box.append(first, last);
    first.focus();

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));

    expect(document.activeElement).toBe(last);
    close();
  });

  // Closing used to drop focus on <body>, so the next Tab restarted from the
  // top of the document instead of where the user had been.
  it("returns focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { close } = openDialog({ onCancel: () => {}, onAccept: () => {} });
    close();

    expect(document.activeElement).toBe(opener);
  });

  it("stops listening once closed", () => {
    const onCancel = vi.fn();
    const { close } = openDialog({ onCancel, onAccept: () => {} });
    close();
    press("Escape");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
