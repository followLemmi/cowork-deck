import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import { Deck } from "./sessions";
import { claudeAvailable, loadLayout, onScheduledFire, scheduleAck, schedulerReady } from "./ipc";
import type { Skill, Workspace } from "./ipc";
import { alertModal } from "./modal";
import { matchHotkey, isMacPlatform } from "./commands";
import type { Command } from "./commands";
import { openPalette } from "./palette";
import { runBoot } from "./boot";
import { installSprite } from "./icons";
import { resolvePrompt, fillPlaceholders } from "./placeholders";
import { resolveScheduledWorkspace } from "./schedule";
import { placeholderForm } from "./forms";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

installSprite();
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const deckEl = document.querySelector<HTMLElement>("#deck")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
const listMount = document.createElement("div");
const newBtn = document.createElement("button");
newBtn.textContent = "+ сессия"; newBtn.className = "btn-primary";
sidebar.append(wsMount, skMount, newBtn, listMount);

const deck = new Deck(deckEl, listMount, () => workspaces.all);
deck.wireNotificationFocus();
const boot = () => runBoot({
  steps: [
    () => deck.wireEvents(),
    () => onScheduledFire((skillId, occurrenceMs, catchUp) => {
      const missedAt = catchUp
        ? new Date(occurrenceMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : undefined;
      void handleScheduledFire(skillId, missedAt).then(async (outcome) => {
        if (outcome !== "launched") console.warn("scheduled fire not launched:", skillId, outcome);
        // Tell the backend what came of it: an occurrence it emitted counts as
        // a run only once a session has actually started.
        await scheduleAck(skillId, occurrenceMs, outcome).catch((e) =>
          console.warn("schedule ack failed:", skillId, e));
        // Show the outcome in the scenario row now, rather than at the next
        // minute tick — a skip or a refusal is what the user needs to see.
        await skills.refreshRuns();
      });
    }).then(() => {}),
    () => workspaces.load(),
    () => skills.load(),
    async () => {
      const entries = await loadLayout();
      if (entries.length) await deck.restore(entries);
    },
    () => { deck.setActiveWorkspace(workspaces.active?.id ?? null); },
  ],
  // Sent last so a catch-up fire arriving immediately can be resolved to a
  // scenario — but sent even if a step above failed, or the scheduler stays
  // parked forever.
  releaseScheduler: schedulerReady,
  onError: (e) => {
    console.error("boot failed:", e);
    void alertModal(
      "Приложение запустилось не полностью — часть сессий или настроек могла не загрузиться. " +
      "Перезапустите приложение; если повторится, посмотрите консоль разработчика.",
    );
  },
});

/** Why a scheduled fire did or did not produce a run. The backend-driven path
 *  only logs it; a user-initiated run surfaces it in a modal. */
type FireOutcome = "launched" | "skipped-overlap" | "no-workspace" | "not-scheduled";

/** A scheduled scenario came due (from the backend scheduler or from the ⏰
 *  button): resolve it to a scenario + workspace, fill placeholder defaults (a
 *  scheduled run cannot ask) and launch it as a fresh tile. */
async function handleScheduledFire(skillId: string, catchUpFor?: string): Promise<FireOutcome> {
  const skill = skills.find(skillId);
  if (!skill?.schedule?.enabled) return "not-scheduled";
  const res = resolveScheduledWorkspace(skill, workspaces.all, workspaces.active);
  if (!res.ok) return res.reason;
  const filled = fillPlaceholders(skill.prompt, skill.schedule.defaults);
  const launched = await deck.launchScheduled(res.workspace, skill, filled, catchUpFor);
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
const workspaces = new WorkspacesPanel(wsMount, (ws) => deck.setActiveWorkspace(ws.id));
/** Every launch path needs an active workspace. Saying so beats a button that
 *  looks broken — the old behaviour was a bare `return`. */
async function requireWorkspace(): Promise<Workspace | null> {
  const ws = workspaces.active;
  if (ws) return ws;
  await alertModal(
    "Сначала выберите пространство — это папка проекта, в которой запускаются сессии. "
    + "Если пространств ещё нет, создайте его кнопкой «+ пространство».",
  );
  return null;
}

const skills = new SkillsPanel(skMount, () => workspaces.active?.id ?? null, async (skill) => {
  const ws = await requireWorkspace();
  if (!ws) return;
  const prompt = await resolvePrompt(skill.prompt, placeholderForm);
  if (prompt === null) return;
  deck.launch(ws, { ...skill, prompt });
}, (skill) => { void runScheduledNow(skill); }, () => workspaces.all.map((w) => w.id),
   () => workspaces.active?.name ?? null);
// Deleting a workspace strands the scenarios pinned to it — the confirmation
// says how many before it happens.
workspaces.setSkillsSource(() => skills.all);
const newSession = async () => {
  const ws = await requireWorkspace();
  if (ws) await deck.launch(ws, null);
};
newBtn.onclick = () => { void newSession(); };

/** Human-readable binding for the palette. Filled in because the `hotkey`
 *  field existed on Command from the start and was never populated, so the
 *  palette — and with it every binding, including Cmd+K itself — was
 *  undiscoverable. */
function hotkeyLabel(letter: string): string {
  return isMacPlatform() ? `Cmd+${letter}` : `Ctrl+Shift+${letter}`;
}

function paletteCommands(): Command[] {
  return [
    { id: "new-session", title: "Новая сессия", hotkey: hotkeyLabel("N"), run: () => { void newSession(); } },
    { id: "close-active", title: "Закрыть активную сессию", hotkey: hotkeyLabel("W"), run: () => deck.closeActive() },
    { id: "next-waiting", title: "К следующей ждущей вводу", hotkey: isMacPlatform() ? "Cmd+Shift+]" : "Ctrl+Shift+]", run: () => deck.focusNextWaiting() },
    { id: "zoom", title: "Развернуть активную сессию", hotkey: isMacPlatform() ? "Cmd+Enter" : "Ctrl+Shift+Enter", run: () => deck.toggleZoomActive() },
    { id: "search", title: "Поиск в терминале", hotkey: hotkeyLabel("F"), run: () => deck.searchActive() },
    { id: "clear", title: "Очистить терминал", run: () => deck.clearActive() },
    { id: "broadcast", title: "Режим broadcast (ввод в несколько сессий)", hotkey: hotkeyLabel("B"), run: () => deck.toggleBroadcast() },
    { id: "next-region", title: "Перейти к следующей области (F6)", hotkey: "F6", run: () => cycleRegion(1) },
    { id: "scenarios", title: "Сценарии: к списку в боковой панели", run: () => focusRegion("sidebar") },
  ];
}

/** Focus cycling between the sidebar and the active terminal.
 *
 *  Without it the terminal is a one-way door: xterm consumes Tab and Shift+Tab
 *  (they go to the PTY), so once focus landed in a tile — which happens
 *  automatically on launch — the sidebar, the scenario buttons and the
 *  run-now button were unreachable by keyboard entirely. */
type Region = "sidebar" | "terminal";
const REGIONS: Region[] = ["sidebar", "terminal"];

function currentRegion(): Region {
  return sidebar.contains(document.activeElement) ? "sidebar" : "terminal";
}

function focusRegion(r: Region): void {
  if (r === "terminal") {
    if (deck.focusActiveTerminal()) return;
    // No session to go to — stay where something is focusable.
    focusRegion("sidebar");
    return;
  }
  const first = sidebar.querySelector<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  first?.focus();
}

function cycleRegion(step: number): void {
  const i = REGIONS.indexOf(currentRegion());
  focusRegion(REGIONS[(i + step + REGIONS.length) % REGIONS.length]);
}

const COMMANDS: Record<string, () => void> = {
  "palette": () => openPalette(paletteCommands()),
  "new-session": () => { void newSession(); },
  "close-active": () => deck.closeActive(),
  "search": () => deck.searchActive(),
  "next-waiting": () => deck.focusNextWaiting(),
  "broadcast": () => deck.toggleBroadcast(),
  "zoom": () => deck.toggleZoomActive(),
  "next-region": () => cycleRegion(1),
  "prev-region": () => cycleRegion(-1),
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
