import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, saveLayout, updateTask, type SessionState, type Skill, type Workspace, type SessionEntry, type SessionAuth, type Task, type BoardConfig } from "./ipc";
import { gitStatus, sessionTokens, type TokenUsage } from "./ipc";
import { formatTokens, sumUsage, uniqueCwds } from "./observability";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { emit } from "@tauri-apps/api/event";
import { NotifyRouter, wireNotificationFocus } from "./notify";
import { confirmModal } from "./modal";
import { broadcastInput } from "./broadcast";
import { groupTilesByWorkspace, resolveWorkspaceId } from "./grouping";
import { zoomParticipants, flipTransform } from "./flip";
import { shouldSkipOverlap } from "./schedule";
import { icon, iconButton } from "./icons";
import { linksInWorkspace, liveSessionForTask, taskPrompt, type TaskSessionLink } from "./tasks";
import { workingStep } from "./board-config";

/** Обычный тайл — сессия claude. Командный — разовый запуск пользовательской
 *  команды (установка gh, `gh auth login`): без хуков состояния, без
 *  перезапуска и, главное, без автовосстановления. */
export type TileKind = "claude" | "command";

interface Tile {
  session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; workspaceId?: string; prompt: string | null; restartBtn: HTMLButtonElement;
  searchBar: HTMLElement; bcastCheck: HTMLInputElement; gitBadge: HTMLElement; tokenBadge: HTMLElement;
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
}

const LABEL: Record<SessionState, string> = {
  idle: "idle", working: "working", waitingInput: "needs input", done: "done",
  ended: "exited", error: "error",
};
// `done` is here because "the agent finished the job" is exactly what an
// unsupervised session is started for. It stays out of the pill, though: the
// pill answers "how many sessions are blocked on me".
const NOTIFY_ON: SessionState[] = ["waitingInput", "done", "ended", "error"];

