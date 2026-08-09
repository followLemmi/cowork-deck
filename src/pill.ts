import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pillLabel } from "./pill-util";

const win = getCurrentWindow();
const text = document.getElementById("pill-text")!;
const pill = document.getElementById("pill")!;

/** What the window is currently doing, mirroring `.visible(false)` on the
 *  builder in `src-tauri/src/main.rs`. `show()` is not idempotent on macOS — it
 *  raises and re-activates the window — so an already-visible pill must not be
 *  shown again. The count arrives on every poll tick, five seconds apart. */
let visible = false;

void listen<{ n: number }>("pill://count", async (e) => {
  const n = e.payload.n;
  // The label follows the count whether or not visibility changes: 1 → 2
  // waiting keeps the pill up and has to redraw it.
  if (n > 0) text.textContent = pillLabel(n);
  const wanted = n > 0;
  if (wanted === visible) return;
  visible = wanted;
  await (wanted ? win.show() : win.hide());
});

pill.addEventListener("click", () => {
  void emit("pill://focus-next");
});
