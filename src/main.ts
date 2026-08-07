import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { applyView, firstFocusable } from "./view";
import { settingsDialog } from "./settings";
import {
  applyScale, broadcastScale, clampScale, currentScale, nextScale, prevScale, scaleLabel,
} from "./ui-scale";
import type { ViewName } from "./view";
import { claudeAvailable, loadLayout, loadUiState, onScheduledFire, onSchedulerBroken, saveUiState, scheduleAck, schedulerReady } from "./ipc";
import { offerUpdateIfAvailable } from "./updater";
import type { Skill, Workspace } from "./ipc";
import { BoardView } from "./board";
import {
  listTasks, resolveTask, taskCapabilities, taskOpenCounts, onTasksChanged, taskWatchSync, createTask,
  taskMigrationStatus, taskMigrate, taskMigrationDismiss, updateTask,
  boardConfigSave, boardStepRewrite, boardStepUsage,
  prList, prDetail, prDiff, prFilePatch, prMergeOptions, prMerge, prClose, prReopen, prWorktreeAdd,
  prWorktreePath, prWorktreeRemove,
  issueTotals, issueWorktreeAdd, issueWorktreePath, issueWorktreeRemove,
} from "./ipc";
import type { MigrationOffer, PullRequest, StepId, Task } from "./ipc";
import { firstTerminal, isTerminal } from "./board-config";
import { issuePrompt } from "./tasks";
import { pollIntervalMs } from "./pr";
import {
  boardPollMs, CLOSED_PAGE_LIMIT, needsCloseConfirmation, needsTotals, nextPageLimit,
  repoFromIssueUrl, sourceOf, unavailableFrom,
} from "./issues";
import { PrView } from "./pr-view";
import { DiffDrawer } from "./diff-drawer";
import type { GhUnavailable } from "./gh-unavailable";
import type { PrState } from "./pr-view";
import { alertModal, confirmModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { runBoot } from "./boot";
import { appMark, iconButton, installSprite } from "./icons";
import { openGithubScreen } from "./github-screen";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
import { resolveScheduledWorkspace } from "./schedule";
import { closeIssueModal, mergeForm, placeholderForm, taskForm } from "./forms";
import { computePatch, openCardModal } from "./card-modal";
import { applyBoardEdit, openBoardEditor } from "./board-editor";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

installSprite();
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
// Each list is a raised surface of its own. The sidebar used to be one
// undifferentiated scroll — heading, rows, heading, rows — so a workspace, a
// scenario and a session all read as the same kind of thing. The class is all this
// takes: the panels render into these mounts exactly as before, and the stylesheet
// turns each one into an island with the heading it already writes as its head.
const wsMount = document.createElement("div");
wsMount.className = "island";
const skMount = document.createElement("div");
skMount.className = "island";
const listMount = document.createElement("div");
listMount.className = "island";
const newBtn = document.createElement("button");
newBtn.textContent = "+ session"; newBtn.className = "btn-primary";
// Between the scenarios and the sessions, and outside both islands: it is the app's
// one primary action, not a row in a list.
sidebar.append(wsMount, skMount, newBtn, listMount);

const boardEl = document.querySelector<HTMLElement>("#board")!;

// The "Terminals | Board | Pull requests" switch. Each screen takes the full
// width because GitHub and Jira boards land here later, and those need room
// rather than a strip.
//
// It mounts into `#viewbar` above the row of screens, not into `#sidebar`. In the
// sidebar it was a flex-column child, so it stretched to whatever width the
// workspace names left it and its buttons had nowhere to grow — which capped the
// type scale at a 17px base before the app's primary navigation started
// horizontally scrolling. Above the row it is content-sized and independent.
const viewbar = document.querySelector<HTMLElement>("#viewbar")!;
const views = document.createElement("div");
views.className = "tk-views";
const termBtn = document.createElement("button");
termBtn.textContent = "Terminals"; termBtn.className = "active";
const boardBtn = document.createElement("button");
boardBtn.textContent = "Board";
const prBtn = document.createElement("button");
prBtn.textContent = "Pull requests";
views.append(termBtn, boardBtn, prBtn);
viewbar.append(views);

// The rest of the top bar: the wordmark on the left, the global actions on the
// right. Both are optional-chained on purpose — three test files import this module
// against a fixture that mirrors only `#app`, `#viewbar` and `#stage`, and a
// non-null assertion here would throw before a single one of their assertions ran.
const markEl = document.querySelector<HTMLElement>("#mark");
if (markEl) {
  const glyph = document.createElement("span");
  glyph.className = "mark-glyph";
  // The application's icon itself, not a glyph standing in for it — see `appMark`.
  glyph.append(appMark(22));
  const text = document.createElement("span");
  text.className = "mark-text";
  text.append(document.createTextNode("cowork"));
  const suffix = document.createElement("span");
  suffix.textContent = "·deck";
  text.append(suffix);
  markEl.append(glyph, text);
}

const actionsEl = document.querySelector<HTMLElement>("#topbar-actions");
if (actionsEl) {
  // Both already exist as commands; these are the same actions with a place to be
  // clicked, for the majority of moments when nobody is holding the keyboard.
  const paletteBtn = iconButton("search", `Command palette (${hotkeyLabel("K")})`);
  paletteBtn.onclick = () => openPalette(paletteCommands());
  const settingsBtn = iconButton("sliders", "Text size");
  settingsBtn.onclick = () => void chooseScale();
  actionsEl.append(paletteBtn, settingsBtn);
}

/** The next step for each of the three unavailabilities, shared by both GitHub
 *  screens: the board's source can be unavailable for exactly the same reasons as
 *  the pull request list's, and two copies would drift apart. Never called for
 *  `no-repo` — that state offers no button, because nothing in the app can fix
 *  it. */
function fixUnavailable(u: GhUnavailable) {
  if (u === "no-gh") void openGithubScreen(deck, workspaces.active?.path ?? ".");
  else void alertModal("Bind a GitHub account in the workspace settings (✎).");
}

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
  onEditBoard: () => void editBoard(),
  onFixUnavailable: (u) => fixUnavailable(u),
  onShowMore: (from) => void showMoreTasks(from),
});
boardEl.append(board.mount);