export class Deck {
  private tiles = new Map<string, Tile>();
  /** skillId -> session of that scenario's most recent scheduled run. */
  private scheduledSessions = new Map<string, string>();
  private notifyOk = false;
  private notify = new NotifyRouter();
  private broadcasting = false;
  private bcastPanel: HTMLElement | null = null;
  private restoring = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private usage = new Map<string, TokenUsage>();
  private activeWorkspaceId: string | null = null;
  private collapsed = new Set<string>();
  private zoomedSession: string | null = null;
  private strip: HTMLElement | null = null;
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement, private workspaces: () => Workspace[]) {}

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
      // tokens: per session; errors isolated, plus a guard against racing with tile removal
      await Promise.all(tiles.map(async (t) => {
        try {
          const u = await sessionTokens(t.session);
          if (!this.tiles.has(t.session)) return;
          this.usage.set(t.session, u);
          t.tokenBadge.textContent = `↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`;
          t.tokenBadge.title = `cache: +${formatTokens(u.cacheCreation)} / ${formatTokens(u.cacheRead)} read`;
          t.tokenBadge.classList.remove("hidden");
        } catch (e) {
          console.debug("sessionTokens failed", t.session, e);
        }
      }));
      this.renderList();
    } catch (e) {
      console.debug("pollOnce failed", e);
    }
  }

  wireNotificationFocus() {
    return wireNotificationFocus(this.notify, (s) => this.focusTile(s));
  }

  async wireEvents() {
    this.notifyOk = await isPermissionGranted();
    if (!this.notifyOk) this.notifyOk = (await requestPermission()) === "granted";
    await onOutput((s, text) => this.tiles.get(s)?.panel.write(text));
    await onState((s, state) => this.setState(s, state));
    await onExit((s) => { /* state already emitted; keep tile for scrollback */ void s; });
  }

  async launch(workspace: Workspace, skill: Skill | null) {
    const titleText = skill ? `${skill.icon} ${skill.name}` : `session · ${workspace.name}`;
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText,
      prompt: skill ? skill.prompt : null,
      resume: false,
    });
  }

  /** Бейдж рисуется ТОЛЬКО когда что-то не так: аккаунт не подключился или
   *  окружение устарело после смены привязки. В норме шапка тайла чистая. */
  private renderAuthBadge(tile: Tile) {
    const { authBadge: b } = tile;
    if (tile.authStale) {
      b.textContent = "GitHub ⟳";
      b.title = "Привязка воркспейса изменилась — окружение подхватится после перезапуска сессии";
      b.className = "tile-auth stale";
      return;
    }
    if (tile.auth?.degraded) {
      b.textContent = "GitHub ✕";
      b.title = `Аккаунт ${tile.auth.account ?? "?"} не подключён: ${tile.auth.degraded}`;
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
    const alive = liveSessionForTask(task.id, this.taskLinks(workspace.id));
    if (alive) { this.focusTile(alive); return "focused"; }
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
    if (taskId !== undefined) {
      const alive = liveSessionForTask(taskId, this.taskLinks(workspaceId));
      if (alive) { this.focusTile(alive); return "focused"; }
    }
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

  setActiveWorkspace(id: string | null) {
    this.zoomedSession = null;
    this.activeWorkspaceId = id;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    let firstVisible: string | null = null;
    for (const t of this.tiles.values()) {
      const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, ws);
      // Orphan tiles (rid === null) stay visible everywhere so a session whose
      // workspace was deleted remains reachable.
      const visible = rid === null || rid === id;
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
    scheduledSkillId?: string;
    /** Tracker card this tile is working on. */
    taskId?: string;
    /** Marks the tile as started by a schedule. Shown as its own icon rather
     *  than glued to the title, which gets clipped by text-overflow. */
    scheduled?: boolean;
    /** Whether the new tile should take over the keyboard and the layout.
     *  False for unattended work: a scheduled run announces itself through a
     *  notification, not by yanking the caret out of whatever is being typed. */
    grabAttention?: boolean;
    /** "command" — разовый запуск `command` вместо сессии claude. */
    kind?: TileKind;
    command?: string;
  }) {
    const { session, cwd, workspaceId, titleText, prompt, resume } = opts;
    const grabAttention = opts.grabAttention ?? true;
    const isCommand = opts.kind === "command";
    const el = document.createElement("div");
    el.className = "tile";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    title.textContent = titleText;
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
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
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
      title, gitBadge, authBadge, tokenBadge, label, clearBtn, close,
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
        tile.auth = await tile.panel.start(
          tile.workspacePath, tile.workspaceId ?? null, null, tile.taskId ?? null, true,
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
      if ((e.target as HTMLElement).closest("button")) return;
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
    el.append(head, searchBar, mount);
    this.deckEl.appendChild(el);
    el.addEventListener("mousedown", () => this.focusTile(session));

    const panel = new TerminalPanel(session, mount);
    const tile: Tile = {
      session, name: title.textContent!, panel, state: "idle", el, label,
      workspacePath: cwd, workspaceId, prompt, restartBtn: restart, searchBar, bcastCheck,
      gitBadge, authBadge, tokenBadge, scheduledSkillId: opts.scheduledSkillId,
      kind: opts.kind, taskId: opts.taskId,
    };
    this.tiles.set(session, tile);
    if (grabAttention && !resume && this.zoomedSession !== null) { this.zoomedSession = null; this.applyLayout(); }
    this.startPolling();
    this.renderList();
    try {
      if (isCommand) {
        await panel.startCommand(cwd, opts.command ?? "");
        // Командный тайл в layout не попадает — persistLayout не зовём.
      } else {
        tile.auth = await panel.start(cwd, workspaceId ?? null, prompt, opts.taskId ?? null, resume);
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

  /** Apply the active-workspace filter to one tile. Tiles used to be created
   *  without it, so a scheduled run for another workspace appeared in whatever
   *  deck was on screen and disappeared at the next switch. */
  private applyWorkspaceVisibility(session: string) {
    const t = this.tiles.get(session);
    if (!t) return;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    const rid = resolveWorkspaceId(t.workspaceId, t.workspacePath, ws);
    // Orphans stay visible everywhere, as in setActiveWorkspace.
    const visible = rid === null || rid === this.activeWorkspaceId;
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
          titleText: e.name, prompt: null, resume: true,
          scheduledSkillId: e.scheduledSkillId, taskId: e.taskId,
        });
      }
    } finally {
      this.restoring = false;
    }
    void this.persistLayout();
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
    if (alive && !(await confirmModal(`Close session “${t.name}”? It is still alive.`))) return;
    this.remove(session);
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

  private focusSessionAnywhere(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    const ws = this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path }));
    const rid = resolveWorkspaceId(tile.workspaceId, tile.workspacePath, ws);
    if (rid !== null && rid !== this.activeWorkspaceId) {
      this.setActiveWorkspace(rid);
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
    this.deckEl.classList.toggle("has-active", this.tiles.size > 0);
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
    tile.label.textContent = LABEL[state];
    // У командного тайла перезапуск не предлагаем: он поднял бы claude, а не
    // повторил команду. Разовое действие повторяется из своего экрана.
    const restartable = tile.kind !== "command" && (state === "ended" || state === "error");
    tile.restartBtn.style.display = restartable ? "inline" : "none";
    this.renderList();
    if (state !== prev && NOTIFY_ON.includes(state) && this.notifyOk) {
      const id = this.notify.register(session);
      sendNotification({ id, title: `cowork-deck · ${LABEL[state]}`, body: tile.name });
    }
  }

  private applyLayout() {
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
      return;
    }
    this.deckEl.classList.add("is-zoomed");
    if (!this.strip) {
      this.strip = document.createElement("div");
      this.strip.className = "deck-strip";
    }
    const z = this.tiles.get(parts.zoomed)!;
    z.el.classList.add("zoomed");
    z.el.classList.remove("minimized");
    this.deckEl.appendChild(z.el);
    this.deckEl.appendChild(this.strip);
    for (const s of parts.minimized) {
      const t = this.tiles.get(s)!;
      t.el.classList.add("minimized");
      t.el.classList.remove("zoomed");
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

  private remove(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    void closeSession(session);
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
    if (tile.scheduledSkillId && this.scheduledSessions.get(tile.scheduledSkillId) === session) {
      this.scheduledSessions.delete(tile.scheduledSkillId);
    }
    this.applyLayout();
    this.usage.delete(session);
    if (this.tiles.size === 0) this.stopPolling();
    if (this.tiles.size === 0) this.deckEl.classList.remove("has-active");
    this.renderList();
    void this.persistLayout();
  }

  private persistLayout() {
    if (this.restoring) return Promise.resolve();
    const entries = serializeTiles([...this.tiles.values()].map((t) => ({
      session: t.session, workspacePath: t.workspacePath, name: t.name, workspaceId: t.workspaceId,
      kind: t.kind,
      scheduledSkillId: t.scheduledSkillId,
      taskId: t.taskId,
    })));
    return saveLayout(entries).catch((e) => console.debug("saveLayout failed", e));
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
    void emit("pill://count", { n: waiting });
    const header = waiting > 0 ? `Sessions · ${waiting} waiting for input` : "Sessions";
    this.listEl.innerHTML = `<h3>${header}</h3>`;
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
    const total = sumUsage([...this.usage.values()]);
    if (this.usage.size > 0) {
      const sum = document.createElement("div");
      sum.className = "sess-tokens-sum";
      sum.textContent = `Total tokens · ↑${formatTokens(total.input)} ↓${formatTokens(total.output)}`;
      this.listEl.appendChild(sum);
    }
    const groups = groupTilesByWorkspace(
      tiles.map((t) => ({
        session: t.session, name: t.name, state: t.state,
        workspaceId: t.workspaceId, workspacePath: t.workspacePath,
      })),
      this.workspaces().map((w) => ({ id: w.id, name: w.name, color: w.color, path: w.path })),
    );
    const ORPHAN_KEY = "__orphan__";
    for (const g of groups) {
      const wsId = g.workspace?.id ?? ORPHAN_KEY;
      const color = g.workspace?.color ?? "var(--fg-subtle)";
      const name = g.workspace?.name ?? "Other";
      const collapsed = this.collapsed.has(wsId);
      const groupWaiting = g.tiles.filter((t) => t.state === "waitingInput").length;

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
      nm.className = "sess-group-name"; nm.textContent = name;
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
      this.listEl.appendChild(head);
      if (collapsed) continue;

      for (const t of g.tiles) {
        const live = this.tiles.get(t.session);
        const row = document.createElement("button");
        row.dataset.focusKey = `session:${t.session}`;
        row.setAttribute("aria-label", `${t.name} — ${LABEL[t.state]}`);
        row.className = "sess-row" + (live?.el.classList.contains("is-active") ? " active" : "");
        row.style.borderLeftColor = color;
        row.onclick = () => this.focusSessionAnywhere(t.session);
        const stateSpan = document.createElement("span");
        stateSpan.className = `tile-state state-${t.state}`;
        stateSpan.textContent = LABEL[t.state];
        const nameSpan = document.createElement("span");
        nameSpan.textContent = t.name;
        row.append(stateSpan, " ", nameSpan);
        this.listEl.appendChild(row);
      }
    }
    if (focusKey) {
      this.listEl.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
    }
  }
}

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

export function serializeTiles(
  tiles: {
    session: string; workspacePath: string; name: string; workspaceId?: string;
    scheduledSkillId?: string; taskId?: string;
    kind?: TileKind;
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
    }));
}

export function selectedFromChecks(checks: { session: string; checked: boolean }[]): string[] {
  return checks.filter((c) => c.checked).map((c) => c.session);
}
