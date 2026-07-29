import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { applyView } from "./view";
import { claudeAvailable, loadLayout, onScheduledFire, onSchedulerBroken, scheduleAck, schedulerReady } from "./ipc";
import type { Skill, Workspace } from "./ipc";
import { BoardView } from "./board";
import {
  listTasks, resolveTask, taskCapabilities, taskOpenCounts, onTasksChanged, taskWatchSync, createTask,
  taskMigrationStatus, taskMigrate, taskMigrationDismiss, updateTask,
} from "./ipc";
import type { MigrationOffer, StepId, Task } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { runBoot } from "./boot";
import { installSprite } from "./icons";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
import { taskPrompt } from "./tasks";
import { resolveScheduledWorkspace } from "./schedule";
import { placeholderForm, taskForm } from "./forms";
import { computePatch, openCardModal } from "./card-modal";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

installSprite();
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ session"; newBtn.className = "btn-primary";
sidebar.append(wsMount, skMount, newBtn, listMount);

const boardEl = document.querySelector<HTMLElement>("#board")!;

// The "Terminals | Board" switch. The board takes the full width because
// GitHub and Jira boards land here later, and those need room rather than a strip.
const views = document.createElement("div");
views.className = "tk-views";
const termBtn = document.createElement("button");
termBtn.textContent = "Terminals"; termBtn.className = "active";
const boardBtn = document.createElement("button");
boardBtn.textContent = "Board";
views.append(termBtn, boardBtn);
sidebar.prepend(views);

const board = new BoardView({
  onLaunch: (t) => void launchFromTask(t),
  onResolve: (t) => void closeTask(t),
  onNew: () => void captureTask(),
  onConfigure: () => void alertModal(
    "Configure the tracker in the workspace settings (✎): a folder in the project, or one of your own."),
  onMigrate: () => void migrateCards(),
  onDismissMigration: () => void dismissMigration(),
  onOpen: (t) => void openCard(t),
  onMove: (t, step) => void moveTask(t, step),
});
boardEl.append(board.mount);

let boardVisible = false;
let boardTimer: ReturnType<typeof setInterval> | null = null;

function setView(showBoard: boolean) {
  boardVisible = showBoard;
  applyView({ deck: deckEl, board: boardEl, termBtn, boardBtn,
              terminalsOnly: [skMount, newBtn, listMount] }, showBoard);
  if (showBoard) {
    void refreshBoard();
    // Polling is the primary refresh path; the watcher only makes it faster, so
    // a watcher failure degrades into a delay and needs no detection. The
    // sidebar counts degrade the same way (see the spec), which is why this tick
    // refreshes them too — otherwise on a workspace without a watcher (an SMB
    // volume, say) the badge stays stuck at whatever it was at load. Each call
    // has its own try/catch inside refreshBoard/refreshCounts: one failing
    // handle must not take the other down.
    if (boardTimer === null) {
      boardTimer = setInterval(() => { void refreshBoard(); void refreshCounts(); }, 5000);
    }
  } else if (boardTimer !== null) {
    clearInterval(boardTimer); boardTimer = null;
  }
}
termBtn.onclick = () => setView(false);
boardBtn.onclick = () => setView(true);

