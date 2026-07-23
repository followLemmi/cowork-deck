import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SessionState = "idle" | "working" | "waitingInput" | "ended" | "error";
export interface Workspace { id: string; name: string; path: string; color: string; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; }
export interface SessionEntry { sessionId: string; cwd: string; name: string; }
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
