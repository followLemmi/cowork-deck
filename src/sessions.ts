import { TerminalPanel } from "./terminal";
import { onOutput, onState, onExit, closeSession, type SessionState, type Skill, type Workspace, type SessionEntry } from "./ipc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { nextWaitingIndex } from "./commands";
import { NotifyRouter, wireNotificationFocus } from "./notify";
import { confirmModal } from "./modal";

interface Tile {
  session: string; name: string; panel: TerminalPanel; state: SessionState; el: HTMLElement; label: HTMLElement;
  workspacePath: string; prompt: string | null; restartBtn: HTMLButtonElement; searchBar: HTMLElement;
}

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

export class Deck {
  private tiles = new Map<string, Tile>();
  private notifyOk = false;
  private notify = new NotifyRouter();
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement) {}

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
    const session = crypto.randomUUID();
    const el = document.createElement("div");
    el.className = "tile";
    const head = document.createElement("div");
    head.className = "tile-head";
    const title = document.createElement("span");
    title.textContent = skill ? `${skill.icon} ${skill.name}` : `терминал · ${workspace.name}`;
    const label = document.createElement("span");
    label.className = "tile-state state-idle"; label.textContent = LABEL.idle;
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "⌫"; clearBtn.className = "tile-close"; clearBtn.title = "очистить";
    clearBtn.onclick = () => tile.panel.clear();
    const close = document.createElement("button");
    close.textContent = "✕"; close.className = "tile-close";
    close.onclick = () => this.remove(session);
    head.append(title, label, clearBtn, close);
    const restart = document.createElement("button");
    restart.textContent = "⟳"; restart.className = "tile-close"; restart.style.display = "none";
    restart.title = "перезапустить";
    restart.onclick = async () => {
      restart.style.display = "none";
      tile.panel.write("\r\n[перезапуск сессии...]\r\n");
      try {
        await tile.panel.start(tile.workspacePath, null, true);
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
      workspacePath: workspace.path, prompt: skill ? skill.prompt : null, restartBtn: restart, searchBar,
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

export function serializeTiles(
  tiles: { session: string; workspacePath: string; name: string }[],
): SessionEntry[] {
  return tiles.map((t) => ({ sessionId: t.session, cwd: t.workspacePath, name: t.name }));
}
