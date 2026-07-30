import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `waitingInput` — blocked until a human decides (a permission request).
 *  `done` — the agent finished its turn and the prompt is free: nothing is
 *  blocked, but work got done, which is worth a notification. */
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
  tracker?: TrackerConfig | null;
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
  /** Set when the session was launched from a tracker card. */
  taskId?: string;
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

/** Four distinct check states. `none` is not `passed`: nothing has built this.
 *  Mirrors `gh_pr::ChecksSummary`, tagged on `kind`. */
export type ChecksSummary =
  | { kind: "none" }
  | { kind: "running"; done: number; total: number }
  | { kind: "passed"; total: number }
  | { kind: "failed"; failed: number; total: number };

export interface PullRequest {
  number: number;
  title: string;
  /** Empty when the author's account is gone. */
  author: string;
  isDraft: boolean;
  headRefName: string;
  /** What a merge is pinned to — see `prMerge`. */
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  reviewDecision: string | null;
  checks: ChecksSummary;
  mergeable: string;
  mergeStateStatus: string;
  updatedAt: string;
  url: string;
  labels: string[];
}

export interface MergeOptions {
  /** Only what this repository permits. Can be empty — a repository may allow
   *  no strategy at all, and then `default` carries nothing usable either. */
  strategies: ("merge" | "squash" | "rebase")[];
  default: "merge" | "squash" | "rebase";
  /** The repository deletes merged branches itself; the dialog says so rather
   *  than offering a checkbox that misdescribes what happens. */
  repoDeletesBranch: boolean;
}

export const prList = (workspaceId: string) =>
  invoke<PullRequest[]>("pr_list", { workspaceId });
export const prMergeOptions = (workspaceId: string) =>
  invoke<MergeOptions>("pr_merge_options", { workspaceId });
/** `headOid` pins the merge to the commit that was reviewed: the backend passes
 *  it to `gh pr merge --match-head-commit`, so a push that lands mid-review
 *  makes this fail rather than merge something nobody looked at. */
export const prMerge = (
  workspaceId: string, number: number, strategy: string, headOid: string, deleteBranch: boolean,
) => invoke<void>("pr_merge", { workspaceId, number, strategy, headOid, deleteBranch });
export const prClose = (workspaceId: string, number: number) =>
  invoke<void>("pr_close", { workspaceId, number });
export const prReopen = (workspaceId: string, number: number) =>
  invoke<void>("pr_reopen", { workspaceId, number });
/** Resolves to the path of the worktree that now holds the PR's branch. */
export const prWorktreePath = (workspaceId: string, number: number, branch: string) =>
  invoke<string | null>("pr_worktree_path", { workspaceId, number, branch });
export const prWorktreeAdd = (workspaceId: string, number: number, branch: string) =>
  invoke<string>("pr_worktree_add", { workspaceId, number, branch });
export const prWorktreeRemove = (workspaceId: string, number: number, branch: string) =>
  invoke<void>("pr_worktree_remove", { workspaceId, number, branch });

/** Исход привязки аккаунта для стартовавшей сессии. Токена тут нет: только имя
 *  аккаунта и, если резолв не удался, причина — её показывает бейдж на тайле. */
export interface SessionAuth { account: string | null; degraded: string | null; }