const prView = new PrView({
  onLaunch: (pr) => void launchFromPr(pr),
  onMerge: (pr) => void mergePr(pr),
  onClose: (pr) => void closePr(pr),
  onReopen: (pr) => void reopenPr(pr),
  onRefresh: () => void refreshPrs(),
  onFixUnavailable: (u) => fixUnavailable(u),
  // The workspace is resolved at call time, not captured: a row can be expanded
  // moments before a switch, and the answer must be about the repository the row
  // came from or about nothing at all.
  onDetail: (pr) => {
    const ws = workspaces.active;
    return ws
      ? prDetail(ws.id, pr.number)
      : Promise.reject(new Error("No workspace is selected."));
  },
  onOpenDiff: (pr, fileIndex, path) => {
    diffDrawer.open(pr, fileIndex, path);
    prView.setOpenDiff(pr.number, fileIndex);
  },
});

/** The diff drawer, beside the list rather than inside it.
 *
 *  Owned here and not by `PrView` because `PrView.render` empties its mount on
 *  every poll tick — every 15 s, and gated on the window having focus, which is
 *  precisely while somebody is reading. A drawer inside it would lose the
 *  reader's scroll position in a document up to 63,000px tall, and their text
 *  selection with it, twice a minute. No focus restore fixes either. */
const diffDrawer = new DiffDrawer({
  // The workspace is resolved at call time for the reason `onDetail` gives: a
  // diff can be asked for moments before a switch, and the answer must be about
  // the repository the row came from or about nothing at all.
  onFetch: (pr) => {
    const ws = workspaces.active;
    return ws
      ? prDiff(ws.id, pr.number)
      : Promise.reject(new Error("No workspace is selected."));
  },
  // A patch, so it cannot take the active workspace or the text size with it.
  onWidth: (cols) => {
    saveUiState({ prDiffCols: cols })
      .catch((e) => console.debug("diff width save failed", e));
  },
  // Focus never moved into the drawer, so on close there is a specific row to
  // go back to — the one for the file that was showing.
  onClosed: (pr, fileIndex) => {
    prView.setOpenDiff(null, null);
    prView.focusFile(pr.number, fileIndex);
  },
  // Resolved at call time and guarded the same way `onFetch` is, for the same
  // reason: this can be pressed moments before a workspace switch.
  onRefetchFile: (pr, fileIndex) => {
    const ws = workspaces.active;
    return ws
      ? prFilePatch(ws.id, pr.number, fileIndex)
      : Promise.reject(new Error("No workspace is selected."));
  },
});

// The pull request screen: a flex row holding the list and the drawer, in that
// DOM order so reading order matches visual order (SC 1.3.2). Created here
// rather than in index.html because nothing else refers to it. It answers to
// `#pr` so the switch's stylesheet rule (`#pr.hidden`) applies exactly as it
// does to the board.
//
// This used to *be* `prView.mount`, which is why that element is now `.pr-list`:
// a drawer inside the mount would be destroyed on every poll — see above.
const prEl = document.createElement("div");
prEl.className = "pr-view";
prEl.id = "pr";
prEl.classList.add("hidden");
prEl.append(prView.mount, diffDrawer.live);
boardEl.after(prEl);
diffDrawer.attach(prEl, prView.mount);

let boardVisible = false;
let boardTimer: ReturnType<typeof setTimeout> | null = null;
let currentView: ViewName = "deck";

function stopBoardPolling() {
  if (boardTimer !== null) { clearTimeout(boardTimer); boardTimer = null; }
}

/** Poll only while the board is on screen and the window is focused, and only
 *  ever one tick ahead.
 *
 *  Replaces a five-second `setInterval` with no focus gate. Two reasons, and the
 *  second applies to the file board as much as to the GitHub one: a GitHub board
 *  at five seconds would spend 14.4% of the hourly GraphQL budget on one
 *  workspace, and `setInterval` schedules the next tick whether or not the
 *  previous one came back — which for a slow network means queued `gh`
 *  processes. The interval is the source's, from `boardPollMs`. */
function scheduleBoardPoll() {
  stopBoardPolling();
  if (currentView !== "board" || !document.hasFocus()) return;
  const source = sourceOf(workspaces.active?.tracker ?? null);
  boardTimer = setTimeout(() => void boardTick(), boardPollMs(source));
}

/** One tick: both reads, then the next tick. The reschedule is at the end rather
 *  than beside the read, so a slow `tasks_open_counts` cannot overlap the next
 *  `tasks_list`.
 *
 *  Shared with the focus handler, which has to re-arm the chain and not merely
 *  read once: blur cleared the handle, so a focus that only refreshed would leave
 *  the board still until the view was left and re-entered — worse than the
 *  interval this replaces. Polling is the primary refresh path; the watcher only
 *  makes it faster, so a watcher failure degrades into a delay and needs no
 *  detection. The sidebar counts degrade the same way, which is why a tick
 *  refreshes them too — otherwise on a workspace without a watcher (an SMB
 *  volume, say) the badge stays at whatever it was at load. Each call has its own
 *  try/catch inside, so one failing handle cannot take the other down. */
async function boardTick() {
  await refreshBoard();
  await refreshCounts();
  scheduleBoardPoll();
}

