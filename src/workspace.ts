/** Entry point for a window pinned to one workspace.
 *
 *  The same app as the main window, started with a different role: `startApp`
 *  suppresses the singletons that must not run twice, and the label says which
 *  workspace this window is for.
 *
 *  `windowReady()` last, and it has to stay last. An emit to a webview holding no
 *  listener for that event is a silent no-op at both ends, so the backend routes
 *  nothing here until this arrives — saying it before the listeners are up is the
 *  same as not saying it at all.
 */
import { startApp } from "./app";
import { roleOf } from "./window-role";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { windowReady } from "./ipc";

startApp(roleOf(getCurrentWindow().label));
void windowReady();