export const startSession = (
  session: string, cwd: string, workspaceId: string | null, initialPrompt: string | null,
  taskId: string | null, cols: number, rows: number, resume: boolean,
) => invoke<SessionAuth>("start_session", {
  session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume,
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

/** A step id and a kind id are whatever `board.json` says they are — the
 *  frontend never enumerates them, it reads them (see src/board-config.ts). */
export type StepId = string;
export type KindId = string;
export type TaskOrigin = "human" | "session";

export interface BoardStep { id: StepId; label: string; terminal?: boolean; working?: boolean }
export interface BoardKind { id: KindId; label: string }
export interface BoardConfig { v: number; steps: BoardStep[]; kinds: BoardKind[] }

export interface Task {
  id: string; title: string; kind: KindId; status: StepId; project: string;
  created: string; resolved: string | null; origin: TaskOrigin; session: string | null;
  body: string; path: string;
  /** Why the card could not be parsed in full. Shown, not hidden. */
  damaged: string | null;
  /** More than one file carries this id. */
  conflict: boolean;
}
// project/origin are set by the backend (workspace name / "human") and are
// deliberately not settable from here — see tasks_cmd::TaskDraftInput.
export interface TaskDraft { title: string; kind: KindId; body: string; }
/** Which fields of a card to write. Every field optional: Save applies only
 *  what the person touched, and a step-only move (drag-and-drop, `‹`/`›`) is a
 *  patch carrying only `status` — see tasks_cmd::tasks_update. */
export interface TaskPatch { title?: string; kind?: KindId; status?: StepId; body?: string }
/** Capabilities and the board configuration arrive together, flattened into one
 *  object by `tasks_cmd::BoardCapabilities`: the board, the card modal and the
 *  ⚙ editor all read the same thing, so there is no second channel to fall out
 *  of step with the first. */
export interface ProviderCapabilities {
  canCreate: boolean;
  canResolve: boolean;
  statuses: StepId[];
  board: BoardConfig;
  /** Why `board.json` could not be used, when it could not. The board draws
   *  either way; the person has to be told which they are looking at. */
  boardError: string | null;
}
export type TrackerRoot = { kind: "project" } | { kind: "path"; path: string };
export interface TrackerConfig { providers: { type: "fs"; root: TrackerRoot }[] }

export const listTasks = (workspaceId: string) => invoke<Task[]>("tasks_list", { workspaceId });
export const createTask = (workspaceId: string, draft: TaskDraft) =>
  invoke<Task>("tasks_create", { workspaceId, draft });
export const resolveTask = (workspaceId: string, id: string) =>
  invoke<Task>("tasks_resolve", { workspaceId, id });
export const updateTask = (workspaceId: string, id: string, patch: TaskPatch) =>
  invoke<Task>("tasks_update", { workspaceId, id, patch });
export const taskCapabilities = (workspaceId: string) =>
  invoke<ProviderCapabilities | null>("tasks_capabilities", { workspaceId });
export const taskOpenCounts = () => invoke<Record<string, number>>("tasks_open_counts");
export const taskWatchSync = () => invoke<void>("tasks_watch_sync");
/** A pending move of this workspace's cards from where they used to live. */
export interface MigrationOffer {
  from: string; to: string;
  moving: number;
  leavingForeign: number;
  leavingDamaged: number;
  /** Whether `project:` inside the moved cards will be rewritten. */
  renamingProject: boolean;
}
export type SkipReason =
  | { kind: "alreadyAtDestination" }
  | { kind: "failed"; detail: string };
export interface MigrationReport {
  moved: number;
  skipped: { fileName: string; reason: SkipReason }[];
}

export const taskMigrationStatus = (workspaceId: string) =>
  invoke<MigrationOffer | null>("tasks_migration_status", { workspaceId });
export const taskMigrate = (workspaceId: string) =>
  invoke<MigrationReport>("tasks_migrate", { workspaceId });
export const taskMigrationDismiss = (workspaceId: string) =>
  invoke<void>("tasks_migration_dismiss", { workspaceId });

/** What configuring a picked folder would resolve to, and what it would create. */
export interface TrackerRootPreview {
  root: string;
  /** Single folder names, outermost first, that do not exist yet. */
  creating: string[];
  /** The picked folder itself is absent, so nothing will be created. */
  baseMissing: boolean;
}

export const trackerRootPreview = (workspaceName: string, pickedPath: string) =>
  invoke<TrackerRootPreview>("tracker_root_preview", { workspaceName, pickedPath });

export const onTasksChanged = (cb: (workspaceId: string) => void): Promise<UnlistenFn> =>
  listen<{ workspaceId: string }>("tasks://changed", (e) => cb(e.payload.workspaceId));

/** How many of this project's cards currently sit in one step — including a
 *  step the configuration no longer lists, since the ⚙ editor needs to know a
 *  step is occupied precisely when it is about to disappear. */
export interface StepUsage { step: StepId; count: number }
/** A card that could not be moved by a step rewrite, and why. */
export interface RewriteSkip { fileName: string; reason: string }
/** What a step rename or removal left behind: how many cards moved, and which
 *  ones could not be. */
export interface RewriteReport { rewritten: number; skipped: RewriteSkip[] }

export const boardConfigSave = (workspaceId: string, config: BoardConfig) =>
  invoke<void>("board_config_save", { workspaceId, config });
/** `config` is the draft the ⚙ editor is about to save, not whatever
 *  board.json currently holds: a rename's target id is not yet on disk, and
 *  validating `to` against the on-disk file would refuse every card of it —
 *  see tasks_cmd::rewrite_step's docstring on the Rust side. */
export const boardStepRewrite = (workspaceId: string, from: StepId, to: StepId, config: BoardConfig) =>
  invoke<RewriteReport>("board_step_rewrite", { workspaceId, from, to, config });
export const boardStepUsage = (workspaceId: string) =>
  invoke<StepUsage[]>("board_step_usage", { workspaceId });
