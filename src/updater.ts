import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmModal, alertModal } from "./modal";

/** The version the user last said no to — by declining the offer or by having
 *  its install fail. Offered again only when a newer version appears, so
 *  neither a decline nor a broken artifact turns the startup check into a
 *  every-launch nag. */
const DISMISSED_KEY = "updater:dismissed-version";

/** Ask GitHub Releases whether a newer version exists, and offer it.
 *
 *  Fire-and-forget from startup: an unreachable endpoint, a declined offer, a
 *  failed install must never get in the way of the session the user came here
 *  to start — every failure path ends in a `return`, loudly logged but never
 *  fatal. The check runs over the app's own HTTP client, so the WebView CSP
 *  does not apply to it.
 */
export async function offerUpdateIfAvailable(): Promise<void> {
  // A dev build reports whatever version tauri.conf.json carries and would
  // happily "update" itself to the released one on every reload.
  if (import.meta.env.DEV) return;
  let update;
  try {
    update = await check();
  } catch (e) {
    // Unreachable is routine; a signature or config fault would also land
    // here, and silence would hide it for good.
    console.warn("update check failed:", e);
    return;
  }
  if (!update) return;
  if (localStorage.getItem(DISMISSED_KEY) === update.version) return;
  const go = await confirmModal(
    `Version ${update.version} is available (you have ${update.currentVersion}). Download and install it now?`,
  );
  if (!go) {
    localStorage.setItem(DISMISSED_KEY, update.version);
    return;
  }
  try {
    await update.downloadAndInstall();
  } catch (e) {
    console.warn("update install failed:", e);
    localStorage.setItem(DISMISSED_KEY, update.version);
    await alertModal(
      `The update could not be downloaded or installed. It will be offered again with the next release; version ${update.version} can also be installed by hand from the releases page.`,
    );
    return;
  }
  const restart = await confirmModal("The update is installed and takes effect on restart. Restart now?");
  if (restart) await relaunch();
}
