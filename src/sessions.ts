import { TerminalPanel } from "./terminal";
import { onState, onExit, closeSession, memoryCaptureOffer, saveUiState, saveLayout, updateTask, prepareWorkspace, describeExit, type RunTrigger, type ScenarioLaunch, type SessionState, type Skill, type Workspace, type SessionEntry, type SessionAuth, type Task, type BoardConfig, type CaptureOnClose } from "./ipc";
import { gitStatus, sessionActivity, sessionSnapshots, type CliKind, type HandOffTile, type NameKind, type SessionTokens } from "./ipc";
import { activityButton, localRoll, openActivityPanel, setActivityCount, type ActivityPanel } from "./activity";
import { formatContext, tokenTooltip, uniqueCwds } from "./observability";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { emit } from "@tauri-apps/api/event";
import { NotifyRouter, wireNotificationFocus } from "./notify";
import { notifyIdSeed } from "./cross-window";
import { workspaceIdOf } from "./window-role";
import { confirmModal } from "./modal";
import { askCapture, askWorthPutting, decideCapture } from "./memory-consent";
import { broadcastInput } from "./broadcast";
import { groupTilesByWorkspace, resolveWorkspaceId } from "./grouping";
import { TileTools } from "./tile-tools";
import { zoomParticipants, flipTransform } from "./flip";
import { shouldSkipOverlap } from "./schedule";
import { icon, iconButton, type IconName } from "./icons";
import { linksInWorkspace, liveSessionForTask, taskPrompt, type TaskSessionLink } from "./tasks";
import { workingStep } from "./board-config";

/** Обычный тайл — сессия claude. Командный — разовый запуск пользовательской
 *  команды (установка gh, `gh auth login`): без хуков состояния, без
 *  перезапуска и, главное, без автовосстановления. */
export type TileKind = "claude" | "command";

interface Tile {
  session: string; names: TileNames; nameEl: HTMLElement;
  /** The open editor, when this tile is being renamed. Its presence is what
   *  makes a commit idempotent: blur fires after Enter has already committed. */
  renameInput: HTMLInputElement | null;
  panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; workspaceId?: string; prompt: string | null; restartBtn: HTMLButtonElement;
  searchBar: HTMLElement; bcastCheck: HTMLInputElement; gitBadge: HTMLElement; tokenBadge: HTMLElement;
  /** The button that opens the activity panel, carrying this session's call
   *  count. Always in the DOM; the stylesheet hides it until the tile is
   *  hovered, active or holds focus, as `tile-rename` documents. */
  activityBtn: HTMLButtonElement;
  /** The open panel, or nothing. Its presence is what makes the tick re-read
   *  this session's log at all — closing the panel is what stops the reads. */
  activityPanel: ActivityPanel | null;
  /** The branch the poll last read for this tile's directory, kept beside the
   *  badge that renders it because the sidebar row needs the same answer and
   *  reading it back out of the badge's text would be parsing our own markup. */
  branch: string | null;
  /** The tools that belong to this session, inside its frame and only while it is
   *  zoomed. See `tile-tools.ts` for why they are not in the app's panel. */
  tools: TileTools;
  authBadge: HTMLElement;
  /** Set when the tile came from a scheduled run — keys the overlap guard. */
  scheduledSkillId?: string;
  /** Исход привязки GitHub-аккаунта на момент СТАРТА процесса. Живой сессии
   *  окружение не поменять, поэтому значение не обновляется до перезапуска. */
  auth?: SessionAuth;
  /** Привязка воркспейса изменилась после старта — окружение устарело. */
  authStale?: boolean;
  kind?: TileKind;
  /** Set when the tile was launched from a tracker card — keys the "in progress" state. */
  taskId?: string;
  /** Scenario this tile was launched from, by any route. Wider than
   *  `scheduledSkillId`, which stays what it was: the overlap guard's key. */
  skillId?: string;
  /** The run journal record this tile is currently in. Written by the backend,
   *  minted here, and persisted so a restart can chain to it. */
  runId?: string;
  /** The placeholder values this tile was launched with, carried so a restart
   *  can hand them back to the journal rather than opening a record that
   *  forgets what it ran with. */
  params?: Record<string, string>;
  /** Which agent CLI this tile runs. Always `claude` for now, and that is the
   *  point: the field is what the activity registry dispatches on, and the
   *  alternative was discovering at the second reader that the shape had
   *  nowhere to live. */
  cliKind?: CliKind;
}

/** The four things that can name a tile, in one place so no reader can hold a
 *  stale copy of a name.
 *
 *  There is no `autoNameable` flag: "this tile may take a transcript title" is
 *  exactly `context === null`, so the two cannot disagree — and `openCommandTile`
 *  supplies a context name, which excludes command tiles for free without
 *  consulting `kind`. */
export interface TileNames {
  /** "☑ <card>", "<icon> <scenario>", a worktree name, a command label. */
  context: string | null;
  /** "session · <workspace>" — the only string an automatic title may replace. */
  placeholder: string;
  /** The latest title read out of the transcript. */
  auto: string | null;
  /** Hand-typed. Wins over everything, forever. */
  user: string | null;
}

/** Longest name kept. The same string reaches `sessions.json`, a desktop
 *  notification body and a confirmation sentence — and it must agree with
 *  `TITLE_CAP` in `src-tauri/src/commands.rs`, which caps the automatic side. */
export const NAME_CAP = 120;

/** Clean up what someone typed or pasted: control characters out, whitespace
 *  runs collapsed to one space, trimmed, capped at [`NAME_CAP`].
 *
 *  By code point rather than by UTF-16 unit, matching the Rust sanitiser — a cap
 *  counted in units would split a surrogate pair and leave half a character. */
export function normaliseName(raw: string): string {
  const flat = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return [...flat].slice(0, NAME_CAP).join("").trim();
}

/** What the tile, the sidebar row, the notification and the close question all
 *  show. Every slot is trimmed and an empty one counts as absent.
 *
 *  A context name beating an automatic title is the row that carries the whole
 *  decision: `☑ Fix the pill counter` and `⚡ Daily digest` are already
 *  meaningful, and they are how the board and the sidebar say which card or
 *  scenario a session belongs to. */
export function resolveTileName(n: TileNames): string {
  const some = (v: string | null) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  return some(n.user) ?? some(n.context) ?? some(n.auto) ?? some(n.placeholder) ?? "";
}

const LABEL: Record<SessionState, string> = {
  idle: "idle", working: "working", waitingInput: "needs input", done: "done",
  ended: "exited", error: "error",
};
// `done` is here because "the agent finished the job" is exactly what an
// unsupervised session is started for. It stays out of the pill, though: the
// pill answers "how many sessions are blocked on me".
const NOTIFY_ON: SessionState[] = ["waitingInput", "done", "ended", "error"];

/** What an empty deck should say, and which one action it should offer.
 *
 *  `<main id="deck">` is an empty element until a session exists, so the app's most
 *  likely first screen — and its screen every time the last session is closed — was an
 *  unexplained dark rectangle.
 *
 *  Two states rather than one, because the action differs. With no workspace there is
 *  nowhere for a session to run at all, and offering "New session" there produces
 *  `Pick a workspace first.` in a modal: a question answered by a refusal. Pure, so the
 *  copy can be asserted without standing a Deck up. */
export function emptyDeckCopy(
  activeWorkspaceName: string | null, anyWorkspaceExists: boolean,
): { mark: IconName; title: string; body: string; action: string } {
  if (activeWorkspaceName === null) {
    return {
      mark: "folder",
      title: anyWorkspaceExists ? "Pick a workspace to start working" : "Add a workspace to start working",
      body: "A workspace is a project folder. Sessions run in one, so it is the first thing "
        + "the deck needs — and it is what binds the GitHub account git push will go out as.",
      action: anyWorkspaceExists ? "Add another workspace" : "Add a workspace",
    };
  }
  return {
    mark: "terminal",
    title: `No sessions in ${activeWorkspaceName}`,
    body: "A session is a real claude process in this folder. It is a child of this window: "
      + "closing the app ends it, and its scrollback stays on screen after it finishes so "
      + "you can read what it did.",
    action: "New session",
  };
}

