// @vitest-environment jsdom
/** Writing into the corpus by hand.
 *
 *  Two shapes and three acts, and the shapes are why these are forms: `Facts.md`
 *  and a diary are append-only line records (ADR-0004), so a fact is marked and
 *  replaced rather than rewritten, and the date and the `[active]` marker are the
 *  app's to write — a form that let somebody type the marker would let somebody
 *  type it wrong, and `grep` is what reads the file. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addFactForm, addLessonForm, NO_ROOMS_NOTICE, replaceFactForm, SHORT_LINE_NOTICE,
} from "../src/memory-write";

const addFact = vi.fn();
const facts = vi.fn();
const supersede = vi.fn();
const rooms = vi.fn();
const addLesson = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryAddFact: (ws: string, f: string) => addFact(ws, f),
  memoryFacts: (ws: string) => facts(ws),
  memorySupersedeFact: (ws: string, o: string, r: string) => supersede(ws, o, r),
  memoryRooms: () => rooms(),
  memoryAddLesson: (l: unknown) => addLesson(l),
}));

const TARGET = { workspaceId: "ws-1", workspaceName: "cowork-deck" };
const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const box = () => document.querySelector<HTMLElement>(".modal-box");
const fk = <T extends HTMLElement>(n: string) => box()!.querySelector<T>(`[data-fk="${n}"]`)!;
const press = async (n: string) => { fk<HTMLButtonElement>(n).click(); await settled(); };

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  addFact.mockResolvedValue(undefined);
  facts.mockResolvedValue([
    { date: "2026-08-01", body: "the model — is — 479 MB" },
    { date: "2026-08-02", body: "memory — is — a port" },
  ]);
  supersede.mockResolvedValue(true);
  rooms.mockResolvedValue([{ name: "reviewer", description: "review lessons" }]);
  addLesson.mockResolvedValue(undefined);
});

describe("recording a fact", () => {
  it("writes the claim and nothing else, leaving the date and the marker to the app", async () => {
    const done = addFactForm(TARGET);
    await settled();
    fk<HTMLInputElement>("fact-body").value = "  the corpus root — is — the config directory  ";
    await press("memory-write-ok");

    expect(addFact).toHaveBeenCalledWith("ws-1", "the corpus root — is — the config directory");
    expect(await done).toBe(true);
    expect(box()).toBeNull();
  });

  /** The measured 120-letter floor. Somebody who writes one fact and cannot find
   *  it has met a threshold, not a bug (#375), and this is where it is said. */
  it("says why a line just written may not be searchable yet", async () => {
    void addFactForm(TARGET);
    await settled();
    expect(box()!.textContent).toContain(SHORT_LINE_NOTICE);
  });

  it("does not write an empty fact, and does not close on one", async () => {
    void addFactForm(TARGET);
    await settled();
    fk<HTMLInputElement>("fact-body").value = "   ";
    await press("memory-write-ok");
    expect(addFact).not.toHaveBeenCalled();
    expect(box()).not.toBeNull();
  });

  it("keeps the form open and says why when the write fails", async () => {
    addFact.mockRejectedValue("the corpus is read-only");
    void addFactForm(TARGET);
    await settled();
    fk<HTMLInputElement>("fact-body").value = "a — b — c";
    await press("memory-write-ok");
    expect(box()).not.toBeNull();
    expect(box()!.textContent).toContain("read-only");
  });
});

