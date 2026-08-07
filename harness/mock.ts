/* The Tauri backend, replaced by fixtures.
 *
 * `docs/images/README.md` asks for shots of the running app rather than of the
 * mockups, and this is the running app: `src/main.ts` boots unmodified, every
 * view renders from the data it would get over IPC, and the terminals are real
 * xterm instances fed real bytes. What is not real is the backend — no `claude`
 * process, no `gh`, no repository, no account.
 *
 * Nothing here is imported by the app: the harness is a separate entry point
 * (`harness/index.html`) that installs the mocks and only then imports `main.ts`.
 */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import * as F from "./fixtures";

/** Event name -> the callback ids `listen()` registered for it. */
const listeners = new Map<string, number[]>();

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Deliver an event the way the Rust side would. */
export function emit(event: string, payload: unknown): void {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { runCallback(id: number, data: unknown): void };
  }).__TAURI_INTERNALS__;
  for (const id of listeners.get(event) ?? []) internals.runCallback(id, { event, id, payload });
}

const STATE: Record<string, string> = {
  [F.S_WORK]: "working",
  [F.S_WAIT]: "waitingInput",
  [F.S_DONE]: "done",
  [F.S_ERR]: "error",
};

/** A started session gets its scrollback and its state on the next tick — the
 *  same order the backend produces them in: bytes first, then the hook. */
function feed(session: string): void {
  setTimeout(() => {
    const text = F.scrollback[session];
    if (text) emit("session://output", { session, dataB64: b64(text) });
    const state = STATE[session];
    if (state) emit("session://state", { session, state });
  }, 30);
}

function handle(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    /* Events and plugins. */
    case "plugin:event|listen": {
      const event = args.event as string;
      const list = listeners.get(event) ?? [];
      list.push(args.handler as number);
      listeners.set(event, list);
      return list.length;
    }
    case "plugin:event|unlisten":
    case "plugin:event|emit":
    case "plugin:event|emit_to":
      return null;
    case "plugin:notification|is_permission_granted": return false;
    case "plugin:notification|request_permission": return "denied";

    /* Settings and lists. */
    case "list_workspaces": return F.workspaces;
    case "save_workspace":
    case "remove_workspace": return F.workspaces;
    case "load_ui_state": return F.uiState;
    case "save_ui_state": return null;
    case "list_skills":
    case "save_skill":
    case "remove_skill": return F.skills;
    case "load_schedule_state": return F.scheduleState;
    case "schedule_ack": return null;
    case "scheduler_ready": return null;
    case "claude_available": return true;
    case "gh_status": return F.ghStatus;
    case "host_platform": return { os: "linux", distro: "Ubuntu" };

    /* Sessions. */
    case "load_layout": return F.layout;
    case "save_layout": return null;
    case "start_session": {
      feed(args.session as string);
      return { account: "acme-dev", degraded: null };
    }
    case "start_command_session": return null;
    case "write_session":
    case "resize_session":
    case "close_session": return null;
    case "git_status":
      return F.gitByCwd[args.cwd as string] ?? { branch: null, dirty: false };
    case "session_tokens":
      return F.tokens[args.sessionId as string]
        ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

    /* The tracker. */
    case "tasks_capabilities":
      return args.workspaceId === F.WS_HARBOR ? F.githubCaps
        : args.workspaceId === F.WS_RELAY ? F.fileCaps : null;
    case "tasks_list":
      return args.workspaceId === F.WS_HARBOR ? F.issues
        : args.workspaceId === F.WS_RELAY ? F.fileTasks : [];
    case "tasks_open_counts": return F.openCounts;
    case "tracker_open_count":
      return F.openCounts[args.workspaceId as string] ?? null;
    case "tasks_watch_sync": return null;
    case "tasks_migration_status": return null;
    case "board_step_usage": return [];
    case "issue_totals":
      return { open: F.openCount, closed: F.closedCount, rateRemaining: 4_812 };

    /* Pull requests. */
    case "pr_list":
      return args.workspaceId === F.WS_HARBOR ? F.pullRequests : [];
    // Every row can be expanded, not only the one the README's shot opens: a
    // half-populated fixture would put "Could not read #151" on screen the
    // moment anybody clicked the wrong triangle.
    case "pr_detail":
      return F.prDetails[args.number as number] ?? F.genericDetail(args.number as number);
    case "pr_diff":
      return F.prDiffs[args.number as number] ?? F.genericDiff(args.number as number);
    case "pr_merge_options": return F.mergeOptions;

    default:
      // Window calls (`plugin:window|…`) and anything else the app asks for that
      // has no visible answer. Logged rather than thrown: a missing case should
      // show up while shooting, not stop the page.
      if (!cmd.startsWith("plugin:")) console.debug("[harness] unhandled command", cmd, args);
      return null;
  }
}

export function installMocks(): void {
  // The plugin asks the browser first and only falls back to IPC, so the browser
  // has to answer — otherwise headless Chrome shows a permission prompt nobody
  // can click and the deck never finishes wiring its events.
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "denied", requestPermission: async () => "denied" },
  });
  mockWindows("main");
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Record<string, unknown>));
  // For harness/record.mjs, which needs to change a session's state mid-take
  // the way the backend would; nothing in the app reads this.
  (window as unknown as { __harness?: unknown }).__harness = { emit };
}
