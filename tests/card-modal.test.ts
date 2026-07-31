// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computePatch, openCardModal, type CardFormValues } from "../src/card-modal";
import type { BoardConfig, Task } from "../src/ipc";

const original: Task = {
  id: "1", title: "Original", kind: "task", status: "todo", project: "p",
  created: "2026-07-01T00:00:00Z", resolved: null, origin: "human", session: null,
  body: "Body.\n", path: "/t/1.md", damaged: null, conflict: false, labels: [],
};
const same = (): CardFormValues =>
  ({ title: "Original", kind: "task", status: "todo", body: "Body.\n" });

// Used by the DOM tests in step 7. This file is new, so it declares its own.
const CFG: BoardConfig = {
  v: 1,
  steps: [
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing", working: true },
    { id: "done", label: "Done", terminal: true },
  ],
  kinds: [{ id: "bug", label: "Bug" }, { id: "task", label: "Task" }],
};

describe("computePatch", () => {
  it("is empty when nothing was touched", () => {
    expect(computePatch(original, same())).toEqual({});
  });

  it("carries only the field that changed", () => {
    expect(computePatch(original, { ...same(), title: "Renamed" })).toEqual({ title: "Renamed" });
    expect(computePatch(original, { ...same(), status: "done" })).toEqual({ status: "done" });
  });

  it("carries several changes together", () => {
    expect(computePatch(original, { ...same(), kind: "bug", body: "New.\n" }))
      .toEqual({ kind: "bug", body: "New.\n" });
  });

  it("does not send a step the person never touched", () => {
    // The point of the whole exercise: an agent may have moved the card while
    // the modal was open, and sending the step back would undo that.
    const patch = computePatch(original, { ...same(), title: "Renamed" });
    expect(patch.status).toBeUndefined();
  });

  it("treats a trimmed-to-identical title as untouched", () => {
    expect(computePatch(original, { ...same(), title: "  Original  " })).toEqual({});
  });

  it("sends an emptied body as an empty string, not as untouched", () => {
    expect(computePatch(original, { ...same(), body: "" })).toEqual({ body: "" });
  });

  it("treats a CRLF-vs-LF body as untouched, since a textarea always hands back LF", () => {
    // A <textarea>'s `.value` normalises newlines to LF whatever the file used,
    // so a CRLF card would otherwise report its body changed the instant it was
    // opened — and renaming such a card would ship `body` too, overwriting
    // whatever an agent or a sync wrote to it meanwhile, and leave the file with
    // a CRLF frontmatter block and an LF body. The Rust side preserves CRLF on
    // purpose; the frontend must not defeat that.
    const crlf: Task = { ...original, body: "Line one.\r\nLine two.\r\n" };
    const edited: CardFormValues = { ...same(), body: "Line one.\nLine two.\n" };
    expect(computePatch(crlf, edited)).toEqual({});
  });

  it("sends a real edit to a CRLF card back with CRLF throughout, not mixed with the file", () => {
    // A textarea can only ever hand back LF. Sending that verbatim on a genuine
    // edit would leave a CRLF frontmatter block next to an LF body — this is the
    // first path in the app that rewrites a body at all, so that mismatch would
    // be introduced by this feature, not inherited from anywhere.
    const crlf: Task = { ...original, body: "Line one.\r\nLine two.\r\n" };
    const edited: CardFormValues = { ...same(), body: "Line one.\nChanged.\n" };
    expect(computePatch(crlf, edited)).toEqual({ body: "Line one.\r\nChanged.\r\n" });
  });

  it("does not double up a stray \\r\\n already in the edited value into \\r\\r\\n", () => {
    // Normalise first, then re-expand: if the re-expansion ran on the raw edited
    // value instead of the normalised one, a value that already contained a
    // \r\n (however it got there) would gain a second \r in front of its \n.
    const crlf: Task = { ...original, body: "Line one.\r\nLine two.\r\n" };
    const edited: CardFormValues = { ...same(), body: "Line one.\r\nChanged.\n" };
    expect(computePatch(crlf, edited)).toEqual({ body: "Line one.\r\nChanged.\r\n" });
  });

  it("sends a real edit to an LF card as LF, unchanged", () => {
    expect(computePatch(original, { ...same(), body: "Body two.\n" })).toEqual({ body: "Body two.\n" });
  });
});

describe("openCardModal", () => {
  it("offers a card's unknown step as the selected option", () => {
    // Rendered, not resolved: the modal is how an unknown-step card gets out,
    // and it must not silently pick a different step on the way.
    const p = openCardModal({ ...original, status: "legacy" }, CFG, true);
    const step = document.querySelector<HTMLSelectElement>(".tk-c-step")!;
    expect(step.value).toBe("legacy");
    expect(step.options[0].textContent).toContain("not in board.json");
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });

  it("disables everything and offers no Save for a damaged card", () => {
    const p = openCardModal({ ...original, damaged: "no created field" }, CFG, false);
    expect(document.querySelector<HTMLInputElement>(".tk-c-title")!.disabled).toBe(true);
    expect(document.querySelector(".tk-c-broken")!.textContent).toContain("no created field");
    expect(document.querySelector(".modal-ok")).toBeNull();
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });

  it("focuses something reachable when the card cannot be written", () => {
    // Focusing the (now disabled) title input is a no-op, and `FOCUSABLE`
    // excludes disabled controls, so nothing takes focus unless something else
    // is focused explicitly — leaving it on the card's title button *behind*
    // the overlay, where Space (unlike Enter) is not intercepted and reopens
    // a second modal on top of the first.
    const p = openCardModal({ ...original, damaged: "no created field" }, CFG, false);
    const overlay = document.querySelector(".modal-overlay")!;
    expect(overlay.contains(document.activeElement)).toBe(true);
    document.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    return expect(p).resolves.toBeNull();
  });

  it("resolves with the values the form holds when Save is clicked", async () => {
    // The one seam `computePatch`'s pure tests structurally cannot reach: every
    // one of them hand-builds its input, so a `kind`/`status` transposition in
    // `submit`'s object literal — `StepId` and `KindId` are both `string`, so it
    // would typecheck — would ship a step id as a kind and go unnoticed.
    const p = openCardModal(original, CFG, true);
    const ov = document.querySelector(".modal-overlay")!;
    ov.querySelector<HTMLInputElement>(".tk-c-title")!.value = "Renamed";
    ov.querySelector<HTMLSelectElement>(".tk-c-kind")!.value = "bug";
    ov.querySelector<HTMLSelectElement>(".tk-c-step")!.value = "doing";
    ov.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const edited = await p;
    expect(edited).toEqual({ title: "Renamed", kind: "bug", status: "doing", body: "Body.\n" });
    expect(computePatch(original, edited!)).toEqual({ title: "Renamed", kind: "bug", status: "doing" });
  });
});
