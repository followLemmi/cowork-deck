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

function internals() {
  return (window as unknown as {
    __TAURI_INTERNALS__: { runCallback(id: number, data: unknown): void };
  }).__TAURI_INTERNALS__;
}

/** Deliver an event the way the Rust side would. */
export function emit(event: string, payload: unknown): void {
  for (const id of listeners.get(event) ?? []) internals().runCallback(id, { event, id, payload });
}

/* --- The output channel ---------------------------------------------------
   A session's bytes do not come back as an event any more. Every launch hands
   the backend a Tauri `Channel`, and the backend writes the pty's output into
   it — which is why the harness's terminals had been empty for a while and the
   README's shots were the last set taken before the change: this file went on
   emitting `session://output`, and nothing had listened for it since.

   A channel crosses the IPC boundary as the string `__CHANNEL__:<id>`, where the
   id names a callback the mock registered. Delivering to it means calling that
   callback with the envelope the real transport uses — an index, so the client
   can keep order, and the message itself. */
const sinks = new Map<string, number>();

function rememberSink(session: string, sink: unknown): void {
  /* Two shapes, because `mockIPC` hands the argument over WITHOUT serialising
     it: over the real bridge a channel arrives as the string `__CHANNEL__:<id>`,
     while here it is still the `Channel` object, whose `toJSON` produces that
     string. Reading only the string is the bug this comment exists to prevent —
     it looks right in a log (`JSON.stringify` calls `toJSON`) and matches
     nothing at runtime. */
  const raw = sink as { id?: number } | string | undefined;
  const id = typeof raw === "string"
    ? (raw.startsWith("__CHANNEL__:") ? Number(raw.slice("__CHANNEL__:".length)) : NaN)
    : Number(raw?.id);
  if (Number.isFinite(id)) sinks.set(session, id);
}

/** How many messages a session's channel has taken. The client drops anything
 *  out of order, so the count is not decoration. */
const sinkIndex = new Map<string, number>();

/** Write bytes into a session's channel, as the pty would. */
function toSink(session: string, text: string): void {
  const id = sinks.get(session);
  if (id === undefined) return;
  const index = sinkIndex.get(session) ?? 0;
  sinkIndex.set(session, index + 1);
  internals().runCallback(id, { index, message: new TextEncoder().encode(text).buffer });
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
    if (text) toSink(session, text);
    const state = STATE[session];
    if (state) emit("session://state", { session, state });
  }, 30);
}

/** A shell's output, after the drawer has written its banner. Deliberately
 *  slower than `feed`: the banner goes in when `start_shell_session` resolves,
 *  and output that beat it would be held rather than dropped — which is correct,
 *  and would also hide whether the ordering works at all. */