function setView(view: ViewName) {
  currentView = view;
  boardVisible = view === "board";
  applyView({ deck: deckEl, board: boardEl, pr: prEl, termBtn, boardBtn, prBtn,
              terminalsOnly: [skMount, newBtn, listMount] },
             view);
  if (view === "board") {
    // The read is unconditional — opening the screen is a deliberate act — and
    // the chain is armed separately, so an unfocused window reads once and then
    // waits (see `scheduleBoardPoll`).
    void refreshBoard();
    scheduleBoardPoll();
  } else {
    stopBoardPolling();
  }
  // Leaving the screen stops its polling in the same breath as hiding it: a
  // timer that outlives the view keeps talking to GitHub about a screen nobody
  // is looking at.
  if (view === "pr") void refreshPrs();
  else stopPrPolling();
}
termBtn.onclick = () => setView("deck");
boardBtn.onclick = () => setView("board");
prBtn.onclick = () => setView("pr");

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
  // No kind row on a synthesized board: one synthetic kind is not a choice.
  const draft = await taskForm(caps.board, caps.boardEditable);
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
  if (sourceOf(target.tracker ?? null) === "github") {
    const number = Number(t.id);
    if (!Number.isInteger(number)) {
      await alertModal(`“${t.id}” is not an issue number, so no branch could be derived from it.`);
      return;
    }
    // Before any side effect, exactly as `Deck.launchFromTask` does it on the file
    // path. Behind the worktree call this check was unreachable in the case that
    // needs it: `gh` resolving the default branch offline, the directory removed by
    // hand, a locked index — any of those and the person was told the worktree
    // could not be prepared while a session on that very issue was running two
    // tiles away, with the guard that would have focused it never reached.
    if (deck.focusTaskSession(t.id, target.id)) { setView("deck"); return; }
    // A worktree of its own, on a new branch off the repository's default branch,
    // and the session linked to the issue so a second ▶ focuses it rather than
    // starting a rival session in the same directory.
    const cwd = await issueWorktreeAdd(target.id, number, t.title)
      .catch((e) => { void alertModal(`Could not prepare a worktree for #${t.id}: ${String(e)}`); return null; });
    if (cwd === null) return;
    // The repository comes off the issue's own URL — the same row the prompt is
    // built from — rather than from a command of its own: one less call and one
    // less failure mode, and `issuePrompt` says nothing about the repository when
    // the URL cannot be read.
    await deck.launchOnWorktree(
      cwd, target.id, `☑ #${t.id}`, issuePrompt(t, repoFromIssueUrl(t.path)), t.id);
    setView("deck");
    return;
  }
  // The *target* workspace's configuration, not the active board's: on a shared
  // root the card may belong to another project with another board.json, and the
  // kind's label comes from whichever one owns the card.
  const caps = await taskCapabilities(target.id).catch(() => null);
  // No tracker configured there: the kind's own id is the best label available,
  // which is what an empty configuration makes `kindLabel` fall back to.
  const cfg = caps?.board ?? { v: 1, steps: [], kinds: [] };
  // The prompt is built inside `launchFromTask`, from the card as it stands
  // after the working-step move it attempts — not here, before that move has
  // happened. Building it here would tell the agent a step the card had
  // already left on any board with a `working` step.
  await deck.launchFromTask(target, t, cfg);
  // Both "launched" and "focused" leave a session worth looking at — staying on
  // the board would look like the button did nothing.
  setView("deck");
}

/** The last good list per GitHub workspace, so a failed tick keeps the screen
 *  populated. In memory only, and keyed by workspace id: a late reply about a
 *  workspace nobody is looking at must not repaint the current one.
 *
 *  **GitHub only, deliberately — on the read as much as on the write.** The reason
 *  for keeping stale rows is that being offline or rate-limited is a blip in front
 *  of data that is still true, which is a GitHub condition; a file board's failure
 *  is almost always "the folder is gone", where phantom cards would invite actions
 *  that can only fail and would replace the one screen offering `Configure`. The
 *  plan's code kept them for both sources; narrowed here rather than changing a
 *  shipped screen nobody asked about.
 *
 *  Gating only the write was not enough, and the entry outliving the source is the
 *  reason: switching a workspace's source to a folder is a first-class action with
 *  its own confirmation, and it leaves this map holding that workspace's issues
 *  under the same id. An ungated read then handed the file board those issues on
 *  its first failure — phantom cards on a board whose root is gone, `Configure`
 *  withheld because the list was not empty, and a count line about issues that
 *  were never in that folder. */
const lastGood = new Map<
  string, { tasks: Task[]; fetchedAt: number; total: number | null; closedTotal: number | null }
>();

/** How far each GitHub workspace has been paged, or absent for the source's own
 *  defaults (50 open, 20 closed).
 *
 *  Keyed by workspace, so paging one board does not widen another's — and every
 *  poll from then on fetches the larger page, which is the honest cost of showing
 *  rows somebody asked to see. In memory only: a page is a reading position, not a
 *  setting, and a restart landing back on the first fifty is the right default. */
const pageLimits = new Map<string, number>();

/** Which workspace the board is currently showing an answer for, whatever that
 *  answer is — rows, an error beside them, or an unavailable box.
 *
 *  The one thing the skeleton needs to know. A loading state is painted only when
 *  this is not the workspace about to be read: the first read of a board, and the
 *  first read after a switch, are the two moments when nothing on screen belongs
 *  to it. A poll tick keeps what is drawn; replacing a screen that is true — or a
 *  box explaining why it cannot be — with grey boxes every 30 s is a flicker
 *  rather than feedback. */
let boardShowing: string | null = null;

/** "Show more": one step past the page the rows on screen were measured against,
 *  then read it again. `from` comes from the view because the two states start at
 *  different defaults and only the view knows which filter the button was under. */
async function showMoreTasks(from: number) {
  const ws = workspaces.active;
  if (!ws) return;
  pageLimits.set(ws.id, nextPageLimit(from));
  await refreshBoard();
}

/** Redraw the active workspace's board. Every IPC call is isolated: one failing
 *  handle must not take the whole tick down. */
