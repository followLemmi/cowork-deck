// The diary rooms editor: what a lesson can be filed under, and what happens to
// a room that is retired.
//
// Diaries are why memory is worth more than per-project notes — a lesson learned
// in one repository reaching the next one — and a diary needs a room. The rooms
// are the person's, not the app's: the model routes a lesson by the description
// written here, so this pane is the only thing deciding where lessons go.
//
// Mounted rather than built inline, following `mountSync`, so the settings window
// stays a rail and a pane and this keeps its own tests.

import {
  memoryRenameRoom, memoryRetireRoom, memoryRooms, memorySaveRoom, type DiaryRoom,
} from "./ipc";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** What retiring a room does, said where the button is.
 *
 *  It is the one thing about this pane somebody could get wrong in a way that
 *  frightens them: "Remove" beside a year of lessons reads like a delete. It is
 *  not one — the notes stay on disk and stay searchable, and what stops is new
 *  lessons being routed there. */
export const RETIRE_NOTICE =
  "Removing a room keeps every lesson already in it — they stay on disk and stay "
  + "searchable. What stops is new lessons being filed there.";

export interface RoomsView {
  dispose: () => void;
}

/** Build the editor into `body`. */
export function mountRooms(body: HTMLElement): RoomsView {
  let gone = false;

  const render = async () => {
    if (gone) return;
    let rooms: DiaryRoom[];
    try {
      rooms = await memoryRooms();
    } catch (e) {
      body.replaceChildren(el("p", "form-hint", `The diary rooms could not be read (${e}).`));
      return;
    }
    if (gone) return;
    body.replaceChildren();

    const list = el("div", "rooms-list");
    for (const room of rooms) list.append(row(room, render));
    if (rooms.length === 0) {
      list.append(el("p", "form-hint", "No rooms, so lessons a session offers are dropped."));
    }
    body.append(list, addRow(render), el("p", "form-hint", RETIRE_NOTICE));
  };

  void render();
  return {
    dispose: () => {
      gone = true;
    },
  };
}

/** Show a fault where it happened rather than in an alert. A rename that would
 *  merge two diaries is the one a person needs to read. */
function fault(host: HTMLElement, message: string) {
  host.querySelector(".rooms-fault")?.remove();
  host.append(el("p", "rooms-fault form-hint", message));
}

function row(room: DiaryRoom, refresh: () => Promise<void>): HTMLElement {
  const wrap = el("div", "rooms-row");
  wrap.dataset.room = room.name;

  /* The name is an input because renaming a room is a real operation with a real
     guarantee behind it: the directory moves, so the lessons move with it and no
     split diary is left behind. Committed on Enter and on blur, like the tile
     rename. */
  const name = el("input", "rooms-name");
  name.type = "text";
  name.value = room.name;
  name.dataset.fk = `room-name-${room.name}`;
  name.setAttribute("aria-label", `Name of the ${room.name} room`);
  let renaming = false;
  const commitName = async () => {
    const next = name.value.trim();
    if (renaming || next === room.name) return;
    if (next === "") {
      name.value = room.name;
      return;
    }
    renaming = true;
    try {
      await memoryRenameRoom(room.name, next);
      await refresh();
    } catch (e) {
      name.value = room.name;
      fault(wrap, String(e));
    } finally {
      renaming = false;
    }
  };
  name.onblur = () => void commitName();
  name.onkeydown = (e) => {
    if (e.key === "Enter") void commitName();
    if (e.key === "Escape") name.value = room.name;
  };

  const description = el("input", "rooms-desc");
  description.type = "text";
  description.value = room.description;
  description.dataset.fk = `room-desc-${room.name}`;
  description.setAttribute("aria-label", `What belongs in the ${room.name} room`);
  description.placeholder = "What belongs in this room";
  const commitDescription = async () => {
    const next = description.value.trim();
    if (next === room.description || next === "") return;
    try {
      await memorySaveRoom(room.name, next);
    } catch (e) {
      description.value = room.description;
      fault(wrap, String(e));
    }
  };
  description.onchange = () => void commitDescription();

  const remove = el("button", "rooms-remove", "Remove");
  remove.type = "button";
  remove.dataset.fk = `room-remove-${room.name}`;
  remove.setAttribute("aria-label", `Remove the ${room.name} room`);
  remove.onclick = () => {
    void memoryRetireRoom(room.name)
      .then(() => refresh())
      .catch((e) => fault(wrap, String(e)));
  };

  wrap.append(name, description, remove);
  return wrap;
}

function addRow(refresh: () => Promise<void>): HTMLElement {
  const wrap = el("div", "rooms-row rooms-row--add");

  const name = el("input", "rooms-name");
  name.type = "text";
  name.placeholder = "New room";
  name.dataset.fk = "room-new-name";
  name.setAttribute("aria-label", "Name of a new room");

  const description = el("input", "rooms-desc");
  description.type = "text";
  description.placeholder = "What belongs in it";
  description.dataset.fk = "room-new-desc";
  description.setAttribute("aria-label", "What belongs in the new room");

  const add = el("button", "rooms-add", "Add");
  add.type = "button";
  add.dataset.fk = "room-add";
  const submit = () => {
    /* Both, before anything is written. A room with no description is a room the
       model has nothing to route by, so the backend refuses it — refusing here
       too means the message names the missing half instead of echoing an error. */
    if (!name.value.trim() || !description.value.trim()) {
      fault(wrap, "A room needs a name and a sentence saying what belongs in it.");
      return;
    }
    void memorySaveRoom(name.value.trim(), description.value.trim())
      .then(() => {
        name.value = "";
        description.value = "";
        return refresh();
      })
      .catch((e) => fault(wrap, String(e)));
  };
  add.onclick = submit;
  for (const input of [name, description]) {
    input.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
  }

  wrap.append(name, description, add);
  return wrap;
}
