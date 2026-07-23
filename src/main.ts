import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey } from "./commands";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ сессия"; newBtn.className = "ws-add";
sidebar.append(wsMount, skMount, newBtn, listMount);

const deck = new Deck(deckEl, listMount);
deck.wireEvents();

// NOTE: `workspaces.active` is read live (via the getter) at every launch point
// instead of caching the workspace passed to onSelect, because
// WorkspacesPanel.del() does not re-fire onSelect when the active workspace
// is the one being deleted — a cached variable could go stale and point at
// a deleted workspace's path. Reading `workspaces.active` at click time keeps
// us in sync with whatever del()/select() last did.
const workspaces = new WorkspacesPanel(wsMount, () => {});
const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, (skill) => {
  const ws = workspaces.active;
  if (ws) deck.launch(ws, skill);
});
newBtn.onclick = () => {
  const ws = workspaces.active;
  if (ws) deck.launch(ws, null);
};

workspaces.load();
skills.load();

const COMMANDS: Record<string, () => void> = {
  "palette": () => {}, // Task 7
  "new-session": () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
};

window.addEventListener("keydown", (e) => {
  const id = matchHotkey(e);
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
  if (!ok) alertModal("Не найден исполняемый файл claude. Укажите путь через переменную окружения COWORK_CLAUDE_PATH и перезапустите приложение.");
});