async function refreshBoard() {
  const ws = workspaces.active;
  if (!ws) {
    board.render({ project: "", caps: null, error: null, tasks: [], links: [], source: "fs" });
    // No workspace is nobody's answer, so the next board to be read gets a
    // skeleton rather than inheriting this screen's emptiness.
    boardShowing = null;
    return;
  }
  const wsId = ws.id;
  const source = sourceOf(ws.tracker ?? null);
  const pageLimit = pageLimits.get(wsId) ?? null;
  let caps = null;
  try { caps = await taskCapabilities(wsId); } catch (e) { console.debug("caps failed", e); }

  // Until now this window drew nothing at all: `setView("board")` called this, and
  // the first render came after every await below — so opening a GitHub board left an
  // empty pane for as long as a repository lookup plus a page per state takes.
  //
  // Painted after `taskCapabilities` and not before it, and the few milliseconds are
  // affordable because that call is a local read by construction — `provider_for`
  // does no I/O, which is what keeps the three unavailable states reachable. What it
  // buys is a head drawn with this board's real `+ task` and `⚙` rather than one
  // that grows buttons a moment later. It is not what keeps "No task tracker is
  // configured" off the screen: the skeleton branch in `board.ts` sits ahead of that
  // one deliberately, and the comment there is the reason.
  if (boardShowing !== wsId && workspaces.active?.id === wsId) {
    board.render({
      project: ws.name, caps, error: null, tasks: [], links: deck.taskLinks(wsId),
      source, unavailable: null, fetchedAt: null, total: null, closedTotal: null,
      rateRemaining: null, loading: true, pageLimit,
    }, Date.now());
  }

  let tasks: Task[] = [];
  let error: string | null = null;
  let unavailable: GhUnavailable | null = null;
  let total: number | null = null;
  let closedTotal: number | null = null;
  let rateRemaining: number | null = null;
  let fetchedAt: number | null = null;

  if (caps) {
    const cfg = caps.board;
    try {
      tasks = await listTasks(wsId, pageLimit ?? undefined);
      fetchedAt = Date.now();
      const open = tasks.filter((t) => !isTerminal(cfg, t.status)).length;
      const closed = tasks.length - open;
      // Only when it can change the answer: a page shorter than what was asked for
      // *is* the total, so in a repository under fifty open issues this never
      // fires. Measured against the page actually requested rather than against
      // the constant — a board paged to 150 would otherwise ask for totals it
      // already has on screen, every 30 s.
      //
      // Either state being at its cap is reason enough: the closed filter needs its
      // own total for the same reason the open one does, and both come back in the
      // one point this call costs.
      if (source === "github"
          && (needsTotals(open, pageLimit ?? undefined)
            || needsTotals(closed, pageLimit ?? CLOSED_PAGE_LIMIT))) {
        const t = await issueTotals(wsId).catch(() => null);
        if (t) { total = t.open; closedTotal = t.closed; rateRemaining = t.rateRemaining; }
      }
      if (source === "github") lastGood.set(wsId, { tasks, fetchedAt, total, closedTotal });
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      // The three states in which the source cannot be read at all become their
      // own screen; everything else — offline, rate-limited, a missing scope —
      // keeps the last good list on screen beside the error, with its age. Asked
      // only of a GitHub source: none of those markers can come out of a folder,
      // and a file board's own errors already say what is wrong.
      const known = source === "github" ? unavailableFrom(msg) : null;
      if (known !== null) unavailable = known;
      else error = msg;
      // Read under the same condition it is written under: the map is keyed by
      // workspace id and outlives a source switch, so an ungated read is how a
      // file board ends up drawing the issues that workspace had while it was
      // GitHub-backed.
      const kept = source === "github" ? lastGood.get(wsId) : undefined;
      if (kept) {
        tasks = kept.tasks;
        fetchedAt = kept.fetchedAt;
        total = kept.total;
        closedTotal = kept.closedTotal;
      }
    }
  }
  let migration: MigrationOffer | null = null;
  // Asked only where it can be answered: a GitHub workspace has no previous
  // folder, and the backend refuses the command rather than inventing one.
  if (source === "fs") {
    try { migration = await taskMigrationStatus(wsId); }
    catch (e) { console.debug("migration status failed", e); }
  }
  // The workspace may have been switched while we waited on IPC: a late reply
  // must not repaint the board with another workspace's data over the current one.
  if (workspaces.active?.id !== wsId) return;
  board.render({
    // This workspace's links, never the app's: the rules behind "in progress" and
    // "no live session" match on the card id, and an issue number is unique to one
    // repository. A session on another workspace's #42 must not speak for this
    // board's — it would read as in progress and lose its ▶.
    project: ws.name, caps, error, tasks, links: deck.taskLinks(wsId), migration,
    source, unavailable, fetchedAt, total, closedTotal, rateRemaining, pageLimit,
  }, Date.now());
  // Whatever the board ended up drawing, it is this workspace's answer — so the
  // next tick keeps it rather than blanking it. Set after the render, and after the
  // late-reply guard above, so a reply that was discarded does not claim the screen.
  boardShowing = wsId;
}

/** The sidebar counts — one handle covering every workspace. */
async function refreshCounts() {
  try { workspaces.setCounts(await taskOpenCounts()); }
  catch (e) { console.debug("taskOpenCounts failed", e); }
}

/** ✓ on a card. A file card is resolved; an issue is closed, which is public, so
 *  it is confirmed first and carries the reason the confirmation collected. */
