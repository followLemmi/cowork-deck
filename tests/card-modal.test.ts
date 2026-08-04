// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  brokenReasons, cardFacts, computePatch, describePatch, openCardModal,
  type CardFormValues,
} from "../src/card-modal";
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

  /// One synthetic kind is not a choice, and an issue's kind is always empty —
  /// the same flag the ⚙ button reads, so the two cannot disagree about whether
  /// this board has kinds worth showing.
  it("hides the kind select when the board is not editable", async () => {
    const p = openCardModal(original, CFG, true, false);
    const ov = document.querySelector(".modal-overlay")!;
    expect(ov.querySelector(".tk-c-kind")).toBeNull();
    // And the step select stays: moving an issue between open and closed is the
    // one edit this modal is for on a GitHub board.
    expect(ov.querySelector(".tk-c-step")).not.toBeNull();
    ov.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
  });

  /// The half that matters for the write: a hidden control must not turn into an
  /// emptied field. A step-only edit on a board with no kind row has to produce a
  /// step-only patch, or every save would also blank the card's kind.
  it("sends no kind at all when the kind select is hidden", async () => {
    const p = openCardModal(original, CFG, true, false);
    const ov = document.querySelector(".modal-overlay")!;
    ov.querySelector<HTMLSelectElement>(".tk-c-step")!.value = "done";
    ov.querySelector<HTMLButtonElement>(".modal-ok")!.click();
    const edited = await p;
    expect(computePatch(original, edited!)).toEqual({ status: "done" });
  });

  it("keeps the kind select for a file-backed board", async () => {
    const p = openCardModal(original, CFG, true);
    const ov = document.querySelector(".modal-overlay")!;
    expect(ov.querySelector(".tk-c-kind")).not.toBeNull();
    ov.querySelector<HTMLButtonElement>(".modal-cancel")!.click();
    await expect(p).resolves.toBeNull();
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

// ---------------------------------------------------------------------------

describe("cardFacts", () => {
  const NOW = Date.parse("2026-07-04T00:00:00Z"); // three days after `original.created`

  it("puts the dates in a form a person reads, keeping the exact value", () => {
    const [, created] = cardFacts(original, NOW);
    expect(created.label).toBe("created");
    expect(created.value).toBe("3 d ago");
    // Nothing is lost: the timestamp survives as the row's tooltip.
    expect(created.title).toBe("2026-07-01T00:00:00Z");
  });

  it("gives no row to a value that is absent", () => {
    // `resolved: —` and `session: —` were two of six lines saying nothing. A row is a
    // claim, so the honest rendering of "there is no session" is no session row.
    const labels = cardFacts(original, NOW).map((f) => f.label);
    expect(labels).toEqual(["id", "created", "path"]);
    expect(labels).not.toContain("closed");
    expect(labels).not.toContain("session");
  });

  it("adds the rows a card has earned", () => {
    const labels = cardFacts({
      ...original, resolved: "2026-07-03T00:00:00Z", session: "s-7", origin: "session",
    }, NOW).map((f) => f.label);
    expect(labels).toEqual(["id", "created", "closed", "session", "filed by", "path"]);
  });

  it("stays silent about the ordinary origin", () => {
    // A person filing a card is the default; a session filing one is worth saying.
    expect(cardFacts(original, NOW).map((f) => f.label)).not.toContain("filed by");
  });

  it("marks identifiers as read character by character", () => {
    const mono = cardFacts({ ...original, session: "s-7" }, NOW)
      .filter((f) => f.mono).map((f) => f.label);
    expect(mono).toEqual(["id", "session", "path"]);
  });
});

describe("describePatch", () => {
  it("says so when there is nothing to write", () => {
    expect(describePatch(computePatch(original, same()))).toBe("Nothing changed yet.");
  });

  it("names the one field that changed", () => {
    expect(describePatch(computePatch(original, { ...same(), title: "New" })))
      .toBe("Save writes the title — nothing else.");
  });

  it("lists several, and the last one reads as the last", () => {
    const patch = computePatch(original, { ...same(), title: "New", status: "doing", body: "b" });
    expect(describePatch(patch)).toBe("Save writes the title, the step and the body — nothing else.");
  });

  it("names fields in a fixed order rather than in the order they were touched", () => {
    // Two edits made in opposite orders describe the same write, because the write is
    // the same. Key insertion order would have made the sentence depend on typing.
    const a = describePatch(computePatch(original, { ...same(), body: "b", title: "New" }));
    const b = describePatch(computePatch(original, { ...same(), title: "New", body: "b" }));
    expect(a).toBe(b);
  });

  it("is the sentence the dialog shows, so it cannot disagree with the save", () => {
    // Guards the one property that matters: the note and the patch come from the same
    // function, so a field that will be written can never be missing from the note.
    const edited = { ...same(), kind: "bug", body: "b" };
    const patch = computePatch(original, edited);
    for (const key of Object.keys(patch)) {
      const word = { title: "title", kind: "kind", status: "step", body: "body" }[key];
      expect(describePatch(patch)).toContain(word!);
    }
  });
});

describe("brokenReasons", () => {
  it("is empty for a healthy, writable card", () => {
    expect(brokenReasons(original, true)).toEqual([]);
  });

  it("returns each reason separately rather than one run-on line", () => {
    const reasons = brokenReasons(
      { ...original, damaged: "bad frontmatter", conflict: true }, false);
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toContain("bad frontmatter");
    expect(reasons[1]).toContain("More than one file");
    expect(reasons[2]).toContain("cannot be saved");
  });

  it("no longer carries the path, which the facts list owns", () => {
    // It used to sit in the middle of the joined message, which is the worst place for
    // the one thing a person needs in order to go and fix the file.
    expect(brokenReasons({ ...original, damaged: "x" }, false).join(" "))
      .not.toContain(original.path);
  });
});
