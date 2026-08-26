import { onAction } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Pure map from a sent notification's numeric id back to the session it
 *  was raised for. No DOM/Tauri dependency — unit-tested directly. */
export class NotifyRouter {
  private map = new Map<number, string>();
  private seq: number;

  /** `seed` is where this window's ids start. It used to be 1 in every window,
   *  so id 3 named a different session in each of them: clicking a notification
   *  resolved to the wrong tile, in a window that then raised itself over the one
   *  the person was working in. With disjoint ranges a foreign id resolves to
   *  nothing, which is the right answer whether or not the notification plugin
   *  delivers an action to every listening webview — a question this does not
   *  have to answer. See `notifyIdSeed`. */
  constructor(seed = 1) { this.seq = seed; }

  register(session: string): number {
    const id = this.seq++;
    this.map.set(id, session);
    return id;
  }

  resolve(notifId: number): string | null {
    return this.map.get(notifId) ?? null;
  }
}

/** Wire OS-notification clicks so they raise the window and focus the tile
 *  the notification came from. Best-effort: platforms without action routing
 *  simply won't call back. */
export async function wireNotificationFocus(
  router: NotifyRouter,
  focus: (session: string) => void,
): Promise<void> {
  await onAction((notification) => {
    if (notification.id == null) return;
    const session = router.resolve(Number(notification.id));
    if (!session) return;
    const w = getCurrentWindow();
    void w.unminimize().then(() => w.show()).then(() => w.setFocus());
    focus(session);
  });
}
