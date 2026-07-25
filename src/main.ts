import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, loadLayout, onScheduledFire, schedulerReady } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
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
  await onScheduledFire((skillId) => { void handleScheduledFire(skillId); });
  await workspaces.load();
  await skills.load();
  const entries = await loadLayout();
  if (entries.length) await deck.restore(entries);
  deck.setActiveWorkspace(workspaces.active?.id ?? null);
  // Release the backend scheduler only once skills/workspaces are loaded, so a
  // catch-up fire arriving immediately can be resolved to a scenario.
  await schedulerReady();
}

/** A scheduled scenario came due in the backend: resolve it to a scenario +
 *  workspace, fill placeholder defaults (a scheduled run cannot ask) and
 *  launch it as a fresh tile. */
async function handleScheduledFire(skillId: string) {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return;
  // Scenario pinned to a workspace runs there; a workspace-agnostic scenario
  // runs in the active one (as a manual launch would). A pinned workspace that
  // no longer exists is skipped rather than run in the wrong folder.
  const ws = skill.workspaceId
    ? workspaces.all.find((w) => w.id === skill.workspaceId) ?? null
    : workspaces.active;
  if (!ws) { console.warn("scheduled fire: no workspace for", skillId); return; }
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  await deck.launchScheduled(ws, skill, filled);
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

// Selecting a workspace (click, startup restore of the active one, or after a
// deletion re-selects the next one) switches the deck to that workspace's tiles.
const workspaces = new WorkspacesPanel(wsMount, (ws) => deck.setActiveWorkspace(ws.id));
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
  if (e.key === "Escape" && deck.exitZoom()) { e.preventDefault(); return; }
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
