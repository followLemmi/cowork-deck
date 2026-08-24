// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { emptyDeckCopy } from "../src/sessions";
import { ICON_NAMES } from "../src/icons";

// `#deck` is an empty element until a session exists, so the app's most likely first
// screen — and its screen every time the last session is closed — was an unexplained
// dark rectangle. These assert the part of the answer that is a decision rather than
// markup: which state it is, and which single action it offers.
describe("emptyDeckCopy", () => {
  it("asks for a workspace when there is none, because a session has nowhere to run", () => {
    // Offering "New session" here produces `Pick a workspace first.` in a modal — a
    // question answered by a refusal.
    const c = emptyDeckCopy(null, false);
    expect(c.title).toBe("Add a workspace to start working");
    expect(c.action).toBe("Add a workspace");
    expect(c.body).toContain("project folder");
  });

  it("says pick rather than add when workspaces already exist", () => {
    const c = emptyDeckCopy(null, true);
    expect(c.title).toBe("Pick a workspace to start working");
    // The action is still the one this screen can perform: the sidebar does the picking.
    expect(c.action).toBe("Add another workspace");
  });

  it("names the workspace it is empty in, and offers a session", () => {
    const c = emptyDeckCopy("cowork-deck", true);
    expect(c.title).toBe("No sessions in cowork-deck");
    expect(c.action).toBe("New session");
    // The thing nobody knows, and the one that removes the fear of starting one.
    expect(c.body).toContain("scrollback stays on screen");
  });

  it("marks each state with a glyph the icon set actually has", () => {
    // The mark is drawn through `icon()`, which looks the name up in `PATHS`; a name that
    // is not in the sprite renders an empty symbol and the state loses the thing a person
    // looks at before reading. `folder` was added for exactly this and has no other caller.
    for (const c of [emptyDeckCopy(null, false), emptyDeckCopy("cowork-deck", true)]) {
      expect(ICON_NAMES).toContain(c.mark);
    }
  });
});
