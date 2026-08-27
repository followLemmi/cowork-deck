import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pillLabel, pillWanted, type PillLimit } from "./pill-util";

const win = getCurrentWindow();
const text = document.getElementById("pill-text")!;
const pill = document.getElementById("pill")!;

/** One window command at a time. The count arrives on every poll tick, five
 *  seconds apart, and again whenever a session changes state, so two events can
 *  land within the same frame; `isVisible()` is a round trip to the main thread,
 *  and unqueued both handlers would read the window before either had acted. */
let pending: Promise<void> = Promise.resolve();

void listen<{ n: number; limit?: PillLimit | null }>("pill://count", (e) => {
  const n = e.payload.n;
  const limit = e.payload.limit ?? null;
  // The label follows the count whether or not visibility changes: 1 → 2
  // waiting keeps the pill up and has to redraw it. The guard is `pillWanted`
  // rather than `n > 0` because a spent budget puts the pill up on its own now,
  // and writing the label only when a session waits would have left an exhausted
  // deck showing whatever the pill last said.
  if (pillWanted(n, limit)) text.textContent = pillLabel(n, limit);
  pending = pending
    .then(async () => {
      const wanted = pillWanted(n, limit);
      // Ask the window rather than remember what we told it. `show()` is not
      // idempotent on macOS — it is `makeKeyAndOrderFront:`, which raises and
      // re-activates — so an already-visible pill must not be shown again, and
      // a flag is the weaker way to know: it has to guess what the window
      // started as, and a failed call leaves it lying for the rest of the run.
      // The pill carries what it is saying, not just how many: an exhausted
      // deck is a different fact from a queue of questions, and the one colour
      // the palette gives to "stopped" is the one that says so.
      pill.classList.toggle("pill--limit", limit?.exhausted === true);
      if (wanted === (await win.isVisible())) return;
      await (wanted ? win.show() : win.hide());
    })
    .catch((err) => {
      // A failed window call must not poison the queue — the deck re-sends the
      // count on the next tick, and that attempt is the recovery.
      console.error("pill: could not apply the count", err);
    });
  // Handed back so a caller can await the window, not just the bookkeeping.
  return pending;
});

pill.addEventListener("click", () => {
  void emit("pill://focus-next");
});
