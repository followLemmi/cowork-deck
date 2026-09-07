/** A drag handle that resizes one box, and the only one this app has.
 *
 *  Five surfaces are resized by dragging a grip: the app's panel, the tool panel
 *  inside a zoomed tile, the workspace page, the terminal drawer's height and the
 *  diff pane's width. They were three implementations (#424) — this one, a
 *  hand-rolled `wireGrip` in `drawer.ts`, and the diff drawer's own wiring on
 *  `startDrag` — and each was missing something a different one had. That is what
 *  three copies of "pointerdown, capture, move, release, persist" costs: not
 *  duplication, but a set of surfaces that behave differently for no reason
 *  anybody chose.
 *
 *  What it insists on, and which copy was missing it:
 *
 *  · **Keys as well as a pointer.** A drag is the only gesture in this app with no
 *    keyboard equivalent unless one is written, and a panel somebody cannot resize
 *    with a keyboard is a panel they cannot resize. All three had this.
 *  · **`role="separator"` with the VALUE on it.** A focusable separator is a
 *    *window splitter*, and the value it reports is what tells a screen reader
 *    what the arrow keys just did. `drawer.ts`'s grip had the role and the
 *    orientation and no `aria-valuenow`, `aria-valuemin` or `aria-valuemax` — so
 *    it announced itself as a splitter and then said nothing about where it was.
 *  · **One layout read per gesture, one write per frame.** Through `startDrag`,
 *    whose own note is the long version: a write followed by a read inside
 *    `pointermove` forces a synchronous layout per event, and against the diff's
 *    2500 rows that is 15–28 ms — three to four frames of budget, per event, and
 *    the events arrive faster than the frames. Only the diff drawer had this.
 *  · **The commit is separate from the write.** Dragging writes on every frame;
 *    the number is stored once, at the end. A save per frame is a file write per
 *    frame.
 *
 *  A `div` and not a `button`: `separator` is not among the roles a `<button>` may
 *  take, and the platform's own splitters are not buttons either.
 */
import { startDrag } from "./drag";

/** Which way the pointer travels to make the box BIGGER.
 *
 *  Stated as a direction rather than an axis because that is what a caller knows
 *  about its own layout, and the axis follows from it. */
export type Grow = "left" | "right" | "up" | "down";

export interface ResizeSpec {
  grip: HTMLElement;
  grow: Grow;
  /** The box's size now, in whatever unit this grip works in. */
  read: () => number;
  /** Where the size may land. Clamped here, so no caller has to remember. */
  min: number;
  max: () => number;
  /** Apply a size. Called at most once a frame during a drag.
   *
   *  **Must not read layout** — see `startDrag`. */
  write: (value: number) => void;
  /** Remember a size. Called once, when the gesture ends. */
  commit: (value: number) => void;
  /** For an accessible name that says which panel this splits. */
  label: string;
  /** How much one arrow key moves it. Defaults to 16, one step of the app's
   *  spacing, which is right for a grip working in pixels and wrong for one
   *  working in anything else. */
  step?: number;
  /** How many pixels of pointer travel one unit is worth. 1 for a grip working in
   *  pixels, which is most of them; the diff pane works in `ch` and passes the
   *  measured width of one. */
  unitPx?: () => number;
  /** The reading in words. `aria-valuenow` alone is read as a bare number, and
   *  "62" is not a width — so a grip whose unit is not pixels says what it is. */
  valueText?: (value: number) => string;
  /** Run once when a gesture is accepted, paired with `commit`.
   *
   *  For a caller that has to freeze a measurement for the length of the drag:
   *  the diff pane answers `unitPx` and its own layout questions from a snapshot
   *  while a pointer is down, because reading them back would force the very
   *  layout `startDrag` exists to avoid. Symmetric with `commit`, which runs if
   *  and only if a gesture began. */
  beginGesture?: () => void;
  /** When a held arrow key persists.
   *
   *  `"each"` (the default) commits on every press, which is right where the
   *  commit is a cheap state write. `"keyup"` commits once when the key comes
   *  back up, for a surface where it is not: the diff pane's commit refits a
   *  2500-row grid, and a held arrow would do that per repeat. */
  commitOn?: "each" | "keyup";
}

