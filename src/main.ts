import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, loadLayout, onScheduledFire, schedulerReady } from "./ipc";
import type { Skill } from "./ipc";
import { BoardView } from "./board";
import {
  listTasks, resolveTask, taskCapabilities, taskOpenCounts, onTasksChanged, taskWatchSync, createTask,
} from "./ipc";
import type { Task } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
import { taskPrompt } from "./tasks";
import { resolveScheduledWorkspace } from "./schedule";
import { placeholderForm, taskForm } from "./forms";
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

const boardEl = document.querySelector<HTMLElement>("#board")!;

// Переключатель «Терминалы | Доска»: доска берёт всю ширину, потому что позже
// сюда приедут доски GitHub/Jira, которым нужно место, а не полоска.
const views = document.createElement("div");
views.className = "tk-views";
const termBtn = document.createElement("button");
termBtn.textContent = "Терминалы"; termBtn.className = "active";
const boardBtn = document.createElement("button");
boardBtn.textContent = "Доска";
views.append(termBtn, boardBtn);
sidebar.prepend(views);

const board = new BoardView({
  onLaunch: (t) => void launchFromTask(t),
  onResolve: (t) => void closeTask(t),
  onNew: () => void captureTask(),
  onConfigure: () => void alertModal(
    "Настройте трекер в свойствах пространства (✎): каталог в проекте или свой путь."),
});
boardEl.append(board.mount);

let boardVisible = false;
let boardTimer: ReturnType<typeof setInterval> | null = null;

function setView(showBoard: boolean) {
  boardVisible = showBoard;
  deckEl.classList.toggle("tk-hidden", showBoard);
  boardEl.classList.toggle("hidden", !showBoard);
  termBtn.classList.toggle("active", !showBoard);
  boardBtn.classList.toggle("active", showBoard);
  if (showBoard) {
    void refreshBoard();
    // Опрос — основной путь обновления; watcher лишь ускоряет его, поэтому
    // его отказ деградирует в задержку и не требует детекции.
    if (boardTimer === null) boardTimer = setInterval(() => void refreshBoard(), 5000);
  } else if (boardTimer !== null) {
    clearInterval(boardTimer); boardTimer = null;
  }
}
termBtn.onclick = () => setView(false);
boardBtn.onclick = () => setView(true);

const deck = new Deck(deckEl, listMount, () => workspaces.all);
deck.wireNotificationFocus();
async function boot() {
  await deck.wireEvents();
  await onScheduledFire((skillId) => {
    void handleScheduledFire(skillId).then((outcome) => {
      if (outcome !== "launched") console.warn("scheduled fire not launched:", skillId, outcome);
    });
  });
  await workspaces.load();
  await skills.load();
  await onTasksChanged((workspaceId) => {
    if (boardVisible && workspaces.active?.id === workspaceId) void refreshBoard();
    void refreshCounts();
  });
  await taskWatchSync();
  await refreshCounts();
  const entries = await loadLayout();
  if (entries.length) await deck.restore(entries);
  deck.setActiveWorkspace(workspaces.active?.id ?? null);
  // Release the backend scheduler only once skills/workspaces are loaded, so a
  // catch-up fire arriving immediately can be resolved to a scenario.
  await schedulerReady();
}

/** Быстрый захват: модалка, карточка в активное пространство, доска и
 *  счётчики обновляются сразу, не дожидаясь watcher'а. */
async function captureTask() {
  const ws = workspaces.active;
  if (!ws) { await alertModal("Выберите пространство."); return; }
  const caps = await taskCapabilities(ws.id).catch(() => null);
  if (!caps?.canCreate) {
    await alertModal("Трекер не настроен для этого пространства. Настройте его в свойствах пространства (✎).");
    return;
  }
  const draft = await taskForm();
  if (!draft) return;
  try {
    await createTask(ws.id, draft);
  } catch (e) {
    await alertModal(`Не удалось создать задачу: ${String(e)}`);
    return;
  }
  if (boardVisible) await refreshBoard();
  await refreshCounts();
}
/** ▶ на карточке. Пространство берётся из `project:` карточки, а не активное:
 *  на общем корне (например, папка волта на три проекта) активное пространство
 *  уронило бы работу в чужой каталог. */
