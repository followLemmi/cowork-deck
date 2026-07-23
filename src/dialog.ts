import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker. Returns the chosen absolute path, or null if the
 *  user cancelled. */
export async function pickFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}
