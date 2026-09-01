/** The panel behind the status-area icon.
 *
 *  A window rather than a native menu, so a limit can be a meter and a waiting
 *  session can be a row you click — see ADR-0011. It draws with the deck's own
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

function draw(): void {
  applyScale(facts.scale, document.documentElement);
  fillPanel(sections, { usage: facts.usage, sessions: facts.sessions, now: Date.now() }, act);
  report();
}

/** Tell Rust how tall the panel wants to be.
 *
 *  `offsetHeight` plus the margin the stylesheet insets the shell by, so the
 *  shadow is not clipped by the window's own edge. Rust caps it; past the cap
 *  the sections scroll inside the panel.
 *
 *  Rounded and compared before sending, because a resize changes the layout,
 *  which fires the observer, which would resize again — a loop that a
 *  sub-pixel difference is enough to keep alive.
 */
let sent = 0;
function report(): void {
  const margin = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tray-margin")) || 0;
  const height = Math.ceil(shell.offsetHeight + margin * 2);
  if (height === sent || height <= 0) return;
  sent = height;
  void trayResize(height).catch((e) => console.debug("tray: could not resize the panel", e));
}

new ResizeObserver(report).observe(shell);

void listen<TrayFactsPayload>("tray://facts", (e) => {
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