async function launchFromTask(t: Task) {
  const target = workspaces.all.find((w) => w.name === t.project);
  if (!target) {
    await alertModal(
      `Не найдено пространство с именем «${t.project}» из поля project: карточки. ` +
      `Переименовано пространство? Запуск отменён, чтобы не начать работу в чужом каталоге.`);
    return;
  }
  const outcome = await deck.launchFromTask(target, t, taskPrompt(t));
  if (outcome === "launched") setView(false); // показать поднятый терминал
  if (boardVisible) await refreshBoard();
}

/** Перерисовать доску активного пространства. Каждый вызов IPC изолирован:
 *  одна упавшая ручка не должна ронять весь тик. */
async function refreshBoard() {
  const ws = workspaces.active;
  if (!ws) {
    board.render({ project: "", caps: null, error: null, tasks: [], links: [] });
    return;
  }
  const wsId = ws.id;
  let caps = null;
  try { caps = await taskCapabilities(wsId); } catch (e) { console.debug("caps failed", e); }
  let tasks: Task[] = [];
  let error: string | null = null;
  if (caps) {
    try { tasks = await listTasks(wsId); }
    catch (e) { error = String(e); }
  }
  // Пространство могли переключить, пока мы ждали IPC: поздний ответ не должен
  // перерисовать доску данными чужого пространства поверх актуальных.
  if (workspaces.active?.id !== wsId) return;
  board.render({ project: ws.name, caps, error, tasks, links: deck.taskLinks() });
}

/** Счётчики в сайдбаре — одна ручка на все пространства. */
async function refreshCounts() {
  try { workspaces.setCounts(await taskOpenCounts()); }
  catch (e) { console.debug("taskOpenCounts failed", e); }
}

async function closeTask(t: Task) {
  const ws = workspaces.active;
  if (!ws) return;
  try { await resolveTask(ws.id, t.id); }
  catch (e) { await alertModal(`Не удалось закрыть задачу: ${String(e)}`); }
  await refreshBoard();
  await refreshCounts();
}

/** Why a scheduled fire did or did not produce a run. The backend-driven path
 *  only logs it; a user-initiated run surfaces it in a modal. */
type FireOutcome = "launched" | "skipped-overlap" | "no-workspace" | "not-scheduled";

/** A scheduled scenario came due (from the backend scheduler or from the ⏰
 *  button): resolve it to a scenario + workspace, fill placeholder defaults (a
 *  scheduled run cannot ask) and launch it as a fresh tile. */
async function handleScheduledFire(skillId: string): Promise<FireOutcome> {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return "not-scheduled";
  const res = resolveScheduledWorkspace(skill, workspaces.all, workspaces.active);
  if (!res.ok) return res.reason;
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  const launched = await deck.launchScheduled(res.workspace, skill, filled);
  return launched ? "launched" : "skipped-overlap";
}

/** ⏰ button: run a scheduled scenario now, exactly as the schedule would. The
 *  schedule itself is untouched — `lastRun` is written only by the backend
 *  loop, so the regular occurrence still fires. Unlike a backend-driven fire,
 *  a click must say why nothing happened. */
async function runScheduledNow(skill: Skill) {
  const outcome = await handleScheduledFire(skill.id);
  if (outcome === "skipped-overlap") {
    await alertModal("Прогон пропущен: предыдущий ещё активен.");
  } else if (outcome === "no-workspace") {
    await alertModal("У сценария нет доступного пространства: привяжите его или выберите пространство.");
  }
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
const workspaces = new WorkspacesPanel(wsMount, (ws) => {
  deck.setActiveWorkspace(ws.id);
  if (boardVisible) void refreshBoard();
});
const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, async (skill) => {
  const ws = workspaces.active;
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
}, (skill) => { void runScheduledNow(skill); });
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
    { id: "board", title: "Открыть доску задач", run: () => setView(true) },
    { id: "new-task", title: "Новая задача", run: () => { void captureTask(); } },
  ];
}

const COMMANDS: Record<string, () => void> = {
  "palette": () => openPalette(paletteCommands()),
  "new-session": () => { const ws = workspaces.active; if (ws) deck.launch(ws, null); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
  "broadcast": () => deck.toggleBroadcast(),
  "board": () => setView(true),
  "new-task": () => { void captureTask(); },
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
