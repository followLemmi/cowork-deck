/** The panel behind the status-area icon.
 *
 *  A window rather than a native menu, so a limit can be a meter and a waiting
 *  session can be a row you click — see ADR-0013. It draws with the deck's own
 *  stylesheet and, for the limits, with the deck's own `LimitsBlock`; what goes
 *  in it is `tray-panel.ts`'s `PANEL`, the one list both this and the Linux menu
 *  are built from.
 *
 *  This file is the window and nothing else: it receives the facts, hands them
 *  to the renderer, reports how tall the result is, and forwards a click. Every
 *  decision about what a row says is somewhere else, which is why there is
 *  almost nothing here to test.
 *
 *  Three things it owns, all of them about being a panel rather than a page:
 *
 *  - **It never routes an action itself.** A click emits `tray://action` and the
 *    deck answers — the deck is the only window that knows which window holds a
 *    session (#243). The same event the Linux menu emits, so there is one
 *    handler for both.
 *  - **It closes on anything that means "done".** Escape, and any action it
 *    forwards. Losing focus closes it too, and that one is Rust's, because a
 *    webview cannot see itself being deactivated reliably.
 *  - **It tells Rust how tall it is.** The height depends on how many providers
 *    and how many waiting sessions there are, and only the page that laid them
 *    out knows.
 */

import "./tray.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fillPanel } from "./tray-panel";
import { trayActivate, trayResize, type TrayFactsPayload } from "./ipc";
import { applyScale } from "./ui-scale";

const win = getCurrentWindow();
const shell = document.getElementById("tray")!;
const sections = document.getElementById("tray-sections")!;
const foot = document.querySelector<HTMLElement>(".tray-foot")!;

/** The last report. Kept so a resize or a scale change can redraw without
 *  waiting for the deck's next tick. */
let facts: TrayFactsPayload = { usage: [], sessions: [], scale: 1 };

/** Send a row's click to the deck, and get out of the way.
 *
 *  Hidden first, and not for tidiness: every action ends with a window being
 *  raised, and a panel still up in front of the window it just raised is the
 *  panel refusing to have been used.
 */
function act(action: string): void {
  void win.hide();
  void emit("tray://action", { action });
}

/** Draw the sections, keeping the two things a repaint must not take.
 *
 *  Every element in the panel is replaced on each draw — `fillPanel` starts by
 *  emptying the root, and each section builds a fresh `LimitsBlock` on a fresh
 *  body. `LimitsBlock`'s own focus and scroll bookkeeping therefore cannot help
 *  here: it reads the DOM it is about to replace, and the DOM it is handed is
 *  new every time. So the same rule is kept one level up, over the whole panel,
 *  keyed by what a control IS rather than by node — not one of these nodes lives
 *  to be focused again.
 *
 *  Without it, a session changing state anywhere in the deck returned a person
 *  reading the ninth row to the first, and threw the keyboard back to the top of
 *  the panel, while they were pointing at a row.
 */
function draw(): void {
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && shell.contains(active)
    ? active.dataset.focusKey ?? null
    : null;
  const scrollTop = sections.scrollTop;

  applyScale(facts.scale, document.documentElement);
  fillPanel(sections, { usage: facts.usage, sessions: facts.sessions, now: Date.now() }, act);

  sections.scrollTop = scrollTop;
  if (focusKey) refocus(focusKey);
  report();
}

/** Put the keyboard back on the control it was on. Matched by walking rather
 *  than by an attribute selector, for the reason `LimitsBlock.refocus` gives: a
 *  provider key and a session id are not escaped, and a selector built out of
 *  one would be the only place in this file that cared. `preventScroll`, because
 *  restoring focus is not a request to move the view. */
function refocus(key: string): void {
  for (const el of shell.querySelectorAll<HTMLElement>("[data-focus-key]")) {
    if (el.dataset.focusKey === key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

/** Tell Rust how tall the panel wants to be.
 *
 *  **Measured from the content, not from the shell**, and that is the whole
 *  subtlety. `#tray` carries `max-height: calc(100vh - margin * 2)` so it can
 *  never overflow the window it is drawn in — which means `shell.offsetHeight`
 *  can never report a height LARGER than the window already has. Reporting it
 *  made the panel a ratchet that only ever tightened: the first draw runs before
 *  any facts arrive, measures two sentences and a footer, and the window shrinks
 *  to that; the facts then arrive wanting twice the room, the clamp holds the
 *  shell where it is, and the reported height comes back identical, is dropped
 *  by the guard below, and the panel stays small with everything scrolled inside
 *  it for as long as it lives. `PANEL_MAX_HEIGHT` never got a say.
 *
 *  So: the sections at their scroll height — what they would be if nothing
 *  clipped them — plus the footer, the shell's border, and the margin the
 *  stylesheet insets the shell by so its shadow is not clipped by the window's
 *  edge. Rust caps the result; past the cap the sections scroll inside the panel
 *  and this keeps reporting the same unclipped number, which the guard drops.
 *
 *  Rounded and compared before sending, because a resize changes the layout,
 *  which fires the observer, which would resize again — a loop that a sub-pixel
 *  difference is enough to keep alive.
 */
let sent = 0;
function report(): void {
  // A hidden or not-yet-laid-out webview measures zero, and the panel is drawn
  // while it is hidden — every tick of the deck reaches it. Checked on the shell
  // itself rather than on the total, because the margin is added below and would
  // make "no layout at all" arrive as a plausible 16 pixels — which, before the
  // measurement above was fixed, was a height the panel could never grow out of.
  if (shell.offsetHeight <= 0) return;
  const margin = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tray-margin")) || 0;
  const border = shell.offsetHeight - shell.clientHeight;
  const height = Math.ceil(sections.scrollHeight + foot.offsetHeight + border + margin * 2);
  if (height === sent) return;
  sent = height;
  void trayResize(height).catch((e) => console.debug("tray: could not resize the panel", e));
}

new ResizeObserver(report).observe(shell);

/** The deck sends on every render, unchanged included (`sessions.ts`), and a
 *  redraw is not free: it replaces every row under a pointer that may be over
 *  one. So an identical report is dropped here, exactly as Rust drops an
 *  identical `TrayPanel` rather than rebuilding the menu under an open cursor.
 *
 *  Serialised rather than compared field by field, which is what the deck
 *  already does to decide whether its own remote-session list changed. Nothing
 *  drawn from these facts depends on the clock beyond the day a reset falls on
 *  (`formatReset`), so a report that has not changed has nothing new to say. */
let lastFacts = "";
void listen<TrayFactsPayload>("tray://facts", (e) => {
  const serialised = JSON.stringify(e.payload);
  if (serialised === lastFacts) return;
  lastFacts = serialised;
  facts = e.payload;
  draw();
});

/** Escape closes it. The one keystroke a panel with no chrome has to answer, and
 *  the same one that dismisses every dialog in the deck. */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void win.hide();
});

document.getElementById("tray-open")!.onclick = () => void trayActivate("open");
document.getElementById("tray-quit")!.onclick = () => void trayActivate("quit");

// Something on screen before the first report arrives — which is at most a tick
// away, and is instant when the panel was opened by a click, because opening it
// asks the deck for one.
draw();