export class Deck {
  private tiles = new Map<string, Tile>();
  /** skillId -> session of that scenario's most recent scheduled run. */
  private scheduledSessions = new Map<string, string>();
  private notifyOk = false;
  /** Set by `app.ts` before anything is announced. The default keeps a Deck
   *  built in a test working without one. */
  private windowLabel = "main";
  /** Sessions held by other windows, as they last reported them.
   *
   *  Only the main window fills this. They are drawn in the sidebar exactly
   *  where they would be if they were here — under their workspace's heading,
   *  counted by its waiting badge — so a workspace pulled into a window of its
   *  own does not disappear into the void. Clicking one raises the window that
   *  has it. */
  private remote: { session: string; name: string; state: SessionState; workspaceId?: string; label: string }[] = [];
  /** What the other windows hold, as they last reported it.
   *
   *  **The comparison is load-bearing, not an optimisation.** `renderList` emits
   *  `session://waiting` so the other windows know what is here, and a Tauri emit
   *  is global — the sender hears itself. So the main window's own report comes
   *  straight back to its own listener, which recomputes the proxies and calls
   *  this. Rendering unconditionally closed that circle: render, emit, hear,
   *  render, at whatever rate the machine could manage.
   *
   *  What it looked like is worth writing down, because it does not look like a
   *  loop. The sidebar is rebuilt from `innerHTML`, so `:hover` was dropped and
   *  reapplied continuously — a row strobing under the cursor — and a click never
   *  landed, because the element it went down on was gone before it came up.
   *
   *  Comparing serialised is the same idiom `persistLayout` uses below, and for a
   *  list this size it costs nothing worth measuring. A real change still
   *  re-renders, once: the second pass finds the proxies unchanged and stops. */
  setRemoteSessions(
    list: { session: string; name: string; state: SessionState; workspaceId?: string; label: string }[],
  ) {
    const serialized = JSON.stringify(list);
    if (serialized === this.remoteSerialized) return;
    this.remoteSerialized = serialized;
    this.remote = list;
    this.renderList();
  }
  private remoteSerialized = "[]";
  /** Ask the window holding a session to raise itself and focus it. Set by
   *  `app.ts`; absent in a window that has no proxies. */
  private onRemoteFocus: (label: string, session: string) => void = () => {};
  setRemoteFocus(fn: (label: string, session: string) => void) { this.onRemoteFocus = fn; }
  setWindowLabel(label: string) {
    this.windowLabel = label;
    this.adoptsOrphans = workspaceIdOf(label) === null;
    this.notify = new NotifyRouter(notifyIdSeed(label));
  }
  /** Whether a session whose workspace no longer exists belongs here.
   *
   *  An orphan is deliberately visible in every workspace filter, so a session
   *  whose workspace was deleted stays reachable. Under a per-window layout that
   *  rule has no home — "everywhere" would mean every window showing it, which
   *  is the same session drawn twice. So: **orphans belong to the main window.**
   *  Its filter is "my workspace, plus orphans"; a window pinned to a workspace
   *  shows that workspace only. The same rule as before, with one owner instead
   *  of N. */
  private adoptsOrphans = true;
  private notify = new NotifyRouter();
  private broadcasting = false;
  private bcastPanel: HTMLElement | null = null;
  private restoring = false;
  /** The last layout `saveLayout` actually accepted, serialised. See
   *  `persistLayout`: a write that would change nothing is skipped. */
  private savedLayout: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private usage = new Map<string, SessionTokens>();
  private activeWorkspaceId: string | null = null;
  private collapsed = new Set<string>();
  private zoomedSession: string | null = null;
  private strip: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private emptyActions: {
    newSession: () => void; addWorkspace: () => void;
    scenarios: () => Skill[]; runScenario: (s: Skill) => void;
  } | null = null;
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement, private workspaces: () => Workspace[]) {}

  /** Wired after construction for the same reason `WorkspacesPanel.setSkillsSource` is:
   *  the deck is built before the handlers it needs exist. Without them the empty deck
   *  still renders and simply carries no buttons — an explanation is worth more than a
   *  dark rectangle even with nothing to press. */
  setEmptyActions(a: NonNullable<Deck["emptyActions"]>) {
    this.emptyActions = a;
    this.renderEmpty();
  }

  /** The tree this deck's session rows live in, when something else is drawing
   *  the workspaces.
   *
   *  Workspaces and sessions are one tree, and a workspace appears in it once.
   *  That was not true before: the panel listed every workspace, and the session
   *  list listed every workspace again as a group heading — the same fact stated
   *  twice, in two shapes, and neither of them said where a new session would go.
   *
   *  Two modules render one row between them, and the split follows ownership
   *  rather than convenience: the workspace row is the workspaces panel's, which
   *  owns activation, the account, the form and the delete; the sessions under it
   *  are this deck's. So the panel leaves a container under each row and this asks
   *  for it, rather than either half moving into the other.
   *
   *  With no tree the deck draws its own headings — not a fallback kept for tests:
   *  the "Other" group is sessions whose workspace was deleted from under them, and
   *  it has no workspace row to hang under and never will. */
  setTree(t: DeckTree) { this.tree = t; this.renderList(); }
  private tree: DeckTree | null = null;

  /** Told when the tool panel inside a tile is dragged. Wired by the app, which
   *  owns the file the width is remembered in — a tile does not persist anything
   *  and this deck does not know what `ui_state.json` is. */
  setToolWidth(fn: (px: number) => void) { this.onToolWidth = fn; }
  private onToolWidth: ((px: number) => void) | null = null;

  /** Fold a group by its workspace id — for the panel's row, which activates on
   *  the first press and folds on the second. One gesture with a rule, rather than
   *  two targets inside one row, one of which is always the one you miss. */
  toggleGroup(workspaceId: string) {
    if (this.collapsed.has(workspaceId)) this.collapsed.delete(workspaceId);
    else this.collapsed.add(workspaceId);
    this.renderList();
  }

  /** Repaint the tree's rows. The panel rebuilds its own list from `innerHTML`,
   *  which throws away the containers these rows were in — so the render that
   *  replaces them has to be followed by this. */
  repaintList() { this.renderList(); }

  /** Told after every list render, because that is where the app already counts
   *  what its sessions are doing. The ledger in the top bar reads these rather
   *  than counting again: the two statements of "N waiting" this app used to make
   *  — a sidebar heading and the floating pill — came from two different places,
   *  and with two windows open they disagreed. */
  setCounts(fn: (counts: SessionCounts) => void) {
    this.onCounts = fn;
    this.renderList();
  }
  private onCounts: ((counts: SessionCounts) => void) | null = null;

  /** The deck with nothing on it. "Nothing" means nothing VISIBLE: tiles belonging to
   *  another workspace stay in the DOM behind `ws-hidden`, so counting the map would
   *  call a deck full while the screen is blank. */
  /** Which tile, if any, has the stage to itself — and therefore the tools that
   *  belong to a session filling it.
   *
   *  One visible tile already HAS the stage. The condition for the tools was "the
   *  deck is zoomed", and `zoomTo` refuses when there is nothing to zoom past — so
   *  the one case where a person is unambiguously inside a single session was the
   *  case with no Files, no Changes and no Source. How a session came to fill the
   *  stage is not the question the tools answer.
   *
   *  Called from `renderEmpty` because that is the one function every path that
   *  changes what the deck holds already goes through: a launch, a close, a
   *  workspace switch, a tile arriving from another window. Marking it in
   *  `applyLayout` instead covered three of those and missed the launch. */
  private markStage() {
    const visible = [...this.tiles.values()].filter((t) => !t.el.classList.contains("ws-hidden"));
    const alone = visible.length === 1 && this.zoomedSession === null ? visible[0] : null;
    for (const t of this.tiles.values()) {
      const solo = t === alone;
      t.el.classList.toggle("solo", solo);
      t.tools.setZoomed(solo || t.el.classList.contains("zoomed"));
    }
  }

  private renderEmpty() {
    this.markStage();
    const visible = [...this.tiles.values()]
      .some((t) => !t.el.classList.contains("ws-hidden"));
    if (visible) {
      this.emptyEl?.remove();
      this.emptyEl = null;
      return;
    }
    const all = this.workspaces();
    const active = this.activeWorkspaceId === null
      ? null
      : all.find((w) => w.id === this.activeWorkspaceId)?.name ?? null;
    const copy = emptyDeckCopy(active, all.length > 0);

    const box = document.createElement("div");
    box.className = "deck-empty";
    const mark = document.createElement("span");
    mark.className = "deck-empty-mark";
    mark.append(icon(copy.mark, 24));
    const h = document.createElement("h2");
    h.className = "deck-empty-title";
    h.textContent = copy.title;
    const p = document.createElement("p");
    p.textContent = copy.body;
    box.append(mark, h, p);

    if (this.emptyActions) {
      const go = document.createElement("button");
      go.className = "deck-empty-go";
      go.textContent = copy.action;
      go.onclick = active === null
        ? () => this.emptyActions!.addWorkspace()
        : () => this.emptyActions!.newSession();
      box.append(go);

      // Scenarios are the fastest start there is — a session with its prompt already
      // written — and on an empty deck the sidebar is the only place they appear. Quiet,
      // because this screen has one primary and it is the button above.
      const scenarios = active === null ? [] : this.emptyActions.scenarios();
      if (scenarios.length > 0) {
        const alt = document.createElement("div");
        alt.className = "deck-empty-alt";
        const caption = document.createElement("span");
        caption.className = "deck-empty-caption";
        caption.textContent = "or start from a scenario";
        const row = document.createElement("div");
        row.className = "deck-empty-alt-row";
        for (const s of scenarios.slice(0, 4)) {
          const b = document.createElement("button");
          b.className = "deck-empty-scenario";
          b.textContent = s.name;
          b.onclick = () => this.emptyActions!.runScenario(s);
          row.append(b);
        }
        alt.append(caption, row);
        box.append(alt);
      }
    }

    this.emptyEl?.remove();
    this.emptyEl = box;
    this.deckEl.appendChild(box);
  }

  private startPolling() {
    if (this.pollTimer !== null) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), 5000);
  }
  private stopPolling() {
    if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private async pollOnce() {
    try {
      const tiles = [...this.tiles.values()];
      if (tiles.length === 0) { this.stopPolling(); return; }
      // git: one call per unique cwd; errors are isolated — a single failed IPC must not bring down the whole tick
      const cwds = uniqueCwds(tiles.map((t) => ({ cwd: t.workspacePath })));
      const gitByCwd = new Map<string, { branch: string | null; dirty: boolean }>();
      await Promise.all(cwds.map(async (cwd) => {
        try {
          gitByCwd.set(cwd, await gitStatus(cwd));
        } catch (e) {
          console.debug("gitStatus failed", cwd, e);
        }
      }));
      for (const t of tiles) {
        if (!this.tiles.has(t.session)) continue;
        const g = gitByCwd.get(t.workspacePath);
        t.branch = g?.branch ?? null;
        if (g && g.branch) {
          t.gitBadge.replaceChildren(
            icon("git-branch", 12),
            document.createTextNode(` ${g.branch}${g.dirty ? " •" : ""}`),
          );
          t.gitBadge.classList.remove("hidden");
        } else {
          t.gitBadge.classList.add("hidden");
        }
      }
      // snapshots: one call for every session; errors isolated, plus a guard
      // against racing with tile removal.
      //
      // Every open session is asked for, including command tiles and ones a card
      // or a scenario already named: the same batch carries their token counts,
      // computing a title off a buffer already in hand costs about nothing, and
      // which name to show is a decision the resolver makes rather than a shape
      // the IPC should encode. A tile carrying a hand-typed name is polled too,
      // so clearing that name falls back to a title already in hand instead of
      // going blank for a tick.
      //
      // Nothing here writes `sessions.json`: the automatic title is not
      // persisted, so "do not save the layout every five seconds" is not a
      // problem that needs a dirty check — it does not arise.
      try {
        const snaps = await sessionSnapshots(tiles.map((t) => t.session));
        for (const t of tiles) {
          if (!this.tiles.has(t.session)) continue;
          const snap = snaps[t.session];
          if (!snap) continue;
          const u = snap.tokens;
          // No reading available — the transcript is gone or would not open.
          // Hide the badge rather than render a zero, which reads as an idle
          // session and is indistinguishable from a real one. The name is left
          // alone either way; the two halves of a snapshot fail separately.
          if (!u) {
            this.usage.delete(t.session);
            t.tokenBadge.classList.add("hidden");
          } else {
            this.usage.set(t.session, u);
            t.tokenBadge.textContent = formatContext(u.context);
            t.tokenBadge.title = tokenTooltip(u);
            t.tokenBadge.classList.remove("hidden");
          }
          // The count rides this batch rather than a second command: the poll
          // has already read and parsed every line of this transcript, and
          // walking the content blocks it parsed is cheap beside that parse.
          // The BREAKDOWN does not ride it — that is `session_activity`, called
          // only while a panel is open.
          setActivityCount(t.activityBtn, snap.calls);
          // A missing title never clears the slot. Measured over 96 transcripts a
          // title is minted once and never revised, so a null here is either "not
          // yet" or "this read did not see it" — and blanking a name on the
          // second would be a visible flicker for no information gained.
          if (snap.title) {
            t.names.auto = snap.title;
            this.applyName(t);
          }
        }
      } catch (e) {
        console.debug("sessionSnapshots failed", e);
      }
      // Only the panels that are open, and one read each. A deck of twelve with
      // no panel open makes no activity call at all, which is the point.
      for (const t of tiles) {
        if (!this.tiles.has(t.session)) continue;
        void t.activityPanel?.refresh();
      }
      this.renderList();
    } catch (e) {
      console.debug("pollOnce failed", e);
    }
  }

  wireNotificationFocus() {
    return wireNotificationFocus(this.notify, (s) => this.focusTile(s));
  }

  /** Whether an OS notification would actually be delivered.
   *
   *  Exposed because the limits block raises one too (#305) and the permission is
   *  asked for exactly once, here, in `wireEvents`. A second module calling
   *  `requestPermission` would be a second prompt for one answer. */
  canNotify(): boolean {
    return this.notifyOk;
  }

  async wireEvents() {
    this.notifyOk = await isPermissionGranted();
    if (!this.notifyOk) this.notifyOk = (await requestPermission()) === "granted";
    // No output listener here any more. Each `TerminalPanel` owns a `Channel` that
    // the backend writes its own session's bytes into, so there is nothing to
    // demultiplex — and nothing that walks the tile map once per chunk of output.
    await onState((s, state) => this.setState(s, state));
    // The tile is kept for its scrollback and its state chip is already set —
    // what is added here is the one thing the chip cannot say. "Ended" covers a
    // clean exit, a build that failed, and a process the app hung up on its way
    // out, and a person looking at a dead tile deserves to know which. Nothing
    // is written for an ordinary success: that needs no epitaph.
    await onExit((s, exit) => {
      const said = describeExit(exit);
      if (said) this.tiles.get(s)?.panel.write(`\r\n[${said}]\r\n`);
    });
  }

  /** A scenario, or a bare session when `skill` is null.
   *
   *  `params` is the values the prompt's placeholders were filled with, and it
   *  is passed on rather than discarded: the run journal records what a run was
   *  launched with, so it can later be offered again with those values in front
   *  of the person instead of silently reused. */
  async launch(workspace: Workspace, skill: Skill | null, params: Record<string, string> = {}) {
    const titleText = skill ? `${skill.icon} ${skill.name}` : `session · ${workspace.name}`;
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText,
      // A session launched without a scenario is the one tile nothing named, so
      // it is the one a transcript title may take over.
      nameKind: skill ? "context" : "placeholder",
      prompt: skill ? skill.prompt : null,
      resume: false,
      ...(skill ? { skillId: skill.id, trigger: "manual" as const, params } : {}),
    });
  }

  /** The badge is drawn ONLY when something is wrong: the account did not
   *  connect, or the environment went stale when the binding changed. In the
   *  ordinary case a tile head carries nothing here. */
  private renderAuthBadge(tile: Tile) {
    const { authBadge: b } = tile;
    if (tile.authStale) {
      b.textContent = "GitHub ⟳";
      b.title = "The workspace binding changed — the environment follows when the session restarts";
      b.className = "tile-auth stale";
      return;
    }
    if (tile.auth?.degraded) {
      b.textContent = "GitHub ✕";
      b.title = `Account ${tile.auth.account ?? "?"} did not connect: ${tile.auth.degraded}`;
      b.className = "tile-auth";
      return;
    }
    b.textContent = "";
    b.className = "tile-auth hidden";
  }

  /** Привязка воркспейса изменилась: у живых сессий окружение уже зафиксировано
   *  при fork, поменять его нельзя — честно помечаем как устаревшее. */
  markAuthStale(workspaceId: string) {
    for (const t of this.tiles.values()) {
      if (t.workspaceId !== workspaceId || t.kind === "command") continue;
      t.authStale = true;
      this.renderAuthBadge(t);
    }
  }

  /** Открывает тайл с разовой пользовательской командой (установка gh,
   *  `gh auth login`). Такой тайл не сохраняется в layout: восстановление
   *  молча перезапустило бы sudo-команду на следующем старте приложения. */
  async openCommandTile(titleText: string, command: string, cwd: string) {
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd,
      titleText,
      prompt: null,
      resume: false,
      kind: "command",
      command,
    });
  }

  /** Fire a scheduled scenario as a fresh tile. Returns false (and does not
   *  launch) if this scenario's previous scheduled session is still active.
   *
   *  A scheduled scenario keeps at most one tile: once the guard lets a new
   *  run through, the previous one is finished by definition, and leaving it
   *  behind would add a tile per run — 24 a day for an hourly schedule. */
  async launchScheduled(
    workspace: Workspace,
    skill: Skill,
    filledPrompt: string,
    /** Which of the two paths this fire came down: the backend scheduler, or
     *  the ⏰ button. Both are recorded — the question a history answers is
     *  "when did this scenario last run", not "who pressed it" — and both are
     *  told apart, so the screen can filter one out. */
    trigger: Extract<RunTrigger, "schedule" | "runNow">,
    /** Occurrence this run is making up for, when it is not running on time.
     *  Without it a tile appearing at 14:20 for a 09:00 schedule reads as a
     *  fault rather than as catch-up. */
    catchUpFor?: string,
  ): Promise<boolean> {
    const prevSession = this.scheduledSessions.get(skill.id);
    const prevState = prevSession ? (this.tiles.get(prevSession)?.state ?? null) : null;
    if (shouldSkipOverlap(prevState)) {
      console.info("scheduled run skipped: previous still active", skill.id);
      return false;
    }
    if (prevSession && this.tiles.has(prevSession)) this.remove(prevSession);
    const session = crypto.randomUUID();
    this.scheduledSessions.set(skill.id, session);
    await this.spawnTile({
      session,
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText: catchUpFor
        ? `${skill.icon} ${skill.name} · catching up ${catchUpFor}`
        : `${skill.icon} ${skill.name}`,
      scheduled: true,
      prompt: filledPrompt,
      resume: false,
      scheduledSkillId: skill.id,
      skillId: skill.id,
      trigger,
      params: skill.schedule?.defaults ?? {},
      grabAttention: false,
    });
    return true;
  }

  /** Launch a session from a tracker card. If the card already has a live
   *  session, focus it rather than raise a second one — the same call a
   *  scheduled scenario makes when it skips an overlapping run. */
  async launchFromTask(
    workspace: Workspace, task: Task, cfg: BoardConfig,
  ): Promise<"launched" | "focused"> {
    if (this.focusTaskSession(task.id, workspace.id)) return "focused";
    // ▶ writes the step itself, so the card moves whether or not the agent
    // remembers to. A failure must not block the launch: the work matters more
    // than the bookkeeping, and the board's stale marker will show the mismatch.
    let current = task;
    const step = workingStep(cfg);
    if (step !== null && task.status !== step) {
      // The prompt is built from `current` below, so it must reflect what the
      // move actually did, not what it was meant to do: on a failed write
      // `current` stays the unmoved card, which is the true state the session
      // is starting from. Predicting the destination here would tell the
      // agent a step it never reached whenever the write fails.
      current = await updateTask(workspace.id, task.id, { status: step }).catch((e) => {
        console.warn("could not move the card to the working step:", e);
        return task;
      });
    }
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText: `☑ ${task.title}`,
      prompt: taskPrompt(current, cfg),
      resume: false,
      taskId: task.id,
    });
    return "launched";
  }

  /** A session for a pull request, in the worktree prepared for it.
   *
   *  `cwd` is deliberately not the workspace path: the worktree keeps the
   *  branch out of the workspace's own working copy, where other sessions are
   *  running. `workspaceId` still points at the workspace, so the tile groups,
   *  filters and inherits its account exactly like any other. */
  async launchOnWorktree(
    cwd: string, workspaceId: string, titleText: string, prompt: string,
    /** Set for an issue, absent for a pull request. An issue session is both in a
     *  worktree and linked to a card: without the link `derivedStatus` cannot
     *  show "in progress" and a second ▶ would raise a duplicate session rather
     *  than focus the first. */
    taskId?: string,
  ): Promise<"launched" | "focused"> {
    // The same guard `launchFromTask` applies, and only where there is a card to
    // apply it to. It is not redundant with the board hiding ▶: `derivedStatus`
    // reads "in progress" only while the session is *busy*, so an idle session
    // still linked to the issue leaves ▶ on screen — which is precisely the case
    // that would otherwise put a second session in the same worktree.
    //
    // Asked of this workspace's links only. An issue number belongs to one
    // repository, so a session on another workspace's #42 is a different piece of
    // work; focusing it would hand the person a terminal in the wrong repository
    // and leave the worktree just prepared here with nothing running in it.
    //
    // Still asked here even though the board now asks it before preparing the
    // worktree: this is the last line before a second agent lands in the same
    // directory, and it also covers callers that never went through the board.
    if (taskId !== undefined && this.focusTaskSession(taskId, workspaceId)) return "focused";
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd,
      workspaceId,
      titleText,
      prompt,
      resume: false,
      taskId,
    });
    return "launched";
  }

  /** Whether any live tile is running inside `path`. Removal of a worktree
   *  asks first: a session whose directory disappears comes back on the next
   *  restore pointing at nothing. */
  hasSessionIn(path: string): boolean {
    return [...this.tiles.values()].some((t) => t.workspacePath === path);
  }

  /** What a session is called on its tile, for anything outside the deck that
   *  has to name one to a person — the quit question, in particular. Falls back
   *  to the id, which is at least something to go on for a session the deck no
   *  longer holds. */
  nameOf(session: string): string {
    const t = this.tiles.get(session);
    return t ? resolveTileName(t.names) : session;
  }

  setActiveWorkspace(id: string | null) {
    this.zoomedSession = null;
    this.activeWorkspaceId = id;
    // Resolve this workspace's account binding now, while nobody is waiting for
    // it. Entering a workspace is the last moment before a launch that is not
    // itself a launch, so the `gh` call and the `claude` discovery happen here
    // — off the main thread, and cached — instead of freezing the window at the
    // moment a session is asked for. Fire-and-forget: a launch that arrives
    // before this lands still resolves it the slow way.
    if (id) void prepareWorkspace(id).catch((e) => console.debug("prepareWorkspace failed", e));
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    let firstVisible: string | null = null;
    for (const t of this.tiles.values()) {
      const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, ws);
      // An orphan stays reachable, in the window that owns orphans. See
      // `adoptsOrphans`.
      const visible = (rid === null && this.adoptsOrphans) || rid === id;
      t.el.classList.toggle("ws-hidden", !visible);
      if (visible) {
        t.panel.fit();
        if (firstVisible === null) firstVisible = t.session;
      }
    }
    this.applyLayout();
    const active = this.activeSession;
    const activeHidden = !active || !!this.tiles.get(active)?.el.classList.contains("ws-hidden");
    if (activeHidden && firstVisible) this.focusTile(firstVisible); // focusTile calls renderList
    else this.renderList();
  }

  private async spawnTile(opts: {
    session: string; cwd: string; workspaceId?: string; titleText: string; prompt: string | null; resume: boolean;
    /** What `titleText` is. A context name stands for the life of the tile; the
     *  generic placeholder is the one string a transcript title may replace.
     *  Absent means context — the safer of the two, since it leaves a name the
     *  person recognises alone. */
    nameKind?: NameKind;
    /** A hand-typed name restored from the layout. */
    userName?: string | null;
    scheduledSkillId?: string;
    /** Tracker card this tile is working on. */
    taskId?: string;
    /** Scenario this launch came from, and how it started. Present together or
     *  not at all: a trigger without a scenario names nothing, and a scenario
     *  without a trigger cannot be recorded. */
    skillId?: string;
    trigger?: RunTrigger;
    params?: Record<string, string>;
    /** The record a `resume` continues. Read out of the restored layout entry;
     *  a ⟳ inside a live app does not need it, since the backend still has the
     *  predecessor open under the same session id. */
    continuesRunId?: string | null;
    /** Marks the tile as started by a schedule. Shown as its own icon rather
     *  than glued to the title, which gets clipped by text-overflow. */
    scheduled?: boolean;
    /** Whether the new tile should take over the keyboard and the layout.
     *  False for unattended work: a scheduled run announces itself through a
     *  notification, not by yanking the caret out of whatever is being typed. */
    grabAttention?: boolean;
    /** "command" — разовый запуск `command` вместо сессии claude. */
    kind?: TileKind;
    /** Take over a session that is already running instead of starting one, and
     *  put this scrollback back on screen first.
     *
     *  The third path `TerminalPanel.attach` describes. Set only by `receive`,
     *  when a workspace arrives from another window. */
    attach?: { scrollback: string };
    command?: string;
    /** Which agent CLI this tile runs. Absent is `claude` — every launch path,
     *  and every entry restored from a layout written before the field. */
    cliKind?: CliKind;
  }) {
    const { session, cwd, workspaceId, titleText, prompt, resume } = opts;
    const grabAttention = opts.grabAttention ?? true;
    const isCommand = opts.kind === "command";
    const el = document.createElement("div");
    el.className = "tile";
    // The state rail's carrier. A data attribute rather than a class for the reason
    // the session row documents: `.state-*` already means "a chip with this fill",
    // and one of those names on the tile would paint a chip across the whole thing.
    el.dataset.state = "idle";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    // A class, because the selector this used to rely on could not work. The rule was
    // `.tile-head span:first-child`, and `head.insertBefore(bcastCheck, title)` below
    // puts an `<input>` in front of the title on every tile — so the title is never
    // `:first-child` and never got the `flex: 1` or the ellipsis that rule grants. A
    // long session name pushed the badges out of the head instead of truncating.
    title.className = "tile-name";
    // The text and the tooltip are written together by `applyName`, and only by
    // `applyName` — the tooltip is for the sighted reader of a truncated name and
    // the accessible name comes from the text itself, so the two must never
    // drift. One writer is what keeps that true now that a name can change.
    const schedMark = opts.scheduled ? icon("clock", 12) : null;
    if (schedMark) {
      schedMark.classList.add("tile-sched-mark");
      schedMark.setAttribute("aria-hidden", "false");
      schedMark.setAttribute("role", "img");
      schedMark.setAttribute("aria-label", "started on a schedule");
    }
    const gitBadge = document.createElement("span");
    gitBadge.className = "tile-git hidden";
    const tokenBadge = document.createElement("span");
    tokenBadge.className = "tile-tokens hidden";
    // The badge already sits there and is already about this session's
    // measurements, and its tooltip is currently the only home for the spend and
    // the subagent count — a tooltip is where information goes to be missed. One
    // surface, reached from either.
    tokenBadge.setAttribute("role", "button");
    tokenBadge.tabIndex = 0;
    tokenBadge.onclick = () => this.openActivity(session);
    tokenBadge.onkeydown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      this.openActivity(session);
    };
    const activityBtn = activityButton();
    activityBtn.onclick = () => this.openActivity(session);
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
    // The pencil leads the action cluster because it is the least destructive of
    // the four, and it sits after the state chip so the flexible name keeps one
    // contiguous run of width. It is always in the DOM — so it is in the tab
    // order and reachable by touch — and the stylesheet is what hides it until
    // the tile is hovered, active or holds focus.
    const renameBtn = iconButton("pencil", "Rename session", "tile-close tile-rename");
    renameBtn.onclick = () => this.beginRename(session);
    const clearBtn = iconButton("eraser", "Clear terminal", "tile-close");
    clearBtn.onclick = () => tile.panel.clear();
    const close = iconButton("x", "Close session", "tile-close btn--icon--danger");
    // Same question Cmd+W asks. Without it the mouse was the more dangerous
    // of the two ways to do the same thing: one stray click killed a live
    // session outright, while the keyboard asked first.
    close.onclick = () => { void this.requestClose(session); };
    const authBadge = document.createElement("span");
    authBadge.className = "tile-auth hidden";
    head.append(
      ...(schedMark ? [schedMark] : []),
      title, gitBadge, authBadge, tokenBadge, label, activityBtn, renameBtn, clearBtn, close,
    );
    const bcastCheck = document.createElement("input");
    bcastCheck.type = "checkbox"; bcastCheck.className = "bcast-check";
    bcastCheck.classList.toggle("hidden", !this.broadcasting);
    head.insertBefore(bcastCheck, title);
    const restart = iconButton("rotate", "Restart session", "tile-close");
    restart.style.display = "none";
    restart.onclick = async () => {
      restart.style.display = "none";
      tile.panel.write("\r\n[restarting session...]\r\n");
      try {
        // A new record rather than a reopened one: a run is one launched PTY,
        // and a record spanning a restart could never say which side of it a
        // result came from. The chain comes from `scenarioLaunch` reading the
        // tile's outgoing `runId`: by the time this button is on screen the
        // session has ended, and the backend has already closed that record.
        //
        // The one launch that means to replace a live process: the backend
        // refuses a spawn into an id it is already running, and this button is
        // the only place that refusal is not what the caller wants. A tile whose
        // process merely ended still holds its pty entry — the orphans of a
        // build it started are reachable no other way — so the replacement is
        // explicit even here.
        tile.auth = await tile.panel.start(
          tile.workspacePath, tile.workspaceId ?? null, null, tile.taskId ?? null, true,
          scenarioLaunch(tile, "resume", null), true,
        );
        tile.authStale = false;
        this.renderAuthBadge(tile);
        this.setState(session, "idle");
        void this.persistLayout();
      } catch (e) {
        this.setState(session, "error");
        const raw = String((e as { message?: string })?.message ?? e);
        const readable = raw.includes("claude-not-found")
          ? "claude not found — set its path and restart"
          : raw;
        tile.panel.write(`\r\n[launch failed: ${readable}]\r\n`);
        restart.style.display = "inline";
      }
    };
    head.insertBefore(restart, close);
    head.addEventListener("dblclick", (e) => {
      // Buttons and anything editable. Double-clicking a word inside a header
      // input is how a person selects it, and zooming the tile instead is a
      // defect the broadcast checkbox already suffered from.
      const t = e.target as HTMLElement;
      if (t.closest("button, input, textarea, [contenteditable]")) return;
      this.toggleZoom(session);
    });
    const mount = document.createElement("div");
    mount.className = "tile-body";
    const searchBar = document.createElement("div");
    searchBar.className = "tile-search hidden";
    const sInput = document.createElement("input"); sInput.className = "tile-search-input"; sInput.placeholder = "search…";
    const sNext = iconButton("chevron", "Next match", "tile-search-btn icon--down");
    const sPrev = iconButton("chevron", "Previous match", "tile-search-btn icon--up");
    const sClose = iconButton("x", "Close search", "tile-search-btn");
    searchBar.append(sInput, sPrev, sNext, sClose);
    sInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); tile.panel.search(sInput.value); }
      else if (e.key === "Escape") { e.preventDefault(); searchBar.classList.add("hidden"); tile.panel.focus(); }
    });
    sNext.onclick = () => tile.panel.search(sInput.value);
    sPrev.onclick = () => tile.panel.searchPrev(sInput.value);
    sClose.onclick = () => { searchBar.classList.add("hidden"); tile.panel.focus(); };
    /* The tile's work area is a ROW: the terminal, then the tools that belong to
       this session, then the strip that opens them. The strip is on the right, the
       opposite edge from the app's panel, and that distance is doing real work — it
       is what stops "Files" in here being read as the project's files rather than
       this checkout's. Both are `display: none` until the tile is zoomed. */
    const work = document.createElement("div");
    work.className = "tile-work";
    const tools = new TileTools({
      cwd,
      cols: () => tile.panel.cols,
      termWidth: () => mount.getBoundingClientRect().width,
      source: () => this.sourceOfTile(tile),
      onWidth: (px) => this.onToolWidth?.(px),
    });
    work.append(mount, tools.panel, tools.rail);
    el.append(head, searchBar, work);
    this.deckEl.appendChild(el);
    el.addEventListener("mousedown", () => this.focusTile(session));

    // A panel taking over a live session is born without resize authority: it
    // must not tell the PTY its geometry before it owns the session.
    const panel = new TerminalPanel(session, mount, isCommand, opts.attach !== undefined);
    const names: TileNames = {
      // The placeholder slot always holds the launch string. On a context-named
      // tile it is the same string as `context`, which the resolver never reaches
      // — there is no way for the two to disagree.
      context: opts.nameKind === "placeholder" ? null : titleText,
      placeholder: titleText,
      auto: null,
      user: opts.userName ?? null,
    };
    const tile: Tile = {
      session, names, nameEl: title, renameInput: null, panel, state: "idle", el, label, tools,
      workspacePath: cwd, workspaceId, prompt, restartBtn: restart, searchBar, bcastCheck,
      gitBadge, authBadge, tokenBadge, activityBtn, activityPanel: null,
      branch: null, scheduledSkillId: opts.scheduledSkillId,
      kind: opts.kind, taskId: opts.taskId,
      skillId: opts.skillId, params: opts.params,
      // A command tile runs a shell command, not an agent, so it names no CLI
      // at all — which is a different thing from naming the default one, and
      // the panel says so in its own sentence.
      cliKind: isCommand ? undefined : opts.cliKind ?? "claude",
    };
    this.applyName(tile);
    this.tiles.set(session, tile);
    // The first tile ends the empty deck. `applyLayout` is only reached from here when a
    // zoom has to be dropped, so this cannot wait for it — the panel would sit under the
    // new terminal until something else moved the layout.
    this.renderEmpty();
    if (grabAttention && !resume && this.zoomedSession !== null) { this.zoomedSession = null; this.applyLayout(); }
    this.startPolling();
    this.renderList();
    try {
      if (opts.attach) {
        // The order is the design, and it is why this is not a branch of the
        // launch path. Listeners and the claim first, so nothing arrives at a
        // panel that is not reading; then the history, into a grid that has
        // finished settling; then authority, which sends one resize and makes
        // the process redraw. See `TerminalPanel.attach`, `replay`, `activate`.
        await panel.attach();
        panel.replay(opts.attach.scrollback);
        panel.activate();
        void this.persistLayout();
      } else if (isCommand) {
        await panel.startCommand(cwd, opts.command ?? "");
        // Командный тайл в layout не попадает — persistLayout не зовём.
      } else {
        tile.auth = await panel.start(
          cwd, workspaceId ?? null, prompt, opts.taskId ?? null, resume,
          scenarioLaunch(tile, opts.trigger, opts.continuesRunId ?? null),
        );
        this.renderAuthBadge(tile);
        void this.persistLayout();
      }
    } catch (e) {
      this.setState(session, "error");
      const raw = String((e as { message?: string })?.message ?? e);
      const readable = raw.includes("claude-not-found")
        ? "claude not found — set its path and restart"
        : raw;
      panel.write(`\r\n[launch failed: ${readable}]\r\n`);
    }
    if (grabAttention) this.focusTile(session);
    else {
      // Still needs to obey the workspace filter, which focusTile would have
      // triggered via renderList/applyLayout.
      this.applyWorkspaceVisibility(session);
      this.renderList();
    }
  }

  /** The only writer of a tile's name into the DOM — text and tooltip together.
   *
   *  Called wherever a slot changes, rather than by each of them, so a tile, its
   *  tooltip, its sidebar row, the notification body and `sessions.json` cannot
   *  come to show four different names. */
  private applyName(tile: Tile) {
    // The input's value belongs to the person typing into it. The slots keep
    // being filled while an edit is open — the tick still writes `names.auto` —
    // and this repaints once the edit closes.
    if (tile.renameInput) return;
    const name = resolveTileName(tile.names);
    tile.nameEl.textContent = name;
    tile.nameEl.title = name;
  }

  /** Open the activity panel for one session.
   *
   *  One panel per tile: pressing the button again while it is open closes it,
   *  the way a toggle should, rather than stacking a second read of the same log
   *  behind the first.
   *
   *  The reads start here and stop when the panel closes. That is the whole cost
   *  argument: the log is the source of truth precisely because it is
   *  retrospective, and the price of that is a file read — the heaviest
   *  transcript measured is 3.1 MB — which must not be on the five-second poll
   *  for twelve tiles nobody is looking at. */
  openActivity(session: string) {
    const t = this.tiles.get(session);
    if (!t) return;
    if (t.activityPanel) {
      t.activityPanel.close();
      t.activityPanel = null;
      return;
    }
    // A command tile is not an agent session and never will have a log. The
    // frontend is where a tile's kind is known, so the sentence is decided here
    // rather than by asking the backend to look for a transcript that cannot
    // exist.
    const isCommand = t.kind === "command";
    const panel = openActivityPanel({
      session,
      name: resolveTileName(t.names),
      initial: localRoll(isCommand ? "notAnAgent" : "noLog"),
      tokens: () => this.usage.get(session) ?? null,
      read: isCommand
        ? undefined
        : async () => {
            const rolls = await sessionActivity([session]);
            return rolls[session] ?? null;
          },
    });
    // The close comes from four places — the button, Escape, the backdrop and
    // this method — and all four have to clear the slot, or the tick keeps
    // reading a log for a panel that is gone.
    const clear = panel.close;
    panel.close = () => {
      clear();
      if (this.tiles.get(session)?.activityPanel === panel) {
        const tile = this.tiles.get(session);
        if (tile) tile.activityPanel = null;
      }
    };
    t.activityPanel = panel;
  }

  /** Turn the header's name into an input, in place.
   *
   *  The editor lives in the tile header and nowhere else: `renderList()` rebuilds
   *  the sidebar from `innerHTML` every five seconds and restores only
   *  `data-focus-key`, so an input there would lose its value and its caret twice
   *  a minute. */
  private beginRename(session: string) {
    const tile = this.tiles.get(session);
    if (!tile || tile.renameInput) return;
    // One edit at a time, app-wide.
    for (const other of this.tiles.values()) this.commitRename(other);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tile-name-input";
    // Felt while typing rather than sprung afterwards. The commit normalises
    // anyway, for the paths this cannot cover — a paste, or an IME.
    input.maxLength = NAME_CAP;
    // No `title`: the tooltip on the span is for a name too long to read, and on
    // an input it would sit over what the person is typing.
    input.setAttribute("aria-label", "Session name");
    input.value = resolveTileName(tile.names);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commitRename(tile);
        tile.panel.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Or it also reaches the window handler and leaves the zoom.
        e.stopPropagation();
        this.cancelRename(tile);
        tile.panel.focus();
      }
    });
    // Committing on blur, not discarding: throwing away someone's typing because
    // they clicked a terminal is the hostile reading of the same gesture.
    input.addEventListener("blur", () => this.commitRename(tile));
    tile.renameInput = input;
    tile.nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  /** Take what is in the editor, or nothing if it says the same as the automatic
   *  name — clearing the field is the whole undo story, and there is nothing to
   *  report about any of it, so no path here produces an error. */
  private commitRename(tile: Tile) {
    const input = tile.renameInput;
    if (!input) return;
    const typed = normaliseName(input.value);
    const automatic = resolveTileName({ ...tile.names, user: null });
    tile.names.user = typed === "" || typed === automatic ? null : typed;
    this.closeRename(tile, input);
    void this.persistLayout();
  }

  private cancelRename(tile: Tile) {
    const input = tile.renameInput;
    if (!input) return;
    this.closeRename(tile, input);
  }

  /** Put the span back and repaint it. Clearing `renameInput` first is what makes
   *  the blur this removal fires a no-op instead of a second commit. */
  private closeRename(tile: Tile, input: HTMLInputElement) {
    tile.renameInput = null;
    input.replaceWith(tile.nameEl);
    this.applyName(tile);
    this.renderList();
  }

  /** Apply the active-workspace filter to one tile. Tiles used to be created
   *  without it, so a scheduled run for another workspace appeared in whatever
   *  deck was on screen and disappeared at the next switch. */
  private applyWorkspaceVisibility(session: string) {
    const t = this.tiles.get(session);
    if (!t) return;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, ws);
    // Orphans belong to the window that adopts them, as in setActiveWorkspace.
    const visible = (rid === null && this.adoptsOrphans) || rid === this.activeWorkspaceId;
    t.el.classList.toggle("ws-hidden", !visible);
    this.applyLayout();
  }

  async restore(entries: SessionEntry[]) {
    this.restoring = true;
    try {
      for (const e of entries) {
        if (e.scheduledSkillId) this.scheduledSessions.set(e.scheduledSkillId, e.sessionId);
        await this.spawnTile({
          session: e.sessionId, cwd: e.cwd, workspaceId: e.workspaceId,
          titleText: e.name, nameKind: e.nameKind ?? "context", userName: e.userName ?? null,
          prompt: null, resume: true,
          scheduledSkillId: e.scheduledSkillId, taskId: e.taskId,
          // A layout entry with no `cliKind`, or with one this build has never
          // heard of, restores as `claude` and the tile behaves exactly as
          // before. An unrecognised CLI is a session the deck can still show,
          // which is why the field is a string on the way to disk and never an
          // enum that could fail the parse and drop the tile.
          cliKind: e.cliKind ?? "claude",
          // Only a tile that was itself launched from a scenario gets a record.
          // A restored card session or bare "+ session" stays out of the
          // journal, which answers "what did my scenarios do" and nothing wider.
          ...(e.skillId
            ? { skillId: e.skillId, trigger: "resume" as const, continuesRunId: e.runId ?? null }
            : {}),
        });
      }
    } finally {
      this.restoring = false;
    }
    void this.persistLayout();
  }

  /** Focus the session already running on this card, if there is one.
   *
   *  The guard `launchFromTask` and `launchOnWorktree` apply, exposed because the
   *  board's issue path has to ask it *before* preparing a worktree: the check is
   *  worthless behind a fallible IPC call, which is precisely the position it used
   *  to be in. One implementation, so the three callers cannot come to disagree
   *  about what "already running" means. */
  focusTaskSession(taskId: string, workspaceId: string): boolean {
    const alive = liveSessionForTask(taskId, this.taskLinks(workspaceId));
    if (alive === null) return false;
    this.focusTile(alive);
    return true;
  }

  /** Live tiles in the shape the board needs, for one workspace.
   *
   *  The workspace is a required argument, not a filter a caller may forget: a
   *  card id is unique only inside its own tracker (a GitHub issue number is the
   *  first id two repositories can share), and every rule reading these links
   *  matches on the id alone. Handing out the whole app's tiles is what let a
   *  session on A's #42 speak for B's #42 — see `linksInWorkspace`. */
  taskLinks(workspaceId: string): TaskSessionLink[] {
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    return linksInWorkspace(
      [...this.tiles.values()].map((t) => ({
        session: t.session,
        taskId: t.taskId,
        // The tile's own id wins, and is never discarded merely because the
        // workspace list has not loaded yet — that would silently stop the launch
        // guard matching. Only a tile without one (an older layout entry) falls
        // back to being placed by its directory, exactly as the sidebar places it.
        workspaceId: t.workspaceId ?? resolveWorkspaceId(undefined, t.workspacePath, ws) ?? undefined,
        state: t.state,
      })),
      workspaceId,
    );
  }

  get activeSession(): string | null {
    for (const [id, t] of this.tiles) if (t.el.classList.contains("is-active")) return id;
    return null;
  }
  focusByIndex(n: number) {
    const ids = [...this.tiles.values()]
      .filter((t) => !t.el.classList.contains("ws-hidden"))
      .map((t) => t.session);
    const id = ids[n - 1];
    if (id) this.focusTile(id);
  }
  focusNextWaiting() {
    const tiles = [...this.tiles.values()];
    const target = nextWaitingAcross(
      tiles.map((t) => ({ session: t.session, workspaceId: t.workspaceId, state: t.state })),
      this.activeSession,
    );
    if (target) this.focusSessionAnywhere(target.session);
  }
  async closeActive() {
    const id = this.activeSession;
    if (id) await this.requestClose(id);
  }

  /** Close a session, asking first when it is still alive. `ended`/`error`
   *  tiles hold nothing but scrollback, so those go without a question. */
  private async requestClose(session: string) {
    const t = this.tiles.get(session);
    const alive = t && (t.state === "working" || t.state === "waitingInput" || t.state === "done");
    if (alive && !(await confirmModal(
      `Close session “${resolveTileName(t.names)}”? It is still alive.`,
    ))) return;
    this.remove(session, await this.captureFor(session));
  }

  /** Whether this closing session gets a note, asking when it has to.
   *
   *  Only ever reached from a close a person asked for. The programmatic
   *  removals — a scheduled run replacing its predecessor, a workspace handed to
   *  another window — pass nothing, because neither is somebody deciding to end a
   *  session and neither is a moment to put a question in front of them.
   *
   *  Returns `null` for "close it and write nothing", which is what every close
   *  meant before #366. */
  private async captureFor(session: string): Promise<CaptureOnClose | null> {
    const t = this.tiles.get(session);
    if (!t || !t.workspaceId) return null;
    // A command tile is a one-shot, not a conversation.
    if (t.kind === "command") return null;

    const decision = decideCapture(this.captureAnswer);
    if (decision.action === "skip") return null;
    if (decision.action === "ask") {
      // Only here, on the one path that is about to open a dialog: asking the
      // backend whether a note is even possible costs a round trip, and it would
      // be spent on every close of somebody who has already answered.
      const offer = await memoryCaptureOffer(session, t.cliKind)
        .catch(() => ({ available: false, reason: undefined }));
      const worth = askWorthPutting(offer);
      if (worth.action === "skip") {
        if (worth.reason) console.debug("no note for this session:", worth.reason);
        return null;
      }
      const answer = await askCapture(resolveTileName(t.names));
      if (answer.remember) {
        this.captureAnswer = answer.capture;
        void saveUiState({ captureOnClose: answer.capture })
          .catch((e) => console.debug("remembering the note answer failed", e));
      }
      if (!answer.capture) return null;
    }
    return {
      workspaceId: t.workspaceId,
      cliKind: t.cliKind,
      sessionName: resolveTileName(t.names),
    };
  }

  /** Everything live that could still be summarised, for the quit path.
   *
   *  Read while this window is still rendering its tiles, which is the same
   *  reason `handOffPayload` is read here rather than in Rust. */
  captureOnQuit(): { session: string; capture: CaptureOnClose }[] {
    if (this.captureAnswer !== true) return [];
    return [...this.tiles.values()]
      .filter((t) => t.workspaceId && t.kind !== "command")
      .map((t) => ({
        session: t.session,
        capture: {
          workspaceId: t.workspaceId!,
          cliKind: t.cliKind,
          sessionName: resolveTileName(t.names),
        },
      }));
  }

  /** The remembered answer to the note question, or `undefined` for never asked. */
  setCaptureAnswer(answer: boolean | undefined) {
    this.captureAnswer = answer;
  }
  /** Open the editor on whichever tile has the keyboard, and do nothing when
   *  there is none — the same shape as `closeActive` and `searchActive`. */
  renameActive() {
    const id = this.activeSession;
    if (id) this.beginRename(id);
  }
  searchActive() {
    const id = this.activeSession;
    if (!id) return;
    const t = this.tiles.get(id)!;
    t.searchBar.classList.remove("hidden");
    (t.searchBar.querySelector(".tile-search-input") as HTMLInputElement).focus();
  }
  clearActive() {
    const id = this.activeSession;
    if (id) this.tiles.get(id)!.panel.clear();
  }

  toggleBroadcast() {
    this.broadcasting = !this.broadcasting;
    for (const t of this.tiles.values()) t.bcastCheck.classList.toggle("hidden", !this.broadcasting);
    // The deck makes room for the bar rather than letting it float over the bottom
    // tile's last rows — which is the output a person is about to type at. The
    // padding lives in the stylesheet; this only says when it applies.
    this.deckEl.classList.toggle("has-bcast", this.broadcasting);
    if (this.broadcasting) this.showBroadcastPanel();
    else this.hideBroadcastPanel();
  }

  private showBroadcastPanel() {
    if (!this.bcastPanel) {
      const panel = document.createElement("div");
      panel.className = "bcast-panel";
      const input = document.createElement("input");
      input.className = "bcast-input"; input.type = "text";
      input.placeholder = "broadcast: type into every ticked session, Enter to send";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const targets = selectedFromChecks(
            [...this.tiles.values()].map((t) => ({ session: t.session, checked: t.bcastCheck.checked })));
          broadcastInput(targets, input.value);
          input.value = "";
        } else if (e.key === "Escape") {
          e.preventDefault(); this.toggleBroadcast();
        }
      });
      panel.append(input);
      this.deckEl.appendChild(panel);
      this.bcastPanel = panel;
    }
    this.bcastPanel.classList.remove("hidden");
    (this.bcastPanel.querySelector(".bcast-input") as HTMLInputElement).focus();
  }

  private hideBroadcastPanel() {
    this.bcastPanel?.classList.add("hidden");
    for (const t of this.tiles.values()) t.bcastCheck.checked = false;
  }

  /** Go to a session wherever it is, switching workspace when it lives in
   *  another one — a tile the deck is not currently showing cannot take focus,
   *  and focusing it silently would look like the control did nothing.
   *
   *  Public because the history screen's "go to the session" needs exactly the
   *  path the pill and the notification already take. Returns false when there
   *  is no such tile: the caller decides whether that is worth saying. */
  focusSession(session: string): boolean {
    if (!this.tiles.has(session)) return false;
    this.focusSessionAnywhere(session);
    return true;
  }

  /** Sessions with a live tile, for callers deciding whether to offer a way to
   *  one. Command tiles included: they are tiles. */
  liveSessions(): string[] {
    return [...this.tiles.keys()];
  }

  private focusSessionAnywhere(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    const rid = resolveWorkspaceId(tile.workspaceId, tile.workspacePath, ws);
    if (rid !== null && rid !== this.activeWorkspaceId) {
      /* Through the tree rather than `setActiveWorkspace`, and that is the fix:
         this deck's filter was the only thing that moved, so going to a session in
         another workspace left the panel's tint, the crumb, the board and the pull
         requests pointing at the workspace you had just left. One notion of
         "active", owned by the thing that also persists it. */
      if (this.tree) this.tree.activate(rid);
      else this.setActiveWorkspace(rid);
    } else if (tile.el.classList.contains("ws-hidden")) {
      // Orphan (or otherwise stale-hidden) target: unhide so focus lands on a visible tile.
      tile.el.classList.remove("ws-hidden");
      tile.panel.fit();
    }
    this.focusTile(session);
  }

  private focusTile(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    // While zoomed, focusing a different visible tile juggles it into the main area.
    if (this.zoomedSession !== null && this.zoomedSession !== session
        && !tile.el.classList.contains("ws-hidden")) {
      this.zoomTo(session);
    }
    for (const t of this.tiles.values()) t.el.classList.toggle("is-active", t === tile);
    tile.el.scrollIntoView?.({ block: "nearest" });
    tile.panel.focus();
    this.renderList();
  }

  private setState(session: string, state: SessionState) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    const prev = tile.state;
    tile.state = state;
    tile.label.className = `tile-state state-${state}`;
    // Keeps the tile's rail in step with its chip. Two carriers, one source.
    tile.el.dataset.state = state;
    tile.label.textContent = LABEL[state];
    // У командного тайла перезапуск не предлагаем: он поднял бы claude, а не
    // повторил команду. Разовое действие повторяется из своего экрана.
    const restartable = tile.kind !== "command" && (state === "ended" || state === "error");
    tile.restartBtn.style.display = restartable ? "inline" : "none";
    this.renderList();
    if (state !== prev && NOTIFY_ON.includes(state) && this.notifyOk) {
      const id = this.notify.register(session);
      sendNotification({
        id, title: `cowork-deck · ${LABEL[state]}`, body: resolveTileName(tile.names),
      });
    }
  }

  /** What launched this session, in words that can be true of it. The scenario's
   *  NAME rather than its id where the app can resolve one: an id is not something
   *  a person recognises, and the deck can already reach the scenario list for the
   *  empty deck's sake. */
  private sourceOfTile(tile: Tile): { kind: string; detail: string | null; prompt: string | null } {
    if (tile.skillId) {
      const skill = this.emptyActions?.scenarios().find((x) => x.id === tile.skillId);
      return {
        kind: tile.scheduledSkillId ? "Scenario, on its schedule" : "Scenario",
        detail: skill?.name ?? null,
        prompt: tile.prompt,
      };
    }
    if (tile.taskId) return { kind: "Card", detail: tile.taskId, prompt: tile.prompt };
    if (tile.kind === "command") return { kind: "Command", detail: null, prompt: tile.prompt };
    return { kind: "Started by hand", detail: null, prompt: tile.prompt };
  }

  /** Lay the deck out, and give the keyboard back to whatever was holding it.
   *
   *  `appendChild` on a node already in the document is a *move* — remove, then
   *  insert — and removing a node unfocuses anything inside it. Every re-parent
   *  below is therefore a blur: the terminal somebody was typing into loses focus
   *  and `<body>` gets it, with nothing on screen saying so.
   *
   *  Zoom is where that was felt. The tile filled the deck, the caret still looked
   *  like it was in it, and the next keystroke went to the window handler instead
   *  of to the pty — which is how `Escape` came to unzoom the deck rather than
   *  reach `vim`, `less`, `htop` or claude's own "esc to interrupt" (#269). Not
   *  only zoom: a session launched while another one is being typed into re-parents
   *  every tile too, and took the keyboard with it just the same.
   *
   *  Restored only when this is what dropped it — focus back on `<body>`, and the
   *  element still in the document. A layout that hid the tile (a workspace switch)
   *  or removed it (a close) leaves focus alone, and the callers that move focus
   *  themselves run after this and still win. */
  private applyLayout() {
    const had = document.activeElement as HTMLElement | null;
    const keep = had && had !== document.body && this.deckEl.contains(had) ? had : null;
    this.layOutTiles();
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (keep && keep.isConnected && lost) keep.focus();
  }

  /** The layout itself: which tile is zoomed, which are in the strip, and what
   *  each one hangs from. Called only by `applyLayout`, which says why the two are
   *  separate. */
  private layOutTiles() {
    const parts = zoomParticipants(
      [...this.tiles.values()].map((t) => ({
        session: t.session, hidden: t.el.classList.contains("ws-hidden"),
      })),
      this.zoomedSession,
    );
    if (parts.zoomed === null) {
      // Grid mode: return every tile to #deck in Map order, drop the strip.
      this.zoomedSession = null;
      this.deckEl.classList.remove("is-zoomed");
      for (const t of this.tiles.values()) {
        t.el.classList.remove("minimized", "zoomed");
        this.deckEl.appendChild(t.el);
      }
      if (this.strip) { this.strip.remove(); this.strip = null; }
      this.onZoom?.(false);
      // Last, so the panel is appended after the tiles it replaces have been moved —
      // and here rather than in each caller, because this is the one function every
      // path that changes what the deck holds already goes through.
      this.renderEmpty();
      return;
    }
    // A zoomed session is a session, so the deck is not empty.
    this.emptyEl?.remove();
    this.emptyEl = null;
    this.deckEl.classList.add("is-zoomed");
    if (!this.strip) {
      this.strip = document.createElement("div");
      this.strip.className = "deck-strip";
    }
    this.onZoom?.(true);
    const z = this.tiles.get(parts.zoomed)!;
    z.el.classList.add("zoomed");
    z.el.classList.remove("minimized", "solo");
    z.tools.setZoomed(true);
    this.deckEl.appendChild(z.el);
    this.deckEl.appendChild(this.strip);
    for (const s of parts.minimized) {
      const t = this.tiles.get(s)!;
      t.el.classList.add("minimized");
      t.el.classList.remove("zoomed", "solo");
      t.tools.setZoomed(false);
      this.strip.appendChild(t.el);
    }
  }

  // FLIP: measure visible tiles (First), run the layout mutation (Last),
  // set the inverse transform, then animate it away. transform-only, so the
  // ResizeObserver (which fits terminals to the already-final layout box) is
  // not retriggered — no resize feedback loop.
  private animateLayoutChange(mutate: () => void) {
    const before = [...this.tiles.values()].filter((t) => !t.el.classList.contains("ws-hidden"));
    const first = new Map(before.map((t) => [t.session, t.el.getBoundingClientRect()]));
    mutate();
    const after = [...this.tiles.values()].filter((t) => !t.el.classList.contains("ws-hidden"));
    const animating: Tile[] = [];
    for (const t of after) {
      const f = first.get(t.session);
      if (!f) continue;
      const last = t.el.getBoundingClientRect();
      const { dx, dy, sx, sy } = flipTransform(f, last);
      if (dx === 0 && dy === 0 && sx === 1 && sy === 1) continue;
      t.el.style.transformOrigin = "top left";
      t.el.style.transition = "none";
      t.el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      animating.push(t);
    }
    requestAnimationFrame(() => {
      for (const t of animating) {
        t.el.style.transition = "transform 180ms var(--ease)";
        t.el.style.transform = "";
      }
    });
    // Authoritative cleanup + refit after the morph (covers no-transition cases).
    setTimeout(() => {
      for (const t of after) {
        t.el.style.transition = "";
        t.el.style.transform = "";
        t.el.style.transformOrigin = "";
        t.panel.fit();
      }
    }, 220);
  }

  zoomTo(session: string | null) {
    if (session !== null) {
      const parts = zoomParticipants(
        [...this.tiles.values()].map((t) => ({
          session: t.session, hidden: t.el.classList.contains("ws-hidden"),
        })),
        session,
      );
      if (parts.zoomed === null) return; // nothing to zoom (≤1 visible / not visible)
    }
    if (this.zoomedSession === session) return;
    this.animateLayoutChange(() => { this.zoomedSession = session; this.applyLayout(); });
  }

  /** Zoom the active tile. Until now the only way in was a double-click on the
   *  header — a headline feature with no keyboard path at all. */
  toggleZoomActive() {
    const id = this.activeSession;
    if (id) this.toggleZoom(id);
  }

  isZoomed(): boolean { return this.zoomedSession !== null; }

  /** Refit every visible terminal, and re-check the tool panel's column floor.
   *
   *  For whatever moves a box these live in without resizing the window: the
   *  panel's grip, the drawer's, the panel collapsing. `fit()` is debounced inside
   *  the terminal, so calling this on every frame of a drag costs one resize at the
   *  end of it — which is the behaviour the PTY needs and the reason the debounce
   *  is there. */
  refit() {
    for (const t of this.tiles.values()) {
      if (t.el.classList.contains("ws-hidden")) continue;
      t.panel.fit();
      t.tools.refit();
    }
  }

  /** Told whenever the deck enters or leaves zoom.
   *
   *  For the panel beside it, which collapses to the rail while one session is
   *  filling the stage: inside a session, the queue is not what a person is
   *  looking at, and the tile's own tools want the width more. One listener
   *  rather than a call at every site that can zoom — there are five, and a
   *  behaviour wired at five call sites is a behaviour with four bugs in it. */
  setZoomListener(fn: (zoomed: boolean) => void) { this.onZoom = fn; }
  private onZoom: ((zoomed: boolean) => void) | null = null;

  /** Zoom the active tile and say whether that is what happened.
   *
   *  For the panel taking the deck's width: the deck yields by falling into its
   *  filmstrip, which is the layout a zoom already produces. The return value is
   *  what lets the panel give back exactly what it took — a tile somebody zoomed
   *  themselves must not be un-zoomed by a panel narrowing. */
  zoomActive(): boolean {
    if (this.zoomedSession !== null) return false;
    const id = this.activeSession;
    if (!id) return false;
    this.zoomTo(id);
    return this.zoomedSession !== null;
  }

  /** Focus the first session in a state, for the ledger's readings: pressing "2
   *  waiting for a decision" goes to one of the two rather than to a list of
   *  everything. Insertion order, which is the order the deck lays tiles out in,
   *  so "first" means the same thing to the eye. */
  focusFirst(state: SessionState): boolean {
    for (const t of this.tiles.values()) {
      if (t.state === state && !t.el.classList.contains("ws-hidden")) {
        return this.focusSession(t.session);
      }
    }
    return false;
  }

  /** Move keyboard focus into the active terminal. Half of region cycling: the
   *  terminal swallows Tab, so getting back in needs an explicit route too. */
  focusActiveTerminal(): boolean {
    const id = this.activeSession;
    if (!id) return false;
    this.tiles.get(id)?.panel.focus();
    return true;
  }

  toggleZoom(session: string) {
    this.zoomTo(this.zoomedSession === session ? null : session);
  }

  exitZoom(): boolean {
    if (this.zoomedSession === null) return false;
    this.zoomTo(null);
    return true;
  }

  /** Give a tile up because another window has taken its session over.
   *
   *  Everything `remove` does except ending the session — the PTY, the process
   *  and the conversation carry on in the window that claimed them. Called from
   *  the `session://owner` event rather than from the hand-off itself, so losing
   *  the race costs nothing: this window's writes have been refused since the
   *  claim (#240), and the tile is only a picture by then. */
  releaseTile(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    // The session carries on in the window that claimed it; this window's panel
    // does not, or it would keep reading a log this deck no longer shows.
    tile.activityPanel?.close();
    tile.activityPanel = null;
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
    if (tile.scheduledSkillId && this.scheduledSessions.get(tile.scheduledSkillId) === session) {
      this.scheduledSessions.delete(tile.scheduledSkillId);
    }
    this.applyLayout();
    this.usage.delete(session);
    if (this.tiles.size === 0) this.stopPolling();
    this.renderList();
    void this.persistLayout();
  }

  /** Whether any tile here belongs to this workspace — what a pull-out asks
   *  before opening a window for it. */
  hasWorkspace(workspaceId: string): boolean {
    return [...this.tiles.values()].some((t) => t.workspaceId === workspaceId);
  }

  /** Everything the window taking this workspace over needs to rebuild its
   *  tiles, including what the person was looking at in each.
   *
   *  Read here, while this window is still alive and still rendering them. That
   *  is the whole reason the scrollback needs no home in Rust. */
  handOffPayload(workspaceId: string): HandOffTile[] {
    return [...this.tiles.values()]
      .filter((t) => t.workspaceId === workspaceId && t.kind !== "command")
      .map((t) => ({
        ...serializeTiles([{
          session: t.session, workspacePath: t.workspacePath,
          name: t.names.context ?? t.names.placeholder, workspaceId: t.workspaceId,
          kind: t.kind, scheduledSkillId: t.scheduledSkillId, taskId: t.taskId,
          userName: t.names.user,
          nameKind: t.names.context === null ? "placeholder" : "context",
          skillId: t.skillId, runId: t.runId,
        }])[0],
        scrollback: t.panel.serialize(),
      }));
  }

  /** Build tiles for sessions this window is taking over from another one. */
  async receive(tiles: HandOffTile[]) {
    for (const e of tiles) {
      if (this.tiles.has(e.sessionId)) continue;
      await this.spawnTile({
        session: e.sessionId, cwd: e.cwd, workspaceId: e.workspaceId,
        titleText: e.name, nameKind: e.nameKind ?? "context", userName: e.userName ?? null,
        prompt: null, resume: false,
        scheduledSkillId: e.scheduledSkillId, taskId: e.taskId, skillId: e.skillId,
        // A layout entry with no `cliKind`, or with one this build does not
        // know, restores as `claude` — the tile behaves exactly as before, and
        // an unrecognised CLI is a session the deck can still show.
        cliKind: e.cliKind ?? "claude",
        attach: { scrollback: e.scrollback },
        grabAttention: false,
      });
    }
  }

  /** The remembered answer to the note question. `undefined` is never asked,
   *  which is not the same as `false` — see `ui_state.captureOnClose`. */
  private captureAnswer: boolean | undefined = undefined;

  private remove(session: string, capture: CaptureOnClose | null = null) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    // The note travels with the close rather than ahead of it — see
    // `closeSession` for why the ordering lives in one command.
    void closeSession(session, capture);
    // Before the tile leaves the map, or the panel outlives the session it is
    // describing and keeps reading a log for a tile that is gone.
    tile.activityPanel?.close();
    tile.activityPanel = null;
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
    if (tile.scheduledSkillId && this.scheduledSessions.get(tile.scheduledSkillId) === session) {
      this.scheduledSessions.delete(tile.scheduledSkillId);
    }
    this.applyLayout();
    this.usage.delete(session);
    if (this.tiles.size === 0) this.stopPolling();
    this.renderList();
    void this.persistLayout();
  }

  private persistLayout() {
    if (this.restoring) return Promise.resolve();
    const entries = serializeTiles([...this.tiles.values()].map((t) => ({
      session: t.session, workspacePath: t.workspacePath,
      name: t.names.context ?? t.names.placeholder, workspaceId: t.workspaceId,
      kind: t.kind,
      scheduledSkillId: t.scheduledSkillId,
      taskId: t.taskId,
      userName: t.names.user,
      nameKind: t.names.context === null ? "placeholder" : "context",
      skillId: t.skillId,
      runId: t.runId,
      cliKind: t.cliKind,
    })));
    // Skip a write that would change nothing. Not something the naming needs —
    // it is here because it lives in the function this change touches, and it
    // collapses the redundant writes the spawn, restart and remove bursts
    // already produce. The memo is assigned only once the write has resolved:
    // a failed save has to stay dirty, or the next real change is skipped too.
    const serialized = JSON.stringify(entries);
    if (serialized === this.savedLayout) return Promise.resolve();
    return saveLayout(entries)
      .then(() => { this.savedLayout = serialized; })
      .catch((e) => console.debug("saveLayout failed", e));
  }

  /** The row that creates a session where it stands.
   *
   *  Exactly one of them is prominent — the active workspace's — so the panel still
   *  has one obvious primary action after the full-width "+ session" button that
   *  used to be it. The difference from that button is the whole point: this one is
   *  inside the thing it acts on and names it, so being wrong about which workspace
   *  is active costs nothing. Pressing any of the others creates there. */
  private createRow(workspaceId: string, name: string): HTMLElement {
    const add = document.createElement("button");
    add.className = "sess-add" + (workspaceId === this.activeWorkspaceId ? " sess-add--primary" : "");
    add.dataset.focusKey = `add:${workspaceId}`;
    add.append(icon("plus", 13), document.createTextNode(`New session in ${name}`));
    add.title = `New session in ${name}`;
    add.onclick = () => this.tree?.newSession(workspaceId);
    return add;
  }

  private renderList() {
    // The whole list is rebuilt via innerHTML, and the poll rebuilds it every
    // five seconds. That was harmless only while nothing in it could hold
    // focus; now that rows are buttons, the focused key has to be remembered
    // and restored, or keyboard focus would jump to the top of the page twice
    // a minute.
    const focusKey = this.listEl.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.focusKey ?? null
      : null;
    const tiles = [...this.tiles.values()];
    const waiting = waitingCount(tiles.map((t) => t.state));
    this.onCounts?.({
      waiting,
      error: tiles.filter((t) => t.state === "error").length,
      // Not for a reading of its own — the ledger is only the things that want a
      // person — but the rail's dot needs to know whether there is anything here
      // at all, which is a different question from whether anything is wrong.
      total: tiles.length,
    });
    // What this window has, not what the app has — and said as a list rather
    // than a number.
    //
    // It used to send `pill://count` with its own partial total, which the pill
    // trusted absolutely: with two windows open the pill flapped between two
    // partial counts every five seconds, whichever arrived last winning. The
    // main window now does the adding, because it is the only participant that
    // sees everybody. The same message also says *where* each session is, which
    // is what lets "who is blocked on me" reach the other monitor.
    //
    // Sent on every render, unchanged included. A listener registers
    // asynchronously, and an event arriving before it is ready is dropped rather
    // than queued — re-sending is the only way back from that, and from a send
    // that failed.
    void emit("session://waiting", {
      label: this.windowLabel,
      sessions: tiles.map((t) => ({
        session: t.session, name: resolveTileName(t.names),
        state: t.state, workspaceId: t.workspaceId,
      })),
    });
    /* Nothing of its own any more, and that is the tree arriving in two steps. The
       heading went first — the row above these sessions is the workspace's, stated
       once, and how many are waiting is the ledger's reading in the top bar. The
       total spend went second, by request: a running bill is not something a person
       acts on, and it was the one line keeping a third island in this column. Each
       session's own spend is still on its tile's token badge, in the tooltip
       `tokenTooltip` writes.

       So on the tree's own path this mount ends up EMPTY, and an empty island is a
       small painted box with nothing in it — hidden at the end of this function.
       It is not dead: with no tree, or with sessions whose workspace was deleted from
       under them, the groups below still render into it. */
    this.listEl.replaceChildren();
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
    const groups = groupTilesByWorkspace(
      [
        ...tiles.map((t) => ({
          session: t.session, name: resolveTileName(t.names), state: t.state,
          workspaceId: t.workspaceId, workspacePath: t.workspacePath, branch: t.branch,
        })),
        // Proxies, mixed in rather than listed apart: a session is under its
        // workspace wherever it is being rendered, and a separate "elsewhere"
        // section would make the person answer "which list is this in?" before
        // they could answer "who is waiting for me?".
        ...this.remote.map((r) => ({
          session: r.session, name: r.name, state: r.state,
          workspaceId: r.workspaceId, workspacePath: "", remote: r.label,
        })),
      ],
      this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path })),
    );
    const ORPHAN_KEY = "__orphan__";
    for (const g of groups) {
      const wsId = g.workspace?.id ?? ORPHAN_KEY;
      const color = g.workspace?.color ?? "var(--fg-subtle)";
      const name = g.workspace?.name ?? "Other";
      const collapsed = this.collapsed.has(wsId);
      const groupWaiting = g.tiles.filter((t) => t.state === "waitingInput").length;

      /* Where this group's rows go, and whether this deck draws its heading at
         all. See `setTree`. The count goes out either way: with a tree it is the
         workspace row that carries the badge, and that row is repainted on its own
         schedule, so it has to be told rather than asked. */
      const host = g.workspace ? this.tree?.host(g.workspace.id) ?? null : null;
      if (g.workspace) {
        this.tree?.waiting(g.workspace.id, groupWaiting);
        this.tree?.expanded(g.workspace.id, !collapsed);
      }
      let into: HTMLElement = this.listEl;
      if (host) {
        host.replaceChildren();
        host.hidden = collapsed;
        into = host;
        if (collapsed) continue;
      }

      const head = document.createElement("button");
      head.dataset.focusKey = `group:${wsId}`;
      head.setAttribute("aria-expanded", String(!collapsed));
      head.className = "sess-group-head"
        + (g.workspace && g.workspace.id === this.activeWorkspaceId ? " active" : "");
      const toggle = document.createElement("span");
      toggle.className = "sess-group-toggle";
      // One chevron, rotated: every arrow in the app now opens at the same
      // angle and carries the same stroke weight.
      toggle.append(icon("chevron", 12));
      toggle.classList.toggle("icon--down", !collapsed);
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = color;
      const nm = document.createElement("span");
      // Truncates the same way `.ws-label` does, and for the same reason: a
      // workspace name against a sidebar's width.
      nm.className = "sess-group-name"; nm.textContent = name; nm.title = name;
      head.append(toggle, dot, nm);
      if (groupWaiting > 0) {
        const badge = document.createElement("span");
        badge.className = "sess-group-badge";
        badge.textContent = `${groupWaiting} waiting`;
        head.append(badge);
      }
      head.onclick = () => {
        if (collapsed) this.collapsed.delete(wsId); else this.collapsed.add(wsId);
        this.renderList();
      };
      if (!host) {
        this.listEl.appendChild(head);
        if (collapsed) continue;
      }

      for (const t of g.tiles) {
        const live = this.tiles.get(t.session);
        const row = document.createElement("button");
        row.dataset.focusKey = `session:${t.session}`;
        // A proxy says where it is, in its accessible name, because that is the
        // one thing about it a sighted reader gets from the dimmed row and a
        // screen reader would otherwise get from nothing at all. Not
        // `aria-disabled`: the row is not disabled, it does something different.
        // The branch is on the row for the eye, so it is in the accessible name
        // too: a list where two rows differ only by which worktree they run in
        // must differ by that for a reader who never sees the second line.
        const meta = [LABEL[t.state], ...(t.branch ? [t.branch] : []),
          ...(t.remote ? ["in another window"] : [])];
        row.setAttribute("aria-label", [t.name, ...meta].join(" — "));
        const isActive = !!live?.el.classList.contains("is-active");
        row.className = "sess-row" + (isActive ? " active" : "")
          + (t.remote ? " remote" : "");
        // The `active` class was the only carrier: a background tint and a left
        // border, both invisible to a screen reader, on the row telling the person
        // which of a dozen sessions they are looking at. `aria-current` rather than
        // `aria-selected` — this is a list of things to go to, not a widget with a
        // selection, and it is the same reading as `.ws-label` below.
        if (isActive) row.setAttribute("aria-current", "true");
        // The left edge used to be a 3px border in the WORKSPACE's colour, which the
        // group heading three lines up already carries as a dot — so it was a second
        // rendering of the grouping and said nothing about the row. It is a state
        // rail now: the one thing a list of a dozen sessions exists to answer, and
        // readable in a single sweep instead of by reading a dozen small chips.
        //
        // A data attribute rather than a class: `.state-*` already means "a chip with
        // this fill and this text colour", and putting one of those names on the row
        // would paint a chip's background across the whole line.
        row.dataset.state = t.state;
        row.onclick = t.remote
          ? () => this.onRemoteFocus(t.remote!, t.session)
          : () => this.focusSessionAnywhere(t.session);
        /* Two lines, and which one is which is the whole point: the name is what
           tells one session from another, so it takes the row's full width on a
           line of its own, and everything that is true of every row — the state,
           the branch — goes under it, quieter and smaller.
           What this replaces put the state chip FIRST, which made a column of a
           dozen sessions read as a column of pills: the chips are the widest and
           brightest thing in the row, they are a different width per state, and
           so the names started at a different x on every line. There was no column
           for the eye to run down. */
        const nameSpan = document.createElement("span");
        nameSpan.className = "sess-name";
        nameSpan.textContent = t.name;
        // The row truncates now rather than wrapping to four lines, so the full
        // name has to be reachable. The accessible name already carries it; this
        // is for the sighted reader looking at "Port the settings rail to t…".
        nameSpan.title = t.name;
        const metaLine = document.createElement("span");
        metaLine.className = "sess-meta";
        const stateSpan = document.createElement("span");
        // `--bare` and not a chip: the fill was contrast spent rather than earned
        // (see the note over `.state-ended`), and a pill per row is what made the
        // list unreadable. The dot the chip already carries stays, and so does the
        // rail — two channels for the state, which is one more than the name gets.
        stateSpan.className = `tile-state tile-state--bare state-${t.state}`;
        stateSpan.textContent = LABEL[t.state];
        metaLine.append(stateSpan);
        if (t.branch) {
          const branchSpan = document.createElement("span");
          branchSpan.className = "sess-branch";
          branchSpan.append(icon("git-branch", 12), document.createTextNode(` ${t.branch}`));
          metaLine.append(branchSpan);
        }
        row.append(nameSpan, metaLine);
        into.appendChild(row);
      }

      /* Creation is positional: the last row inside the group, at the place the
         new session will appear, and it says which workspace that is. What it
         replaces was one button outside every list which created in whichever
         workspace happened to be active — so being wrong about which workspace was
         active was a session in the wrong folder, discovered afterwards. */
      if (host && g.workspace) into.appendChild(this.createRow(g.workspace.id, g.workspace.name));
    }

    /* A workspace with no sessions at all still gets its create row, and this is
       where it comes from: `groupTilesByWorkspace` groups TILES, so a workspace
       nothing is running in produces no group. It is also the case that needs the
       row most — an empty workspace's only useful sentence is "start something
       here" — and without this it was the one row in the tree that could not be
       created into. */
    if (this.tree) {
      for (const w of this.workspaces()) {
        const host = this.tree.host(w.id);
        if (!host || host.childElementCount > 0) continue;
        const folded = this.collapsed.has(w.id);
        host.hidden = folded;
        this.tree.expanded(w.id, !folded);
        if (!folded) host.appendChild(this.createRow(w.id, w.name));
      }
    }
    /* An island with nothing in it is a box the eye has to dismiss. `hidden` rather
       than a class, because `#sidebar .island` sets no `display` of its own and the
       attribute's is enough — and it has to be re-evaluated on every render, since
       an orphan group appearing is what fills this again. */
    this.listEl.hidden = this.listEl.childElementCount === 0;
    if (focusKey) {
      this.listEl.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
    }
  }
}

