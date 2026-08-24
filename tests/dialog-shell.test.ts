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

  // Unless the textarea is one only in order to WRAP. The card dialog's title is one: an
  // issue title runs past what a single-line input can show, but a title has no second
  // line, so Enter there still means save.
  it("still accepts on Enter in a textarea that declares itself single-line", () => {
    const onAccept = vi.fn();
    const { box } = openDialog({ onCancel: () => {}, onAccept });
    const ta = document.createElement("textarea");
    ta.dataset.singleLine = "true";
    box.append(ta);
    press("Enter", ta);
    expect(onAccept).toHaveBeenCalledOnce();
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

  // Two startup checks can each open a dialog; every dialog listens on
  // document, so both hear one Enter. Only the top of the stack may act — a
  // user must not accept a dialog whose text they never read.
  it("routes keys to the top dialog only, then back down as dialogs close", () => {
    const bottomAccept = vi.fn();
    const topAccept = vi.fn();
    openDialog({ onCancel: () => {}, onAccept: bottomAccept });
    const top = openDialog({ onCancel: () => {}, onAccept: topAccept });

    press("Enter");
    expect(topAccept).toHaveBeenCalledOnce();
    expect(bottomAccept).not.toHaveBeenCalled();

    top.close();
    press("Enter");
    expect(bottomAccept).toHaveBeenCalledOnce();
    expect(topAccept).toHaveBeenCalledOnce();
  });

  it("stops listening once closed", () => {
    const onCancel = vi.fn();
    const { close } = openDialog({ onCancel, onAccept: () => {} });
    close();
    press("Escape");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