async function closeTask(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  if (sourceOf(ws.tracker ?? null) !== "github") {
    try { await resolveTask(ws.id, t.id); }
    catch (e) { await alertModal(`Could not close the task: ${String(e)}`); }
    await refreshBoard();
    await refreshCounts();
    return;
  }
  const caps = await taskCapabilities(ws.id).catch(() => null);
  // Which step closes an issue is the configuration's answer, not the literal
  // "closed": the synthesized board names it, and asking `firstTerminal` is how
  // the four write paths stay one. No terminal step means nothing to do, and
  // saying so beats a patch the backend would refuse.
  const step = caps ? firstTerminal(caps.board) : null;
  if (step === null) {
    await alertModal("This board has no closing step, so there is nothing for ✓ to do.");
    return;
  }
  const reason = await closeIssueModal(t.id, t.title);
  if (reason === null) return;
  let closed = true;
  try { await updateTask(ws.id, t.id, { status: step, reason }); }
  catch (e) {
    closed = false;
    await alertModal(`Could not close the issue: ${String(e)}`);
  }
  await refreshBoard();
  await refreshCounts();
  // Only a close that actually happened leaves a worktree nobody needs.
  if (closed) await offerIssueWorktreeCleanup(t);
}

/** A drag or an arrow click both land here: a step-only patch, exactly like
 *  the modal's own step-only move (card-modal.ts's computePatch).
 *
 *  A move into a terminal step on a GitHub board *is* a close, so it asks the same
 *  question and carries the same reason — the drag, the arrow and ✓ are one write
 *  path, and a confirmation that only one of them raised would be a hole rather
 *  than a shortcut. Which moves need it is `needsCloseConfirmation`'s decision. */
async function moveTask(t: Task, step: StepId) {
  const ws = workspaces.active;
  if (!ws) return;
  const source = sourceOf(ws.tracker ?? null);
  const caps = source === "github" ? await taskCapabilities(ws.id).catch(() => null) : null;
  let reason: string | null = null;
  if (caps && needsCloseConfirmation(caps.board, t.status, step, source)) {
    reason = await closeIssueModal(t.id, t.title);
    if (reason === null) return;
  }
  let moved = true;
  try { await updateTask(ws.id, t.id, reason === null ? { status: step } : { status: step, reason }); }
  catch (e) {
    moved = false;
    // Nothing here is optimistic — a native drag never moves the node, and this
    // awaits the write before re-reading the board. So a refusal has to be said
    // out loud: without the alert the drag or the arrow would simply appear to
    // do nothing at all.
    await alertModal(`Could not move the card: ${String(e)}`);
  }
  await refreshBoard();
  await refreshCounts();
  // A closing move orphans the issue's worktree exactly as ✓ does.
  if (moved && reason !== null) await offerIssueWorktreeCleanup(t);
}

/** A closed issue leaves the worktree its session ran in.
 *
 *  The same three guards as `offerWorktreeCleanup`: a live session in it stops the
 *  offer outright, the backend refuses while it is dirty, and the person still has
 *  to say yes. Offered when the issue closes, never automatic.
 *
 *  **It silently does not offer for an issue renamed on GitHub since the worktree
 *  was made.** `issue_worktree_path` derives the directory from `slug(title)`, so
 *  a renamed issue reports `None` for the old one — known, recorded under Task 23,
 *  and untidiness rather than loss: the `{number}-` prefix keeps the orphan
 *  adjacent to its replacement on disk. */
async function offerIssueWorktreeCleanup(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  const number = Number(t.id);
  // An issue's id is its number. Anything else is not an issue and the derived
  // path would be nonsense — an fs card reaching here is a bug elsewhere, and a
  // silent return is the safe reading of it.
  if (!Number.isInteger(number)) return;
  const path = await issueWorktreePath(ws.id, number, t.title).catch(() => null);
  if (!path) return;
  if (deck.hasSessionIn(path)) return;
  if (!(await confirmModal(`Remove the worktree at ${path}?`))) return;
  await issueWorktreeRemove(ws.id, number, t.title)
    .catch((e) => void alertModal(String(e)));
}

/** Open a card, edit it, and save only what changed — see card-modal.ts for
 *  why a full-field patch would be unsafe here. */