export function wireResizer(spec: ResizeSpec): void {
  const { grip, grow, read, min, max, write, commit, label } = spec;
  const step = spec.step ?? 16;
  const unitPx = spec.unitPx ?? (() => 1);
  const vertical = grow === "left" || grow === "right";
  const clamp = (v: number) => Math.max(min, Math.min(max(), v));

  grip.setAttribute("role", "separator");
  /* `aria-orientation` describes the SEPARATOR, not the drag: a separator between
     two side-by-side boxes is a vertical line, and it is dragged horizontally. */
  grip.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
  grip.setAttribute("aria-label", label);
  grip.tabIndex = 0;

  /** The reading a screen reader gets, and the reason the min and max are on it:
   *  "340" alone says nothing about how much room is left. */
  const report = (value: number) => {
    grip.setAttribute("aria-valuenow", String(Math.round(value)));
    grip.setAttribute("aria-valuemin", String(min));
    grip.setAttribute("aria-valuemax", String(Math.round(max())));
    if (spec.valueText) grip.setAttribute("aria-valuetext", spec.valueText(value));
  };
  report(read());

  /** The size the last frame of a drag settled on, so `commit` stores what the
   *  pointer was released at rather than re-reading a layout that `write` may
   *  have expressed in a unit this module does not know. */
  let last = read();

  const apply = (value: number) => {
    const next = clamp(value);
    write(next);
    report(next);
    last = next;
    return next;
  };

  grip.addEventListener("pointerdown", (e) => {
    /** Read once, before the gesture: the size it started at, and how many pixels
     *  one unit is worth. Neither can change while a pointer is down unless the
     *  window is resized, and every caller here already watches for that. */
    const began = startDrag<{ from: number; per: number; at: { x: number; y: number } }>(
      grip,
      e,
      {
        measure: () => {
          spec.beginGesture?.();
          const per = unitPx();
          // No layout, no drag: jsdom reports zero for every box, and a delta
          // divided by a zero-width unit would set a size to NaN.
          if (!Number.isFinite(per) || per <= 0) return null;
          return { from: read(), per, at: { x: e.clientX, y: e.clientY } };
        },
        apply: (ctx, at) => {
          const travel = vertical ? at.x - ctx.at.x : at.y - ctx.at.y;
          const towards = grow === "right" || grow === "down" ? travel : -travel;
          // From the size the gesture STARTED at, every frame — not from the
          // last one. An incremental sum drifts, and a clamp at either end would
          // make the drift permanent: the pointer would come back off the stop
          // with the box somewhere it never was.
          apply(ctx.from + towards / ctx.per);
        },
        commit: () => {
          grip.classList.remove("is-dragging");
          commit(last);
        },
      },
    );
    if (!began) return;
    grip.classList.add("is-dragging");
  });

  /** Arrow keys held down, when `commitOn` is `"keyup"`. A set rather than a
   *  boolean: left and right can both be down. */
  const held = new Set<string>();

  grip.addEventListener("keydown", (e) => {
    /* Left and right whichever side the grip is on, up and down whichever way it
       grows: the keys mean "move this edge that way", which is what a person
       watching the edge expects — rather than "make it bigger/smaller", a mapping
       that would invert between two panels and be wrong on one of them. */
    const dir = vertical
      ? e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
      : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    /* `Home` and `End` are part of a window splitter's keyboard contract, not an
       extra: WAI-ARIA gives them as "move to the minimum" and "move to the
       maximum", and on a panel that takes fifty presses to cross they are the
       difference between a reachable end and a theoretical one. They were on the
       diff pane's grip alone before #424 — which is the shape of the whole
       finding: each copy had something the others did not. */
    const end = e.key === "Home" ? min : e.key === "End" ? max() : null;
    if (dir === 0 && end === null) return;
    e.preventDefault();
    const towards = grow === "right" || grow === "down" ? dir : -dir;
    const next = end !== null ? apply(end) : apply(read() + towards * step);
    if (spec.commitOn === "keyup") held.add(e.key);
    else commit(next);
  });

  grip.addEventListener("keyup", (e) => {
    if (!held.delete(e.key)) return;
    commit(read());
  });
}
