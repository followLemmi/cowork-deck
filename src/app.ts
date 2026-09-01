import { WorkspacesPanel } from "./workspaces";
import { mountMemory } from "./memory-page";
import { NoteReader } from "./note-reader";
import { SkillsPanel } from "./skills";
import { Deck, nextWaitingAcross, type SessionCounts } from "./sessions";
import {
  applyPanel, applyWorkspacePanel, firstFocusable,
  PANEL_TITLE, WORKSPACE_PAGES, WORKSPACE_TITLE,
} from "./view";
import { wireResizer } from "./resize";
import { settingsDialog } from "./settings";
import type { SettingsSection } from "./settings";
import { syncDialog } from "./sync-dialog";
import { offerBanner, shouldOffer } from "./sync-offer";
import {
  applyScale, broadcastScale, clampScale, currentScale, nextScale, prevScale, scaleLabel,
} from "./ui-scale";
import type { PanelPage, WorkspacePage } from "./view";
import {
  claudeAvailable, closeSession, deleteSkillHistory, listRuns, loadLayout, loadUiState,
  memoryForgetCaptureAnswer, memoryWarm, onMemoryChanged, onRunsChanged,
  onScheduledFire, onSchedulerBroken, onQuitBlocked, quitCancelled, quitConfirmed,
  revealPath, saveUiState, scheduleAck, schedulerReady, openWorkspaceWindow, onSessionOwner,
  onWorkspacesChanged,
  syncSummary,
  hostPlatform,
  configPaths,
  usageSnapshot, onUsageChanged,
  type AiUsage,
  type HandOffTile,
  type SessionState,
} from "./ipc";
import { LimitsBlock } from "./usage-block";
import { deckLimit, LimitNotifier } from "./usage";
import { offerUpdateIfAvailable } from "./updater";
import { TerminalDrawer, DEFAULT_TERMINAL_ROWS } from "./drawer";
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
import type { MigrationOffer, PullRequest, RunRecord, StepId, Task } from "./ipc";
import { firstTerminal, isTerminal } from "./board-config";
import { issuePrompt } from "./tasks";
import { pollIntervalMs } from "./pr";
import {
  boardPollMs, CLOSED_PAGE_LIMIT, needsCloseConfirmation, needsTotals, nextPageLimit,
  fsRootOf, repoFromIssueUrl, sourceOf, unavailableFrom,
} from "./issues";
import { HistoryView } from "./history";
import { reconcileParams, type RunFilters } from "./runs";
import { PrView } from "./pr-view";
import { DiffDrawer } from "./diff-drawer";
import type { GhUnavailable } from "./gh-unavailable";
import type { PrState } from "./pr-view";
import { alertModal, confirmModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { runBoot } from "./boot";
import { appMark, iconButton, installSprite, type IconName } from "./icons";
import { openGithubScreen } from "./github-screen";
import { fillPlaceholders, resolvePrompt } from "./placeholders";
import { resolveScheduledWorkspace } from "./schedule";
import { closeIssueModal, mergeForm, placeholderForm, taskForm } from "./forms";
import { computePatch, openCardModal } from "./card-modal";
import { applyBoardEdit, openBoardEditor } from "./board-editor";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { listen, emit, emitTo } from "@tauri-apps/api/event";
import {
  allSessions, sumWaiting, windowOf,
  type RemoteSession, type SessionsByWindow, type WindowSessions,
} from "./cross-window";
import { addressedTo, MAIN_WINDOW_LABEL, workspaceIdOf, workspaceLabel } from "./window-role";
import { hasLeftWindow, pressStartsOnControl, startsTearOut } from "./tear-out";
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
import type { WindowRole } from "./window-role";

/** The whole app, for either kind of window.
 *
 *  Extracted from `main.ts`, which was a 1597-line single-window bootstrap: it
 *  queried `#sidebar`, `#deck` and `#board` at module scope and wired everything
 *  below. Run twice, several of those lines stop being harmless — a scheduled
 *  fire launched N times, N update prompts racing one `relaunch()`, N modals.
 *
 *  A function rather than an inline `if (isMain)` branch, and the reason is the
 *  test at the bottom of `tests/app-singletons.test.ts`: the singletons are
 *  spread over a dozen places with no seam an assertion could hold, and the
 *  duplicate-launch class needs exactly one boundary that can be asserted. A
 *  second HTML entry alone would not do either — it would duplicate the palette,
 *  the hotkeys, region cycling, and the board and pull request screens, all of
 *  which are identical between the two kinds of window.
 *
 *  The wrap is otherwise mechanical. The forward references keep working: the
 *  board's callbacks call `launchFromTask`, which reads `workspaces` declared
 *  hundreds of lines later, but those are closures invoked after initialisation,
 *  so function scope behaves exactly as module scope did. There was no top-level
 *  `await` to unwind.
 */
export function startApp(role: WindowRole): Promise<void> {

  /** Whether this window speaks for the app rather than for one workspace.
   *
   *  Everything gated on it is something the backend does once, or something a
   *  person should be asked once — not something each window has its own copy
   *  of. A screen, a hotkey, a palette or a poll is per-window and is not here.
   *
   *  Deliberately one flag read in a handful of named places rather than a role
   *  check scattered through the file: `tests/app-singletons.test.ts` asserts the
   *  whole class at once, and it can only do that if the class has a boundary.
   */
  const isMain = role.kind === "main";
  /** The workspace this window is pinned to, or null when it speaks for the app.
   *
   *  `isMain` answers "may this window do the things that must happen once"; this
   *  answers "is this window ABOUT one workspace", and the two are not the same
   *  question even though today one is the negation of the other. What hangs off
   *  this one is the shape of the window: a window pulled out to hold `relay` is
   *  a window whose every surface is `relay`'s, so the app-wide navigation is not
   *  hidden there — it is not built. */
  const pinnedTo = role.kind === "workspace" ? role.workspaceId : null;
  /** This window's own label — what `session://owner` is compared against. */
  const myLabel = getCurrentWindow().label;
  /** For every listener whose event is addressed to one window rather than
   *  broadcast: `session://focus`, `workspace://gone`, `workspace://take`. A bare
   *  `listen` hears all three whoever they were sent to — see `addressedTo`, and
   *  #349 for what that cost. Only the three, deliberately: every other listener
   *  in this file is waiting on a broadcast and must go on hearing it. */
  const addressed = addressedTo(myLabel);

  installSprite();
  /** The panel — still `#sidebar` in the DOM. The element stopped being a sidebar
   *  the moment the rail arrived beside it: it is one column holding one page out
   *  of five. The id stays because it is written into some forty selectors and a
   *  dozen test fixtures, and renaming it is a commit of its own rather than a
   *  line in this one. */
  const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
  const deckEl = document.querySelector<HTMLElement>("#deck")!;
  const panelHead = document.querySelector<HTMLElement>("#panel-head")!;
  const panelStack = document.querySelector<HTMLElement>("#panel-stack")!;
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

  /* --- The panel's pages --------------------------------------------------
     THREE of them, and which three is the whole point: the tree, the journal and the
     scenarios are the APP's pages and live in this stack. The board and the pull
     requests are one repository's and live in `#wspanel`, on the other side of the
     deck.

     That split is why `#history` is appended HERE, explicitly. It used to be
     positioned off `#pr` (`prEl.after(historyEl)`), which was correct while all five
     pages were in this stack — and stopped being correct the moment the board moved
     to `#wspanel`, because `#pr` went with it and the journal rode along. The rail's
     Journal button then un-hid a page inside a panel that is hidden by default: the
     journal rendered at 0×0, and with the workspace panel open it rendered on the
     WRONG side of the window. A page belongs to the stack it is a page of. */
  const sessionsPage = document.createElement("div");
  sessionsPage.id = "ws-page";
  sessionsPage.className = "panel-page";
  /* A row in this tree does two things depending on which row it is, and that is
     the one thing about it a person cannot see: pressing a workspace makes it the
     subject of three of the panel's pages, and pressing the create row inside it
     starts a session THERE. Both are deliberate and neither is guessable, so the
     rule is written under the tree once rather than discovered by being wrong. */
  const treeHint = document.createElement("p");
  treeHint.className = "panel-hint";
  /* Both halves of this rule are about a CHOICE between workspaces, so in a window
     that holds one it is not a shorter sentence — it is no sentence. "Pressing a
     workspace makes it the one the journal shows" names a page this window does
     not have, over a choice it does not offer. */
  treeHint.hidden = pinnedTo !== null;
  treeHint.textContent =
    "Pressing a workspace makes it the one the queue, pull requests and journal show. "
    + "It does not decide where a new session goes — the row you press does.";

  /* The tree, the rule under it, and the one line the tree does not carry: the
     bill. There was a full-width primary "+ session" button in here, and it is
     gone — creation is a row inside the workspace it creates in. See
     `Deck.setTree`. */
  sessionsPage.append(wsMount, treeHint, listMount);
  const scenariosPage = document.createElement("div");
  scenariosPage.id = "sk-page";
  scenariosPage.className = "panel-page hidden";
  scenariosPage.append(skMount);

  /* The fourth page, and the corpus's own. Memory had three doors and no home — a
     search dialog, a captures dialog and a settings section — which is how two
     doors to one set of facts come to disagree. It is app-wide rather than one
     workspace's for the same reason the journal is: the diaries are global and the
     notes span projects, so it belongs on this rail and not in `#wspanel`.

     Empty here. What fills it is the corpus listed (#381, #382), read on the
     document surface (#383), searched (#384) and written into (#385, #386) — and
     the page exists first so none of that is blocked on the plumbing. */
  const memMount = document.createElement("div");
  memMount.className = "island";
  const memHead = document.createElement("h3");
  memHead.textContent = PANEL_TITLE.memory;
  /* The document surface, over the deck rather than instead of it — #346's
     precedent, and the reason giving the deck back is exact: it was covered, not
     resized. Built in every window, pinned or not: the rail is what a pinned
     window does not get, and this is reached from the page behind that rail. */
  const noteReader = new NoteReader({
    host: document.querySelector<HTMLElement>("#workarea")!,
    describe: (note) => {
      if (note.kind === "diary") return note.room ? `${note.room} — lessons` : "Lessons";
      return workspaces.all.find((w) => w.id === note.scope)?.name ?? note.scope;
    },
    // A note written or saved on that surface is a corpus that moved, and the
    // navigator beside it is a walk over the corpus.
    onWrote: () => { void memoryView.refresh(); },
  });
  /* Asked for the workspace each render rather than handed one: the page outlives
     every workspace switch, and "this project" has to mean whichever project the
     panel's head is naming at the time. */
  const memoryView = mountMemory({
    workspace: () => {
      const ws = workspaces.active;
      return ws ? { id: ws.id, name: ws.name } : null;
    },
    names: () => new Map(workspaces.all.map((w) => [w.id, w.name])),
    onOpen: (note) => { void noteReader.open(note); },
    onCompose: () => {
      const ws = workspaces.active;
      if (ws) noteReader.compose({ workspaceId: ws.id, workspaceName: ws.name });
    },
  });
  memMount.append(memHead, memoryView.mount);
  const memoryPage = document.createElement("div");
  memoryPage.id = "mem-page";
  memoryPage.className = "panel-page hidden";
  memoryPage.append(memMount);

  const boardEl = document.querySelector<HTMLElement>("#board")!;
  panelStack.prepend(sessionsPage);
  panelStack.append(scenariosPage, memoryPage);

  /* --- The rail -----------------------------------------------------------
     Five icons, and pressing one changes what the PANEL holds. It does not change
     what the window holds — the deck stays where it is, and that is the whole
     difference between this and the tab bar it replaces.

     The tab bar was answering "which of four states is this window in", which is
     not a question anybody has. The question people do have is "does anything need
     me", and the app already shipped an answer to it: a floating always-on-top pill
     counting blocked sessions, which exists because the window could not show the
     deck and anything else at the same time. Now it can, and the ledger in the top
     bar says the number where the eye already is.

     Vertical, and 44px wide, because the panel beside it is a column: a horizontal
     switch over a column has to be as wide as the column, which is how the old one
     came to be sized by the longest workspace name.

     No ⌘1…⌘5 on these, deliberately, and the mockups have them: in this app those
     five are already "focus session N", which shipped first and is the more
     frequent act. The palette carries every page instead. */
  const railEl = document.querySelector<HTMLElement>("#rail")!;
  /* Four, not five, and never the five it started with. The board and the pull
     requests left this rail because they are not the app's: each belongs to one
     repository, and a global switch that silently changed what it was about every
     time the workspace changed was the old tab bar's defect wearing a new shape.
     They are children of their workspace in the tree now — see
     `WorkspacesPanel.render`. What stays here is what is genuinely app-wide: the
     tree itself, the journal of every run, the scenarios, which belong to a
     workspace but are listed across all of them, and the corpus, whose diaries are
     global and whose notes span projects. */
  const RAIL: { page: PanelPage; icon: IconName }[] = [
    { page: "sessions", icon: "terminal" },
    { page: "history", icon: "clock" },
    { page: "scenarios", icon: "bolt" },
    /* Four. The fourth is the corpus — every note ever written, this project's and
       every project's — which is app-wide by the same test the other three pass:
       it does not change subject when the workspace does. */
    { page: "memory", icon: "book" },
  ];
  /* The mark that travels between the icons. What makes a column of five read as
     one control with a position is that the mark MOVES — five icons one of which is
     lit reads as five things, and the eye has to find the lit one each time. */
  const railInk = document.createElement("span");
  railInk.className = "rail-ink";
  railInk.setAttribute("aria-hidden", "true");
  const railBtns = {} as Record<PanelPage, HTMLButtonElement>;

  /* --- and none of it in a window pinned to one workspace ------------------
     Four of the five things on this rail are about the app rather than about a
     workspace — the journal of every run, the scenarios listed across all of
     them, the corpus of notes, and the settings — and a window pulled out to hold
     `relay` is about `relay`. Shipping them there put the app's own navigation inside a window
     that is a project, which is how the settings in that window came to look like
     that project's settings.
     Not built, rather than built and hidden: a control that exists is a control
     the palette can still reach, the keyboard can still land on and a later change
     can still un-hide by accident. The element stays in the markup — all four
     window bodies are one copy, kept in step by `page-bodies.test.ts` — so it is
     the fill that is skipped and the empty box that is taken out of the layout. */
  if (pinnedTo === null) {
    railEl.append(railInk);
    for (const { page, icon } of RAIL) {
      const b = iconButton(icon, PANEL_TITLE[page], "rail-btn", 17);
      b.dataset.page = page;
      b.onclick = () => setPanel(page);
      railBtns[page] = b;
      railEl.append(b);
    }

    /* Settings sits at the FOOT of the rail, under a spacer, and the position is
       the statement: everything above it selects what the panel holds, and this
       does not — it opens a window about the app itself. In the top bar it was one
       of two round glyphs beside a search, which said nothing about either being
       different from the other. */
    const railFoot = document.createElement("span");
    railFoot.className = "rail-spacer";
    const settingsBtn = iconButton("sliders", "Settings", "rail-btn");
    settingsBtn.onclick = () => void openSettings();
    railEl.append(railFoot, settingsBtn);
  } else {
    railEl.hidden = true;
  }

  /* --- The panel's head ---------------------------------------------------
     One line, and it was always the load-bearing one: with a rail selecting what
     this column holds, "whose data is this" is the question that breaks the idea,
     and it is answered here before it is asked. The workspace's name, the folder a
     session in it runs in, and the account it pushes as — which is the one fact the
     old sidebar answered only if you scrolled to it.

     What the head does NOT say any more is which page it is holding. Each of the
     three is an island with its own head, so the name was stated twice twelve
     pixels apart, in two type treatments; the one that stayed is the one attached to
     the thing it names. The journal had to be given a visible head for this — it was
     the odd page out, with neither an island nor a title of its own. */
  const panelScope = document.createElement("span");
  panelScope.className = "panel-scope";
  /* Collapsing leaves the rail, which is the point: the panel goes and the way
     back stays. A control that hid its own way back would be a control nobody
     presses twice. */
  const shutBtn = iconButton("chevron", "Collapse the panel", "icon--left");
  shutBtn.id = "panel-shut";
  shutBtn.onclick = () => setCollapsed(!sidebar.classList.contains("is-collapsed"));
  /* And that sentence is exactly why this control goes with the rail: collapsing
     takes `#sidebar` to zero width, head and button with it, so in a window with
     no rail the way back would be the palette or nothing. A window pinned to one
     workspace keeps its panel — it is that window's only navigation. */
  shutBtn.hidden = pinnedTo !== null;
  panelHead.append(panelScope, shutBtn);

  /* --- The panel's width is the person's ---------------------------------
     ONE width now, and that is the change: this column held a kanban until the
     board moved to `#wspanel`, and a column of names and a kanban wanted two
     different widths out of one box. What is left here is three lists of names.
     Written as a custom property rather than an inline `width`, so the stylesheet
     keeps the default — `clamp(17.5rem, 19vw, 24rem)` tracks the window and the
     text size, and an inline pixel width would freeze both the moment anything
     was dragged. */
  const panelGrip = document.createElement("div");
  panelGrip.className = "panel-grip";
  sidebar.append(panelGrip);
  wireResizer({
    grip: panelGrip,
    grow: "right",
    label: "Panel width",
    min: 240,
    max: () => Math.round(window.innerWidth * 0.7),
    read: () => sidebar.getBoundingClientRect().width,
    write: (px) => {
      sidebar.style.setProperty("--panel-w", `${px}px`);
      // The terminals have to be refitted, and the tool panel's 80-column floor
      // re-checked: both follow a box this drag is moving.
      deck.refit();
    },
    commit: (px) => {
      saveUiState({ panelPx: Math.round(px) })
        .catch((e) => console.debug("panel width save failed", e));
    },
  });

  /* --- The workspace's own panel -----------------------------------------
     The board and the pull requests, on the right of the deck, about ONE
     repository — the one named in its head.

     Why not in the rail: a global switch that silently changed its subject every
     time the workspace changed was the old tab bar's defect in a new shape. Why
     not rows in the tree, which is where they went next: two rows per workspace is
     twelve identical navigation rows on six workspaces, measured at 261px of a
     300px column — the height of four session rows — and a kanban opened in that
     column had to take the deck's width every single time.

     The head, the tabs and the grip are built here; the two pages themselves are
     `#board` from the markup and `prEl` below, which is why neither needed
     rewriting to move. */
  const wspEl = document.querySelector<HTMLElement>("#wspanel")!;
  const wspHead = document.querySelector<HTMLElement>("#wsp-head")!;
  const wspBody = document.querySelector<HTMLElement>("#wsp-body")!;
  const wspScope = document.createElement("span");
  wspScope.className = "wsp-scope";
  const wspTitle = document.createElement("span");
  wspTitle.className = "wsp-title";
  const wspTitles = document.createElement("div");
  wspTitles.className = "wsp-titles";
  wspTitles.append(wspScope, wspTitle);
  /* Right-pointing, because that is where the panel goes: the rule the whole shell
     follows is that an arrow names its destination. */
  const wspShut = iconButton("chevron", "Close the workspace panel");
  wspShut.onclick = () => closeWorkspacePanel();
  wspHead.append(wspTitles, wspShut);

  /* A real tab widget, so it is allowed to claim one: `role="tablist"`, two
     `role="tab"`s over one region, a roving tabindex from `applyWorkspacePanel`
     and the arrow keys below. The rail next door deliberately does NOT claim it,
     because navigation between the pages of a panel is not this. */
  const wspTabs = document.createElement("div");
  wspTabs.className = "wsp-tabs";
  wspTabs.setAttribute("role", "tablist");
  wspTabs.setAttribute("aria-label", "What this workspace shows");
  const wspTabEls = {} as Record<WorkspacePage, HTMLButtonElement>;
  /* The board's count, and only when it is not zero: "0" beside a page that says
     "nothing open" is the same fact stated twice. */
  const wspCount = document.createElement("span");
  wspCount.className = "wsp-tab-count";
  wspCount.hidden = true;
  for (const page of WORKSPACE_PAGES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wsp-tab";
    b.dataset.page = page;
    b.setAttribute("role", "tab");
    b.append(document.createTextNode(WORKSPACE_TITLE[page]));
    b.onclick = () => showWorkspacePage(page);
    if (page === "board") b.append(wspCount);
    wspTabEls[page] = b;
    wspTabs.append(b);
  }
  wspTabs.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const at = WORKSPACE_PAGES.indexOf(wspPage);
    const next = WORKSPACE_PAGES[(at + step + WORKSPACE_PAGES.length) % WORKSPACE_PAGES.length];
    showWorkspacePage(next);
    wspTabEls[next].focus();
  });
  wspEl.insertBefore(wspTabs, wspBody);

  /* On the left edge, because the deck is the box a drag here takes from. Two
     widths remembered rather than one: the diff's and the page's answer different
     questions, and sizing one says nothing about the other. */
  const wspGrip = document.createElement("div");
  wspGrip.className = "wsp-grip";
  wspEl.append(wspGrip);
  const wspWide = () => wspEl.classList.contains("is-wide");
  wireResizer({
    grip: wspGrip,
    grow: "left",
    label: "Workspace panel width",
    min: 320,
    max: () => Math.round(window.innerWidth * 0.75),
    read: () => wspEl.getBoundingClientRect().width,
    write: (px) => {
      wspEl.style.setProperty(wspWide() ? "--wsp-wide-w" : "--wsp-w", `${px}px`);
      // The deck is the box this drag is moving, so its terminals have to be
      // refitted and the tool panel's 80-column floor re-checked.
      deck.refit();
    },
    commit: (px) => {
      const patch = wspWide() ? { wspWidePx: Math.round(px) } : { wspPx: Math.round(px) };
      saveUiState(patch).catch((e) => console.debug("workspace panel width save failed", e));
    },
  });

  /* --- The ledger ---------------------------------------------------------
     What replaced four tab labels: not where to go, but what wants me. Written
     from the deck's own counts rather than typed beside them — the two numbers
     that used to be stated in the app (a sidebar heading and the pill) came from
     two different places and could disagree. */
  const ledgerEl = document.querySelector<HTMLElement>("#ledger")!;

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

  /* --- The crumb ---------------------------------------------------------
     Which workspace this window is on, and which account a push from it goes out
     as. The panel's head says the same while the panel is open — and that is
     exactly the reason this exists: the panel CLOSES. Zoom collapses it, which is
     the state a person spends most of their time in, and in that state nothing
     else on screen named the folder a session is running in or the account it
     pushes as. It was answerable before only by leaving the session.

     Pressing it goes to the tree rather than opening a menu of its own: switching
     workspace is what the tree is for, and it is the one that can also say what
     is running in each. A second switcher would be two ways to do one thing, and
     the one in a dropdown would be the one that cannot answer "which of these is
     busy".

     Built here rather than in the four pages that mount the app: it has no
     content of its own until a workspace is active, and four copies of an empty
     button are four more things to keep in step. */
  const crumbEl = document.createElement("button");
  crumbEl.id = "crumb";
  crumbEl.className = "crumb";
  crumbEl.onclick = () => { setPanel("sessions"); workspaces.focusActive(); };
  const crumbDot = document.createElement("span");
  crumbDot.className = "dot";
  const crumbName = document.createElement("span");
  crumbName.className = "crumb-name";
  const crumbSep = document.createElement("span");
  crumbSep.className = "crumb-sep";
  crumbSep.textContent = "/";
  const crumbLogin = document.createElement("span");
  crumbLogin.className = "crumb-login";
  crumbEl.append(crumbDot, crumbName, crumbSep, crumbLogin);
  markEl?.after(crumbEl);

  /* --- The second door to the workspace's own pages ------------------------
     The chip on the active workspace's row is the pointer route to the board and
     the pull requests, and it lives in the one place a zoom takes away: a zoomed
     tile collapses the panel to nothing, so from the state a person spends most of
     their day in there was no way to the board with a mouse at all — only the
     palette. That is not the zoom being wrong; it is the route having exactly one
     door, in a room the app closes on purpose.

     Here rather than in the rail, and rather than as a fourth control on the right:
     the crumb already names the workspace these two pages are ABOUT, and it is the
     one thing on screen that survives the zoom. A door beside the name of the thing
     it opens needs no label explaining which repository it means.

     A toggle, not an opener, because it is now the only control that is visible in
     both states: `aria-expanded` says which, and pressing it twice puts the window
     back where it was. The chip on the row stays an opener — it is not on screen
     while the panel it opened is what a person is reading. */
  const crumbPages = document.createElement("button");
  crumbPages.id = "crumb-pages";
  crumbPages.className = "crumb-pages";
  crumbPages.type = "button";
  crumbPages.setAttribute("aria-controls", "wspanel");
  crumbPages.textContent = "board · PRs";
  crumbPages.onclick = () => {
    if (wspEl.hidden) openWorkspacePage(wspPage);
    else closeWorkspacePanel();
  };
  crumbEl.after(crumbPages);

  const actionsEl = document.querySelector<HTMLElement>("#topbar-actions");
  if (actionsEl) {
    // Both already exist as commands; these are the same actions with a place to be
    // clicked, for the majority of moments when nobody is holding the keyboard.
    const paletteBtn = iconButton("search", `Command palette (${hotkeyLabel("K")})`);
    paletteBtn.onclick = () => openPalette(paletteCommands());
    actionsEl.append(paletteBtn);
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
      /* The diff is the thing on this page that needs room, so this is where the
         panel asks for it — not on arrival. The list beside it is four rows of
         text, and a panel that took the deck's width to show those would be the
         full-width screens back under another name. */
      setWspWide(true);
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
      // And gives it back with the diff, which is what makes the widening read as
      // the diff's doing rather than the page's.
      setWspWide(false);
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
  prEl.className = "pr-view panel-page";
  prEl.id = "pr";
  prEl.classList.add("hidden");
  prEl.append(prView.mount, diffDrawer.live);
  boardEl.after(prEl);
  diffDrawer.attach(prEl, prView.mount);

  /* --- the scenario run history -------------------------------------------- */

  /** Which scenario and which trigger the screen is narrowed to. Held here rather
   *  than inside the view because the sidebar's state dot sets it on the way in:
   *  clicking a dot opens the screen already filtered to that scenario. */
  let runFilters: RunFilters = { skillId: null, trigger: null };
  /** Whether new runs are being journalled. Read once at boot and written by the
   *  screen's own checkbox — the switch lives beside the sentence that explains
   *  what being off looks like, rather than inside a text-size dialog whose own
   *  doc comment argues against growing it casually. */
  let recordingRuns = true;
  /** Whether the app may ask a connected AI what is left, as opposed to only
   *  counting what it can see. Mirrors `ui_state.usageReported`; the backend holds
   *  the authoritative copy and applies it to the usage registry. */
  let reportedLimits = true;
  /** Whether closing a session writes a note about it. Mirrors
   *  `ui_state.captureOnClose`, and `undefined` is "never asked" — which is not
   *  `false`, because a default either way would answer a question about spending
   *  somebody's money on their behalf. */
  let captureAnswer: boolean | undefined = undefined;

  const historyView = new HistoryView({
    onFilter: (f) => { runFilters = f; void refreshHistory(); },
    onJump: (rec) => {
      // The deck is revealed *before* the tile is focused, and the order is the
      // whole of it: `#deck.tk-hidden` is `display: none`, and `focus()` on an
      // unrendered element does nothing at all — as does `scrollIntoView` inside a
      // hidden container. Focusing first left the reader on the deck with the tile
      // merely marked active, keyboard focus back on `document.body`, and the
      // first thing they typed going nowhere.
      if (rec.sessionId === null || !deck.liveSessions().includes(rec.sessionId)) {
        void alertModal("That session is no longer open.");
        return;
      }
      setPanel("sessions");
      // The tile may live in another workspace — an unpinned scenario runs
      // wherever it was launched — so this goes through the same path the pill
      // and a notification click take, which switches workspace first.
      deck.focusSession(rec.sessionId);
    },
    onRerun: (rec, skill) => { void rerunScenario(rec, skill); },
    onReveal: (rec) => {
      if (rec.transcriptPath === null) return;
      revealPath(rec.transcriptPath).catch((e) => void alertModal(String(e)));
    },
    onDeleteHistory: (skillId, name) => { void eraseHistory(skillId, name); },
    onRefused: (reason) => { void alertModal(reason); },
  });
  const historyEl = document.createElement("div");
  historyEl.id = "history";
  historyEl.classList.add("panel-page", "hidden");
  /* The fourth island, and the last page in this column to become one. It was the
     odd page out: the tree and the scenarios were each a raised surface with their
     own head, and the journal was loose rows on the column's own ground with its
     title clipped out of sight. The class is all it takes, exactly as for the other
     three — the panel renders into this mount unchanged. */
  historyView.mount.classList.add("island");
  historyEl.append(historyView.mount);
  /* Between the tree and the scenarios, which is the order the rail lists them in:
     these pages overlap in one grid cell, so the order is not visual — it is the
     order the keyboard walks them in. */
  panelStack.insertBefore(historyEl, scenariosPage);

  /** Re-read the journal for the active workspace and repaint.
   *
   *  Scoped by the record's **own** `workspaceId`, in Rust — so a run of a
   *  scenario pinned to nothing appears in the workspace it actually ran in, not
   *  in all of them. A record with no workspace at all (a scheduled fire that
   *  never resolved one) passes every filter, the way an orphaned tile stays
   *  visible everywhere. */
  async function refreshHistory() {
    const ws = workspaces.active;
    let runs: RunRecord[] = [];
    let all: RunRecord[] = [];
    try {
      runs = await listRuns(ws?.id ?? null, null);
      // Asked separately so the empty state can tell "nothing has ever run" from
      // "nothing ran here" — two different sentences with two different next
      // steps, and only this call can distinguish them. Only asked when the
      // question arises: `anyRuns` is read solely to choose between those two
      // sentences, so a workspace with records of its own has already answered
      // it, and a second full read of the journal per repaint buys nothing.
      all = ws && runs.length === 0 ? await listRuns(null, null) : runs;
    } catch (e) {
      console.debug("listRuns failed", e);
    }
    historyView.render({
      runs, anyRuns: all.length > 0, workspaceName: ws?.name ?? null,
      recording: recordingRuns, filters: runFilters, skills: skills.all,
      liveSessions: deck.liveSessions(),
      workspaceIds: workspaces.all.map((w) => w.id),
    }, Date.now());
  }

  /** Run a recorded scenario again.
   *
   *  An ordinary `manual` launch that opens its own record, deliberately **not**
   *  chained through `continuesRunId`: that field means "this PTY resumed that
   *  conversation", and a re-run is a fresh one.
   *
   *  The form opens with the recorded values in the fields and launches nothing
   *  until it is confirmed. A scenario's parameters may name a branch, a target or
   *  a person, and re-running one from history without showing what is in the
   *  fields is how somebody re-runs yesterday's parameters against today's branch.
   *  The values are matched against the *current* template first — the record is
   *  not authoritative over a prompt that has been edited since.
   *
   *  Down `launchScenario`'s own path — `requireWorkspace` then `resolvePrompt` —
   *  rather than re-deriving either. Resolving a target from the record instead
   *  broke the invariant every other manual launch keeps: that a manual launch
   *  lands in the *active* workspace. A record with no workspace of its own shows
   *  in every workspace's history, so pressing this in workspace A could put a
   *  tile in B — running in B's folder, sitting in A's deck under A's header,
   *  gone at the next workspace switch, since `applyWorkspaceVisibility` is only
   *  applied on the unattended path. */
  async function rerunScenario(rec: RunRecord, skill: Skill) {
    const ws = await requireWorkspace();
    if (!ws) return;
    const resolved = await resolvePrompt(
      skill.prompt,
      // The only difference from an ordinary launch: the fields start at what
      // this run used, reconciled against today's template.
      (names) => placeholderForm(names, reconcileParams(names, rec.params)),
    );
    if (resolved === null) return;
    setPanel("sessions");
    await deck.launch(ws, { ...skill, prompt: resolved.prompt }, resolved.params);
  }

  /** Erase one scenario's history — the only erasure there is, and it asks first
   *  exactly as `Delete scenario?` does. There is no deleting of a single record:
   *  a row is a snapshot of what ran, and a journal whose rows can be revised
   *  answers nothing. */
  async function eraseHistory(skillId: string, name: string) {
    // Scoped to the workspace the screen is showing, and said so in the question.
    // The rows on screen are one workspace's; erasing every workspace's records of
    // that scenario from a screen that shows two of them, with no undo and no
    // second copy, is not what the button appears to offer.
    const ws = workspaces.active;
    const where = ws ? ` in ${ws.name}` : "";
    if (!(await confirmModal(`Delete every recorded run of “${name}”${where}?`))) return;
    try {
      await deleteSkillHistory(skillId, ws?.id ?? null);
    } catch (e) {
      await alertModal(`Could not delete the history: ${String(e)}`);
      return;
    }
    await skills.refreshRuns();
    await refreshHistory();
  }

  let boardVisible = false;
  let boardTimer: ReturnType<typeof setTimeout> | null = null;
  let currentPage: PanelPage = "sessions";
  /** Whether the panel took the deck's width, and whether taking it is what
   *  zoomed the deck. Both halves matter: leaving the page has to give back
   *  exactly what was taken, and a tile a person zoomed themselves must not be
   *  un-zoomed by a panel narrowing under them. */
  let wideZoomed = false;

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
    if (!boardVisible || !document.hasFocus()) return;
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

  /** Give the workspace panel more of the deck, or give it back.
   *
   *  The deck yields by falling into its filmstrip — the layout a zoom already
   *  produces — rather than by disappearing, which is the distinction the whole
   *  shell rests on. Only one thing asks for this: a diff. The kanban gets the
   *  panel's own width, which is already three times the left panel's, and the
   *  list of pull requests is a list of names. */
  function setWspWide(on: boolean) {
    wspEl.classList.toggle("is-wide", on);
    if (on) {
      if (!deck.isZoomed()) wideZoomed = deck.zoomActive();
    } else if (wideZoomed) {
      deck.exitZoom();
      wideZoomed = false;
    }
    deck.refit();
  }

  /** Collapse the panel to the rail, or bring it back.
   *
   *  `byHand` is what keeps the automatic version honest: zooming a session
   *  collapses the panel, and leaving zoom brings it back — unless the person had
   *  collapsed it themselves, in which case it was not the zoom's to restore. */
  function setCollapsed(on: boolean, byHand = true) {
    sidebar.classList.toggle("is-collapsed", on);
    if (byHand) collapsedByHand = on;
    shutBtn.setAttribute("aria-label", on ? "Show the panel" : "Collapse the panel");
    shutBtn.title = shutBtn.getAttribute("aria-label")!;
    shutBtn.classList.toggle("icon--left", !on);
  }
  let collapsedByHand = false;

  function setPanel(page: PanelPage) {
    /* The journal and the scenarios are the app's pages, and this window is one
       workspace's — so neither has a way in here and neither may be reached by
       one. A guard rather than trust in the callers: the palette below drops the
       two entries, and this is what makes that a statement about the window
       instead of a statement about one list. */
    if (pinnedTo !== null && page !== "sessions") return;
    currentPage = page;
    // Choosing a page is asking to see it.
    if (sidebar.classList.contains("is-collapsed")) setCollapsed(false);
    applyPanel({
      pages: {
        sessions: sessionsPage, history: historyEl, scenarios: scenariosPage,
        memory: memoryPage,
      },
      buttons: railBtns,
    }, page);
    moveRailInk();
    // Always on entering, and only then: the page re-reads on `runs://changed`
    // while it is visible and does not poll at all. Opening it is a deliberate
    // act, so the read is unconditional.
    if (page === "history") void refreshHistory();
    /* Same rule as the journal's, and for the same reason: opening a page is a
       deliberate act, so the read is unconditional — and the page does not poll.
       What keeps it current while it is open is `memory://changed`, which a
       capture and a reindex both fire.

       The stage goes with it. The deck's empty state offers to start a session,
       which under a page about notes is an answer to a question nobody asked — so
       memory gets a surface of its own for as long as it is the page the rail is
       holding, and leaving gives the deck back. Leaving is not allowed to throw
       away an edit: `close` is skipped while somebody is typing into a note. */
    if (page === "memory") {
      /* Load the model while the person reads the list. A search is 6 ms with it
         in memory and two seconds without, and opening this page is the clearest
         signal anybody is about to search (#389). Fire and forget: it resolves
         when the warm-up starts, and a build with no sidecar answers false. */
      void memoryWarm().catch(() => {});
      void memoryView.refresh().then(() => noteReader.showLanding(memoryView.summary()));
      noteReader.showLanding(memoryView.summary());
    } else if (!noteReader.isEditing()) {
      noteReader.close();
    }
  }
  /** Which of the two the workspace panel is holding.
   *
   *  It survives a close on purpose: the two tabs are two views of one thing —
   *  the work of this repository — so coming back should land where it was left
   *  rather than resetting to the board every time. */
  let wspPage: WorkspacePage = "board";

  /** Open the panel on one page. The one route in, from every entry point: the
   *  chip on the active workspace's row, the crumb, the palette and the keys.
   *
   *  A workspace id is passed when a row was pressed and omitted when it was not,
   *  in which case the active one is the answer — and the head says which it was,
   *  before anybody has to ask. */
  function openWorkspacePage(page: WorkspacePage, workspaceId?: string) {
    if (workspaceId != null && workspaces.active?.id !== workspaceId) {
      workspaces.activate(workspaceId);
    }
    /* A zoomed tile puts its tool panel on this same edge, inside the tile frame.
       Two panels on one edge is a person guessing which one a drag will move, so
       the zoom goes rather than the panel opening under it. */
    if (deck.isZoomed()) deck.exitZoom();
    wspEl.hidden = false;
    showWorkspacePage(page);
  }

  /** Switch the tab. The panel is already open — the tabs live inside it. */
  function showWorkspacePage(page: WorkspacePage) {
    wspPage = page;
    boardVisible = page === "board" && !wspEl.hidden;
    applyWorkspacePanel({ pages: { board: boardEl, pr: prEl }, tabs: wspTabEls }, page);
    drawWspHead();
    /* The read on arrival is unconditional — opening a page is a deliberate act —
       and the poll chain is armed separately, so an unfocused window reads once and
       then waits. Leaving a page stops its polling in the same breath as hiding it:
       a timer that outlives the page keeps talking to GitHub about something nobody
       is looking at. */
    if (page === "board") { void refreshBoard(); scheduleBoardPoll(); }
    else stopBoardPolling();
    if (page === "pr") void refreshPrs();
    else stopPrPolling();
    drawCrumbPages();
    deck.refit();
  }

  /** Put it away. Both polls stop and the deck takes its width back. */
  function closeWorkspacePanel() {
    if (wspEl.hidden) return;
    wspEl.hidden = true;
    boardVisible = false;
    stopBoardPolling();
    stopPrPolling();
    setWspWide(false);
    drawCrumbPages();
    deck.refit();
    /* Focus does not vanish with the panel: the chip that opens it is where this
       came from, and a closed panel that left the caret nowhere is a keyboard dead
       end. */
    workspaces.focusActive();
  }

  /** Whose panel this is, in the two facts that answer it: the repository, and the
   *  account a push from it goes out as. This is the whole reason these two pages
   *  are allowed to exist outside the tree — in the rail they showed one
   *  repository while naming none. */
  function drawWspHead() {
    const ws = workspaces.active;
    wspTitle.textContent = WORKSPACE_TITLE[wspPage];
    wspScope.textContent = ws
      ? `${ws.name} · ${ws.github?.login ?? "no account bound"}`
      : "No workspace is selected";
    if (ws) wspScope.title = ws.path;
  }

  /** The mark travels to the button that is current. Read from the DOM rather
   *  than computed from an index, so a rail that grows a sixth entry needs no
   *  arithmetic here. */
  function moveRailInk() {
    const on = railEl.querySelector<HTMLElement>('.rail-btn[aria-current="page"]');
    if (!on) return;
    railInk.style.setProperty("--y", `${on.offsetTop}px`);
  }

  /** Open the history filtered to one scenario — what the sidebar's state dot
   *  does, and the only thing it does.
   *
   *  The dot reports the last run in **any** workspace, because a scenario with a
   *  schedule is on screen in all of them and fires wherever it was pinned. The
   *  screen is scoped to one workspace, and its own empty state says why:
   *  switching workspace switches what is listed. So the click does that
   *  switching rather than landing on a list that cannot contain the run the dot
   *  just described. A record naming a workspace since deleted switches nothing —
   *  the screen then honestly shows the current one. */
  function openHistoryFor(skill: Skill) {
    const last = skills.lastRunOf(skill.id);
    if (last?.workspaceId != null && last.workspaceId !== workspaces.active?.id) {
      workspaces.activate(last.workspaceId);
    }
    runFilters = { skillId: skill.id, trigger: null };
    setPanel("history");
  }

  const deck = new Deck(deckEl, listMount, () => workspaces.all);
  deck.setWindowLabel(myLabel);
  // Clicking a proxy row: raise the window that holds the session, and let it
  // focus the tile. Both halves happen there — see `session://focus`.
  deck.setRemoteFocus((label, session) => { void emitTo(label, "session://focus", { session }); });
  deck.wireNotificationFocus();
  /** The terminal drawer reads the active workspace at the moment a terminal is
   *  opened rather than being told about it: the active one changes under it, and
   *  a shell already running in another workspace must not follow along. */
  /** Show one workspace: its deck tiles and its terminals.
   *
   *  One function because they have to agree. A terminal belongs to a workspace
   *  the way a tile does, so switching hides the ones that belong elsewhere and
   *  brings back the ones that belong here — with their scrollback, since nothing
   *  was closed, and with the drawer up or down as that workspace last left it.
   *  A workspace nobody has opened a terminal in has no drawer at all. */
  function activateWorkspace(id: string | null): void {
    deck.setActiveWorkspace(id);
    terminals.setWorkspace(id);
    drawPanelScope();
    /* The workspace panel follows, because its head NAMES the repository: leaving
       the previous name written above a board that has already changed is the exact
       defect that took these two pages out of the rail.
       The head and the count only. The READ belongs to the switch itself, which
       already does it once for whichever page is open — doing it here as well is
       two reads of one board for one act, and the poll chain re-arms from there at
       the new source's interval. */
    drawWspHead();
    drawWspCount();
  }

  /** Whose data the panel is holding, written where it is read: above the page,
   *  not inside it. Three facts and no more — the workspace's name, the folder a
   *  session in it runs in, and the account it pushes as. The third one is the
   *  reason this line exists at all: it was answerable before only by scrolling
   *  the sidebar to the row and reading its second line. */
  function drawPanelScope(): void {
    const ws = workspaces.active;
    if (!ws) { panelScope.textContent = "No workspace"; return; }
    const account = ws.github?.login ? `as ${ws.github.login}` : "no account bound";
    panelScope.textContent = `${ws.name} · ${ws.path} · ${account}`;
    panelScope.title = panelScope.textContent;
    drawCrumb();
  }

  /** The same two facts in the top bar, where they survive the panel closing.
   *
   *  The workspace's own colour rather than its state: state is the ledger's
   *  subject two inches to the right, and the colour is what identifies this
   *  workspace everywhere else in the app — the dot on its row, the dot on its
   *  sessions' groups. A second state reading here would be a fifth hue on a bar
   *  that already carries two. */
  function drawCrumb(): void {
    const ws = workspaces.active;
    crumbEl.hidden = !ws;
    // No workspace is no subject: two pages about one repository have nothing to
    // show, and the panel's own head says as much when there is none.
    crumbPages.hidden = !ws;
    drawCrumbPages();
    if (!ws) return;
    crumbDot.style.background = ws.color;
    crumbName.textContent = ws.name;
    const login = ws.github?.login ?? null;
    crumbLogin.textContent = login ?? "no account";
    crumbLogin.classList.toggle("crumb-login--none", login === null);
    crumbEl.setAttribute(
      "aria-label",
      login
        ? `Workspace ${ws.name}, pushing as ${login} — go to the tree`
        : `Workspace ${ws.name}, no account bound — go to the tree`,
    );
    crumbEl.title = `${ws.path}${login ? ` · as ${login}` : " · no account bound"}`;
  }

  /** The door's own state, which is the panel's. Written from three places — the
   *  crumb's own redraw, opening a page and closing the panel — because those are
   *  the three things that change the answer, and a control claiming
   *  `aria-expanded="false"` over an open panel is worse than one claiming
   *  nothing. */
  function drawCrumbPages(): void {
    const open = !wspEl.hidden;
    crumbPages.setAttribute("aria-expanded", String(open));
    crumbPages.classList.toggle("is-open", open);
    /* Named for the page that is actually showing, because that is what pressing it
       hides. "Hide" rather than "close": the panel is one of two things on this bar
       that can be put away, and the other one — the tree — says the same word. */
    const label = open
      ? `Hide the ${WORKSPACE_TITLE[wspPage].toLowerCase()}`
      : "Open this workspace's board and pull requests";
    crumbPages.setAttribute("aria-label", label);
    crumbPages.title = label;
  }

  /** How the drawer was left last time, read once with the rest of the stored ui
   *  state (see `bootWithStoredScale`) and applied when the drawer restores. */
  let storedDrawer = { rows: DEFAULT_TERMINAL_ROWS };
  const terminalsEl = document.getElementById("terminals")!;
  const terminals = new TerminalDrawer(
    terminalsEl,
    () => ({
      id: workspaces.active?.id ?? null,
      name: workspaces.active?.name ?? null,
      path: workspaces.active?.path ?? ".",
    }),
    () => workspaces.all,
  );
  const boot = () => runBoot({
    steps: [
      () => deck.wireEvents(),
      () => terminals.wireEvents(),
      // The backend emits one `schedule://fire`. Every window listening would
      // launch the scenario and acknowledge it, so a nightly job would run as
      // many times as there are windows open.
      ...(isMain ? [() => onScheduledFire((skillId, occurrenceMs, catchUp) => {
        const missedAt = catchUp
          ? new Date(occurrenceMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
          : undefined;
        void handleScheduledFire(skillId, "schedule", missedAt).then(async ({ outcome, workspaceId }) => {
          if (outcome !== "launched") console.warn("scheduled fire not launched:", skillId, outcome);
          // Tell the backend what came of it: an occurrence it emitted counts as
          // a run only once a session has actually started. Anything else also
          // becomes a `failed-to-launch` record in the run journal — "the
          // schedule silently did nothing" is what people open a history to find.
          await scheduleAck(skillId, occurrenceMs, outcome, workspaceId).catch((e) =>
            console.warn("schedule ack failed:", skillId, e));
          // Show the outcome in the scenario row now, rather than at the next
          // minute tick — a skip or a refusal is what the user needs to see.
          await skills.refreshRuns();
        });
      }).then(() => {})] : []),
      // An alert apiece, for one fault. The same class as the `claudeAvailable`
      // question below: the app has one thing to say and one person to say it to.
      ...(isMain
        ? [() => onSchedulerBroken((message) => { void alertModal(message); }).then(() => {})]
        : []),
      // The app is on its way out and something is still running inside a session
      // — a build, a test run, a tool call. The backend has already refused the
      // quit and is waiting for one of these two answers; until it gets one the
      // app stays up, which is why every path out of here sends exactly one.
      //
      // Refuse-by-default, like the worktree guards: the app does not destroy work
      // it cannot prove is finished. A second quit gesture goes through regardless
      // — see `ready_to_quit` — so a wedged window can never make the app
      // unquittable.
      // `app://quit-blocked` is emitted app-wide, so every window would put the
      // same question to the person separately — and the first answer would
      // decide it for all of them, leaving the rest on screen with nothing to
      // answer. The main window's close gesture is what raised the question
      // (`ready_to_quit` checks the label), so it is the one that asks it.
      ...(isMain ? [() => onQuitBlocked((work) => {
        const named = work
          .map((w) => `${terminals.nameOf(w.session) ?? deck.nameOf(w.session)} (${w.processes} running)`)
          .join(", ");
        void confirmModal(`Still running: ${named}. Quit anyway and stop it?`)
          .then(async (go) => {
            if (!go) return quitCancelled();
            /* Notes for whatever was still open, queued before the exit and run
               at the next start by #364's recovery. No second question: a quit is
               not the moment to ask about spending money, so this follows the
               answer already given and does nothing at all when there is none.
               `close_session` is what queues them, and it is called here rather
               than left to the teardown because the teardown does not know about
               consent. */
            for (const { session, capture } of deck.captureOnQuit()) {
              await closeSession(session, capture)
                .catch((e) => console.debug("queueing a note at quit failed", e));
            }
            return quitConfirmed();
          })
          .catch((e) => {
            // An answer that never arrives leaves the app up with no explanation.
            console.error("quit question failed:", e);
            void quitCancelled();
          });
      }).then(() => {})] : []),
      // The limits block: one read at boot, then a slow loop of its own, plus
      // the one event that cannot wait for it.
      //
      // Sixty seconds, and it is not a poll of anything: the registry answers
      // from a TTL cache, so this is how often the SCREEN may change, not how
      // often a provider is asked. A limit banner going past a PTY is the case
      // the loop is too slow for, and it arrives as an event instead — with
      // `force`, because the cached answer is exactly the one that just became a
      // lie.
      () => onUsageChanged(() => { void readLimits(true); }).then(() => {}),
      () => {
        void readLimits();
        setInterval(() => { void readLimits(); }, 60_000);
      },
      // A record opened or closed. The sidebar's dot is repainted whatever screen
      // is showing — it is the one always-visible reader of the journal, and a
      // handful of events per run is not polling. The list re-reads only while it
      // is on screen; nothing here runs on a timer.
      () => onRunsChanged(() => {
        void skills.refreshRuns();
        if (currentPage === "history") void refreshHistory();
      }).then(() => {}),
      /* A note was written, or the index moved. Only while the page is on
         screen, and for the same reason the journal re-reads that way: a corpus
         re-read behind a hidden page is work nobody asked for, and opening the
         page reads unconditionally anyway. */
      () => onMemoryChanged(() => {
        if (currentPage === "memory") void memoryView.refresh();
        /* Whatever page the panel is on: the note being READ can be rewritten
           under it — by a capture draining, or by an edit (#386) — and stale
           markdown left on a surface somebody is reading is the one failure this
           costs nothing to avoid. */
        void noteReader.reread();
      }).then(() => {}),
      // The list, and the one question a pinned window has to ask of it before
      // anything is drawn from it. See `closeIfPinnedWorkspaceGone` for why the
      // backend's refusal does not cover this on its own.
      //
      // A list that could not be read is caught here rather than left to
      // `onError`, and the two halves of that are both deliberate. Boot goes on:
      // an unreadable list costs a sidebar, while stopping the remaining steps
      // would cost the deck and every session waiting in it — the app has to stay
      // the place those are recovered from. And the pinned question is not asked,
      // because a store that would not parse deleted nothing.
      () => workspaces.load().then(
        () => closeIfPinnedWorkspaceGone().then(() => {}),
        (e: unknown) => { console.error("the workspace list could not be read at boot", e); },
      ),
      () => skills.load(),
      () => onTasksChanged((workspaceId) => {
        if (boardVisible && workspaces.active?.id === workspaceId) void refreshBoard();
        void refreshCounts();
      }).then(() => {}),
      // The store's workspace list changed without this window asking. Every
      // window listens, main and pinned alike: the row to drop is the main
      // window's business and the window to close is the pinned one's, and
      // neither can be decided by whoever wrote the file. See
      // `rereadWorkspaces`.
      () => onWorkspacesChanged(() => { void rereadWorkspaces(); }).then(() => {}),
      // Idempotent, and merely wasteful rather than wrong — but it re-points
      // backend watchers from a list every window holds the same copy of. The
      // other two calls to it are reactions to something *this* window did, and
      // stay where they are.
      ...(isMain ? [() => taskWatchSync()] : []),
      () => refreshCounts(),
      async () => {
        const entries = await loadLayout();
        if (entries.length) await deck.restore(entries);
      },
      // After the deck, so the drawer's height is applied against a laid-out
      // window. A shell cannot be resumed the way a session can: each of these is
      // a new shell in the directory the old one was in.
      () => terminals.restore(storedDrawer),
      () => { activateWorkspace(workspaces.active?.id ?? null); },
    ],
    // Sent last so a catch-up fire arriving immediately can be resolved to a
    // scenario — but sent even if a step above failed, or the scheduler stays
    // parked forever.
    // The backend gate is a `Notify` and a second release is a no-op, so this is
    // harmless twice — but it means "the app is listening for fires", and only
    // the window that listens for them may say it. A workspace window releasing
    // it would send the first catch-up tick out to nobody.
    releaseScheduler: isMain ? schedulerReady : async () => {},
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
      if (deck.focusTaskSession(t.id, target.id)) { setPanel("sessions"); return; }
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
      setPanel("sessions");
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
    setPanel("sessions");
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

    // Until now this window drew nothing at all: `setPanel("board")` called this, and
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
  /** Open tasks per workspace, and the one number that gets shown: the active
   *  workspace's, on the board's own tab.
   *
   *  It used to be a badge in the tree — first beside the waiting count on the
   *  workspace's own line, where "12" beside "1 waiting" said neither what it
   *  counted, then on a "Board" row of its own under every workspace. On the tab it
   *  sits beside the page it counts, which is the only place it needs no
   *  explaining. */
  async function refreshCounts() {
    try {
      openCounts = await taskOpenCounts();
      drawWspCount();
    } catch (e) { console.debug("taskOpenCounts failed", e); }
  }
  let openCounts: Record<string, number> = {};
  function drawWspCount() {
    const id = workspaces.active?.id;
    const n = id ? (openCounts[id] ?? 0) : 0;
    wspCount.hidden = n === 0;
    wspCount.textContent = n > 0 ? String(n) : "";
    if (n > 0) wspTabEls.board.title = `${n} open`;
    else wspTabEls.board.removeAttribute("title");
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

  /** The mirror of `boardVisible`, and a function rather than a variable because
   *  the pull request page has no watcher to keep one honest: the answer is two
   *  facts that are already on screen. */
  const prVisible = () => !wspEl.hidden && wspPage === "pr";

  function stopPrPolling() {
    if (prTimer !== null) { clearTimeout(prTimer); prTimer = null; }
  }

  /** Poll only while the PR view is on screen and the window is focused. Every
   *  path that schedules a tick goes through here, so there is one place where
   *  the two conditions are checked and one place that owns the handle. */
  function schedulePrPoll() {
    stopPrPolling();
    if (!prVisible() || !document.hasFocus()) return;
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
    if (prVisible()) void refreshPrs();
    // Coming back refreshes at once rather than at the next tick, which is the
    // whole point of pausing on blur — and `boardTick` re-arms the chain the blur
    // cleared.
    if (boardVisible) void boardTick();
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
      setPanel("sessions");
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

  /** What a fire produced, and where. The workspace travels with the outcome
   *  because `schedule_ack` turns anything but `launched` into a
   *  `failed-to-launch` journal record, and that record has to know which
   *  workspace it belongs to. `no-workspace` has none, by definition. */
  interface FireResult { outcome: FireOutcome; workspaceId: string | null }

  /** A scheduled scenario came due (from the backend scheduler or from the ⏰
   *  button): resolve it to a scenario + workspace, fill placeholder defaults (a
   *  scheduled run cannot ask) and launch it as a fresh tile. */
  async function handleScheduledFire(
    skillId: string,
    /** Which path the fire came down. Both are journalled — the question a
     *  history answers is "when did this scenario last run", not "who pressed
     *  it" — and both are told apart, so the screen can filter one out. */
    trigger: "schedule" | "runNow",
    catchUpFor?: string,
  ): Promise<FireResult> {
    const skill = skills.find(skillId);
    if (!skill?.schedule?.enabled) return { outcome: "not-scheduled", workspaceId: null };
    const res = resolveScheduledWorkspace(skill, workspaces.all, workspaces.active);
    if (!res.ok) return { outcome: res.reason, workspaceId: null };
    const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
    const launched = await deck.launchScheduled(res.workspace, skill, filled, trigger, catchUpFor);
    return {
      outcome: launched ? "launched" : "skipped-overlap",
      // Carried even when nothing launched: a skipped fire still happened
      // somewhere, and the history screen it lands on is scoped to one workspace.
      workspaceId: res.workspace.id,
    };
  }

  /** ⏰ button: run a scheduled scenario now, exactly as the schedule would. The
   *  schedule itself is untouched — `lastRun` is written only by the backend
   *  loop, so the regular occurrence still fires. Unlike a backend-driven fire,
   *  a click must say why nothing happened. */
  async function runScheduledNow(skill: Skill) {
    const { outcome } = await handleScheduledFire(skill.id, "runNow");
    if (outcome === "skipped-overlap") {
      await alertModal("Run skipped: the previous one is still active.");
    } else if (outcome === "no-workspace") {
      await alertModal("This scenario has no workspace available: pin it to one or pick a workspace.");
    }
  }

  // Clicking the floating status pill raises the main window (same raise
  // sequence as notify.ts's OS-notification click handler) and focuses the
  // next session that's waiting for input.
  //
  // One addressee, and it is this window. Every window used to answer, so a
  // single click raised all of them and each focused its own next waiting tile.
  // The main window is the one that can answer properly: it is the only
  // participant that sees every session — its own, the orphans, and the proxy
  // rows for detached workspaces (#243, #244).
  if (isMain) void listen("pill://focus-next", async () => {
    // Across every window, not just this one. "Who is blocked on me" is the one
    // command whose entire purpose is that question, and answering it for one
    // monitor is answering the wrong question.
    const target = nextWaitingAcross(allSessions(sessionsByWindow), null);
    const where = target ? windowOf(sessionsByWindow, target.session) : null;
    if (target && where && where !== myLabel) {
      await emitTo(where, "session://focus", { session: target.session });
      return;
    }
    await raiseThisWindow();
    deck.focusNextWaiting();
  });

  /** Focus a session because another window asked — the far end of the routing
   *  above, and of a click on a detached workspace's session row (#244).
   *
   *  Raising happens here rather than at the sender, and only on an explicit
   *  gesture. `set_focus` on a window living on another macOS Space yanks the
   *  person across Spaces, which is tolerable when they just clicked something
   *  and never when a poll decided it. */
  const focusListener = listen<{ session: string }>("session://focus", async (e) => {
    await raiseThisWindow();
    deck.focusSession(e.payload.session);
  }, addressed);

  /** The workspace this window is pinned to has been deleted.
   *
   *  Its sessions are not lost — they go back to the main window and live on
   *  there as orphans, which is exactly what a session whose workspace was
   *  deleted has always been. This window then closes, because a window pinned
   *  to nothing is a state the rest of the app has no answer for.
   *
   *  Through the close handler rather than beside it, so the hand-back happens
   *  once and in one place whatever ends the window. */
  const goneListener = listen("workspace://gone", () => {
    void getCurrentWindow().close();
  }, addressed);

  async function raiseThisWindow() {
    const w = getCurrentWindow();
    await w.unminimize().catch(() => {});
    await w.show().catch(() => {});
    await w.setFocus().catch(() => {});
  }

  /* --- What every connected AI has left -----------------------------------
     The block lives in the panel of every window, including one pinned to a
     workspace: a shared ceiling above twelve sessions is not a property of a
     repository, and a person in a detached window needs it as much as anybody.

     Read on a timer of its own and NOT on the five-second poll tick. The
     registry behind it holds a TTL cache, so this interval is how often the
     screen may change rather than how often a provider is asked — but putting a
     provider that spawns a process anywhere near the tick is the mistake
     `sessions.ts` already documents, so it gets its own slow loop. */
  const limitsEl = document.querySelector<HTMLElement>("#limits")!;
  const limits = new LimitsBlock(limitsEl, {
    openCommandTile: (t, c, cwd) => deck.openCommandTile(t, c, cwd),
    cwd: () => workspaces.active?.path ?? ".",
  });
  /** The last snapshot, so the pill's payload and the block agree on one reading
   *  rather than each asking for its own. */
  let lastUsage: AiUsage[] = [];
  const limitNotifier = new LimitNotifier();

  async function readLimits(force = false): Promise<void> {
    try {
      lastUsage = await usageSnapshot(force);
    } catch (e) {
      // A failed read leaves the previous answer on screen. Blanking the block
      // would say "no limits" where the truth is "we could not ask".
      console.debug("usage: could not read the limits", e);
      return;
    }
    limits.render(lastUsage, Date.now());
    announceLimit();
  }

  /** Tell the pill, and tell somebody who is not looking at the window.
   *
   *  Both go through `deckLimit`, so the pill's story and the notification's are
   *  the same story — and the notifier holds its own state, once for the whole
   *  deck, because twelve notifications about one ceiling is the bug #305 exists
   *  to prevent. */
  function announceLimit(): void {
    if (!isMain) return;
    void emit("pill://count", { n: sumWaiting(sessionsByWindow), limit: deckLimit(lastUsage) });
    const notice = limitNotifier.next(deckLimit(lastUsage));
    // Through the deck, which owns the one permission request — see `canNotify`.
    if (notice && deck.canNotify()) sendNotification({ title: notice.title, body: notice.body });
  }

  /** Every window's sessions, as each of them last reported. Only the main
   *  window keeps this filled — it is the only participant that hears everybody
   *  and the only one that needs to. */
  const sessionsByWindow: SessionsByWindow = new Map();

  const waitingListener = listen<WindowSessions>("session://waiting", (e) => {
    if (!isMain) return;
    sessionsByWindow.set(e.payload.label, e.payload.sessions);
    // The count is added up here, where the whole picture is, and the ceiling
    // travels with it: `pillLabel` decides which of the two stories to tell, and
    // it cannot decide without both. See `pill-util.ts`.
    void emit("pill://count", { n: sumWaiting(sessionsByWindow), limit: deckLimit(lastUsage) });
    showElsewhere();
  });

  /** A window has been destroyed, so stop drawing what it used to hold.
   *
   *  Without this the picture outlived the window: a workspace brought back by
   *  closing its window stayed marked as being elsewhere, could not be selected,
   *  and clicking its row emitted into a label nothing answers to — so it was
   *  unreachable until the app restarted. Nothing in a webview can see another
   *  window go, which is why this comes from Rust rather than being noticed here.
   */
  const windowGoneListener = listen<{ label: string }>("window://gone", (e) => {
    if (!isMain) return;
    if (!sessionsByWindow.delete(e.payload.label)) return;
    void emit("pill://count", { n: sumWaiting(sessionsByWindow), limit: deckLimit(lastUsage) });
    showElsewhere();
  });

  /** Draw what is happening in the other windows, here.
   *
   *  A workspace pulled out must not simply vanish from the main window — the
   *  owner's requirement, and the reason is plain: a workspace that disappears
   *  when you pull it out looks like a workspace you have lost. So its row stays,
   *  detached, and its sessions stay listed under it as proxies. Clicking either
   *  raises the window that has it.
   *
   *  Derived from the same reports the count is, rather than from a second
   *  channel: a window says what it holds on every render, so a window that has
   *  gone stops being drawn as soon as it is dropped, and one that opens appears
   *  on its first report. */
  function showElsewhere() {
    const detached = new Set<string>();
    const proxies: (RemoteSession & { label: string })[] = [];
    for (const [label, sessions] of sessionsByWindow) {
      if (label === myLabel) continue;
      const id = workspaceIdOf(label);
      if (id === null) continue; // the pill, and anything added later
      detached.add(id);
      for (const s of sessions) proxies.push({ ...s, label });
    }
    workspaces.setDetached(detached);
    deck.setRemoteSessions(proxies);
  }

  // Selecting a workspace (click, startup restore of the active one, or after a
  // deletion re-selects the next one) switches the deck to that workspace's tiles
  // — and the terminal drawer with it, which is why both go through one call.
  const workspaces = new WorkspacesPanel(wsMount, (ws) => {
    activateWorkspace(ws.id);
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
    if (prVisible()) void refreshPrs();
    // The records on screen belong to the workspace that was active a moment ago.
    // A run belongs to the workspace it actually happened in, so switching
    // workspace switches what is listed — the same rule the other three screens
    // already follow.
    if (currentPage === "history") void refreshHistory();
  }, () => {
    // A workspace was added, edited or deleted: its tracker root may have moved,
    // so re-point the watcher and re-read the sidebar counts.
    void taskWatchSync();
    void refreshCounts();
  }, (workspaceId) => deck.markAuthStale(workspaceId), isMain,
    // Absent in a window already pinned to one workspace: there is nowhere
    // further to pull it, and a control that reopens the window you are in is
    // worse than no control.
    isMain
      ? {
          icon: "detach" as const,
          label: (name: string) => `Open ${name} in its own window`,
          run: (ws: Workspace) => { void detachWorkspace(ws); },
          drag: beginTearOut,
        }
      : {
          icon: "attach" as const,
          label: (name: string) => `Return ${name} to the main window`,
          run: () => { void returnToMainWindow(); },
        },
    // Clicking a detached workspace's row raises its window rather than
    // switching to it — switching would show an empty deck, since its tiles are
    // somewhere else.
    //
    // Through `openWorkspaceWindow` rather than an event aimed at the window,
    // and that is the load-bearing choice: an emit to a window that is not there
    // is a silent no-op at both ends, so a row whose window had gone was a dead
    // control that answered a click with nothing at all. This raises the window
    // when it exists and opens one when it does not, so the click always does
    // what it says — including in the case this cannot otherwise recover from,
    // a window that died without announcing it.
    (ws) => {
      void openWorkspaceWindow(ws.id).catch((e) => {
        console.debug("raise failed", e);
        // As in `detachWorkspace`: a row for a record the store has lost is
        // refused rather than opened, and re-reading is what removes the row.
        void rereadWorkspaces();
      });
    },
    (workspaceId) => { void emitTo(workspaceLabel(workspaceId), "workspace://gone", {}); });
  /* A window pinned to one workspace shows that one and no other — see `pinTo`.
     Before `load()`, so the first render is already the right list rather than a
     full tree that blinks down to one row. */
  if (pinnedTo !== null) workspaces.pinTo(pinnedTo);

  /** Read the workspace list again, because the store changed under this window.
   *
   *  The list is read once during boot, and until #369 that was the only read
   *  there ever was: a pull that deleted a workspace record — or carried the
   *  answer somebody gave to a duplicate question on the other machine — left
   *  every open window drawing a row for a record that no longer exists. See
   *  `onWorkspacesChanged` for what says so and when.
   *
   *  Two things follow from the new list, and they are the two states a stale one
   *  hid:
   *
   *  A window pinned to a workspace that has gone is pinned to nothing, and that
   *  is the state the comment on `workspace://gone` says the app has no answer
   *  for. It was reachable anyway: the sessions collected under "Other" — the
   *  heading for a session whose workspace was deleted — and with no workspace
   *  row there was no "New session in …" row either, so the window could not be
   *  given work at all. It closes instead, which hands its sessions back to the
   *  main window, where an orphan has always lived.
   *
   *  And the *active* workspace can be the one that went. The panel then has no
   *  active workspace while the deck goes on filtering its tiles to an id nothing
   *  answers for, so the window falls back to the first workspace there is — the
   *  same choice `load()` makes on a cold start. */
  async function rereadWorkspaces(): Promise<void> {
    try {
      await workspaces.load();
    } catch (e) {
      // `list_workspaces` refuses a list it cannot read rather than answering
      // "none" (#369), and refusing is what has to stop this: the *absence* of a
      // record is what closes a pinned window, and a store that would not parse
      // deleted nothing. Keeping the list this window already has is the only
      // honest reading of a failed read.
      console.error("re-reading the workspace list failed; keeping the list this window has", e);
      return;
    }
    if (await closeIfPinnedWorkspaceGone()) return;
    if (workspaces.active === null) {
      const first = workspaces.all[0]?.id ?? null;
      if (first) workspaces.activate(first);
      else activateWorkspace(null);
    }
    // Paired with `refreshCounts` everywhere the workspace set changes, and for
    // the reason `AppState.watchers` gives: a record that arrived in a pull has
    // no tracker watcher until something re-points them, so its open-task count
    // would sit still until the next restart. Main only, exactly as at boot —
    // every window hears this event and holds the same list, so the other copies
    // of the call would re-point the same backend watchers at the same roots.
    if (isMain) void taskWatchSync();
    void refreshCounts();
  }

  /** Close this window if the workspace it is pinned to is not in the store.
   *
   *  Answers whether it did, because everything a caller does next is work for a
   *  window that is staying.
   *
   *  Asked on the announcement and again once at boot. `open_workspace_window`
   *  refuses an id the store does not have, but it answers *before* the window
   *  exists: a pull landing in the gap between that answer and this window's
   *  first read leaves it pinned to nothing with the announcement it would have
   *  heard already sent, which is #369 again with no way out of it. */
  async function closeIfPinnedWorkspaceGone(): Promise<boolean> {
    if (pinnedTo === null || workspaces.all.some((w) => w.id === pinnedTo)) return false;
    await getCurrentWindow().close();
    return true;
  }

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
    const resolved = await resolvePrompt(skill.prompt, placeholderForm);
    if (resolved === null) return;
    // The values go through as well as the text. The journal records what a run
    // was launched with, so it can later be offered again with those values
    // visible in the form rather than silently reapplied to today's branch.
    void deck.launch(ws, { ...skill, prompt: resolved.prompt }, resolved.params);
  };
  const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null,
    (skill) => { void launchScenario(skill); },
    (skill) => { void runScheduledNow(skill); }, () => workspaces.all.map((w) => w.id),
     () => workspaces.active?.name ?? null,
     (skill) => openHistoryFor(skill));
  // Deleting a workspace strands the scenarios pinned to it — the confirmation
  // says how many before it happens.
  workspaces.setSkillsSource(() => skills.all);
  /** Create a session in a NAMED workspace. The row that was pressed says which
   *  one, and it is not necessarily the active one — which is the whole of
   *  "creation is positional".
   *
   *  It activates that workspace first, deliberately: a session lands in a deck,
   *  and the deck shows one workspace at a time, so creating in a workspace whose
   *  tiles are not on screen would be the same defect from the other end — a
   *  session somewhere you cannot see. */
  const newSessionIn = async (workspaceId: string) => {
    const ws = workspaces.all.find((w) => w.id === workspaceId);
    if (!ws) return;
    if (workspaces.active?.id !== ws.id) workspaces.activate(ws.id);
    setPanel("sessions");
    await deck.launch(ws, null);
  };
  /** The keyboard's and the palette's way in, and the empty deck's: no row was
   *  pressed, so the active workspace is the answer — and saying so beats a
   *  control that looks broken when there is no workspace at all. */
  const newSession = async () => {
    const ws = await requireWorkspace();
    if (ws) await newSessionIn(ws.id);
  };

  /* The two halves of the tree, wired once each object exists. The panel owns the
     workspace row; the deck owns the sessions under it. */
  deck.setTree({
    host: (id) => workspaces.sessionHost(id),
    waiting: (id, n) => workspaces.showWaiting(id, n),
    expanded: (id, on) => workspaces.showExpanded(id, on),
    newSession: (id) => { void newSessionIn(id); },
    activate: (id) => { workspaces.activate(id); },
  });
  workspaces.setTreeHooks({
    reselect: (id) => deck.toggleGroup(id),
    rendered: () => deck.repaintList(),
    /* The chip on the active workspace's row, which used to only STATE that three
       pages were showing this workspace and now opens two of them. Activating on
       the way in survives from when these were rows in the tree: the panel that
       opens is about the workspace whose row was pressed, and its head says so. */
    openPage: (id, page) => openWorkspacePage(page, id),
  });

  /** The top bar's readings, and the rail's dot, from the deck's own counts.
   *
   *  Two readings, and they are the two things that want a person: a session
   *  waiting for a decision and a session that stopped. A run that finished while
   *  nobody watched is not one of them, which is why "N done" is absent — the
   *  ledger is not a dashboard of the app's state, it is the list of what is
   *  blocked on me.
   *
   *  Each reading goes to one of the sessions it counted rather than to a list of
   *  everything: the label says "waiting for a decision", and what it opens is a
   *  session waiting for one. */
  function drawLedger(c: SessionCounts): void {
    ledgerEl.replaceChildren();
    const read = (n: number, kind: string, words: string, state: SessionState) => {
      if (n === 0) return;
      const b = document.createElement("button");
      b.className = `led led--${kind}`;
      const num = document.createElement("b");
      num.textContent = String(n);
      b.append(num, document.createTextNode(` ${words}`));
      b.onclick = () => { setPanel("sessions"); deck.focusFirst(state); };
      ledgerEl.append(b);
    };
    read(c.waiting, "wait", "waiting for a decision", "waitingInput");
    read(c.error, "err", "stopped on an error", "error");

    /* A dot, not a digit. Digits on a 32px icon overlap the glyph and are the
       ledger's number said twice; how much is in the button's accessible name,
       where a screen reader gets it without the clutter. Red outranks amber: a
       workspace with one of each has one thing to say first. */
    /* No rail, no dot — a window pinned to one workspace has no button to put it
       on. Nothing is lost with it: the dot is the rail's compressed copy of the
       two readings just written above, and those are in the top bar of every
       window. */
    const btn = railBtns.sessions;
    if (!btn) return;
    let dot = btn.querySelector<HTMLElement>(".rail-dot");
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "rail-dot";
      dot.setAttribute("aria-hidden", "true");
      btn.append(dot);
    }
    dot.hidden = c.waiting === 0 && c.error === 0;
    dot.classList.toggle("rail-dot--error", c.error > 0);
    const note = [
      c.waiting > 0 ? `${c.waiting} waiting for a decision` : "",
      c.error > 0 ? `${c.error} stopped on an error` : "",
    ].filter(Boolean).join(", ");
    const name = note ? `${PANEL_TITLE.sessions} — ${note}` : PANEL_TITLE.sessions;
    btn.setAttribute("aria-label", name);
    btn.title = name;
  }
  /* Zoom takes the panel's room, and gives it back. The tool panel inside a zoomed
     tile is the thing that wants the width — and it has its own floor to keep, so
     the fewer boxes competing for the same pixels the better. */
  deck.setZoomListener((zoomed) => {
    if (zoomed) setCollapsed(true, false);
    else if (!collapsedByHand) setCollapsed(false, false);
    /* And the workspace panel goes, because a zoomed tile's tool panel takes this
       same edge inside the tile frame. Two panels on one edge is a person guessing
       which one a drag will move. It is not brought back on un-zoom: it was opened
       by hand and closed by the app, and restoring it would put a board over a deck
       somebody just came back to. */
    if (zoomed) closeWorkspacePanel();
  });
  /* One width for the tool panel, remembered for the app: every session's tools
     are the same tool, so sizing it once is sizing it. Written on the root, which
     is where a tile that does not exist yet will read it from. */
  deck.setToolWidth((px) => {
    document.documentElement.style.setProperty("--tool-w", `${px}px`);
    saveUiState({ toolPx: px }).catch((e) => console.debug("tool width save failed", e));
  });
  deck.setCounts(drawLedger);
  drawPanelScope();
  // The rail's first selection, which also writes the panel's title and puts the
  // travelling mark somewhere. It was markup before — a button with `class="active"`
  // — and markup cannot say which page is showing to a reader.
  setPanel("sessions");
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
    // `broadcastScale` is a DOM event on `window`, so it reaches this window's
    // terminals and no others — while `ui_state.json` claims the size is the
    // app's. Without this the other window's terminals stayed at the old size
    // until something else happened to move them.
    void emit("ui://scale", { scale: currentScale(), from: myLabel });
    saveUiState({ uiScale: currentScale() })
      .catch((e) => console.debug("ui scale save failed", e));
  }

  /** Open Settings, with the facts it shows gathered here rather than read there:
   *  the paths come from Rust, the workspace from the panel, and the words for a
   *  task source from the module that owns that vocabulary. `settings.ts` owns a
   *  window, not the app's state. */
  async function openSettings(section?: SettingsSection): Promise<void> {
    const ws = workspaces.active;
    const paths = await configPaths().catch((e: unknown) => {
      // A window that cannot say where the files are is still worth opening for
      // the rest of it, and saying so beats a blank section.
      console.debug("config paths unavailable", e);
      return null;
    });
    /* Every section applies as it is touched, so there is nothing to do on the way
       out — only something to persist on the way through. `setScale` is the app's
       own path for that: it writes `ui_state.json` and refits every terminal, and
       the window has no business doing either. */
    await settingsDialog({
      paths,
      workspace: ws,
      section,
      taskSource: ws ? describeTaskSource(ws) : null,
      onReveal: (path) => { revealPath(path).catch((e) => void alertModal(String(e))); },
      onEditWorkspace: () => { void workspaces.editActive(); },
      onScale: (scale) => setScale(scale),
      recording: recordingRuns,
      /* The same three steps the journal's own switch used to do, minus the switch:
         hold it, persist it as a patch so it cannot take the active workspace or the
         text size with it, and re-read the page if it is the one on screen. */
      onRecording: (on) => {
        recordingRuns = on;
        saveUiState({ recordScenarioRuns: on })
          .catch((e) => console.debug("run recording save failed", e));
        if (currentPage === "history") void refreshHistory();
      },
      reportedLimits,
      /* Persisted as a patch, like the switch above, and then re-read at once:
         the backend applies the flag to the live registry before it writes the
         file, so the very next read is on the new footing rather than the old
         one. `force`, because the cached snapshot was taken under the other
         answer. */
      onReportedLimits: (on) => {
        reportedLimits = on;
        saveUiState({ usageReported: on })
          .catch((e) => console.debug("reported limits save failed", e));
        void readLimits(true);
      },
      captureOnClose: captureAnswer,
      /* Three states and two routes, which is why this is not a patch field
         alone: a patch says "set this" and an omitted field says "leave it
         alone", so there is no value left to spell "back to asking". Forgetting
         is its own command. */
      onCaptureOnClose: (value) => {
        captureAnswer = value;
        deck.setCaptureAnswer(value);
        const done = value === undefined
          ? memoryForgetCaptureAnswer()
          : saveUiState({ captureOnClose: value });
        done.catch((e) => console.debug("session note answer save failed", e));
      },
    });
  }

  /** Where this workspace's tasks come from, in words.
   *
   *  Here rather than in the window, because the vocabulary is the tracker's and
   *  this is the file that already speaks it. "Nothing configured" is a real answer
   *  and is returned as null by the caller — a folder that happens to be the
   *  project's default is not the same fact as a folder somebody chose. */
  function describeTaskSource(ws: Workspace): string {
    const provider = ws.tracker?.providers[0] ?? null;
    if (sourceOf(ws.tracker) === "github") {
      return ws.github?.login
        ? `issues in this repository, as ${ws.github.login}`
        : "issues in this repository";
    }
    /* The folder is two rows above, so this does not repeat it: `.cowork/tasks`
       alone means "in this workspace", and a path here means "somewhere else". */
    const root = fsRootOf(provider);
    if (root === null || root.kind === "project") return "cards in .cowork/tasks";
    return `cards in ${root.path}/.cowork/tasks`;
  }

  /** Commands that belong to the app rather than to a workspace, and so are not
   *  offered in a window pinned to one.
   *
   *  The same list the rail drops, plus the two that press what the rail dropped:
   *  a palette entry is a way in, and leaving one for a page with no way out is
   *  worse than the button this window already does not have. */
  const APP_WIDE_COMMANDS = new Set([
    "panel", "sessions", "history", "scenarios", "memory", "notes-search", "notes-jobs",
    "settings", "sync",
  ]);

  function paletteCommands(): Command[] {
    const all: Command[] = [
      { id: "new-session", title: "New session", hotkey: hotkeyLabel("N"), run: () => { void newSession(); } },
      { id: "close-active", title: "Close active session", hotkey: hotkeyLabel("W"), run: () => deck.closeActive() },
      { id: "rename-active", title: "Rename active session", hotkey: "F2", run: () => deck.renameActive() },
      { id: "next-waiting", title: "Go to next session waiting for input", hotkey: isMacPlatform() ? "Cmd+Shift+]" : "Ctrl+Shift+]", run: () => deck.focusNextWaiting() },
      { id: "zoom", title: "Zoom active session", hotkey: isMacPlatform() ? "Cmd+Enter" : "Ctrl+Shift+Enter", run: () => deck.toggleZoomActive() },
      { id: "search", title: "Search in terminal", hotkey: hotkeyLabel("F"), run: () => deck.searchActive() },
      { id: "clear", title: "Clear terminal", run: () => deck.clearActive() },
      { id: "toggle-terminals", title: "Terminals: show or hide the drawer", hotkey: hotkeyLabel("J"), run: () => { void terminals.toggle(); } },
      /* The keyboard half of the button in the terminal bar, and the only half a
         keyboard can use: xterm swallows Tab in both directions, so nothing in
         `.term-bar` is reachable by tabbing once focus is in a terminal. */
      { id: "expand-terminals", title: "Terminals: fill the window, or restore", hotkey: isMacPlatform() ? "Cmd+Shift+E" : "Ctrl+Shift+E", run: () => { void terminals.toggleFull(); } },
      { id: "new-terminal", title: "New terminal", run: () => { void terminals.newTerminal(); } },
      { id: "broadcast", title: "Broadcast mode (type into several sessions)", hotkey: hotkeyLabel("B"), run: () => deck.toggleBroadcast() },
      { id: "next-region", title: "Go to next region (F6)", hotkey: "F6", run: () => cycleRegion(1) },
      /* One entry per page the rail can select, and the wording says what they are
         now: pages of one panel rather than screens that replace the deck. The rail
         has no digits of its own — ⌘1…⌘5 are "focus session N" in this app — so this
         list is the only keyboard route to four of the five. */
      /* No ⌘B: in this app that is broadcast, which shipped first. The palette is
         the keyboard route, as it is for the pages themselves. */
      { id: "panel", title: "Panel: collapse or show", run: () => setCollapsed(!sidebar.classList.contains("is-collapsed")) },
      { id: "sessions", title: "Panel: workspaces and sessions", run: () => setPanel("sessions") },
      /* Named for what they are about rather than for where they live: these two
         are one workspace's, and the panel they open says which. */
      { id: "board", title: "Workspace: the task board", run: () => openWorkspacePage("board") },
      { id: "prs", title: "Workspace: pull requests", run: () => openWorkspacePage("pr") },
      { id: "wsp-close", title: "Workspace panel: close", run: () => closeWorkspacePanel() },
      { id: "history", title: "Panel: the journal", run: () => setPanel("history") },
      { id: "scenarios", title: "Panel: scenarios", run: () => setPanel("scenarios") },
      { id: "memory", title: "Panel: memory", run: () => setPanel("memory") },
      { id: "new-task", title: "New task", hotkey: isMacPlatform() ? "Cmd+Shift+T" : "Ctrl+Shift+T", run: () => { void captureTask(); } },
      { id: "github", title: "GitHub: accounts and gh install", run: () => void openGithubScreen(deck, workspaces.active?.path ?? ".") },
      // The two steps are direct commands because stepping is what a person wants
      // most often and it needs nothing on screen to do; the dialog exists for
      // choosing, which needs the current value visible. Titles carry the value so
      // the palette is not silent about where you already are.
      { id: "text-larger", title: `Text size: larger (now ${scaleLabel(currentScale())})`, run: () => setScale(nextScale(currentScale())) },
      { id: "text-smaller", title: `Text size: smaller (now ${scaleLabel(currentScale())})`, run: () => setScale(prevScale(currentScale())) },
      { id: "settings", title: "Settings…", run: () => void openSettings() },
      /* The window's own section rather than the standalone dialog: two doors to
         one set of facts is how they drift. The dialog stays for the first-run
         offer, which is a flow of its own with its own copy. */
      /* Both land on the memory page now. It is the one door to everything about
         the corpus, and two doors onto one set of facts is how they drift. */
      { id: "notes-jobs", title: "Memory: what has been captured…", run: () => { setPanel("memory"); memoryView.revealCaptures(); } },
      /* The page with the field focused, rather than a dialog of its own. Two
         doors to one set of facts is how they drift, and the page is where the
         result opens anyway — the dialog's preview pane was approximating the
         document surface. */
      { id: "notes-search", title: "Search your notes…", run: () => { setPanel("memory"); memoryView.focusSearch(); } },
      { id: "notes", title: "Session notes…", run: () => void openSettings("notes") },
      { id: "sync", title: "Memory sync…", run: () => void openSettings("config") },
    ];
    return pinnedTo === null ? all : all.filter((c) => !APP_WIDE_COMMANDS.has(c.id));
  }

  /** Focus cycling between the sidebar and the active terminal.
   *
   *  Without it the terminal is a one-way door: xterm consumes Tab and Shift+Tab
   *  (they go to the PTY), so once focus landed in a tile — which happens
   *  automatically on launch — the sidebar, the scenario buttons and the
   *  run-now button were unreachable by keyboard entirely. */
  type Region = "sidebar" | "deck" | "drawer" | "terminals";
  /** The cycle, which is not fixed: the diff drawer is a region only while it is
   *  open, because a region you cannot see is a stop that does nothing.
   *
   *  It has to be one at all — `currentRegion` decides by `sidebar.contains(...)`,
   *  so without this focus inside the drawer reads as `"screen"` and F6 from a diff
   *  sends you to the sidebar, with no key at all going the other way. */
  function regions(): Region[] {
    const cycle: Region[] = ["sidebar"];
    // The deck, unless the terminal drawer is covering it — the same rule as the
    // diff drawer, applied the other way round: F6 onto a deck nobody can see
    // would put the keyboard in an invisible tile, and the two presses back out
    // of it would look like two presses that did nothing.
    if (!terminals.isFull()) cycle.push("deck");
    // Only while it is up, for the same reason as the diff drawer: a region you
    // cannot see is a stop that appears to do nothing.
    if (terminals.isOpen()) cycle.push("terminals");
    if (diffDrawer.isOpen()) cycle.push("drawer");
    return cycle;
  }

  /** The rail is deliberately outside the cycle rather than a third region: it is
   *  the first thing in `#stage`, so plain Tab reaches it, and F6 from it goes to
   *  the panel in both directions — which is where its own selection landed. */
  function currentRegion(): Region {
    // The drawer first, because it is inside the screen: asked in the other order
    // every answer would be "screen".
    if (diffDrawer.contains(document.activeElement)) return "drawer";
    if (terminals.hasFocus()) return "terminals";
    return sidebar.contains(document.activeElement) ? "sidebar" : "deck";
  }

  function focusRegion(r: Region): void {
    if (r === "terminals") {
      if (terminals.focusActive()) return;
      focusRegion("sidebar");
      return;
    }
    if (r === "drawer") {
      if (diffDrawer.focusFirst()) return;
      focusRegion("sidebar");
      return;
    }
    if (r === "deck") {
      // The deck, unconditionally, and it is the change that made this simple
      // again: "the second region" meant three different things while the board
      // and the pull request screen could replace the deck, and F6 from a board
      // row called `focus()` on an xterm inside a `display: none` `#deck` — which
      // does nothing at all. The board is a page of the panel now, so the panel's
      // own region reaches it and this one is only ever the deck.
      if (deck.focusActiveTerminal()) return;
      // No session yet. Stay somewhere focusable rather than dropping focus on the
      // floor.
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

  /** Pull a workspace into a window of its own, sessions and all.
   *
   *  The plain trigger. The drag gesture (#248) ends in exactly this call — it is
   *  built last and only works on macOS, so this is the path that has to exist
   *  and the one every other platform keeps.
   *
   *  The order below is the ordering rule from #241, and none of it is
   *  rearrangeable. `openWorkspaceWindow` resolves only once the new window has
   *  attached its listeners (#239), so the payload cannot be emitted into a
   *  window that is not listening — an emit to a webview with no listener is a
   *  silent no-op at both ends. The scrollback is read *after* that, as late as
   *  possible, so it is what the person was looking at rather than what they were
   *  looking at a second ago. And this window gives nothing up here: it disposes
   *  when `session://owner` says the other window has taken over, by which time
   *  its writes have been refused since the claim (#240). Losing that race costs
   *  nothing. */
  async function detachWorkspace(ws: Workspace) {
    try {
      const label = await openWorkspaceWindow(ws.id);
      const tiles = deck.handOffPayload(ws.id);
      if (tiles.length) await emitTo(label, "workspace://take", { tiles });
    } catch (e) {
      await alertModal(`Could not open a window for ${ws.name}: ${String(e)}`);
      // One of the two reasons this fails is that the row pressed is a record the
      // store no longer has — `open_workspace_window` refuses those rather than
      // opening a window pinned to nothing (#369). Re-reading is what takes the
      // row away, so the same press does not fail the same way twice.
      void rereadWorkspaces();
    }
  }

  /** Give this window's workspace back to the main window, and close.
   *
   *  The mirror of `detachWorkspace`, and the same ordering: the main window
   *  claims before this one gives anything up, so a failure at any point leaves
   *  the sessions where they are rather than nowhere. This window then goes; its
   *  tiles are already somewhere else by then.
   *
   *  Dragging the window back was considered and rejected. `startDragging()`
   *  hands the drag to the OS and **Tauri has no drag-end event**, so the one
   *  signal that would decide "absorb or not" — the moment of release — cannot
   *  be observed. Hand-rolling the drag instead means reimplementing window
   *  dragging with `setPosition` per move, which feels less native and does
   *  nothing at all on Wayland. It buys noticeably less than it costs. */
  async function returnToMainWindow() {
    const tiles = deck.handOffPayload(role.kind === "workspace" ? role.workspaceId : "");
    try {
      if (tiles.length) await emitTo(MAIN_WINDOW_LABEL, "workspace://take", { tiles });
    } catch (e) {
      await alertModal(`Could not hand this workspace back: ${String(e)}`);
      return;
    }
    await getCurrentWindow().destroy().catch((e) => {
      console.error("could not close the workspace window", e);
    });
  }

  /** Whether this platform lets the app say where a window goes. Read once, at
   *  boot: it cannot change while the app is running. */
  let placesWindows = false;
  void hostPlatform()
    .then((p) => { placesWindows = p.placesWindows; })
    .catch((e) => console.debug("host platform unknown; tear-out stays off", e));

  /** A press on a workspace row that may turn into dragging it out of the window.
   *
   *  Pointer capture rather than HTML5 drag-and-drop, which cannot cross the
   *  boundary of a webview or an OS window at all — the drag simply never
   *  arrives anywhere. Capture keeps `pointermove` coming after the pointer
   *  leaves the window, with coordinates that go negative or past the far edge,
   *  so nothing has to be polled until there is a window to place.
   *
   *  Nothing is torn until the pointer has actually left, and the press is not
   *  swallowed: a click that does not become a drag still selects the workspace,
   *  which is what the row is mostly for. */
  function beginTearOut(ws: Workspace, down: PointerEvent) {
    if (!placesWindows || !startsTearOut(down)) return;
    /* A press on one of the row's own controls is that control's, and this must
       not take it: the capture below retargets the compatibility mouse events with
       the pointer ones, so `click` would arrive at the row and ✎, 🗑, the pull-out
       and the `board · PRs · journal` chip would all be dead. See
       `pressStartsOnControl`, which carries the whole reason. */
    if (pressStartsOnControl(down.target)) return;
    const row = down.currentTarget as HTMLElement | null;
    if (!row) return;
    let torn = false;
    const finish = () => {
      row.removeEventListener("pointermove", onMove);
      row.removeEventListener("pointerup", finish);
      row.removeEventListener("pointercancel", finish);
      try { row.releasePointerCapture(down.pointerId); } catch { /* already gone */ }
    };
    const onMove = (e: PointerEvent) => {
      if (torn) return;
      if (!hasLeftWindow(e.clientX, e.clientY, { width: innerWidth, height: innerHeight })) return;
      torn = true;
      finish();
      void tearOut(ws);
    };
    try { row.setPointerCapture(down.pointerId); } catch { return; }
    row.addEventListener("pointermove", onMove);
    row.addEventListener("pointerup", finish);
    row.addEventListener("pointercancel", finish);
  }

  /** Put the workspace in a window under the cursor and let the OS carry on the
   *  drag.
   *
   *  The cursor's position is asked for once, here, because this is the only
   *  moment it is needed — it is global screen coordinates and keeps working
   *  outside the window, which the pointer event's own coordinates do not.
   *
   *  From `startDragging()` on, the window is being moved by the compositor:
   *  snapping, edge behaviour and the feel of it are the platform's rather than
   *  something reimplemented here. */
  async function tearOut(ws: Workspace) {
    try {
      const at = await cursorPosition();
      const label = await openWorkspaceWindow(ws.id, [at.x, at.y], true);
      const tiles = deck.handOffPayload(ws.id);
      if (tiles.length) await emitTo(label, "workspace://take", { tiles });
    } catch (e) {
      await alertModal(`Could not pull ${ws.name} out: ${String(e)}`);
      // As in `detachWorkspace`, and for the same reason: one of the two ways
      // this fails is a row for a record the store has lost (#369).
      void rereadWorkspaces();
    }
  }

  const COMMANDS: Record<string, () => void> = {
    "detach-workspace": () => {
      // Nowhere further to pull it. The row's own control is already absent in
      // this window — see `moveAction` — and the hotkey is the other way in.
      if (!isMain) return;
      const ws = workspaces.active;
      if (ws) void detachWorkspace(ws);
    },
    "return-workspace": () => { if (!isMain) void returnToMainWindow(); },
    "palette": () => openPalette(paletteCommands()),
    "new-session": () => { void newSession(); },
    // Whichever surface has the keyboard. Closing a deck tile because the caret
    // happened to be in a terminal would be the same defect the text-entry guard
    // below exists to prevent, one level up.
    "close-active": () => { if (!terminals.hasFocus()) deck.closeActive(); else void terminals.closeActive(); },
    "rename-active": () => deck.renameActive(),
    "search": () => deck.searchActive(),
    "next-waiting": () => deck.focusNextWaiting(),
    "broadcast": () => deck.toggleBroadcast(),
    "toggle-terminals": () => { void terminals.toggle(); },
    "expand-terminals": () => { void terminals.toggleFull(); },
    "zoom": () => deck.toggleZoomActive(),
    "next-region": () => cycleRegion(1),
    "prev-region": () => cycleRegion(-1),
    // Follows its control: see `shutBtn`. A collapsed panel in a window with no
    // rail is a window with nothing to press.
    "panel": () => { if (pinnedTo === null) setCollapsed(!sidebar.classList.contains("is-collapsed")); },
    "sessions": () => setPanel("sessions"),
    "board": () => openWorkspacePage("board"),
    "prs": () => openWorkspacePage("pr"),
    "history": () => setPanel("history"),
    "scenarios": () => setPanel("scenarios"),
    "memory": () => setPanel("memory"),
    "new-task": () => { void captureTask(); },
    "github": () => void openGithubScreen(deck, workspaces.active?.path ?? "."),
  };

  /** Whether the caret is in a field where a keystroke is text, not a command.
   *
   *  `.xterm-helper-textarea` is the exception: it is the terminal's own hidden
   *  input, and exempting it would disable every hotkey inside a terminal, which
   *  is the whole app. The consequence is a decision rather than an oversight:
   *  `F6` region cycling is suppressed while an editable field holds focus. */
  function isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.classList.contains("xterm-helper-textarea")) return false;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
  }

  window.addEventListener("keydown", (e) => {
    if (document.querySelector(".modal-overlay")) return; // do not intercept while a modal, the palette or a form is open
    // Without this, Cmd+N spawned a session and Cmd+W closed the tile while the
    // caret sat in the tile's search box or the broadcast bar.
    if (isTextEntry(e.target)) return;
    /* The reader is the thing on top, so it takes Escape first. A person reading
       a note over a zoomed tile means "put the note away" by it — leaving the
       zoom, which is behind the cover and unchanged, exactly as they left it. */
    if (e.key === "Escape" && noteReader.isOpen()) {
      e.preventDefault();
      /* Never out from under an unsaved edit. A keystroke that discards what
         somebody has written is the one thing this surface must not do by
         accident — Discard is the way out, and it asks. */
      if (!noteReader.isEditing()) noteReader.close();
      return;
    }
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

  if (isMain) {
    claudeAvailable().then((ok) => {
      if (!ok) alertModal("The claude executable was not found. Set its path via the COWORK_CLAUDE_PATH environment variable and restart the app.");
    });

    // N prompts, and N concurrent `downloadAndInstall()` racing one `relaunch()`.
    // The dismissal key in `localStorage` is shared but written only after the
    // answer, so it does not de-duplicate the prompt either.
    void offerUpdateIfAvailable();
  }

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
      // Read before the screen can be opened. A default of `true` that turned out
      // to be false would have the history screen say runs are being recorded
      // while the backend writes nothing — the one thing its empty state exists
      // to prevent.
      recordingRuns = ui.recordScenarioRuns;
      // Read on the same pass, for the same reason: the settings window must not
      // draw a switch in the wrong position, and the backend has already applied
      // the stored value to its own registry at startup.
      reportedLimits = ui.usageReported;
      // The remembered answer to the note question, on the same pass and for a
      // sharper version of the same reason: read late, the first close of the
      // session would ask somebody who had already answered, which is exactly the
      // reflex-click failure the remembered answer exists to avoid.
      captureAnswer = ui.captureOnClose;
      deck.setCaptureAnswer(captureAnswer);
      // Read here rather than again inside `boot()`: one read of one file, and
      // the drawer's own restore step below runs after the deck's layout so its
      // height lands on a window that is already laid out. *Whether* it is up is
      // not here — that is per workspace and comes with the tabs.
      storedDrawer = { rows: ui.terminalRows };
      /* The widths somebody dragged, applied as properties rather than as inline
         widths so that a value nobody has set leaves the stylesheet's own — which
         tracks the window and the text size — in charge. */
      if (ui.panelPx) sidebar.style.setProperty("--panel-w", `${ui.panelPx}px`);
      if (ui.wspPx) wspEl.style.setProperty("--wsp-w", `${ui.wspPx}px`);
      if (ui.wspWidePx) wspEl.style.setProperty("--wsp-wide-w", `${ui.wspWidePx}px`);
      if (ui.toolPx) document.documentElement.style.setProperty("--tool-w", `${ui.toolPx}px`);
    } catch (e) {
      console.debug("ui state read failed, using the defaults", e);
    }
    applyScale(scale, document.documentElement);
    await boot();
    // After the deck, never before it: somebody who has just launched the app
    // wants their sessions back, and a question in front of that is the fastest
    // way to teach people to dismiss things unread. Failing to offer is not
    // worth reporting — the palette still has it.
    void maybeOfferSync().catch((e) => console.debug("sync offer skipped", e));
  }

  /** Mention memory sync, once, to somebody who has never been asked.
   *
   *  Main window only. A pulled-out workspace window is a view of one project,
   *  and sync is about everything this machine holds — an offer there would be
   *  the same question asked from the wrong place, and twice if both are open.
   *
   *  Everything about the decision lives in `sync-offer.ts`; this is the wiring.
   *  Dismissing writes to `ui_state.json`, which is not on the sync allowlist —
   *  so declining on the laptop says nothing about the desktop, which is the
   *  right answer for a question about *this* machine's memory leaving it. */
  async function maybeOfferSync(): Promise<void> {
    if (!isMain) return;
    const [summary, ui] = await Promise.all([syncSummary(), loadUiState()]);
    if (!shouldOffer({ on: summary.on, workspaces: workspaces.all, ui })) return;

    const banner = offerBanner(
      workspaces.all.length,
      () => {
        banner.remove();
        void syncDialog();
      },
      () => {
        banner.remove();
        saveUiState({ syncOfferDismissed: true })
          .catch((e) => console.debug("sync offer dismissal not saved", e));
      },
    );
    document.getElementById("workarea")?.prepend(banner);
  }

  /** The two listeners a hand-off needs, and the reason this function returns a
   *  promise at all.
   *
   *  **Awaited, not fired and forgotten.** `listen` is asynchronous: registering
   *  it is a round trip to the backend, and until it completes this window holds
   *  no listener for the event. An emit to a webview in that state is a silent
   *  no-op at both ends — so a window that answered `window_ready` before these
   *  resolved would be told it may be spoken to while it still cannot hear, and
   *  the workspace handed to it would go into the void. That is the exact failure
   *  the handshake exists to prevent, and `void`-ing these would have reinvented
   *  it one layer up.
   *
   *  Before the boot rather than inside it: the boot restores a layout and can
   *  take a while, and there is nothing in it these two depend on. */
  const scaleListener = listen<{ scale: number; from: string }>("ui://scale", (e) => {
    // Applied, not re-announced: the sender told everybody, and echoing would
    // put two windows in a loop for a preference neither of them changed.
    if (e.payload.from === myLabel) return;
    applyScale(e.payload.scale, document.documentElement);
    broadcastScale(e.payload.scale);
  });

  /** Closing a workspace window returns its workspace. It never ends a session.
   *
   *  An accidental Cmd+W must cost nothing but a window, and that is the whole
   *  point of this issue. So the close is intercepted, the workspace is handed
   *  back, and only then is the window destroyed — `destroy()` rather than
   *  `close()`, which would come back through here.
   *
   *  In a `finally`: a hand-back that failed must not leave a window that cannot
   *  be closed. The sessions survive either way — nothing here kills anything,
   *  and PTYs die on app exit only — so the worse of the two outcomes is a tile
   *  that has to be found again, not work that is gone. */
  const closeListener = isMain
    ? Promise.resolve(() => {})
    : getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        try {
          const tiles = deck.handOffPayload(role.kind === "workspace" ? role.workspaceId : "");
          if (tiles.length) await emitTo(MAIN_WINDOW_LABEL, "workspace://take", { tiles });
        } catch (err) {
          console.error("handing the workspace back failed; closing anyway", err);
        } finally {
          void getCurrentWindow().destroy();
        }
      });

  const handOffListeners = Promise.all([
    closeListener,
    goneListener,
    windowGoneListener,
    focusListener,
    waitingListener,
    scaleListener,
    // A workspace arriving from another window.
    listen<{ tiles: HandOffTile[] }>("workspace://take", (e) => {
      void deck.receive(e.payload.tiles);
    }, addressed),
    // A session changed hands. The window that asked for it ignores this; every
    // other one gives up the tile without ending anything — the process, the PTY
    // and the conversation carry on where they went.
    onSessionOwner((session, owner) => {
      if (owner !== myLabel) deck.releaseTile(session);
    }),
  ]);

  return handOffListeners
    .catch((e) => { console.error("hand-off listeners failed", e); })
    .then(() => bootWithStoredScale());
}