async function openCard(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps) return;
  const canWrite = !t.damaged && !t.conflict;
  // `boardEditable` is what says whether this board has kinds worth choosing
  // between — the same flag the ⚙ button reads.
  const edited = await openCardModal(t, caps.board, canWrite, caps.boardEditable);
  if (!edited) return;
  const patch = computePatch(t, edited);
  if (Object.keys(patch).length === 0) return;
  try { await updateTask(ws.id, t.id, patch); }
  catch (e) { await alertModal(`Could not save the card: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}

/** ⚙: edit the board's steps and kinds, rewriting any cards a rename or a
 *  removal leaves pointing at a step the saved configuration no longer has. */
async function editBoard() {
  const ws = workspaces.active;
  if (!ws) return;
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps) return;
  // The board shown right now is the default two-step fallback, not what is
  // on disk — see board.ts's own `caps.boardError` banner. Saving it would ask
  // the backend to replace a board.json it could not even read; the backend
  // refuses that (tasks_cmd::save_config), but the person has to be told
  // before filling in a form, not after submitting it.
  if (caps.boardError) {
    await alertModal(
      `board.json could not be used: ${caps.boardError}. Fix the file by hand before configuring the board here.`);
    return;
  }
  const usage = await boardStepUsage(ws.id).catch(() => []);
  const result = await openBoardEditor(caps.board, usage);
  if (!result) return;
  // The rewrite-then-save sequence lives in board-editor.ts, taking what it
  // needs as arguments: the decision it makes when cards are skipped is worth a
  // test, and main.ts is not reachable from one.
  const written = await applyBoardEdit(result, {
    rewrite: (from, to, config) => boardStepRewrite(ws.id, from, to, config),
    save: (config) => boardConfigSave(ws.id, config),
    alert: alertModal,
    confirm: confirmModal,
  });
  if (!written) return;
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

/* --- Pull requests ------------------------------------------------------- */

let prTimer: ReturnType<typeof setTimeout> | null = null;
/** Which workspace the pull request view is showing an answer for — rows, an error
 *  beside them, or an unavailable box. The board's `boardShowing`, for the same
 *  reason and with the same rule: a skeleton is painted only where nothing on
 *  screen belongs to the workspace about to be read.
 *
 *  Not derivable from `prState`. `workspace` alone says which workspace the state is
 *  *about*, and pairing it with `fetchedAt === null` was wrong in the case that
 *  matters most: a first read that fails leaves both set that way, so every tick
 *  from then on would blank the error — or the unavailable box and its only button —
 *  for grey boxes and then put it back. */
let prShowing: string | null = null;
let prState: PrState = {
  workspace: null, unavailable: null, prs: [], error: null, fetchedAt: null, total: null,
  loading: false,
};

function stopPrPolling() {
  if (prTimer !== null) { clearTimeout(prTimer); prTimer = null; }
}

/** Poll only while the PR view is on screen and the window is focused. Every
 *  path that schedules a tick goes through here, so there is one place where
 *  the two conditions are checked and one place that owns the handle. */
function schedulePrPoll() {
  stopPrPolling();
  if (currentView !== "pr" || !document.hasFocus()) return;
  prTimer = setTimeout(() => void refreshPrs(), pollIntervalMs(prState.prs));
}

/** Re-read the list. The single-timer-chain shape matters: the next tick is
 *  scheduled only after this request has returned, so a slow network cannot
 *  queue up `gh` processes. */
async function refreshPrs() {
  // The previous handle is dropped before the request, not after it: a manual ↻
  // in the middle of a wait must not leave a tick behind.
  stopPrPolling();
  const ws = workspaces.active;
  if (!ws) {
    prState = {
      ...prState, workspace: null, unavailable: "no-account", prs: [], loading: false,
    };
    prView.render(prState, Date.now());
    // No workspace is nobody's answer, so the next one read gets a skeleton rather
    // than inheriting this screen.
    prShowing = null;
    return;
  }
  if (!ws.github) {
    prState = {
      ...prState, workspace: ws.name, unavailable: "no-account", prs: [], loading: false,
    };
    prView.render(prState, Date.now());
    prShowing = ws.id;
    // Nothing will change here without a human editing the workspace, so this
    // state does not poll — but it also must not leave the previous one polling.
    return;
  }
  const wsId = ws.id;
  // Only where there is nothing of this workspace's to keep: a poll tick every 15 s
  // keeps the rows it already has, with the age line above saying how old they are.
  if (prShowing !== wsId) {
    prState = {
      workspace: ws.name, unavailable: null, prs: [], error: null, fetchedAt: null,
      total: null, loading: true,
    };
    prView.render(prState, Date.now());
  }
  try {
    const prs = await prList(wsId);
    // The workspace may have been switched while we waited on IPC: a late reply
    // must not repaint the view with another workspace's pull requests.
    if (workspaces.active?.id !== wsId) return;
    prState = {
      workspace: ws.name, unavailable: null, prs,
      error: null, fetchedAt: Date.now(),
      // What came back, and nothing more: `pr_list` asks for one page, so the
      // number of open pull requests the repository has is not knowable from
      // here (see #115).
      total: prs.length,
      loading: false,
    };
  } catch (e) {
    if (workspaces.active?.id !== wsId) return;
    const msg = String((e as { message?: string })?.message ?? e);
    // Known unavailabilities become their own screen; everything else — a
    // missing `repo` scope, the rate limit, an offline machine — keeps the last
    // good list on screen beside the error, with its age. The mapping itself now
    // lives in `issues.ts` and is read by the board too: it used to be an
    // if-chain here, which was one place for the two GitHub views to disagree
    // about what "no repository" looks like.
    const known = unavailableFrom(msg);
    if (known !== null) prState = { ...prState, unavailable: known, loading: false };
    else prState = { ...prState, error: msg, loading: false };
  }
  prView.render(prState, Date.now());
  // After the render and after the two late-reply guards, so the drawer is never
  // told about a workspace whose answer was discarded. It re-reads the head of
  // whichever pull request it is showing and offers a Reload if the branch has
  // moved — it never swaps the diff out from under a reader.
  diffDrawer.onPoll(prState.prs);
  // Whatever it ended up drawing, it is this workspace's answer — so the next tick
  // keeps it. After the render, and after the two late-reply guards above, so a
  // reply that was discarded does not claim the screen.
  prShowing = wsId;
  schedulePrPoll();
}

// Focus is the other half of "only while watched": a minimised or background
// window polls nothing, and coming back refreshes at once rather than at the
// next tick.
window.addEventListener("focus", () => {
  if (currentView === "pr") void refreshPrs();
  // Coming back refreshes at once rather than at the next tick, which is the
  // whole point of pausing on blur — and `boardTick` re-arms the chain the blur
  // cleared.
  if (currentView === "board") void boardTick();
});
window.addEventListener("blur", () => { stopPrPolling(); stopBoardPolling(); });

/** ▶ on a row: a worktree for the branch, then an ordinary session inside it. */
async function launchFromPr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  try {
    // `isCrossRepository` decides whether the backend may reuse a worktree
    // already on the branch: for a fork the head is not a local branch at all.
    const added = await prWorktreeAdd(ws.id, pr.number, pr.headRefName, pr.isCrossRepository);
    const cwd = added.path;
    await deck.launchOnWorktree(
      cwd, ws.id, `⑂ #${pr.number}`,
      `You are working on pull request #${pr.number}: ${pr.title}\n`
      + `Branch ${pr.headRefName} → ${pr.baseRefName}, checked out in ${cwd}.`
      // Said out loud when the directory was already there for something else —
      // an issue's worktree on the same branch, which is the ordinary case once
      // the branch that fixes an issue is the branch the pull request proposes.
      // Without it the same commits under two names read as two pieces of work.
      + (added.reused
        ? `\nThat directory already existed for this branch and was reused, so anything`
          + ` already committed there is part of this pull request.`
        : ""),
    );
    setView("deck");
  } catch (e) {
    await alertModal(`Could not prepare a worktree for #${pr.number}: ${String(e)}`);
  }
}