/** The scenario half of a launch, minted at the moment the PTY is asked for.
 *
 *  The run id is created here, beside the session id, and written straight onto
 *  the tile — `persistLayout` runs immediately afterwards, so the link survives
 *  a restart, which is the only way a resumed tile can chain its new record to
 *  the one it continues. Minting an identifier is not writing a record: every
 *  line of the journal is written in Rust.
 *
 *  Returns null for a tile that is not a scenario run at all, which is what
 *  keeps cards, issues, pull requests and bare sessions out of the journal. */
function scenarioLaunch(
  tile: Tile, trigger: RunTrigger | undefined, continuesRunId: string | null,
): ScenarioLaunch | null {
  if (!tile.skillId || !trigger) return null;
  // The record this tile is leaving, captured before the new id overwrites it.
  // A ⟳ is only offered once the session has ended or errored, and both of
  // those have already closed the predecessor in Rust and dropped it from
  // `open_runs` — so the backend has nothing left to chain to and the link has
  // to come from here. A tile being built for the first time has no `runId`,
  // which is why this stays a fallback rather than an override.
  const previous = tile.runId ?? null;
  tile.runId = crypto.randomUUID();
  return {
    runId: tile.runId,
    skillId: tile.skillId,
    trigger,
    params: tile.params ?? {},
    continuesRunId: continuesRunId ?? previous,
  };
}

