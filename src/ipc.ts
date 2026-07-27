import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `waitingInput` — заблокирована до решения человека (запрос разрешения).
 *  `done` — агент доделал ход, приглашение свободно: ничего не блокирует,
 *  но работа была сделана, поэтому об этом стоит уведомить. */
export type SessionState = "idle" | "working" | "waitingInput" | "done" | "ended" | "error";
/** Привязка воркспейса к GitHub-аккаунту. Здесь только имя аккаунта —
 *  публичное значение. Токены приложение не хранит: они читаются из keyring
 *  `gh` на старте сессии и живут лишь в памяти дочернего процесса. */
export interface WorkspaceGithub {
  host: string;
  login: string;
  gitName?: string;
  gitEmail?: string;
  sshKey?: string;
}
export interface Workspace {
  id: string; name: string; path: string; color: string;
  github?: WorkspaceGithub | null;
}
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };
/** Schedule definition stored on the scenario. `defaults` carries one value per
 *  `{{placeholder}}` — a scheduled run is unattended and cannot ask. */
export interface Schedule { preset: SchedulePreset; defaults: Record<string, string>; enabled: boolean; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; schedule?: Schedule | null; }
export interface SessionEntry {
  sessionId: string; cwd: string; name: string; workspaceId?: string;
  /** Set when the session came from a schedule — re-arms the overlap guard
   *  on restore, so catch-up cannot duplicate a run that is already back. */
  scheduledSkillId?: string;
}
export interface UiState { activeWorkspaceId: string | null; }
/** Runtime record of a scenario's scheduled runs, owned by the backend.
 *  `lastAttempt` is the occurrence last emitted; `lastRun` only advances when
 *  a session actually started. Epoch millis. */
export interface ScheduleRun {
  lastAttempt: number; lastRun: number | null; lastOutcome: string | null;
  /** Next firing time, computed by the backend — the side that actually
   *  fires. Absent when the schedule is off. */
  nextRunMs?: number | null;
}

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (ws: Workspace) => invoke<Workspace[]>("save_workspace", { ws });
export const removeWorkspace = (id: string) => invoke<Workspace[]>("remove_workspace", { id });
export const loadUiState = () => invoke<UiState>("load_ui_state");
export const saveUiState = (ui: UiState) => invoke<void>("save_ui_state", { ui });
export const listSkills = () => invoke<Skill[]>("list_skills");
export const saveSkill = (sk: Skill) => invoke<Skill[]>("save_skill", { sk });
export const removeSkill = (id: string) => invoke<Skill[]>("remove_skill", { id });
export const claudeAvailable = () => invoke<boolean>("claude_available");

export interface GhAccount { host: string; login: string; active: boolean; scopes: string[]; state: string; }
export interface GhStatus { path: string | null; version: string | null; accounts: GhAccount[]; }
export interface HostPlatform { os: "macos" | "windows" | "linux"; distro: string | null; }

export const ghStatus = () => invoke<GhStatus>("gh_status");
export const hostPlatform = () => invoke<HostPlatform>("host_platform");

/** Исход привязки аккаунта для стартовавшей сессии. Токена тут нет: только имя
 *  аккаунта и, если резолв не удался, причина — её показывает бейдж на тайле. */
export interface SessionAuth { account: string | null; degraded: string | null; }

export const startSession = (
  session: string, cwd: string, initialPrompt: string | null, cols: number, rows: number,
  resume: boolean, workspaceId?: string | null,
) => invoke<SessionAuth>("start_session", {
  session, cwd, initialPrompt, cols, rows, resume, workspaceId: workspaceId ?? null,
});
/** Разовый запуск пользовательской команды в тайле-терминале (установка gh,
 *  `gh auth login`). Не сессия агента: хуков состояния нет. */
export const startCommandSession = (
  session: string, cwd: string, command: string, cols: number, rows: number,
) => invoke<void>("start_command_session", { session, cwd, command, cols, rows });
export const writeSession = (session: string, data: string) => invoke<void>("write_session", { session, data });
export const resizeSession = (session: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { session, cols, rows });
export const closeSession = (session: string) => invoke<void>("close_session", { session });
export const loadLayout = () => invoke<SessionEntry[]>("load_layout");
export const saveLayout = (sessions: SessionEntry[]) => invoke<void>("save_layout", { sessions });

export function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const onOutput = (cb: (session: string, text: string) => void): Promise<UnlistenFn> =>
  listen<{ session: string; dataB64: string }>("session://output", (e) =>
    cb(e.payload.session, decodeB64(e.payload.dataB64)));
export const onState = (cb: (session: string, state: SessionState) => void): Promise<UnlistenFn> =>
  listen<{ session: string; state: SessionState }>("session://state", (e) =>
    cb(e.payload.session, e.payload.state));
export const onExit = (cb: (session: string, ok: boolean) => void): Promise<UnlistenFn> =>
  listen<{ session: string; ok: boolean }>("session://exit", (e) =>
    cb(e.payload.session, e.payload.ok));

/** Released once, after the fire listener below is attached, so the backend
 *  scheduler's first (catch-up) tick has somewhere to land. */
export const schedulerReady = () => invoke<void>("scheduler_ready");
export const onScheduledFire = (
  cb: (skillId: string, occurrenceMs: number, catchUp: boolean) => void,
): Promise<UnlistenFn> =>
  listen<{ skillId: string; occurrenceMs: number; catchUp: boolean }>("schedule://fire", (e) =>
    cb(e.payload.skillId, e.payload.occurrenceMs, e.payload.catchUp ?? false));

/** Report what a fire produced. The backend records only that it attempted a
 *  run; `lastRun` advances only when this says a session actually started. */
export const scheduleAck = (skillId: string, occurrenceMs: number, outcome: string) =>
  invoke<void>("schedule_ack", { skillId, occurrenceMs, outcome });
/** Runtime schedule state, keyed by scenario id. The backend owns it — the
 *  frontend must not compute "did this run" from anything else. */
export const loadScheduleState = () => invoke<Record<string, ScheduleRun>>("load_schedule_state");
/** The scheduler could not persist its state, which means nothing will fire
 *  until it can. */
export const onSchedulerBroken = (cb: (message: string) => void): Promise<UnlistenFn> =>
  listen<string>("schedule://broken", (e) => cb(e.payload));

export interface GitStatus { branch: string | null; dirty: boolean; }
export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number; }
export const gitStatus = (cwd: string) => invoke<GitStatus>("git_status", { cwd });
export const sessionTokens = (sessionId: string) => invoke<TokenUsage>("session_tokens", { sessionId });
