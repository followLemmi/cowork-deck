import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pillLabel } from "./pill-util";

const win = getCurrentWindow();
const text = document.getElementById("pill-text")!;
const pill = document.getElementById("pill")!;

void listen<{ n: number }>("pill://count", async (e) => {
  const n = e.payload.n;
  if (n > 0) {
    text.textContent = pillLabel(n);
    await win.show();
  } else {
    await win.hide();
  }
});

pill.addEventListener("click", () => {
  void emit("pill://focus-next");
});
