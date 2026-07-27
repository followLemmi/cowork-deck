import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SessionState = "idle" | "working" | "waitingInput" | "ended" | "error";
export interface Workspace { id: string; name: string; path: string; color: string; tracker?: TrackerConfig | null; }
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };
/** Schedule definition stored on the scenario. `defaults` carries one value per
 *  `{{placeholder}}` — a scheduled run is unattended and cannot ask. */
export interface Schedule { preset: SchedulePreset; defaults: Record<string, string>; enabled: boolean; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; schedule?: Schedule | null; }
export interface SessionEntry { sessionId: string; cwd: string; name: string; workspaceId?: string; }
export interface UiState { activeWorkspaceId: string | null; }

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (ws: Workspace) => invoke<Workspace[]>("save_workspace", { ws });
export const removeWorkspace = (id: string) => invoke<Workspace[]>("remove_workspace", { id });
export const loadUiState = () => invoke<UiState>("load_ui_state");
export const saveUiState = (ui: UiState) => invoke<void>("save_ui_state", { ui });
export const listSkills = () => invoke<Skill[]>("list_skills");
export const saveSkill = (sk: Skill) => invoke<Skill[]>("save_skill", { sk });
export const removeSkill = (id: string) => invoke<Skill[]>("remove_skill", { id });
export const claudeAvailable = () => invoke<boolean>("claude_available");

export const startSession = (
  session: string, cwd: string, initialPrompt: string | null, cols: number, rows: number, resume: boolean,
) => invoke<void>("start_session", { session, cwd, initialPrompt, cols, rows, resume });
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
export const onScheduledFire = (cb: (skillId: string) => void): Promise<UnlistenFn> =>
  listen<{ skillId: string }>("schedule://fire", (e) => cb(e.payload.skillId));

export interface GitStatus { branch: string | null; dirty: boolean; }
export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number; }
export const gitStatus = (cwd: string) => invoke<GitStatus>("git_status", { cwd });
export const sessionTokens = (sessionId: string) => invoke<TokenUsage>("session_tokens", { sessionId });

export type TaskKind = "bug" | "task" | "idea";
export type TaskStatus = "open" | "done";
export type TaskOrigin = "human" | "session";

export interface Task {
  id: string; title: string; kind: TaskKind; status: TaskStatus; project: string;
  created: string; resolved: string | null; origin: TaskOrigin; session: string | null;
  body: string; path: string;
  /** Причина, если карточку не удалось разобрать до конца. Показывается, не скрывается. */
  damaged: string | null;
  /** Больше одного файла с этим id. */
  conflict: boolean;
}
// project/origin are set by the backend (workspace name / "human") and are
// deliberately not settable from here — see tasks_cmd::TaskDraftInput.
export interface TaskDraft { title: string; kind: TaskKind; body: string; }
export interface ProviderCapabilities { canCreate: boolean; canResolve: boolean; statuses: string[] }
export type TrackerRoot = { kind: "project" } | { kind: "path"; path: string };
export interface TrackerConfig { providers: { type: "fs"; root: TrackerRoot }[] }

export const listTasks = (workspaceId: string) => invoke<Task[]>("tasks_list", { workspaceId });
export const createTask = (workspaceId: string, draft: TaskDraft) =>
  invoke<Task>("tasks_create", { workspaceId, draft });
export const resolveTask = (workspaceId: string, id: string) =>
  invoke<Task>("tasks_resolve", { workspaceId, id });
export const taskCapabilities = (workspaceId: string) =>
  invoke<ProviderCapabilities | null>("tasks_capabilities", { workspaceId });
export const taskOpenCounts = () => invoke<Record<string, number>>("tasks_open_counts");
