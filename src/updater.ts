import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmModal, alertModal } from "./modal";

/** Ask GitHub Releases whether a newer version exists, and offer it.
 *
 *  Fire-and-forget from startup: an unreachable endpoint, a dev build with no
 *  updater artifacts, or a declined offer must never get in the way of the
 *  session the user came here to start — every failure path ends in a quiet
 *  `return`. The check runs over the app's own HTTP client, so the WebView
 *  CSP does not apply to it.
 */
export async function offerUpdateIfAvailable(): Promise<void> {
  let update;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;
  const go = await confirmModal(
    `Version ${update.version} is available (you have ${update.currentVersion}). Download and install it now?`,
  );
  if (!go) return;
  try {
    await update.downloadAndInstall();
  } catch {
    await alertModal("The update could not be downloaded or installed. It will be offered again on the next launch.");
    return;
  }
  const restart = await confirmModal("The update is installed and takes effect on restart. Restart now?");
  if (restart) await relaunch();
}
