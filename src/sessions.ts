import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, saveLayout, type SessionState, type Skill, type Workspace, type SessionEntry } from "./ipc";
import { gitStatus, sessionTokens, type TokenUsage } from "./ipc";
import { formatTokens, sumUsage, uniqueCwds } from "./observability";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { emit } from "@tauri-apps/api/event";
import { nextWaitingIndex } from "./commands";
import { NotifyRouter, wireNotificationFocus } from "./notify";
import { confirmModal } from "./modal";
import { broadcastInput } from "./broadcast";
import { groupTilesByWorkspace } from "./grouping";

interface Tile {
  session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; workspaceId?: string; prompt: string | null; restartBtn: HTMLButtonElement;
  searchBar: HTMLElement; bcastCheck: HTMLInputElement; gitBadge: HTMLElement; tokenBadge: HTMLElement;
}

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

export class Deck {
  private tiles = new Map<string, Tile>();
  private notifyOk = false;
  private notify = new NotifyRouter();
  private broadcasting = false;
  private bcastPanel: HTMLElement | null = null;
  private restoring = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private usage = new Map<string, TokenUsage>();
  private activeWorkspaceId: string | null = null;
  private collapsed = new Set<string>();
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

  private async spawnTile(opts: {
    session: string; cwd: string; workspaceId?: string; titleText: string; prompt: string | null; resume: boolean;
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
      gitBadge, tokenBadge,
    };
    this.tiles.set(session, tile);
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
    const ids = [...this.tiles.keys()];
    const id = ids[n - 1];
    if (id) this.focusTile(id);
  }
  focusNextWaiting() {
    const ids = [...this.tiles.keys()];
    const states = ids.map((id) => this.tiles.get(id)!.state);
    const cur = ids.indexOf(this.activeSession ?? "");
    const idx = nextWaitingIndex(states, cur);
    if (idx != null) this.focusTile(ids[idx]);
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

  private focusTile(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
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

  private remove(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    void closeSession(session);
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
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
      const color = g.workspace?.color ?? "#6b7280";
      const name = g.workspace?.name ?? "Другие";
      const collapsed = this.collapsed.has(wsId);
      const groupWaiting = g.tiles.filter((t) => t.state === "waitingInput").length;

      const head = document.createElement("div");
      head.className = "sess-group-head"
        + (g.workspace && g.workspace.id === this.activeWorkspaceId ? " active" : "");
      head.style.setProperty("--ws-color", color);
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
        row.onclick = () => this.focusTile(t.session);
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