function feedShell(session: string): void {
  setTimeout(() => {
    const text = F.shellScrollback[session];
    if (text) toSink(session, text);
  }, 60);
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
    /* `placesWindows` was missing, which reads as false — and false is the one
       value that switches the tear-out gesture OFF. So the harness ran the branch
       no desktop but Wayland runs, and could not see that the capture the gesture
       takes was killing every control on a workspace row. The Rust struct always
       sends the field; so does this. */
    case "host_platform": return { os: "linux", distro: "Ubuntu", placesWindows: true };

    /* Sessions. */
    case "load_layout": return F.layout;
    case "save_layout": return null;
    case "start_session": {
      rememberSink(args.session as string, args.sink);
      feed(args.session as string);
      return { account: "acme-dev", degraded: null };
    }
    case "start_command_session": {
      rememberSink(args.session as string, args.sink);
      return null;
    }
    /* A session taken over by this window — the other half of the hand-off. It
       brings its own channel, so the old one is replaced rather than kept. */
    case "claim_session": {
      rememberSink(args.session as string, args.sink);
      return null;
    }
    /* The drawer. `feed` gives the shell something on screen, the same way the
       session mocks do — an empty terminal shows nothing about the surface
       around it. */
    case "start_shell_session": {
      rememberSink(args.session as string, args.sink);
      feedShell(args.session as string);
      return { auth: { account: "acme-dev", degraded: null }, identity: "Ada <ada@acme.dev>", program: "zsh" };
    }
    case "session_jobs": return 0;
    case "load_terminals": return F.terminals;
    case "save_terminals": return null;
    case "write_session":
    case "resize_session":
    case "close_session": return null;
    case "git_status":
      return F.gitByCwd[args.cwd as string] ?? { branch: null, dirty: false };
    // The tool panel's two reads. A folder with no entry answers empty rather than
    // throwing: "not a git checkout" is a real state and the panel says so.
    case "config_paths":
      return F.configPaths;
    case "worktree_files":
      return F.filesByCwd[args.cwd as string] ?? [];
    case "git_changes":
      return F.changesByCwd[args.cwd as string] ?? { branch: null, files: [] };
    case "session_snapshots": {
      // Every requested id gets an entry, exactly as the Rust command promises —
      // a mock that dropped the unknown ones would hide the bug it exists to show.
      const out: Record<string, unknown> = {};
      for (const id of args.sessionIds as string[]) {
        out[id] = F.snapshots[id] ?? { tokens: null, title: null, titleSource: null, calls: null };
      }
      return out;
    }
    case "session_activity": {
      // Every requested id gets an entry, as the Rust command promises. An id
      // with no fixture gets `noLog` — a sentence, never a roll of zeroes.
      const out: Record<string, unknown> = {};
      for (const id of args.sessionIds as string[]) {
        out[id] = F.activity[id] ?? {
          cli: "claude", agents: [], tools: [], calls: 0,
          capabilities: { outcomes: false, agents: false },
          readAt: Math.floor(Date.now() / 1000), unavailable: "noLog", truncated: null,
        };
      }
      return out;
    }

    /* What every connected AI has left. Answered unconditionally, `force` or
       not: the harness has no cache to bypass, and a mock that refused the forced
       read would hide the block whenever a limit signal arrived. */
    case "usage_snapshot": return F.usage;
    case "usage_clear_observed": return null;

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

    /* The window plugin.
     *
     * Listed rather than left to the `plugin:` fallback below so that a call the
     * app makes here is a call somebody chose to answer. `null` is the honest
     * answer for all of them: a raise is three fire-and-forget calls
     * (`raiseThisWindow` in `app.ts`) and nothing reads a window back.
     *
     * There used to be a per-label visibility map behind these, because the
     * floating pill's show/hide was a state machine over `isVisible` and a stub
     * that always said "hidden" exercised one branch of it for ever. #394
     * removed that window and with it the only caller of `is_visible`, so the
     * map went too rather than stay as scenery. */
    case "plugin:window|show":
    case "plugin:window|unminimize":
    case "plugin:window|set_focus":
    case "plugin:window|destroy":
    case "plugin:window|close":
      return null;

    default:
      // Anything else the app asks for that has no visible answer. Logged rather
      // than thrown: a missing case should show up while shooting, not stop the
      // page.
      if (!cmd.startsWith("plugin:")) console.debug("[harness] unhandled command", cmd, args);
      return null;
  }
}

/** Stand the app up on mocked IPC.
 *
 *  `label` is which window this page is pretending to be, and it has to be a
 *  parameter: `getCurrentWindow().label` is what `startApp` reads to decide
 *  whether it is the whole app or one workspace, so a hardcoded `"main"` made a
 *  second harness page impossible rather than merely inconvenient. */
export function installMocks(label = "main"): void {
  // The plugin asks the browser first and only falls back to IPC, so the browser
  // has to answer — otherwise headless Chrome shows a permission prompt nobody
  // can click and the deck never finishes wiring its events.
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "denied", requestPermission: async () => "denied" },
  });
  mockWindows(label);
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Record<string, unknown>));
  // For harness/record.mjs, which needs to change a session's state mid-take
  // the way the backend would; nothing in the app reads this.
  (window as unknown as { __harness?: unknown }).__harness = { emit };
}
