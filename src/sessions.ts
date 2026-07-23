import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, type SessionState, type Skill, type Workspace } from "./ipc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { nextWaitingIndex } from "./commands";

interface Tile {
  session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; prompt: string | null; restartBtn: HTMLButtonElement;
}

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

export class Deck {
  private tiles = new Map<string, Tile>();
  private notifyOk = false;
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement) {}

  async wireEvents() {
    this.notifyOk = await isPermissionGranted();
    if (!this.notifyOk) this.notifyOk = (await requestPermission()) === "granted";
    await onOutput((s, text) => this.tiles.get(s)?.panel.write(text));
    await onState((s, state) => this.setState(s, state));
    await onExit((s) => { /* state already emitted; keep tile for scrollback */ void s; });
  }

  async launch(workspace: Workspace, skill: Skill | null) {
    const session = crypto.randomUUID();
    const el = document.createElement("div");
    el.className = "tile";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    title.textContent = skill ? `${skill.icon} ${skill.name}` : `терминал · ${workspace.name}`;
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
    const close = document.createElement("button");
    close.textContent = "✕"; close.className = "tile-close";
    close.onclick = () => this.remove(session);
    head.append(title, label, close);
    const restart = document.createElement("button");
    restart.textContent = "⟳"; restart.className = "tile-close"; restart.style.display = "none";
    restart.title = "перезапустить";
    restart.onclick = async () => {
      restart.style.display = "none";
      tile.panel.write("\r\n[перезапуск сессии...]\r\n");
      try {
        await tile.panel.start(tile.workspacePath, tile.prompt);
        this.setState(session, "idle");
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
    el.append(head, mount);
    this.deckEl.appendChild(el);
    el.addEventListener("mousedown", () => this.focusTile(session));

    const panel = new TerminalPanel(session, mount);
    const tile: Tile = {
      session, name: title.textContent!, panel, state: "idle", el, label,
      workspacePath: workspace.path, prompt: skill ? skill.prompt : null, restartBtn: restart,
    };
    this.tiles.set(session, tile);
    this.renderList();
    try {
      await panel.start(workspace.path, skill ? skill.prompt : null);
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
  closeActive() {
    const id = this.activeSession;
    if (id) this.remove(id);
  }
  searchActive() {
    // расширяется в Task 8: полноценная строка поиска в плитке
    const id = this.activeSession;
    if (id) this.tiles.get(id)!.panel.focus();
  }
  clearActive() {
    // расширяется в Task 8
    const id = this.activeSession;
    if (id) this.tiles.get(id)!.panel.clear();
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
      sendNotification({ title: `cowork-deck · ${LABEL[state]}`, body: tile.name });
    }
  }

  private remove(session: string) {
    const tile = this.tiles.get(session);
    if (!tile) return;
    void closeSession(session);
    tile.panel.dispose();
    tile.el.remove();
    this.tiles.delete(session);
    if (this.tiles.size === 0) this.deckEl.classList.remove("has-active");
    this.renderList();
  }

  private renderList() {
    const waiting = waitingCount([...this.tiles.values()].map((t) => t.state));
    const header = waiting > 0 ? `Сессии · ${waiting} ${waitingVerb(waiting)} ввода` : "Сессии";
    this.listEl.innerHTML = `<h3>${header}</h3>`;
    document.title = waiting > 0 ? `(${waiting}) cowork-deck` : "cowork-deck";
    for (const t of this.tiles.values()) {
      const row = document.createElement("div");
      row.className = "sess-row" + (t.el.classList.contains("is-active") ? " active" : "");
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

export function waitingCount(states: SessionState[]): number {
  return states.filter((s) => s === "waitingInput").length;
}

export function waitingVerb(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "ждёт" : "ждут";
}
