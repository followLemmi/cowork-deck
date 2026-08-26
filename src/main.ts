/** The main window's entry point.
 *
 *  Three lines on purpose. Everything this used to hold is in `app.ts`, which
 *  both kinds of window now start; what is left here is which kind this one is.
 *  The label is read synchronously and is known before the first DOM query, so
 *  nothing has to wait on IPC before the first paint.
 */
import { startApp } from "./app";
import { roleOf } from "./window-role";
import { getCurrentWindow } from "@tauri-apps/api/window";

void startApp(roleOf(getCurrentWindow().label));