/** What a deck needs from the tree its rows live in. Three functions and no
 *  more: where to put the rows, what to tell the row above them, and what the
 *  create row at the end of them does. */
export interface DeckTree {
  /** The container the panel leaves under a workspace's row. Null when that
   *  workspace has no row — which is not the same as having no sessions. */
  host(workspaceId: string): HTMLElement | null;
  /** How many of this workspace's sessions are waiting, including the ones in
   *  another window: the badge answers for the workspace, not for the window. */
  waiting(workspaceId: string, n: number): void;
  /** Whether this workspace's sessions are showing. The deck owns the folding, so
   *  the row above them cannot know it without being told. */
  expanded(workspaceId: string, on: boolean): void;
  /** Create a session in this workspace, from the row that names it. */
  newSession(workspaceId: string): void;
  /** Make this workspace the active one — the whole app's notion of active, not
   *  this deck's filter. Going to a session in another workspace has to go through
   *  here: `setActiveWorkspace` moves the deck and nothing else, so the panel, the
   *  crumb, the board and the pull requests stayed on the workspace you left. */
  activate(workspaceId: string): void;
}

/** What the top bar's ledger is written from. Deliberately not "everything the
 *  deck knows": three numbers, and each one has a reading in the bar or a dot on
 *  the rail. A count nothing renders is a count nobody checks. */
