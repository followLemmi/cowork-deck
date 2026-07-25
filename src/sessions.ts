import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, saveLayout, type SessionState, type Skill, type Workspace, type SessionEntry } from "./ipc";
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

interface Tile {
  session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; workspaceId?: string; prompt: string | null; restartBtn: HTMLButtonElement;
  searchBar: HTMLElement; bcastCheck: HTMLInputElement; gitBadge: HTMLElement; tokenBadge: HTMLElement;
  /** Set when the tile came from a scheduled run — keys the overlap guard. */
  scheduledSkillId?: string;
}

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

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
      // git: один вызов на уникальный cwd; изоляция ошибок — одна упавшая IPC не должна ронять весь тик
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
          t.gitBadge.textContent = `⎇ ${g.branch}${g.dirty ? " •" : ""}`;
          t.gitBadge.classList.remove("hidden");
        } else {
          t.gitBadge.classList.add("hidden");
        }
      }
      // tokens: по сессии; изоляция ошибок + защита от гонки с удалением тайла
      await Promise.all(tiles.map(async (t) => {
        try {
          const u = await sessionTokens(t.session);
          if (!this.tiles.has(t.session)) return;
          this.usage.set(t.session, u);
          t.tokenBadge.textContent = `↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`;
          t.tokenBadge.title = `cache: +${formatTokens(u.cacheCreation)} / ${formatTokens(u.cacheRead)} прочитано`;
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
    const titleText = skill ? `${skill.icon} ${skill.name}` : `терминал · ${workspace.name}`;
    await this.spawnTile({
      session: crypto.randomUUID(),
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText,
      prompt: skill ? skill.prompt : null,
      resume: false,
    });
  }

  /** Fire a scheduled scenario as a fresh tile. Returns false (and does not
   *  launch) if this scenario's previous scheduled session is still active. */
  async launchScheduled(workspace: Workspace, skill: Skill, filledPrompt: string): Promise<boolean> {
    const prevSession = this.scheduledSessions.get(skill.id);
    const prevState = prevSession ? (this.tiles.get(prevSession)?.state ?? null) : null;
    if (shouldSkipOverlap(prevState)) {
      console.info("scheduled run skipped: previous still active", skill.id);
      return false;
    }
    const session = crypto.randomUUID();
    this.scheduledSessions.set(skill.id, session);
    await this.spawnTile({
      session,
      cwd: workspace.path,
      workspaceId: workspace.id,
      titleText: `⏰ ${skill.icon} ${skill.name}`,
      prompt: filledPrompt,
      resume: false,
      scheduledSkillId: skill.id,
    });
    return true;
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
  }) {
    const { session, cwd, workspaceId, titleText, prompt, resume } = opts;
    const el = document.createElement("div");
    el.className = "tile";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    title.textContent = titleText;
    const gitBadge = document.createElement("span");
    gitBadge.className = "tile-git hidden";
    const tokenBadge = document.createElement("span");
    tokenBadge.className = "tile-tokens hidden";
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "⌫"; clearBtn.className = "tile-close"; clearBtn.title = "очистить";
    clearBtn.onclick = () => tile.panel.clear();
    const close = document.createElement("button");
    close.textContent = "✕"; close.className = "tile-close";
    close.onclick = () => this.remove(session);
    head.append(title, gitBadge, tokenBadge, label, clearBtn, close);
    const bcastCheck = document.createElement("input");
    bcastCheck.type = "checkbox"; bcastCheck.className = "bcast-check";
    bcastCheck.classList.toggle("hidden", !this.broadcasting);
    head.insertBefore(bcastCheck, title);
    const restart = document.createElement("button");
    restart.textContent = "⟳"; restart.className = "tile-close"; restart.style.display = "none";
    restart.title = "перезапустить";
    restart.onclick = async () => {
      restart.style.display = "none";
      tile.panel.write("\r\n[перезапуск сессии...]\r\n");
      try {
        await tile.panel.start(tile.workspacePath, null, true);
        this.setState(session, "idle");
        void this.persistLayout();
      } catch (e) {
        this.setState(session, "error");
        const raw = String((e as { message?: string })?.message ?? e);
        const readable = raw.includes("claude-not-found")
          ? "claude не найден — укажите путь и перезапустите"
          : raw;
        tile.panel.write(`\r\n[ошибка запуска: ${readable}]\r\n`);
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
    const sInput = document.createElement("input"); sInput.className = "tile-search-input"; sInput.placeholder = "поиск…";
    const sNext = document.createElement("button"); sNext.textContent = "▼"; sNext.className = "tile-search-btn";
    const sPrev = document.createElement("button"); sPrev.textContent = "▲"; sPrev.className = "tile-search-btn";
    const sClose = document.createElement("button"); sClose.textContent = "✕"; sClose.className = "tile-search-btn";
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
      gitBadge, tokenBadge, scheduledSkillId: opts.scheduledSkillId,
    };
    this.tiles.set(session, tile);
    if (!resume && this.zoomedSession !== null) { this.zoomedSession = null; this.applyLayout(); }
    this.startPolling();
    this.renderList();
    try {
      await panel.start(cwd, prompt, resume);
      void this.persistLayout();
    } catch (e) {
      this.setState(session, "error");
      const raw = String((e as { message?: string })?.message ?? e);
      const readable = raw.includes("claude-not-found")
        ? "claude не найден — укажите путь и перезапустите"
        : raw;
      panel.write(`\r\n[ошибка запуска: ${readable}]\r\n`);
    }
    this.focusTile(session);
  }

  async restore(entries: SessionEntry[]) {
    this.restoring = true;
    try {
      for (const e of entries) {
        await this.spawnTile({
          session: e.sessionId, cwd: e.cwd, workspaceId: e.workspaceId,
          titleText: e.name, prompt: null, resume: true,
        });
      }
    } finally {
      this.restoring = false;
    }
    void this.persistLayout();
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
    if (!id) return;
    const t = this.tiles.get(id);
    if (t && (t.state === "working" || t.state === "waitingInput")) {
      if (!(await confirmModal("Закрыть активную сессию?"))) return;
    }
    this.remove(id);
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
      input.placeholder = "broadcast: ввод во все отмеченные сессии, Enter — отправить";
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
    tile.restartBtn.style.display = (state === "ended" || state === "error") ? "inline" : "none";
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
    })));
    return saveLayout(entries).catch((e) => console.debug("saveLayout failed", e));
  }

  private renderList() {
    const tiles = [...this.tiles.values()];
    const waiting = waitingCount(tiles.map((t) => t.state));
    void emit("pill://count", { n: waiting });
    const header = waiting > 0 ? `Сессии · ${waiting} ${waitingVerb(waiting)} ввода` : "Сессии";
    this.listEl.innerHTML = `<h3>${header}</h3>`;
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
    const total = sumUsage([...this.usage.values()]);
    if (this.usage.size > 0) {
      const sum = document.createElement("div");
      sum.className = "sess-tokens-sum";
      sum.textContent = `Σ токенов · ↑${formatTokens(total.input)} ↓${formatTokens(total.output)}`;
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
      const name = g.workspace?.name ?? "Другие";
      const collapsed = this.collapsed.has(wsId);
      const groupWaiting = g.tiles.filter((t) => t.state === "waitingInput").length;

      const head = document.createElement("div");
      head.className = "sess-group-head"
        + (g.workspace && g.workspace.id === this.activeWorkspaceId ? " active" : "");
      const toggle = document.createElement("span");
      toggle.className = "sess-group-toggle";
      toggle.textContent = collapsed ? "▸" : "▾";
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = color;
      const nm = document.createElement("span");
      nm.className = "sess-group-name"; nm.textContent = name;
      head.append(toggle, dot, nm);
      if (groupWaiting > 0) {
        const badge = document.createElement("span");
        badge.className = "sess-group-badge";
        badge.textContent = `${groupWaiting} ${waitingVerb(groupWaiting)}`;
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
        const row = document.createElement("div");
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
  }
}

export function waitingCount(states: SessionState[]): number {
  return states.filter((s) => s === "waitingInput").length;
}

export function waitingVerb(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "ждёт" : "ждут";
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
  tiles: { session: string; workspacePath: string; name: string; workspaceId?: string }[],
): SessionEntry[] {
  return tiles.map((t) => ({
    sessionId: t.session, cwd: t.workspacePath, name: t.name,
    ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
  }));
}

export function selectedFromChecks(checks: { session: string; checked: boolean }[]): string[] {
  return checks.filter((c) => c.checked).map((c) => c.session);
}
