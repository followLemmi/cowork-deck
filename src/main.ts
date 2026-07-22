import { WorkspacesPanel } from "./workspaces";
import { SkillsPanel } from "./skills";
import type { Workspace } from "./ipc";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const wsMount = document.createElement("div");
const skMount = document.createElement("div");
sidebar.append(wsMount, skMount);

let activeWorkspace: Workspace | null = null;
const workspaces = new WorkspacesPanel(wsMount, (ws) => { activeWorkspace = ws; });
const skills = new SkillsPanel(skMount, () => activeWorkspace?.id ?? null, (skill) => {
  console.log("launch skill", skill.name, "in", activeWorkspace?.path);
});
workspaces.load();
skills.load();