describe("replacing a fact", () => {
  /** Picked rather than typed: it has to match the file exactly, and asking
   *  somebody to retype a claim they can see is asking them to mistype it. */
  it("offers the facts that still stand and replaces the one picked", async () => {
    const done = replaceFactForm(TARGET);
    await settled();
    expect(facts).toHaveBeenCalledWith("ws-1");
    const picker = fk<HTMLSelectElement>("fact-old");
    expect([...picker.options].map((o) => o.value))
      .toEqual(["the model — is — 479 MB", "memory — is — a port"]);
    // The date is shown beside the claim, because "which of these two" is often
    // answered by when it was written.
    expect(picker.options[0].textContent).toContain("2026-08-01");

    picker.value = "memory — is — a port";
    fk<HTMLInputElement>("fact-new").value = "memory — is — a sidecar";
    await press("memory-write-ok");

    expect(supersede).toHaveBeenCalledWith("ws-1", "memory — is — a port", "memory — is — a sidecar");
    expect(await done).toBe(true);
  });

  /** "Replace" reads like an overwrite, and this is not one — the old line is
   *  marked and kept, which is what lets the corpus answer when a fact changed. */
  it("says the old line is marked rather than removed", async () => {
    void replaceFactForm(TARGET);
    await settled();
    expect(box()!.textContent).toContain("marked rather than removed");
  });

  /** The file moved under the form. Writing the replacement anyway would leave
   *  two active claims about the same thing. */
  it("writes nothing and says so when the fact is no longer there as it was", async () => {
    supersede.mockResolvedValue(false);
    void replaceFactForm(TARGET);
    await settled();
    fk<HTMLInputElement>("fact-new").value = "something else";
    await press("memory-write-ok");
    expect(box()).not.toBeNull();
    expect(box()!.textContent).toContain("no longer in the file as it was");
  });

  it("says there is nothing to replace rather than offering an empty picker", async () => {
    facts.mockResolvedValue([]);
    void replaceFactForm(TARGET);
    await settled();
    expect(fk<HTMLSelectElement>("fact-old").disabled).toBe(true);
    expect(fk<HTMLButtonElement>("memory-write-ok").disabled).toBe(true);
    expect(box()!.textContent).toContain("no facts recorded yet");
  });
});

describe("filing a lesson", () => {
  /** The room is the person's choice, and that is the whole difference from a
   *  capture: the model is asked which room only because nobody is there to ask. */
  it("files into the room the person picked, with the fields a diary has", async () => {
    const done = addLessonForm(TARGET);
    await settled();
    expect(fk<HTMLSelectElement>("lesson-room").value).toBe("reviewer");
    fk<HTMLSelectElement>("lesson-severity").value = "high";
    fk<HTMLInputElement>("lesson-category").value = "packaging";
    fk<HTMLTextAreaElement>("lesson-what").value = "the sidecar was staged for the host triple";
    fk<HTMLTextAreaElement>("lesson-avoid").value = "read the tauri target, not the host";
    await press("memory-write-ok");

    expect(addLesson).toHaveBeenCalledWith({
      room: "reviewer",
      workspace: "cowork-deck",
      severity: "high",
      category: "packaging",
      what: "the sidecar was staged for the host triple",
      avoid: "read the tauri target, not the host",
    });
    expect(await done).toBe(true);
  });

  it("shows a room's description beside its name, which is what a room is for", async () => {
    void addLessonForm(TARGET);
    await settled();
    expect(fk<HTMLSelectElement>("lesson-room").options[0].textContent)
      .toBe("reviewer — review lessons");
  });

  /** A person who has retired every room gets no re-seed, deliberately (#367). */
  it("says where rooms come back from rather than offering an empty picker", async () => {
    rooms.mockResolvedValue([]);
    void addLessonForm(TARGET);
    await settled();
    expect(fk<HTMLSelectElement>("lesson-room").disabled).toBe(true);
    expect(fk<HTMLButtonElement>("memory-write-ok").disabled).toBe(true);
    expect(box()!.textContent).toContain(NO_ROOMS_NOTICE);
  });

  it("does not file a lesson that does not say what happened", async () => {
    void addLessonForm(TARGET);
    await settled();
    fk<HTMLTextAreaElement>("lesson-avoid").value = "an answer to nothing";
    await press("memory-write-ok");
    expect(addLesson).not.toHaveBeenCalled();
    expect(box()).not.toBeNull();
  });
});
