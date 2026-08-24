/** Entry point for a window pinned to one workspace.
 *
 *  A placeholder, and it says so on screen. The real bootstrap is `startApp(role)`
 *  (#242), which will run the same app here as in the main window with its
 *  singletons suppressed; this file exists so that #239 — creating the window from
 *  Rust, the capability glob, and the readiness handshake — has something to load
 *  and can be verified end to end rather than reasoned about.
 *
 *  The one line here that will outlive the placeholder is `windowReady()`. An
 *  emit to a webview that has not registered a listener is a silent no-op at both
 *  ends, so the backend refuses to speak to a window until it has said this. It
 *  must therefore stay **last** in whatever this file grows into: it means "my
 *  listeners are attached", and saying it early is the same as not saying it. */
import { windowReady } from "./ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { workspaceIdOf } from "./window-role";

const mount = document.querySelector<HTMLElement>("#workspace-placeholder");
const workspaceId = workspaceIdOf(getCurrentWindow().label);

if (mount) {
  mount.textContent = workspaceId
    ? `Workspace window for ${workspaceId}. The app itself arrives with #242.`
    : "This window names no workspace.";
}

// Last, once there is something on screen and — in #242 — every listener is up.
void windowReady();