const deck = new Deck(deckEl, listMount, () => workspaces.all);
deck.wireNotificationFocus();
const boot = () => runBoot({
  steps: [
    () => deck.wireEvents(),
    () => onScheduledFire((skillId, occurrenceMs, catchUp) => {
      const missedAt = catchUp
        ? new Date(occurrenceMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : undefined;
      void handleScheduledFire(skillId, missedAt).then(async (outcome) => {
        if (outcome !== "launched") console.warn("scheduled fire not launched:", skillId, outcome);
        // Tell the backend what came of it: an occurrence it emitted counts as
        // a run only once a session has actually started.
        await scheduleAck(skillId, occurrenceMs, outcome).catch((e) =>
          console.warn("schedule ack failed:", skillId, e));
        // Show the outcome in the scenario row now, rather than at the next
        // minute tick — a skip or a refusal is what the user needs to see.
        await skills.refreshRuns();
      });
    }).then(() => {}),
    () => onSchedulerBroken((message) => { void alertModal(message); }).then(() => {}),
    () => workspaces.load(),
    () => skills.load(),
    () => onTasksChanged((workspaceId) => {
      if (boardVisible && workspaces.active?.id === workspaceId) void refreshBoard();
      void refreshCounts();
    }).then(() => {}),
    () => taskWatchSync(),
    () => refreshCounts(),
    async () => {
      const entries = await loadLayout();
      if (entries.length) await deck.restore(entries);
    },
    () => { deck.setActiveWorkspace(workspaces.active?.id ?? null); },
  ],
  // Sent last so a catch-up fire arriving immediately can be resolved to a
  // scenario — but sent even if a step above failed, or the scheduler stays
  // parked forever.
  releaseScheduler: schedulerReady,
  onError: (e) => {
    console.error("boot failed:", e);
    void alertModal(
      "The app did not start completely — some sessions or settings may not have loaded. " +
      "Restart it; if this repeats, check the developer console.",
    );
  },
});

/** Quick capture: a modal, a card in the active workspace, and the board and
 *  counts refreshed straight away rather than waiting on the watcher. */
async function captureTask() {
  const ws = workspaces.active;
  if (!ws) { await alertModal("Pick a workspace first."); return; }
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps?.canCreate) {
    await alertModal("No task tracker is configured for this workspace. Set one up in its settings (✎).");
    return;
  }
  const draft = await taskForm(caps.board);
  if (!draft) return;
  try {
    await createTask(ws.id, draft);
  } catch (e) {
    await alertModal(`Could not create the task: ${String(e)}`);
    return;
  }
  if (boardVisible) await refreshBoard();
  await refreshCounts();
}
/** ▶ on a card. The workspace comes from the card's `project:` field, not from
 *  whichever one is active: on a shared root (a vault folder covering three
 *  projects, say) the active workspace would drop the work in the wrong
 *  directory. */
async function launchFromTask(t: Task) {
  const target = workspaces.all.find((w) => w.name === t.project);
  if (!target) {
    await alertModal(
      `No workspace named “${t.project}” — that is the card's project: field. ` +
      `Was the workspace renamed? The launch was cancelled rather than start work in the wrong directory.`);
    return;
  }
  // The *target* workspace's configuration, not the active board's: on a shared
  // root the card may belong to another project with another board.json, and the
  // kind's label comes from whichever one owns the card.
  const caps = await taskCapabilities(target.id).catch(() => null);
  // No tracker configured there: the kind's own id is the best label available,
  // which is what an empty configuration makes `kindLabel` fall back to.
  const cfg = caps?.board ?? { v: 1, steps: [], kinds: [] };
  await deck.launchFromTask(target, t, taskPrompt(t, cfg));
  // Both "launched" and "focused" leave a session worth looking at — staying on
  // the board would look like the button did nothing.
  setView(false);
}

/** Redraw the active workspace's board. Every IPC call is isolated: one failing
 *  handle must not take the whole tick down. */
async function refreshBoard() {
  const ws = workspaces.active;
  if (!ws) {
    board.render({ project: "", caps: null, error: null, tasks: [], links: [] });
    return;
  }
  const wsId = ws.id;
  let caps = null;
  try { caps = await taskCapabilities(wsId); } catch (e) { console.debug("caps failed", e); }
  let tasks: Task[] = [];
  let error: string | null = null;
  if (caps) {
    try { tasks = await listTasks(wsId); }
    catch (e) { error = String(e); }
  }
  let migration: MigrationOffer | null = null;
  try { migration = await taskMigrationStatus(wsId); }
  catch (e) { console.debug("migration status failed", e); }
  // The workspace may have been switched while we waited on IPC: a late reply
  // must not repaint the board with another workspace's data over the current one.
  if (workspaces.active?.id !== wsId) return;
  board.render({ project: ws.name, caps, error, tasks, links: deck.taskLinks(), migration });
}

/** The sidebar counts — one handle covering every workspace. */
async function refreshCounts() {
  try { workspaces.setCounts(await taskOpenCounts()); }
  catch (e) { console.debug("taskOpenCounts failed", e); }
}

