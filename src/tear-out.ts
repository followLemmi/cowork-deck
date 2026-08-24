/** Dragging a workspace out of the window with the mouse.
 *
 *  **HTML5 drag-and-drop cannot do this.** `dragstart`/`drop` do not cross the
 *  boundary of a webview or an OS window — the drag simply never arrives
 *  anywhere. So this is a manual pointer-events drag with pointer capture, which
 *  is what browsers themselves use for tear-off tabs.
 *
 *  The decision is here, as a pure function of numbers, because the rest of the
 *  gesture is `setPointerCapture` and a window being created under a cursor —
 *  neither of which exists in jsdom, and the second of which cannot be checked
 *  anywhere but a real desktop.
 */

/** How far past the edge the pointer has to go before this counts as leaving.
 *
 *  Not zero. A pointer at `clientX === 0` is on the window's own edge, and the
 *  sidebar's rows start a few pixels from it — so a person tidying a row's
 *  position, or overshooting a click, would tear their workspace out. Far enough
 *  to be a decision, near enough that it does not feel like a shove.
 */
export const TEAR_OUT_MARGIN = 24;

export interface Viewport { width: number; height: number }

/** Has the pointer left the window it started in, by enough to mean it?
 *
 *  Pointer capture keeps delivering `pointermove` after the pointer leaves the
 *  window, and the coordinates simply go negative or past the far edge — which
 *  is the whole reason no polling of the cursor's global position is needed
 *  until the moment the window has to be placed.
 */
export function hasLeftWindow(x: number, y: number, view: Viewport): boolean {
  return x < -TEAR_OUT_MARGIN
    || y < -TEAR_OUT_MARGIN
    || x > view.width + TEAR_OUT_MARGIN
    || y > view.height + TEAR_OUT_MARGIN;
}

/** Whether a press should be treated as the start of a possible tear-out.
 *
 *  The primary button only, and never with a modifier held: a right-click opens
 *  a context menu, and a modified click is somebody's shortcut on some platform.
 *  A press that is not this is left entirely alone, so the row's ordinary click
 *  still selects the workspace — the gesture must cost nothing when it does not
 *  happen.
 */
export function startsTearOut(e: {
  button: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
}): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}
