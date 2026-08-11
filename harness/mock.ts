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

/** The journal, mutable — `delete_skill_history` actually erases from it, so the
 *  screen after an erase is the screen the app would show rather than one that
 *  quietly repaints unchanged. The fixture itself stays as written. */
let runs = [...F.runs];

const STATE: Record<string, string> = {
  [F.S_WORK]: "working",
  [F.S_WAIT]: "waitingInput",
  [F.S_DONE]: "done",
  [F.S_ERR]: "error",
  [F.S_AUTO]: "idle",
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
    // Both filters applied here exactly as Rust applies them, including the rule
    // that a record with no workspace of its own passes every workspace filter.
    // A mock that skipped either would show the screen data the app can never
    // actually be handed — the caution the `pr_detail` case above already makes.
    case "list_runs": {
      const ws = args.workspaceId as string | null;
      const sk = args.skillId as string | null;
      return runs.filter((r) =>
        (ws === null || r.workspaceId === null || r.workspaceId === ws)
        && (sk === null || r.skillId === sk));
    }
    // Scoped and refused exactly as Rust does it, for the same reason
    // `list_runs` above is: a mock that erased everything, or erased an open
    // record without complaint, would let the harness rehearse a data loss the
    // app refuses.
    case "delete_skill_history": {
      const ws = args.workspaceId as string | null;
      const sk = args.skillId as string;
      const doomed = (r: typeof runs[number]) =>
        r.skillId === sk && (ws === null || r.workspaceId === null || r.workspaceId === ws);
      if (runs.some((r) => doomed(r) && r.status === "running")) {
        throw new Error("one of this scenario's runs is still going — its record would be "
          + "erased out from under it, and the run would never be journalled at all");
      }
      runs = runs.filter((r) => !doomed(r));
      return null;
    }
    // Reveal is a real shell call in the app; the harness has no file manager
    // and no transcripts, so it answers the way a missing file would.
    case "reveal_path": throw new Error("The transcript is no longer there.");
    // Named rather than left to the `plugin:` default below, which answers null
    // and says nothing — indistinguishable from #252, where a link did nothing
    // at all. Shooting the README must not launch a browser; a line in the
    // console is how a manual check sees that the click arrived.
    case "plugin:opener|open_url":
      console.debug("[harness] would open in the system browser:", args.url);
      return null;
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
    case "session_snapshots": {
      // Every requested id gets an entry, exactly as the Rust command promises —
      // a mock that dropped the unknown ones would hide the bug it exists to show.
      const out: Record<string, unknown> = {};
      for (const id of args.sessionIds as string[]) {
        out[id] = F.snapshots[id] ?? { tokens: null, title: null, titleSource: null };
      }
      return out;
    }

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
