import { onState, closeSession, launchSession, type SessionState, type Skill, type Workspace } from "./ipc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

interface Card {
  session: string; name: string; state: SessionState; el: HTMLElement; label: HTMLElement;
}

const LABEL: Record<SessionState, string> = {
  idle: "готов", working: "работает", waitingInput: "ждёт ввода", ended: "завершён", error: "ошибка",
};
const NOTIFY_ON: SessionState[] = ["waitingInput", "ended", "error"];

export class Deck {
  private cards = new Map<string, Card>();
  private notifyOk = false;
  constructor(private deckEl: HTMLElement, private listEl: HTMLElement) {}

  async wireEvents() {
    this.notifyOk = await isPermissionGranted();
    if (!this.notifyOk) this.notifyOk = (await requestPermission()) === "granted";
    await onState((s, state) => this.setState(s, state));
  }

  async launch(workspace: Workspace, skill: Skill | null) {
    const session = crypto.randomUUID();
    const name = skill ? `${skill.icon} ${skill.name}` : `терминал · ${workspace.name}`;

    const el = document.createElement("div");
    el.className = "card";
    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = name;
    const label = document.createElement("span");
    label.className = "tile-state state-idle";
    label.textContent = LABEL.idle;
    const close = document.createElement("button");
    close.textContent = "✕";
    close.className = "tile-close";
    close.onclick = () => this.remove(session);
    head.append(title, label, close);
    el.append(head);
    this.deckEl.appendChild(el);

    const card: Card = { session, name, state: "idle", el, label };
    this.cards.set(session, card);
    this.renderList();

    await launchSession(session, workspace.path, skill ? skill.prompt : null);
  }

  private setState(session: string, state: SessionState) {
    const card = this.cards.get(session);
    if (!card) return;
    const prev = card.state;
    card.state = state;
    card.label.className = `tile-state state-${state}`;
    card.label.textContent = LABEL[state];
    this.renderList();
    if (state !== prev && NOTIFY_ON.includes(state) && this.notifyOk) {
      sendNotification({ title: `cowork-deck · ${LABEL[state]}`, body: card.name });
    }
  }

  private remove(session: string) {
    const card = this.cards.get(session);
    if (!card) return;
    void closeSession(session);
    card.el.remove();
    this.cards.delete(session);
    this.renderList();
  }

  private renderList() {
    this.listEl.innerHTML = "<h3>Сессии</h3>";
    for (const c of this.cards.values()) {
      const row = document.createElement("div");
      row.className = "sess-row";
      const stateSpan = document.createElement("span");
      stateSpan.className = `tile-state state-${c.state}`;
      stateSpan.textContent = LABEL[c.state];
      const nameSpan = document.createElement("span");
      nameSpan.textContent = c.name;
      row.append(stateSpan, " ", nameSpan);
      this.listEl.appendChild(row);
    }
  }
}
