/** A drag handle that resizes one box along the horizontal axis.
 *
 *  Two panels in this app can be dragged — the app's panel on the left, and the
 *  tool panel inside a zoomed tile — and the terminal drawer and the diff drawer
 *  each grew their own handle before either existed. This is the one they should
 *  have shared: three copies of "pointerdown, capture, move, release, persist" is
 *  three places for the keyboard half to be forgotten in, and it was forgotten in
 *  two of them.
 *
 *  What it insists on:
 *
 *  · **Keys as well as a pointer.** A drag is the only gesture in this app with no
 *    keyboard equivalent unless one is written, and a panel somebody cannot resize
 *    with a keyboard is a panel they cannot resize.
 *  · **`role="separator"` with the value on it.** A separator that is focusable is
 *    a *window splitter*, and the value it reports is what tells a screen reader
 *    what the arrow keys just did. A `<button>` would be wrong: the role is not one
 *    a button may take.
 *  · **The commit is separate from the write.** Dragging writes on every frame;
 *    the number is stored once, at the end. A save per frame is a file write per
 *    frame.
 */
export interface ResizeSpec {
  grip: HTMLElement;
  /** Which direction the pointer travels to make the box BIGGER. */
  grow: "left" | "right";
  /** The box's width now, in px. */
  read: () => number;
  /** Where the width may land. Clamped here, so no caller has to remember. */
  min: number;
  max: () => number;
  /** Apply a width. Called on every frame of a drag. */
  write: (px: number) => void;
  /** Remember a width. Called once, when the gesture ends. */
  commit: (px: number) => void;
  /** For an accessible name that says which panel this splits. */
  label: string;
  /** How much one arrow key moves it. 16px is one step of the app's spacing. */
  step?: number;
}

export function wireResizer(spec: ResizeSpec): void {
  const { grip, grow, read, min, max, write, commit, label } = spec;
  const step = spec.step ?? 16;
  const clamp = (px: number) => Math.max(min, Math.min(max(), px));

  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", label);
  grip.tabIndex = 0;

  /** The reading a screen reader gets, and the reason the min and max are on it:
   *  "340" alone says nothing about how much room is left. */
  const report = (px: number) => {
    grip.setAttribute("aria-valuenow", String(Math.round(px)));
    grip.setAttribute("aria-valuemin", String(min));
    grip.setAttribute("aria-valuemax", String(Math.round(max())));
  };
  report(read());

  const apply = (px: number) => {
    const next = clamp(px);
    write(next);
    report(next);
    return next;
  };

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("is-dragging");
    const startX = e.clientX;
    const startPx = read();
    let last = startPx;
    const move = (m: PointerEvent) => {
      const delta = grow === "right" ? m.clientX - startX : startX - m.clientX;
      last = apply(startPx + delta);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.classList.remove("is-dragging");
      commit(last);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  grip.addEventListener("keydown", (e) => {
    /* Left and right whichever side the grip is on: the keys mean "move this edge
       that way", which is what a person watching the edge expects, rather than
       "make it bigger/smaller" — a mapping that would invert between the two
       panels and be wrong on one of them. */
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const towards = grow === "right" ? dir : -dir;
    commit(apply(read() + towards * step));
  });
}
