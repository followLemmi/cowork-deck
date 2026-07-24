import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, loadLayout } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { resolvePrompt } from "./placeholders";
import { placeholderForm } from "./forms";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ сессия"; newBtn.className = "ws-add";
sidebar.append(wsMount, skMount, newBtn, listMount);

const deck = new Deck(deckEl, listMount, () => workspaces.all);
deck.wireNotificationFocus();
async function boot() {
  await deck.wireEvents();
  await workspaces.load();
  skills.load();
  const entries = await loadLayout();
  if (entries.length) await deck.restore(entries);
}

// Clicking the floating status pill raises the main window (same raise
// sequence as notify.ts's OS-notification click handler) and focuses the
// next session that's waiting for input.
void listen("pill://focus-next", async () => {
  const w = getCurrentWindow();
  await w.unminimize().catch(() => {});
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
  deck.focusNextWaiting();
});

// NOTE: `workspaces.active` is read live (via the getter) at every launch point
// instead of caching the workspace passed to onSelect, because
// WorkspacesPanel.del() does not re-fire onSelect when the active workspace
// is the one being deleted — a cached variable could go stale and point at
// a deleted workspace's path. Reading `workspaces.active` at click time keeps
// us in sync with whatever del()/select() last did.
const workspaces = new WorkspacesPanel(wsMount, () => {});
const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, async (skill) => {
  const ws = workspaces.active;
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
});
newBtn.onclick = () => {
  const ws = workspaces.active;
  if (ws) deck.launch(ws, null);
};

function paletteCommands(): Command[] {
  return [
    { id: "new-session", title: "Новая сессия", run: () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); } },
    { id: "close-active", title: "Закрыть активную сессию", run: () => deck.closeActive() },
    { id: "next-waiting", title: "К следующей ждущей вводу", run: () => deck.focusNextWaiting() },
    { id: "search", title: "Поиск в терминале", run: () => deck.searchActive() },
    { id: "clear", title: "Очистить терминал", run: () => deck.clearActive() },
    { id: "broadcast", title: "Режим broadcast (ввод в несколько сессий)", run: () => deck.toggleBroadcast() },
  ];
}

const COMMANDS: Record<string, () => void> = {
  "palette": () => openPalette(paletteCommands()),
  "new-session": () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
  "broadcast": () => deck.toggleBroadcast(),
};

window.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-overlay")) return; // не перехватываем, пока открыта модалка/палитра/форма
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

claudeAvailable().then((ok) => {
  if (!ok) alertModal("Не найден исполняемый файл claude. Укажите путь через переменную окружения COWORK_CLAUDE_PATH и перезапустите приложение.");
});

void boot();
