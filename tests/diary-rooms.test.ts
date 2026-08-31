// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mountRooms, RETIRE_NOTICE } from "../src/diary-rooms";

const rooms = vi.fn();
const save = vi.fn();
const retire = vi.fn();
const rename = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryRooms: () => rooms(),
  memorySaveRoom: (name: string, description: string) => save(name, description),
  memoryRetireRoom: (name: string) => retire(name),
  memoryRenameRoom: (from: string, to: string) => rename(from, to),
}));

const settled = () => new Promise((r) => setTimeout(r, 0));
let body: HTMLElement;

const fk = <T extends HTMLElement>(name: string) =>
  body.querySelector<T>(`[data-fk="${name}"]`)!;

beforeEach(() => {
  // Cleared, not just re-stubbed: every test mounts an editor, and a call count
  // carried over from the last one is what "called 9 times" looks like.
  vi.clearAllMocks();
  document.body.innerHTML = "";
  body = document.createElement("div");
  document.body.append(body);
  rooms.mockResolvedValue([
    { name: "reviewer", description: "what review keeps catching" },
    { name: "architect", description: "decisions that turned out wrong" },
  ]);
  save.mockResolvedValue("ok");
  retire.mockResolvedValue(true);
  rename.mockResolvedValue("ok");
});

describe("the diary rooms editor", () => {
  it("lists each room with the sentence a lesson is routed by", async () => {
    mountRooms(body);
    await settled();
    expect(fk<HTMLInputElement>("room-name-reviewer").value).toBe("reviewer");
    expect(fk<HTMLInputElement>("room-desc-reviewer").value).toBe("what review keeps catching");
    expect(fk<HTMLInputElement>("room-name-architect").value).toBe("architect");
  });

  /* The one thing here somebody could misread in a way that frightens them:
     "Remove" beside a year of lessons looks like a delete, and is not one. */
  it("says that removing a room keeps its lessons", async () => {
    mountRooms(body);
    await settled();
    expect(body.textContent).toContain(RETIRE_NOTICE);
    expect(RETIRE_NOTICE.toLowerCase()).toContain("keeps every lesson");
  });

  it("saves a changed description without being told to", async () => {
    mountRooms(body);
    await settled();
    const desc = fk<HTMLInputElement>("room-desc-reviewer");
    desc.value = "only what broke twice";
    desc.dispatchEvent(new Event("change"));
    await settled();
    expect(save).toHaveBeenCalledWith("reviewer", "only what broke twice");
  });

  it("does not write a description that has not changed", async () => {
    mountRooms(body);
    await settled();
    const desc = fk<HTMLInputElement>("room-desc-reviewer");
    desc.dispatchEvent(new Event("change"));
    await settled();
    expect(save).not.toHaveBeenCalled();
  });

  it("adds a room, and clears the row it was typed into", async () => {
    mountRooms(body);
    await settled();
    fk<HTMLInputElement>("room-new-name").value = "operator";
    fk<HTMLInputElement>("room-new-desc").value = "what breaks in production";
    fk<HTMLButtonElement>("room-add").click();
    await settled();
    expect(save).toHaveBeenCalledWith("operator", "what breaks in production");
    expect(fk<HTMLInputElement>("room-new-name").value).toBe("");
  });

  /* A room with no description is a room the model has nothing to route by. The
     backend refuses it; refusing here too means the message names the missing
     half rather than echoing an error. */
  it("refuses a room with no sentence, and says which half is missing", async () => {
    mountRooms(body);
    await settled();
    fk<HTMLInputElement>("room-new-name").value = "operator";
    fk<HTMLButtonElement>("room-add").click();
    await settled();
    expect(save).not.toHaveBeenCalled();
    expect(body.querySelector(".rooms-fault")?.textContent?.toLowerCase())
      .toContain("what belongs in it");
  });

  it("retires a room and re-reads the list", async () => {
    mountRooms(body);
    await settled();
    fk<HTMLButtonElement>("room-remove-reviewer").click();
    await settled();
    expect(retire).toHaveBeenCalledWith("reviewer");
    expect(rooms).toHaveBeenCalledTimes(2);
  });

  it("renames on Enter", async () => {
    mountRooms(body);
    await settled();
    const name = fk<HTMLInputElement>("room-name-reviewer");
    name.value = "code review";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settled();
    expect(rename).toHaveBeenCalledWith("reviewer", "code review");
  });

  it("renames on leaving the field", async () => {
    mountRooms(body);
    await settled();
    const name = fk<HTMLInputElement>("room-name-architect");
    name.value = "planner";
    name.dispatchEvent(new Event("blur"));
    await settled();
    expect(rename).toHaveBeenCalledWith("architect", "planner");
  });

  it("does not rename to nothing, and Escape puts the name back", async () => {
    mountRooms(body);
    await settled();
    const name = fk<HTMLInputElement>("room-name-reviewer");
    name.value = "   ";
    name.dispatchEvent(new Event("blur"));
    await settled();
    expect(rename).not.toHaveBeenCalled();
    expect(name.value).toBe("reviewer");

    name.value = "half typed";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(name.value).toBe("reviewer");
  });

  /* A rename that would merge two diaries is refused by the backend, and its
     reason is the one a person actually needs to read. */
  it("shows a refused rename in the row that caused it, and restores the name", async () => {
    rename.mockRejectedValue("architect already exists; renaming into it would merge two diaries");
    mountRooms(body);
    await settled();
    const name = fk<HTMLInputElement>("room-name-reviewer");
    name.value = "architect";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settled();
    const row = body.querySelector('[data-room="reviewer"]')!;
    expect(row.querySelector(".rooms-fault")?.textContent).toContain("merge two diaries");
    expect(name.value).toBe("reviewer");
  });

  /* No rooms is a working state and a consequential one: every lesson a capture
     produces is dropped, so the pane has to say so rather than look tidy. */
  it("says what no rooms means", async () => {
    rooms.mockResolvedValue([]);
    mountRooms(body);
    await settled();
    expect(body.textContent?.toLowerCase()).toContain("dropped");
  });

  it("reports a read it could not do rather than rendering an empty editor", async () => {
    rooms.mockRejectedValue("no memory directory");
    mountRooms(body);
    await settled();
    expect(body.textContent).toContain("could not be read");
    expect(body.querySelector('[data-fk="room-add"]')).toBeNull();
  });

  /* The settings window tears a section down when it closes, and a render that
     landed after that would write into a detached pane. */
  it("stops rendering once disposed", async () => {
    let release: (v: unknown) => void = () => {};
    rooms.mockReturnValue(new Promise((r) => { release = r; }));
    const view = mountRooms(body);
    view.dispose();
    release([{ name: "reviewer", description: "d" }]);
    await settled();
    expect(body.children.length).toBe(0);
  });
});