async function mergePr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  const opts = await prMergeOptions(ws.id).catch(() => null);
  if (!opts || opts.strategies.length === 0) {
    await alertModal("Could not read which merge strategies this repository allows.");
    return;
  }
  const choice = await mergeForm(pr, opts);
  if (!choice) return;
  let merged = false;
  try {
    await prMerge(ws.id, pr.number, choice.strategy, pr.headRefOid, choice.deleteBranch);
    merged = true;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    // gh refuses when the head has moved — which is the guarantee working, not
    // a failure to apologise for.
    await alertModal(
      msg.includes("match-head-commit") || msg.includes("head commit")
        ? `#${pr.number} changed since you looked at it. Refresh and read it again.`
        : `Could not merge #${pr.number}: ${msg}`,
    );
  }
  // Only a pull request that really is done has a worktree nobody needs.
  if (merged) await offerWorktreeCleanup(pr);
  await refreshPrs();
}

async function closePr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  if (!(await confirmModal(`Close #${pr.number} “${pr.title}” without merging?`))) return;
  const closed = await prClose(ws.id, pr.number)
    .then(() => true)
    .catch((e) => { void alertModal(String(e)); return false; });
  if (closed) await offerWorktreeCleanup(pr);
  await refreshPrs();
}

/** A merged or closed pull request leaves a worktree behind.
 *
 *  Three guards, because the directory may hold work nobody else has: a live
 *  session in it stops the offer outright, the backend refuses while it is
 *  dirty, and the person still has to say yes. */
async function offerWorktreeCleanup(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  const path = await prWorktreePath(ws.id, pr.number, pr.headRefName).catch(() => null);
  if (!path) return;
  if (deck.hasSessionIn(path)) return;
  if (!(await confirmModal(`Remove the worktree at ${path}?`))) return;
  await prWorktreeRemove(ws.id, pr.number, pr.headRefName)
    .catch((e) => void alertModal(String(e)));
}

// Reopen restores the state of a moment ago, so it does not ask.
async function reopenPr(pr: PullRequest) {
  const ws = workspaces.active;
  if (!ws) return;
  await prReopen(ws.id, pr.number).catch((e) => void alertModal(String(e)));
  await refreshPrs();
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
  // `boardTick`, not `refreshBoard` — deliberate, and not a copy of the line
  // below. A switch changes which source the board has, and the pending tick was
  // armed for the old one: github→fs would wait 30 s once, fs→github would fire
  // at 5 s. `scheduleBoardPoll` stops the old handle and re-reads the source, so
  // going through `boardTick` re-arms at the new interval without making this a
  // second owner of the timer. Do not simplify it back.
  if (boardVisible) void boardTick();
  // The pull requests on screen belong to the workspace that was active a
  // moment ago; re-reading also re-points the poll at the new one. The drawer
  // goes with them, cache and all: its slots are keyed by pull request number,
  // and two repositories both have a #7.
  diffDrawer.reset();
  // `reset` deliberately does not hand focus back, so the mark it left on the
  // row has to be cleared from here. Two repositories both have a #7, and a
  // stale mark would land on whichever row happens to share the number.
  prView.setOpenDiff(null, null);
  if (currentView === "pr") void refreshPrs();
}, () => {
  // A workspace was added, edited or deleted: its tracker root may have moved,
  // so re-point the watcher and re-read the sidebar counts.
  void taskWatchSync();
  void refreshCounts();
}, (workspaceId) => deck.markAuthStale(workspaceId));
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

/** Named, because the empty deck offers the same scenarios the sidebar does and both must
 *  go through one path: resolve the workspace, fill the prompt's placeholders, launch. */
const launchScenario = async (skill: Skill) => {
  const ws = await requireWorkspace();
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
};
const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null,
  (skill) => { void launchScenario(skill); },
  (skill) => { void runScheduledNow(skill); }, () => workspaces.all.map((w) => w.id),
   () => workspaces.active?.name ?? null);
// Deleting a workspace strands the scenarios pinned to it — the confirmation
// says how many before it happens.
workspaces.setSkillsSource(() => skills.all);
const newSession = async () => {
  const ws = await requireWorkspace();
  if (ws) await deck.launch(ws, null);
};
newBtn.onclick = () => { void newSession(); };
// What an empty deck can offer. Wired here rather than in the constructor because the
// deck is built long before these exist — the same reason `setSkillsSource` is a setter.
deck.setEmptyActions({
  newSession: () => { void newSession(); },
  addWorkspace: () => { void workspaces.add(); },
  scenarios: () => skills.all,
  runScenario: (skill) => { void launchScenario(skill); },
});

/** Human-readable binding for the palette. Filled in because the `hotkey`
 *  field existed on Command from the start and was never populated, so the
 *  palette — and with it every binding, including Cmd+K itself — was
 *  undiscoverable. */
function hotkeyLabel(letter: string): string {
  return isMacPlatform() ? `Cmd+${letter}` : `Ctrl+Shift+${letter}`;
}

/** Apply a scale everywhere and remember it.
 *
 *  Three things, and none of them is optional: the root's font size, from which every
 *  `rem` in the stylesheet resolves; the broadcast, which is how live terminals learn
 *  their new pixel size, since xterm reads no CSS; and the write, sent as a patch so
 *  it cannot take the active workspace with it. A failed write leaves the size applied
 *  — a preference that will not persist is still a preference for this session. */
