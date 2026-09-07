/** Say, on the box itself, which way there is more.
 *
 *  A horizontally scrolling row is the one layout in this app that can be
 *  truncated with nothing on screen to say so. `.tk-cols` has had `overflow-x:
 *  auto` from the start and the board still read as three columns when it had
 *  five (#463): the third one showed a third of itself, and on macOS an overlay
 *  scrollbar is invisible until something is already scrolling. "There is more to
 *  the right" is not a thing a person can be expected to infer from a column
 *  ending mid-card.
 *
 *  So the box carries the answer as an attribute and the stylesheet draws it:
 *  `data-overflow` is `""`, `"right"`, `"left"` or `"both"`. A gradient rather
 *  than a permanent scrollbar, because the fade is only there while there IS
 *  more — a chrome that never changes is a chrome the eye stops reading, which is
 *  the whole reason a hidden scrollbar failed at this.
 *
 *  **Not a count.** "+2 columns" was considered and rejected: it answers "how
 *  many", which nobody asked, and it changes as you scroll, so it is a number
 *  that moves for a reason unrelated to the work. The fade answers the question
 *  actually being asked, which is "is that all of it".
 *
 *  Measured on scroll, on resize of the box, and whenever the caller says the
 *  content changed — the three ways the answer can move. `ResizeObserver` covers
 *  the window and the text-size control together, which a `window.resize`
 *  listener would not: the root font size changing does not resize the window.
 */
export interface OverflowWatch {
  /** Re-measure now. For a caller that has just replaced the content. */
  refresh: () => void;
  /** Stop watching. */
  stop: () => void;
}

/** How far from an edge still counts as being at it.
 *
 *  Not zero: `scrollWidth` and `clientWidth` are rounded to integers while the
 *  scroll position is fractional, so a box scrolled fully to the right can report
 *  half a pixel left to go — and a fade that never quite goes away is worse than
 *  none, because it says there is more when there is not. */
const EDGE_PX = 2;

export function watchOverflow(box: HTMLElement): OverflowWatch {
  const measure = () => {
    const more = box.scrollWidth - box.clientWidth - box.scrollLeft > EDGE_PX;
    const less = box.scrollLeft > EDGE_PX;
    const state = less && more ? "both" : more ? "right" : less ? "left" : "";
    // Written only when it changes: this runs on every scroll event, and an
    // attribute write invalidates style even when the value is identical.
    if (box.dataset.overflow !== state) box.dataset.overflow = state;
  };

  box.addEventListener("scroll", measure, { passive: true });

  // Absent in jsdom, where every box measures zero and there is nothing to
  // observe. The attribute is still written by `measure`, so a test can drive
  // this by hand through `refresh`.
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  ro?.observe(box);

  measure();
  return {
    refresh: measure,
    stop: () => {
      box.removeEventListener("scroll", measure);
      ro?.disconnect();
    },
  };
}
