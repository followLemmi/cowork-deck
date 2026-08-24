/** Entry point for a window pinned to one workspace.
 *
 *  The same app as the main window, started with a different role: `startApp`
 *  suppresses the singletons that must not run twice, and the label says which
 *  workspace this window is for.
 *
 *  `windowReady()` **after** the bootstrap has settled, and that ordering is the
 *  whole point of the handshake. An emit to a webview holding no listener for an
 *  event is a silent no-op at both ends, so a window that says it is ready before
 *  its listeners are attached has said nothing useful — and the workspace being
 *  handed to it would be emitted into the void. `startApp` returns when its
 *  listeners are up, which is what makes this promise the right one to wait on.
 */
import { startApp } from "./app";
import { roleOf } from "./window-role";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { windowReady } from "./ipc";

startApp(roleOf(getCurrentWindow().label))
  .catch((e) => console.error("workspace window failed to start", e))
  .finally(() => { void windowReady(); });
