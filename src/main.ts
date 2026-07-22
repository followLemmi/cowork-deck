import { WorkspacesPanel } from "./workspaces";
import type { Workspace } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const wsMount = document.createElement("div");
sidebar.appendChild(wsMount);

let activeWorkspace: Workspace | null = null;
const workspaces = new WorkspacesPanel(wsMount, (ws) => { activeWorkspace = ws; });
workspaces.load();