export interface SessionCounts { waiting: number; error: number; total: number }

export function waitingCount(states: SessionState[]): number {
  return states.filter((s) => s === "waitingInput").length;
}

export function nextWaitingAcross(
  tiles: { session: string; workspaceId?: string; state: SessionState }[],
  currentSession: string | null,
): { session: string; workspaceId?: string } | null {
  const n = tiles.length;
  if (n === 0) return null;
  const start = tiles.findIndex((t) => t.session === currentSession); // -1 if not found
  for (let i = 1; i <= n; i++) {
    const t = tiles[(start + i + n) % n];
    if (t.state === "waitingInput" && t.session !== currentSession) {
      return { session: t.session, workspaceId: t.workspaceId };
    }
  }
  return null;
}

/** What reaches `sessions.json`.
 *
 *  `name` is the **launch** name — never the resolved one. A transcript title is
 *  not persisted at all: `startPolling()` fires a tick immediately, so a restored
 *  tile refills it within one round trip and a stored copy could only go stale.
 *  A hand-typed name goes in its own field, and `nameKind` records which of the
 *  two kinds `name` is, so the next launch knows whether a title may replace it. */
export function serializeTiles(
  tiles: {
    session: string; workspacePath: string; name: string; workspaceId?: string;
    scheduledSkillId?: string; taskId?: string;
    kind?: TileKind;
    userName?: string | null;
    nameKind?: NameKind;
    skillId?: string;
    runId?: string;
    cliKind?: CliKind;
  }[],
): SessionEntry[] {
  return tiles
    // Командный тайл — разовое действие пользователя (установка пакета, вход в
    // аккаунт). Восстанавливать его на следующем запуске нельзя: это молча
    // выполнило бы sudo-команду без спроса.
    .filter((t) => t.kind !== "command")
    .map((t) => ({
      sessionId: t.session, cwd: t.workspacePath, name: t.name,
      ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
      ...(t.scheduledSkillId ? { scheduledSkillId: t.scheduledSkillId } : {}),
      ...(t.taskId ? { taskId: t.taskId } : {}),
      ...(t.userName ? { userName: t.userName } : {}),
      ...(t.skillId ? { skillId: t.skillId } : {}),
      ...(t.runId ? { runId: t.runId } : {}),
      // Written only when it is not the default, so a layout file does not grow
      // a key that says what its absence already says. Every entry on disk today
      // is a Claude session, and this keeps them byte-identical.
      ...(t.cliKind && t.cliKind !== "claude" ? { cliKind: t.cliKind } : {}),
      nameKind: t.nameKind ?? "context",
    }));
}

export function selectedFromChecks(checks: { session: string; checked: boolean }[]): string[] {
  return checks.filter((c) => c.checked).map((c) => c.session);
}
