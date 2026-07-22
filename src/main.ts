import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, getSettings, saveSettings } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ сессия"; newBtn.className = "ws-add";

const settingsWrap = document.createElement("div");
settingsWrap.className = "settings-field";
const settingsLabel = document.createElement("label");
settingsLabel.textContent = "Команда терминала";
const settingsInput = document.createElement("input");
settingsInput.type = "text";
settingsInput.placeholder = "(системный по умолчанию)";
settingsWrap.append(settingsLabel, settingsInput);

sidebar.append(wsMount, skMount, newBtn, settingsWrap, listMount);

getSettings().then((s) => { settingsInput.value = s.terminalCommand; });
settingsInput.addEventListener("blur", () => {
  void saveSettings({ terminalCommand: settingsInput.value.trim() });
});

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

claudeAvailable().then((ok) => {
  if (!ok) alert("Не найден исполняемый файл claude. Укажите путь через переменную окружения COWORK_CLAUDE_PATH и перезапустите приложение.");
});