function setScale(scale: number): void {
  applyScale(scale, document.documentElement);
  broadcastScale(currentScale());
  saveUiState({ uiScale: currentScale() })
    .catch((e) => console.debug("ui scale save failed", e));
}

async function chooseScale(): Promise<void> {
  // `settingsDialog` previews live and puts the old value back on cancel, so there
  // is nothing to undo here — only something to persist.
  const picked = await settingsDialog();
  if (picked !== null) setScale(picked);
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
    { id: "board", title: "Open the task board", run: () => setView("board") },
    { id: "prs", title: "Open pull requests", run: () => setView("pr") },
    { id: "new-task", title: "New task", hotkey: isMacPlatform() ? "Cmd+Shift+T" : "Ctrl+Shift+T", run: () => { void captureTask(); } },
    { id: "github", title: "GitHub: accounts and gh install", run: () => void openGithubScreen(deck, workspaces.active?.path ?? ".") },
    // The two steps are direct commands because stepping is what a person wants
    // most often and it needs nothing on screen to do; the dialog exists for
    // choosing, which needs the current value visible. Titles carry the value so
    // the palette is not silent about where you already are.
    { id: "text-larger", title: `Text size: larger (now ${scaleLabel(currentScale())})`, run: () => setScale(nextScale(currentScale())) },
    { id: "text-smaller", title: `Text size: smaller (now ${scaleLabel(currentScale())})`, run: () => setScale(prevScale(currentScale())) },
    { id: "settings", title: "Text size…", run: () => void chooseScale() },
  ];
}

/** Focus cycling between the sidebar and the active terminal.
 *
 *  Without it the terminal is a one-way door: xterm consumes Tab and Shift+Tab
 *  (they go to the PTY), so once focus landed in a tile — which happens
 *  automatically on launch — the sidebar, the scenario buttons and the
 *  run-now button were unreachable by keyboard entirely. */
type Region = "sidebar" | "screen" | "drawer";
/** The cycle, which is not fixed: the diff drawer is a region only while it is
 *  open, because a region you cannot see is a stop that does nothing.
 *
 *  It has to be one at all — `currentRegion` decides by `sidebar.contains(...)`,
 *  so without this focus inside the drawer reads as `"screen"` and F6 from a diff
 *  sends you to the sidebar, with no key at all going the other way. */
function regions(): Region[] {
  return diffDrawer.isOpen() ? ["sidebar", "screen", "drawer"] : ["sidebar", "screen"];
}

/** Focus on a `#viewbar` tab reads as "screen" here, so F6 from a tab goes to the
 *  sidebar in both directions. The tabs are deliberately outside the cycle rather
 *  than a third region: they are the first thing in the DOM, so plain Tab reaches
 *  them from the top, which the sidebar's own blocks never could — they sat behind
 *  the tabs when the switch lived there. */
function currentRegion(): Region {
  // The drawer first, because it is inside the screen: asked in the other order
  // every answer would be "screen".
  if (diffDrawer.contains(document.activeElement)) return "drawer";
  return sidebar.contains(document.activeElement) ? "sidebar" : "screen";
}

function focusRegion(r: Region): void {
  if (r === "drawer") {
    if (diffDrawer.focusFirst()) return;
    focusRegion("sidebar");
    return;
  }
  if (r === "screen") {
    // Whichever screen is showing, not the deck unconditionally. It was the deck:
    // from a board row, F6 called `focus()` on an xterm inside a `display: none`
    // `#deck`, which does nothing at all, so focus stayed put and the key looked
    // broken. Plain Tab still worked, which is what made this a degraded shortcut
    // rather than a trap — but "the second region" has meant three different
    // things since the board and the pull request screen arrived.
    if (currentView === "deck") {
      if (deck.focusActiveTerminal()) return;
    } else {
      const target = firstFocusable(currentView === "board" ? boardEl : prEl);
      if (target) { target.focus(); return; }
    }
    // Nothing to go to — no session yet, or a board still loading. Stay somewhere
    // focusable rather than dropping focus on the floor.
    focusRegion("sidebar");
    return;
  }
  firstFocusable(sidebar)?.focus();
}

function cycleRegion(step: number): void {
  const cycle = regions();
  // A region not in the cycle would give -1, and -1 + 1 is 0 — the sidebar,
  // which is a place worth being. Nothing produces that today; it costs a
  // subtraction to not have to think about it again when a fourth arrives.
  const i = cycle.indexOf(currentRegion());
  focusRegion(cycle[(i + step + cycle.length) % cycle.length]);
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
  "board": () => setView("board"),
  "prs": () => setView("pr"),
  "new-task": () => { void captureTask(); },
  "github": () => void openGithubScreen(deck, workspaces.active?.path ?? "."),
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

void offerUpdateIfAvailable();

/** Read the stored text size and apply it, then boot.
 *
 *  Before `boot()` and deliberately not a step inside it: `runBoot` stops at the first
 *  failing step, so a preference that could not be read would take the layout restore
 *  and the scheduler handshake down with it. A preference that cannot be read is a
 *  preference at its default, not a dead app — hence the catch here and the `finally`
 *  below.
 *
 *  Awaited rather than fired alongside, because `boot()` restores the session layout:
 *  terminals built during it read the current scale in their constructor, and a race
 *  would give them the default and leave them there until the next change. */
async function bootWithStoredScale(): Promise<void> {
  let scale = currentScale();
  try {
    const ui = await loadUiState();
    scale = clampScale(ui.uiScale);
    // The drawer's width rides on the same read. It is applied whether or not
    // the drawer is open, because the width is what the pane is drawn at the
    // moment it first appears — set later, the first open would flash the
    // stylesheet's fallback.
    diffDrawer.setCols(ui.prDiffCols);
  } catch (e) {
    console.debug("ui state read failed, using the defaults", e);
  }
  applyScale(scale, document.documentElement);
  await boot();
}

void bootWithStoredScale();
