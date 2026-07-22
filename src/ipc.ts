import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SessionState = "idle" | "working" | "waitingInput" | "ended" | "error";
export interface Workspace { id: string; name: string; path: string; color: string; }
export interface Skill { id: string; name: string; icon: string; prompt: string; workspaceId?: string | null; }
export interface Settings { terminalCommand: string; }

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (ws: Workspace) => invoke<Workspace[]>("save_workspace", { ws });
export const removeWorkspace = (id: string) => invoke<Workspace[]>("remove_workspace", { id });
export const listSkills = () => invoke<Skill[]>("list_skills");
export const saveSkill = (sk: Skill) => invoke<Skill[]>("save_skill", { sk });
export const removeSkill = (id: string) => invoke<Skill[]>("remove_skill", { id });
export const claudeAvailable = () => invoke<boolean>("claude_available");

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const launchSession = (session: string, cwd: string, initialPrompt: string | null) =>
  invoke<void>("launch_session", { session, cwd, initialPrompt });
export const closeSession = (session: string) => invoke<void>("close_session", { session });

export const onState = (cb: (session: string, state: SessionState) => void): Promise<UnlistenFn> =>
  listen<{ session: string; state: SessionState }>("session://state", (e) =>
    cb(e.payload.session, e.payload.state));