async function closeTask(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  try { await resolveTask(ws.id, t.id); }
  catch (e) { await alertModal(`Could not close the task: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}

/** A drag or an arrow click both land here: a step-only patch, exactly like
 *  the modal's own step-only move (card-modal.ts's computePatch). */
async function moveTask(t: Task, step: StepId) {
  const ws = workspaces.active;
  if (!ws) return;
  try { await updateTask(ws.id, t.id, { status: step }); }
  catch (e) {
    // The optimistic move has to be explained: without this the card just
    // springs back on the next poll and the board looks broken.
    await alertModal(`Could not move the card: ${String(e)}`);
  }
  await refreshBoard();
  await refreshCounts();
}

/** Open a card, edit it, and save only what changed — see card-modal.ts for
 *  why a full-field patch would be unsafe here. */
async function openCard(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps) return;
  const canWrite = !t.damaged && !t.conflict;
  const edited = await openCardModal(t, caps.board, canWrite);
  if (!edited) return;
  const patch = computePatch(t, edited);
  if (Object.keys(patch).length === 0) return;
  try { await updateTask(ws.id, t.id, patch); }
  catch (e) { await alertModal(`Could not save the card: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}

/** Move the cards left at a previous root. The watcher has to be re-pointed
 *  afterwards: the destination may have been created moments ago, and without
 *  the re-sync the board would only update on the five-second poll. */
async function migrateCards() {
  const ws = workspaces.active;
  if (!ws) return;
  try {
    const report = await taskMigrate(ws.id);
    const failed = report.skipped.filter((s) => s.reason.kind === "failed");
    if (failed.length) {
      await alertModal(
        `Moved ${report.moved}. ${failed.length} could not be moved:\n` +
        failed.map((s) => `${s.fileName}: ${s.reason.kind === "failed" ? s.reason.detail : ""}`).join("\n"),
      );
    }
  } catch (e) {
    await alertModal(`Could not move the cards: ${String(e)}`);
  }
  await taskWatchSync().catch((e) => console.debug("watch sync failed", e));
  await refreshBoard();
  await refreshCounts();
}

async function dismissMigration() {
  const ws = workspaces.active;
  if (!ws) return;
  try { await taskMigrationDismiss(ws.id); }
  catch (e) { await alertModal(`Could not dismiss: ${String(e)}`); }
  await refreshBoard();
}

/** Why a scheduled fire did or did not produce a run. The backend-driven path
 *  only logs it; a user-initiated run surfaces it in a modal. */
type FireOutcome = "launched" | "skipped-overlap" | "no-workspace" | "not-scheduled";

/** A scheduled scenario came due (from the backend scheduler or from the ⏰
 *  button): resolve it to a scenario + workspace, fill placeholder defaults (a
 *  scheduled run cannot ask) and launch it as a fresh tile. */
async function handleScheduledFire(skillId: string, catchUpFor?: string): Promise<FireOutcome> {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return "not-scheduled";
  const res = resolveScheduledWorkspace(skill, workspaces.all, workspaces.active);
  if (!res.ok) return res.reason;
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  const launched = await deck.launchScheduled(res.workspace, skill, filled, catchUpFor);
  return launched ? "launched" : "skipped-overlap";
}

/** ⏰ button: run a scheduled scenario now, exactly as the schedule would. The
 *  schedule itself is untouched — `lastRun` is written only by the backend
 *  loop, so the regular occurrence still fires. Unlike a backend-driven fire,
 *  a click must say why nothing happened. */
async function runScheduledNow(skill: Skill) {
  const outcome = await handleScheduledFire(skill.id);
  if (outcome === "skipped-overlap") {
    await alertModal("Run skipped: the previous one is still active.");
  } else if (outcome === "no-workspace") {
    await alertModal("This scenario has no workspace available: pin it to one or pick a workspace.");
  }
}

// Clicking the floating status pill raises the main window (same raise
// sequence as notify.ts's OS-notification click handler) and focuses the
// next session that's waiting for input.
void listen("pill://focus-next", async () => {
  const w = getCurrentWindow();
  await w.unminimize().catch(() => {});
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
  deck.focusNextWaiting();
});

// Selecting a workspace (click, startup restore of the active one, or after a
// deletion re-selects the next one) switches the deck to that workspace's tiles.
const workspaces = new WorkspacesPanel(wsMount, (ws) => {
  deck.setActiveWorkspace(ws.id);
  if (boardVisible) void refreshBoard();
}, () => {
  // A workspace was added, edited or deleted: its tracker root may have moved,
  // so re-point the watcher and re-read the sidebar counts.
  void taskWatchSync();
  void refreshCounts();
});
/** Every launch path needs an active workspace. Saying so beats a button that
 *  looks broken — the old behaviour was a bare `return`. */
async function requireWorkspace(): Promise<Workspace | null> {
  const ws = workspaces.active;
  if (ws) return ws;
  await alertModal(
    "Pick a workspace first — it is the project folder that sessions run in. "
    + "If there are none yet, create one with the “+ workspace” button.",
  );
  return null;
}

const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, async (skill) => {
  const ws = await requireWorkspace();
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
}, (skill) => { void runScheduledNow(skill); }, () => workspaces.all.map((w) => w.id),
   () => workspaces.active?.name ?? null);
// Deleting a workspace strands the scenarios pinned to it — the confirmation
// says how many before it happens.
workspaces.setSkillsSource(() => skills.all);
const newSession = async () => {
  const ws = await requireWorkspace();
  if (ws) await deck.launch(ws, null);
};
newBtn.onclick = () => { void newSession(); };

/** Human-readable binding for the palette. Filled in because the `hotkey`
 *  field existed on Command from the start and was never populated, so the
 *  palette — and with it every binding, including Cmd+K itself — was
 *  undiscoverable. */
function hotkeyLabel(letter: string): string {
  return isMacPlatform() ? `Cmd+${letter}` : `Ctrl+Shift+${letter}`;
}

function paletteCommands(): Command[] {
  return [
    { id: "new-session", title: "New session", hotkey: hotkeyLabel("N"), run: () => { void newSession(); } },
    { id: "close-active", title: "Close active session", hotkey: hotkeyLabel("W"), run: () => deck.closeActive() },
    { id: "next-waiting", title: "Go to next session waiting for input", hotkey: isMacPlatform() ? "Cmd+Shift+]" : "Ctrl+Shift+]", run: () => deck.focusNextWaiting() },
    { id: "zoom", title: "Zoom active session", hotkey: isMacPlatform() ? "Cmd+Enter" : "Ctrl+Shift+Enter", run: () => deck.toggleZoomActive() },
    { id: "search", title: "Search in terminal", hotkey: hotkeyLabel("F"), run: () => deck.searchActive() },
    { id: "clear", title: "Clear terminal", run: () => deck.clearActive() },
    { id: "broadcast", title: "Broadcast mode (type into several sessions)", hotkey: hotkeyLabel("B"), run: () => deck.toggleBroadcast() },
    { id: "next-region", title: "Go to next region (F6)", hotkey: "F6", run: () => cycleRegion(1) },
    { id: "scenarios", title: "Scenarios: focus the sidebar list", run: () => focusRegion("sidebar") },
    { id: "board", title: "Open the task board", run: () => setView(true) },
    { id: "new-task", title: "New task", hotkey: isMacPlatform() ? "Cmd+Shift+T" : "Ctrl+Shift+T", run: () => { void captureTask(); } },
  ];
}

/** Focus cycling between the sidebar and the active terminal.
 *
 *  Without it the terminal is a one-way door: xterm consumes Tab and Shift+Tab
 *  (they go to the PTY), so once focus landed in a tile — which happens
 *  automatically on launch — the sidebar, the scenario buttons and the
 *  run-now button were unreachable by keyboard entirely. */
type Region = "sidebar" | "terminal";
const REGIONS: Region[] = ["sidebar", "terminal"];

function currentRegion(): Region {
  return sidebar.contains(document.activeElement) ? "sidebar" : "terminal";
}

function focusRegion(r: Region): void {
  if (r === "terminal") {
    if (deck.focusActiveTerminal()) return;
    // No session to go to — stay where something is focusable.
    focusRegion("sidebar");
    return;
  }
  const first = sidebar.querySelector<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  first?.focus();
}

function cycleRegion(step: number): void {
  const i = REGIONS.indexOf(currentRegion());
  focusRegion(REGIONS[(i + step + REGIONS.length) % REGIONS.length]);
}

const COMMANDS: Record<string, () => void> = {
  "palette": () => openPalette(paletteCommands()),
  "new-session": () => { void newSession(); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
  "broadcast": () => deck.toggleBroadcast(),
  "zoom": () => deck.toggleZoomActive(),
  "next-region": () => cycleRegion(1),
  "prev-region": () => cycleRegion(-1),
  "board": () => setView(true),
  "new-task": () => { void captureTask(); },
};

window.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-overlay")) return; // do not intercept while a modal, the palette or a form is open
  if (e.key === "Escape" && deck.exitZoom()) { e.preventDefault(); return; }
  const id = matchHotkey(e, isMacPlatform());
  if (!id) return;
  if (id.startsWith("focus-")) {
    e.preventDefault();
    deck.focusByIndex(Number(id.slice("focus-".length)));
    return;
  }
  const run = COMMANDS[id];
  if (run) { e.preventDefault(); run(); }
});

claudeAvailable().then((ok) => {
  if (!ok) alertModal("The claude executable was not found. Set its path via the COWORK_CLAUDE_PATH environment variable and restart the app.");
});

void boot();
