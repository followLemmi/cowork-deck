import { Channel, invoke } from "@tauri-apps/api/core";
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
  /** What repository this workspace's folder is, remembered so sync can tell
   *  two records for one project apart from two projects. Written by the sync
   *  cycle, never by this side — an editor that set it would be guessing at a
   *  folder it has not read. */
  repo?: WorkspaceRepo | null;
}
/** The remote a workspace's folder points at, and the folder that was read in.
 *  Mirrors `model::WorkspaceRepo`; `url` absent means the folder was asked and
 *  has none, which is an answer rather than a gap. */
export interface WorkspaceRepo { url?: string | null; from: string }
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
  /** What a person typed for this tile. Outranks everything, including the
   *  transcript title, and is cleared by emptying the field. */
  userName?: string;
  /** What `name` above is. Absent means "context": nothing on disk tells a
   *  card name from a placeholder for an entry written before this existed,
   *  and leaving a recognised name alone is the safer of the two mistakes. */
  nameKind?: NameKind;
  /** Scenario this session was launched from, by **any** route — a click, ⏰,
   *  or a schedule. Deliberately not `scheduledSkillId` above, which means the
   *  narrower "raised by a schedule" and keys the overlap guard. Without this
   *  the backend cannot tell, after a restart, that a restored tile is a
   *  scenario run at all. */
  skillId?: string;
  /** The journal record this tile currently belongs to, so a restart can chain
   *  its new record to this one. Separate from `skillId`, or the chain
   *  degrades into guessing "the previous run of this scenario" — wrong the
   *  moment a scenario ran twice in a day. */
  runId?: string;
  /** Which agent CLI this session runs. **Absent means `claude`**, which is
   *  every entry written before this field existed and every session in them —
   *  `start_session` resolves `claude` and nothing else. Typed as `CliKind`
   *  here and as a bare string on the Rust side, deliberately: an entry naming
   *  a CLI an older build has never heard of must still restore its tile rather
   *  than fail the whole parse. */
  cliKind?: CliKind;
}
export type NameKind = "context" | "placeholder";
export interface UiState {
  activeWorkspaceId: string | null;
  /** A multiplier on the base in `styles.css`, not a pixel size — see `ui-scale.ts`.
   *  Required rather than optional: the Rust side fills it from a `serde` default, so
   *  a reader that treats it as possibly-absent is guarding against a case that
   *  cannot happen and would hide a real one. */
  uiScale: number;
  /** How wide the diff drawer is, in `ch` of the mono face — not pixels.
   *  `ui-scale.ts` moves the root between 11.05px and 18.85px, so a px width
   *  would show *fewer* code columns at 145%, which is the one thing a diff pane
   *  is for. Required for the same reason as `uiScale`: Rust fills it from a
   *  `serde` default, so an optional here would guard a case that cannot happen. */
  prDiffCols: number;
  /** Whether the offer to switch memory sync on has been waved away. Local to
   *  this machine — `ui_state.json` is not on the sync allowlist, so declining
   *  on the laptop says nothing about the desktop. */
  syncOfferDismissed: boolean;
  /** Whether scenario runs are journalled. Default on; off writes nothing new
   *  and deletes nothing already written, and reads keep working. Required for
   *  the same reason as the two above: Rust fills it from a `serde` default. */
  recordScenarioRuns: boolean;
  /** Whether closing a session writes a note about it, once the person has said.
   *  `undefined` is "never asked", which is deliberately not "no": a default
   *  either way would answer a question about spending their money on their
   *  behalf. Local to this machine — `ui_state.json` does not travel. */
  captureOnClose?: boolean;
  /** How tall the drawer is, **in rows of the terminal's own type** — not
   *  pixels, and for a sharper version of `prDiffCols`' reason: the thing being
   *  sized is a grid of characters, so "show me twenty rows" has to keep meaning
   *  twenty rows after the next text-size change. One value for the app, unlike
   *  *whether* the drawer is up, which is per workspace and lives with the tabs:
   *  the height is how much of this window to give a terminal, and that does not
   *  change with the project. */
  terminalRows: number;
  /** How wide the panel is in px, and how wide it is once it has taken the deck's
   *  width. Optional, and this is where the pattern above genuinely stops: the two
   *  above are filled from `serde` defaults, and these are not — until a person
   *  drags an edge the width belongs to the stylesheet, whose `clamp(17.5rem,
   *  19vw, 24rem)` tracks the window and the text size. A pixel default here would
   *  freeze both, and `undefined` is what says "not asked for".
   *
   *  Px and not `ch`, unlike the diff drawer's width and the drawer's rows: what
   *  is being sized is a column of names, not a grid of characters. */
  panelPx?: number;
  wspPx?: number;
  wspWidePx?: number;
  /** Whether the reported source of usage limits may be asked. Default on.
   *
   *  Required rather than optional, for the same reason as `uiScale`: the Rust
   *  side fills it from a `serde` default, so a reader treating it as
   *  possibly-absent would guard a case that cannot happen and hide one that
   *  can. Off means the limits block stays on the observed source and says so. */
  usageReported: boolean;
  /** And the tool panel inside a zoomed tile. One width for the app, not one per
   *  tile: sizing it is sizing the tool, and every session's tools are the same
   *  tool. Its floor is the 80-column rule, which is enforced where the panel is
   *  drawn — a stored number cannot know what the terminal is doing. */
  toolPx?: number;
}

/** A change to the stored state, which is what `save_ui_state` takes.
 *
 *  Separate from `UiState` on purpose. The backend used to write the file from a
 *  whole `UiState`, and the one caller sends the active workspace alone — so the
 *  moment a second field existed, every workspace switch would have wiped the text
 *  size. An absent key here means "leave it alone". */
export interface UiStatePatch {
  activeWorkspaceId?: string;
  /** Sets the remembered answer. Omitted leaves it alone, like every other field
   *  here — putting it back to "never asked" is `memoryForgetCaptureAnswer`. */
  captureOnClose?: boolean;
  uiScale?: number;
  prDiffCols?: number;
  syncOfferDismissed?: boolean;
  recordScenarioRuns?: boolean;
  terminalRows?: number;
  usageReported?: boolean;
  panelPx?: number;
  wspPx?: number;
  wspWidePx?: number;
  toolPx?: number;
}
/** Runtime record of a scenario's scheduled runs, owned by the backend.
 *  `lastAttempt` is the occurrence last emitted; `lastRun` only advances when
 *  a session actually started. Epoch millis. */
export interface ScheduleRun {
  lastAttempt: number; lastRun: number | null; lastOutcome: string | null;
  /** Next firing time, computed by the backend — the side that actually
   *  fires. Absent when the schedule is off. */
  nextRunMs?: number | null;
}

/** The workspace list.
 *
 *  **Rejects** for a `workspaces.json` it cannot read, rather than resolving
 *  empty. It resolved empty until #369, when an unreadable list cost a stale
 *  sidebar and nothing else; a window pinned to a workspace now closes itself
 *  when this stops listing it, so an empty answer is a decision and a fault must
 *  not be able to make it. Every caller has to survive the rejection. */
export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (ws: Workspace) => invoke<Workspace[]>("save_workspace", { ws });
export const removeWorkspace = (id: string) => invoke<Workspace[]>("remove_workspace", { id });
export const loadUiState = () => invoke<UiState>("load_ui_state");
export const saveUiState = (ui: UiStatePatch) => invoke<void>("save_ui_state", { ui });
export const listSkills = () => invoke<Skill[]>("list_skills");
export const saveSkill = (sk: Skill) => invoke<Skill[]>("save_skill", { sk });
export const removeSkill = (id: string) => invoke<Skill[]>("remove_skill", { id });
export const claudeAvailable = () => invoke<boolean>("claude_available");

export interface GhAccount { host: string; login: string; active: boolean; scopes: string[]; state: string; }
export interface GhStatus { path: string | null; version: string | null; accounts: GhAccount[]; error: string | null; }
export interface HostPlatform {
  os: "macos" | "windows" | "linux";
  distro: string | null;
  /** Whether the app may say where a window goes. False on Wayland, where
   *  `set_position` returns success and silently does nothing — so the tear-out
   *  gesture, which is built on placing a window under the cursor, is not
   *  offered there. The plain trigger does the same job everywhere. */
  placesWindows: boolean;
}

export const ghStatus = () => invoke<GhStatus>("gh_status");

// ---------------------------------------------------------------- sync

/** Why sync cannot be switched on yet. Two of the three reasons
 *  `ghUnavailable` already words — the third, `no-repo`, is about a
 *  workspace's own folder and does not apply here. */
export type SyncBlocked = "no-gh" | "no-account";
export interface SyncPreflight {
  blocked: SyncBlocked | null;
  accounts: GhAccount[];
  /** The account listing itself failed. Not the same as having none. */
  error: string | null;
}
export type SyncRepoState =
  | { kind: "empty" }
  | { kind: "ours"; format: number }
  | { kind: "ours-newer"; format: number }
  | { kind: "foreign" }
  | { kind: "missing" }
  | { kind: "unknown"; why: string };
export type SyncFault =
  | { kind: "offline"; since: number }
  | { kind: "conflict"; files: string[] }
  | { kind: "push-rejected"; message: string }
  | { kind: "auth-gone"; message: string }
  | { kind: "format-newer"; found: number; supported: number };
export interface SyncState {
  lastPull: number | null;
  lastPush: number | null;
  fault: SyncFault | null;
}
export interface SyncMachine { id: string; label: string; }
export interface SyncSummary {
  on: boolean;
  remote: string | null;
  state: SyncState;
  machine: SyncMachine;
}
export type SyncQuestion =
  | { kind: "needs-path"; workspaceId: string; name: string; cloneFrom: string | null }
  | {
      kind: "duplicate";
      arrivingId: string;
      localId: string;
      name: string;
      /** What matched: the same remote URL, or one folder on this machine —
       *  which is the identity a project with no repository has
       *  (`sync::adopt::DuplicateBasis`). The two read differently to whoever
       *  answers, so the sentence is not shared. */
      basis: "repository" | "folder";
    }
  | { kind: "needs-board-path"; workspaceId: string; name: string };

export const syncSummary = () => invoke<SyncSummary>("sync_summary");
export const syncPreflight = () => invoke<SyncPreflight>("sync_preflight");
export const syncProbe = (host: string, login: string, repo: string) =>
  invoke<SyncRepoState>("sync_probe", { host, login, repo });
export const syncCreate = (host: string, login: string, name: string) =>
  invoke<string>("sync_create", { host, login, name });
export const syncConnect = (host: string, login: string, repo: string, url: string) =>
  invoke<void>("sync_connect", { host, login, repo, url });
export const syncDisconnect = () => invoke<void>("sync_disconnect");
export const syncNow = () => invoke<SyncState>("sync_now");
export const syncQuestions = () => invoke<SyncQuestion[]>("sync_questions");
/** These two records are one project: fold `from` into `into`. Answers with the
 *  workspaces that are left. */
export const syncMergeWorkspaces = (from: string, into: string) =>
  invoke<Workspace[]>("sync_merge_workspaces", { from, into });
/** These two records are not one project, and the deck is to stop asking. */
export const syncKeepDistinct = (a: string, b: string) =>
  invoke<void>("sync_keep_distinct", { a, b });

/** The loop pushes state after every cycle, so a panel left open does not have
 *  to poll to stay honest. */
export const onSyncState = (fn: (s: SyncState) => void): Promise<UnlistenFn> =>
  listen<SyncState>("sync://state", (e) => fn(e.payload));

/** The store's workspace list is no longer what this window read at boot.
 *
 *  Sent when the list changed without a window asking for it: a pull that
 *  brought a record, deleted one, or carried the answer somebody gave on the
 *  other machine. A window reads `workspaces.json` once, during boot, so
 *  without this it draws a row for a record that is gone — and a window pinned
 *  to that record is pinned to nothing (#369).
 *
 *  No payload: the list is one file, and re-reading it says more than any
 *  description of the change could. */
export const onWorkspacesChanged = (fn: () => void): Promise<UnlistenFn> =>
  listen("workspaces://changed", () => fn());
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

export interface ChangedFile { path: string; additions: number; deletions: number }

/** What a pull request holds, beyond what a row shows. */
export interface PrDetail {
  /** The description as written, Markdown and all. Empty is a legal answer — a
   *  pull request opened without one — and reads as "no description". */
  body: string;
  additions: number;
  deletions: number;
  /** GitHub's own count, which is why it sits beside `files` rather than being
   *  derived from its length: `files` is itself a page. */
  changedFiles: number;
  files: ChangedFile[];
}

/** Why a file arrived with no lines to show. Mirrors `gh_pr::Omission`, tagged on
 *  `kind` and serialised camelCase.
 *
 *  Four states counting the absent one, and they are not interchangeable —
 *  each earns a different sentence and a different escape hatch:
 *
 *  - `null` with hunks — an ordinary file.
 *  - `null` with no hunks — a rename. The row names two paths and nothing is
 *    withheld.
 *  - `tooLargeUpstream` — counts kept, no patch. Re-fetching cannot help;
 *    measured on #151's 5290-change plan, which has no patch even on a page of one.
 *  - `unreported` — counts **zeroed**, no patch. Could be a binary file, a
 *    mode-only change, or the response hitting a budget; one response cannot tell
 *    them apart, and a narrower page resolves it — measured, where the same file
 *    read 0/0/0 on a page of 62 and 163/3 with a patch on a page of three.
 *  - `tooLargeLocal` — over our own cap. The bytes arrived and were dropped in
 *    Rust, so the count is exact and the refusal is ours. */
export type Omission =
  | { kind: "tooLargeUpstream" }
  | { kind: "unreported" }
  | { kind: "tooLargeLocal"; lines: number };

/** One hunk of one file's patch. Mirrors `gh_pr::Hunk`.
 *
 *  `header` is the `@@` line verbatim, kept for its trailing section context —
 *  `@@ -89,6 +91,9 @@ fn main() {` — which git writes and nothing else does.
 *  It is material for a heading, never a row to print. `oldStart`/`newStart` are
 *  parsed in Rust; the single-number form `@@ -1 +1 @@` is real and is already
 *  handled there, so nothing on this side re-parses a header. */
export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  /** Patch lines as written, leading `+`, `-`, ` ` or `\` kept. */
  lines: string[];
}

/** One changed file, as far as GitHub will describe it. Mirrors `gh_pr::DiffFile`.
 *
 *  **The identity of a file is its index in `PrDiff.files`, never `path`.** Two of
 *  549 measured responses name the same `filename` twice, as a `removed` + `added`
 *  pair — a file replaced by a symlink. Anything keyed by path silently merges
 *  those two rows into one, which is why the drawer is opened at an index. */
export interface DiffFile {
  path: string;
  /** Set only on a rename or a copy, where the row names two paths. */
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** The permalink at this head — the escape hatch for everything the drawer
   *  cannot draw, so it is carried even when `hunks` is full. */
  blobUrl: string;
  hunks: Hunk[];
  omitted: Omission | null;
}

export interface PrDiff {
  /** The commit this diff actually describes — read by the backend out of the
   *  rows' `blob_url`, not taken from whatever the caller asked for.
   *
   *  This closes a hole worth naming, because the natural design has it. The
   *  files endpoint is addressed by pull request *number*, so it serves whatever
   *  HEAD is when it runs, and a slot keyed on the head believed at request time
   *  can hold a diff labelled with a commit that is not the one in it. Keying on
   *  this instead means the label is what arrived.
   *
   *  Empty when the response had no rows to read it from — a pull request that
   *  changes nothing, where there is also nothing to go stale. */
  headRefOid: string;
  files: DiffFile[];
  /** How many files the pull request touches, kept beside `files` rather than
   *  derived from its length: `files` is a capped page. */
  totalFiles: number;
}

export const prList = (workspaceId: string) =>
  invoke<PullRequest[]>("pr_list", { workspaceId });
/** One pull request's contents, fetched only when a row is opened. Never part of
 *  the list call: a description and a per-path diffstat on a fifty-row page that
 *  re-polls every 15 s is payload for rows nobody looked at. */
export const prDetail = (workspaceId: string, number: number) =>
  invoke<PrDetail>("pr_detail", { workspaceId, number });
/** Every file of one pull request, in one response.
 *
 *  Not addressed by file: all 62 files of #151 arrive in a single fetch, so a
 *  per-file call would be 62 round trips slicing it. What makes handing over the
 *  lot affordable is that the backend applies its line cap *before* serialising,
 *  so a patch the drawer would refuse to draw never crosses. Fetched when the
 *  drawer opens and never on the list poll. */
export const prDiff = (workspaceId: string, number: number) =>
  invoke<PrDiff>("pr_diff", { workspaceId, number });
/** One file of the diff, on a page of its own and with no cap applied.
 *
 *  The exception to the rule above, and it exists because of a measurement. GitHub
 *  zeroes a file's counts and drops its patch when the *whole response* hits a
 *  budget, so the cure for a file it declined to describe is a response small
 *  enough that it cannot: on #151 `tests/tasks.test.ts` is index 60, reads 0/0/0
 *  with no patch in the 62-file response, and comes back 163/3 with a patch on a
 *  page of one.
 *
 *  The same call is "show anyway" for a file our own cap dropped — one mechanism
 *  for both refusals, which is why `pr_diff` has no per-file exemption. `fileIndex`
 *  is the position in `PrDiff.files` and becomes the one-based page number; a path
 *  would not do, since 2 of 549 measured responses name the same path twice. */
export const prFilePatch = (workspaceId: string, number: number, fileIndex: number) =>
  invoke<DiffFile>("pr_file_patch", { workspaceId, number, fileIndex });
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
/** Where a worktree was prepared, and whether it was already there. */
export interface WorktreeAdded { path: string; reused: boolean }
/** `crossRepository` is required, not inferred: for a fork the head is not a
 *  local branch, so the backend must not go looking for a worktree already on
 *  it. Pass the pull request's own `isCrossRepository`. */
export const prWorktreeAdd = (
  workspaceId: string, number: number, branch: string, crossRepository: boolean,
) => invoke<WorktreeAdded>("pr_worktree_add", { workspaceId, number, branch, crossRepository });
export const prWorktreeRemove = (workspaceId: string, number: number, branch: string) =>
  invoke<void>("pr_worktree_remove", { workspaceId, number, branch });

/** Исход привязки аккаунта для стартовавшей сессии. Токена тут нет: только имя
 *  аккаунта и, если резолв не удался, причина — её показывает бейдж на тайле. */
export interface SessionAuth { account: string | null; degraded: string | null; }

/** Where a session's pty output is delivered. One channel per terminal, created
 *  by the panel that will draw the bytes, handed to the backend at spawn.
 *
 *  **Bytes, not text, and per-session, not broadcast.** Both halves of that are
 *  load-bearing; see `openSink` in `terminal.ts` for why the bytes must stay
 *  bytes, and `start_session` in `commands.rs` for why the transport is a
 *  channel. */
export type OutputSink = Channel<ArrayBuffer>;

/** How a scenario launch describes itself to the run journal.
 *
 *  `runId` is minted here, beside the session id, and for the same reason: the
 *  tile has to persist it into `SessionEntry.runId` the moment it exists, so a
 *  restart can chain to it. Passing an identifier is not writing a record —
 *  every line of `runs.jsonl` is written in Rust and nowhere else. */
export interface ScenarioLaunch {
  runId: string;
  skillId: string;
  trigger: RunTrigger;
  /** The placeholder values this run was launched with. */
  params: Record<string, string>;
  /** The run being resumed, when the caller knows it — auto-restore reads it
   *  out of `SessionEntry.runId`. A ⟳ inside a live app leaves it out: the
   *  backend still has the predecessor open. */
  continuesRunId?: string | null;
}

/** `sink` sits before `scenario` because it is required and `scenario` is not:
 *  a mandatory parameter cannot follow an optional one. Every session has an
 *  output channel; only a scenario launch has a journal record. */
export const startSession = (
  session: string, cwd: string, workspaceId: string | null, initialPrompt: string | null,
  taskId: string | null, cols: number, rows: number, resume: boolean, sink: OutputSink,
  scenario: ScenarioLaunch | null = null,
  /** Deliberately replacing a process still live under this id — the restart
   *  button, and nothing else. Left false, the backend refuses rather than
   *  killing what is there: both spawn paths are unguarded async, so two
   *  launches can be in flight before the first resolves. */
  replace = false,
) => invoke<SessionAuth>("start_session", {
  session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume, sink, scenario, replace,
});

/** Resolve a workspace's account binding and `claude`'s location ahead of a
 *  launch, off the thread that paints the window.
 *
 *  `start_session` is deliberately synchronous — a `write` that overtook its
 *  `start` is lost keyboard input — which used to mean it did up to ten seconds
 *  of `gh` and login-shell work with the window frozen. Awaiting this first
 *  moves that work off the main thread and leaves the launch itself reading a
 *  cache. Safe to call repeatedly; a resolved binding is remembered until the
 *  workspace is saved again. */
export const prepareWorkspace = (workspaceId: string) =>
  invoke<SessionAuth>("prepare_workspace", { workspaceId });
/** What the drawer learns when a shell starts.
 *
 *  `identity` is the git identity the shell actually carries in its
 *  environment, and it is here because a person cannot check it any other way:
 *  `GIT_AUTHOR_*` outranks `.git/config`, so `git config user.email` reports the
 *  value that loses. `program` is the shell's own name, for the tab. */
export interface ShellStart {
  auth: SessionAuth;
  identity: string | null;
  program: string;
}

/** An interactive shell on a pty — the person's own `$SHELL`, in `cwd`, carrying
 *  the workspace's account binding. Refuses an id that is already running, and
 *  refuses past the backend's cap with `terminal-limit:<n>`. */
export const startShellSession = (
  session: string, cwd: string, workspaceId: string | null, cols: number, rows: number,
  sink: OutputSink,
) => invoke<ShellStart>("start_shell_session", { session, cwd, workspaceId, cols, rows, sink });

/** How many jobs a session is running right now.
 *
 *  A shell has no hooks, so its tile chip says `idle` whether it is at a prompt
 *  or halfway through a release build. This is the only honest answer, and what
 *  the close confirmation asks before it destroys anything. */
export const sessionJobs = (session: string) => invoke<number>("session_jobs", { session });

/** A persisted drawer tab. Smaller than `SessionEntry` on purpose: a shell
 *  cannot be resumed, so what comes back is a new shell in the same directory
 *  under the same name, and there is nothing else to store. */
export interface TerminalEntry {
  sessionId: string;
  cwd: string;
  name: string;
  workspaceId?: string;
}
/** The drawer is per workspace, so both of these are too: `active` is the tab in
 *  front keyed by workspace id (`""` for a terminal opened with no workspace),
 *  and `open` is the workspaces whose drawer is up. */
export interface TerminalLayout {
  items: TerminalEntry[];
  active: Record<string, string>;
  open: string[];
}

export const loadTerminals = () => invoke<TerminalLayout>("load_terminals");
export const saveTerminals = (layout: TerminalLayout) =>
  invoke<void>("save_terminals", { layout });

/** Разовый запуск пользовательской команды в тайле-терминале (установка gh,
 *  `gh auth login`). Не сессия агента: хуков состояния нет. */
export const startCommandSession = (
  session: string, cwd: string, command: string, cols: number, rows: number, sink: OutputSink,
) => invoke<void>("start_command_session", { session, cwd, command, cols, rows, sink });
export const writeSession = (session: string, data: string) => invoke<void>("write_session", { session, data });
export const resizeSession = (session: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { session, cols, rows });
/** What a closing session needs for its note, when the person has agreed to one.
 *
 *  The three fields are meaningless apart: consent with no workspace has nowhere
 *  to file the note, and consent with no CLI cannot say which reader understands
 *  the log. */
export interface CaptureOnClose {
  workspaceId: string;
  cliKind?: CliKind;
  sessionName?: string;
}
/** Close a session, and write a note about it when `capture` says to.
 *
 *  The note is an argument of the close rather than a call before it, and that is
 *  the guarantee: `close_session` calls `transcripts::forget`, so the transcript
 *  path is gone the instant the close goes through. An ordering inside one
 *  command cannot be got wrong by a caller. */
export const closeSession = (session: string, capture?: CaptureOnClose | null) =>
  invoke<void>("close_session", { session, capture: capture ?? null });
/** Whether closing this session could produce a note at all — a CLI this build
 *  can read, and a log it knows the location of. Asked before anybody is asked,
 *  because consent to spend money on something that cannot work is worse than no
 *  offer. */
export const memoryCaptureOffer = (session: string, cliKind?: CliKind) =>
  invoke<CaptureOffer>("memory_capture_offer", { session, cliKind: cliKind ?? null });
/** What the model directory holds. Three states, not a boolean: `partial` is a
 *  resumable download, and calling it absent would invite somebody to start
 *  479 MB again with the bytes already on disk. */
export interface MemoryModelState {
  dir: string;
  state: "absent" | "partial" | "present";
  have: number;
  total: number;
}
/** The index and the model, from the sidecar's own `status`. */
export interface MemoryStatus {
  root: string;
  cache: string;
  /** `absent` — nothing has been indexed; `empty` — indexed, nothing in it;
   *  `ready`. Three, because counts alone cannot tell the first two apart. */
  state: "absent" | "empty" | "ready";
  files: number;
  chunks: number;
  dim: number;
  model: MemoryModelState;
}
/** The index and the model. Needs neither, which is what makes it the call that
 *  decides what the interface may offer — a search returning nothing cannot tell
 *  "no matches" from "no model" from "never indexed". */
export const memoryStatus = () => invoke<MemoryStatus>("memory_status");
/** Search the notes. Scoped to a workspace sees its notes plus the global
 *  diaries; absent, it searches everything. */
export const memorySearch = (query: string, workspaceId?: string, top?: number) =>
  invoke<MemoryHit[]>("memory_search", {
    query, workspaceId: workspaceId ?? null, top: top ?? null,
  });
export interface MemoryHit {
  score: number;
  /** Relative to the corpus root — `ws-1/Sessions/2026-08/31-topic.md`. */
  file: string;
  /** The workspace id, or `lessons` for a diary. */
  scope: string;
  room: string | null;
  text: string;
}
/** What one capture cost, off the CLI's own envelope. */
export interface MemoryCost {
  inputTokens: number;
  outputTokens: number;
  /** What the CLI said it cost, when it said. Absent on a plan where the question
   *  has no dollar answer. */
  usd?: number;
}
/** One wrapup job, folded out of the queue's events. */
export interface MemoryJob {
  jobId: string;
  queuedAt: number;
  sessionId: string;
  workspaceId: string;
  transcriptPath: string;
  cliKind: CliKind;
  sessionName: string | null;
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  /** Why it last came out of `running` without finishing, or why it was given up
   *  on. Can hold model output, which is ours — render it as detail, never as a
   *  headline. */
  lastError: string | null;
  notePath: string | null;
  cost: MemoryCost | null;
}
/** Every wrapup job, oldest first. Machine-local: the queue names transcript
 *  paths on this machine and does not travel. */
export const memoryJobs = () => invoke<MemoryJob[]>("memory_jobs");
/** Put a finished-with job back on the queue. Resolves whether there was one to
 *  reopen. **It spends money**, like any capture. */
export const memoryRetryJob = (jobId: string) =>
  invoke<boolean>("memory_retry_job", { jobId });
/** One note, read back out of the corpus by its path relative to the root. */
export interface MemoryNote {
  path: string;
  markdown: string;
}
/** Read a note. The path is relative and checked against the corpus root on the
 *  Rust side — a command taking an absolute one would be a command any window
 *  could ask to read any file. */
/** One note as the corpus holds it, read off its path and its first heading. */
export interface MemoryNoteEntry {
  /** Relative to the corpus root — what `memoryReadNote` takes back. */
  file: string;
  /** The workspace id, or `Diaries` for a lesson. */
  scope: string;
  room: string | null;
  kind: "session" | "facts" | "diary" | "other";
  /** `2026-08-31` for a session note, `2026-08` for a diary, empty otherwise —
   *  from the path, which is where the day the work happened is recorded. */
  when: string;
  /** The first `# ` heading, or the file stem. Verbatim: a session note's own
   *  heading begins with its date, and a row showing both must not say it
   *  twice. */
  title: string;
  size: number;
  /** Seconds since the epoch. The only sort key the three shapes share. */
  mtime: number;
}
/** One fact of a workspace that still stands. */
export interface MemoryFact {
  /** `YYYY-MM-DD`, the day it was recorded. */
  date: string;
  /** The claim, without the date or the `[active]` marker — what a replacement
   *  matches on. */
  body: string;
}
/** The facts a workspace still claims, for the form that replaces one. */
export const memoryFacts = (workspaceId: string) =>
  invoke<MemoryFact[]>("memory_facts", { workspaceId });
/** Record a fact by hand. One line: `subject — predicate — object`. The date and
 *  the `[active]` marker are the app's to write. */
export const memoryAddFact = (workspaceId: string, fact: string) =>
  invoke<void>("memory_add_fact", { workspaceId, fact });
/** Replace a fact that has stopped being true. The old line is marked and the new
 *  one goes under it (ADR-0004). Resolves `false` when nothing matched — the file
 *  moved under the form, and that is worth showing rather than swallowing. */
export const memorySupersedeFact = (workspaceId: string, old: string, replacement: string) =>
  invoke<boolean>("memory_supersede_fact", { workspaceId, old, replacement });
/** File a lesson into a room the person picked. */
export const memoryAddLesson = (lesson: {
  room: string;
  workspace: string;
  severity: string;
  category: string;
  what: string;
  avoid: string;
}) => invoke<void>("memory_add_lesson", lesson);
/** Write a note by hand. Takes the three parts rather than markdown, so the shape
 *  a search reads — the frontmatter, the H1, the `## TL;DR` — is written for the
 *  person. Resolves the path it landed on, relative to the corpus root. */
export const memoryWriteNote = (workspaceId: string, title: string, tldr: string, body: string) =>
  invoke<string>("memory_write_note", { workspaceId, title, tldr, body });
/** Save an edited note over itself, atomically. Refuses a path that is not a note
 *  and markdown with no `## TL;DR`. */
export const memorySaveNote = (file: string, markdown: string) =>
  invoke<void>("memory_save_note", { file, markdown });
/** Everything ever written down, newest first.
 *
 *  A directory walk rather than a search, which is why the memory page is useful
 *  on a machine that has downloaded nothing: `memorySearch` needs the sidecar and
 *  the model, and this needs neither. */
export const memoryNotes = () => invoke<MemoryNoteEntry[]>("memory_notes");
export const memoryReadNote = (file: string) =>
  invoke<MemoryNote>("memory_read_note", { file });
/** Start fetching the embedding model. Resolves whether a download was started —
 *  `false` when one already is. Progress arrives on `memory://model`. */
export const memoryDownloadModel = () => invoke<boolean>("memory_download_model");
/** Where a download has got to, or how it ended. One shape for both, so a
 *  surface rendering "fetching", "done" and "it failed" in one place cannot let
 *  them disagree. */
export interface MemoryModelEvent {
  phase: "fetching" | "verifying" | "ready" | "failed";
  file?: string;
  got: number;
  total: number;
  error?: string;
}
export const onMemoryModel = (fn: (e: MemoryModelEvent) => void): Promise<UnlistenFn> =>
  listen<MemoryModelEvent>("memory://model", (e) => fn(e.payload));
/** The corpus or the index moved. */
export const onMemoryChanged = (fn: () => void): Promise<UnlistenFn> =>
  listen("memory://changed", () => fn());
/** A diary room: a name, and the sentence a lesson is routed by. */
export interface DiaryRoom {
  name: string;
  description: string;
}
/** Every configured room. Seeds a usable default set on a corpus that has never
 *  had any, so the surface never opens on an empty page with an Add button. */
export const memoryRooms = () => invoke<DiaryRoom[]>("memory_rooms");
/** Declare a room or change its description. Resolves the name it was stored
 *  under, which is the slug of what was asked for. */
export const memorySaveRoom = (name: string, description: string) =>
  invoke<string>("memory_save_room", { name, description });
/** Stop routing lessons to a room. **Its lessons stay on disk** — a room removed
 *  by mistake must not take months of them with it. */
export const memoryRetireRoom = (name: string) =>
  invoke<boolean>("memory_retire_room", { name });
/** Rename a room, moving its lessons with it. Rejects a merge into an existing
 *  one. */
export const memoryRenameRoom = (from: string, to: string) =>
  invoke<string>("memory_rename_room", { from, to });
/** Forget the remembered answer, so the next close asks again. */
export const memoryForgetCaptureAnswer = () =>
  invoke<void>("memory_forget_capture_answer");
export interface CaptureOffer {
  available: boolean;
  reason?: string;
}
/** One tile as it crosses between windows: everything `sessions.json` records
 *  about it, plus what was on its screen.
 *
 *  The scrollback rides with the tile rather than being fetched afterwards
 *  because the window that has it is the window that is giving it up — a moment
 *  later there is nobody left to ask. */
export interface HandOffTile extends SessionEntry {
  scrollback: string;
}

/** Take over a running session: point its output here and record this window as
 *  its owner. Spawns nothing — see `TerminalPanel.attach`. */
export const claimSession = (session: string, sink: Channel<ArrayBuffer>) =>
  invoke<void>("claim_session", { session, sink });
/** A session changed hands. Every window hears it; the one whose label is
 *  `owner` asked for it, and the rest give the session up. */
export const onSessionOwner = (cb: (session: string, owner: string) => void) =>
  listen<{ session: string; owner: string }>("session://owner", (e) =>
    cb(e.payload.session, e.payload.owner));
/** Open the window pinned to `workspaceId`, or raise it if it is already up.
 *
 *  Windows are built in Rust rather than here. `core:webview:default` does not
 *  grant `allow-create-webview-window`, and granting it to a webview that renders
 *  untrusted agent output is not worth what it buys — the label scheme and the
 *  window cap belong on that side anyway.
 *
 *  Resolves with the new window's label once that window has attached its
 *  listeners, and rejects if it never does. So a caller that gets a label back
 *  may address the window immediately; one that gets an error has a window that
 *  failed to boot, reported rather than left on screen and inert. */
export const openWorkspaceWindow = (
  workspaceId: string,
  /** Physical screen coordinates to place it at — the tear-out gesture's cursor.
   *  Absent for the plain trigger, which lets the window state plugin put the
   *  window back where it was last left. */
  at?: [number, number],
  /** Hand the new window to the OS's own move, so a torn-out workspace keeps
   *  following the cursor as an ordinary window. Only meaningful with `at`. */
  drag?: boolean,
) => invoke<string>("open_workspace_window", { workspaceId, at, drag });
/** "My listeners are attached; you may send me things."
 *
 *  Called last in a window's bootstrap, and only there. An emit to a webview
 *  holding no listener for that event is a silent no-op at both ends, so the
 *  backend routes nothing to a window until this arrives. The label is taken
 *  from the runtime, not passed, so no window can answer for another. */
export const windowReady = () => invoke<void>("window_ready");
/** The tiles **this window** should restore — not every tile on disk.
 *
 *  The filtering happens in Rust, against the window label the runtime attaches
 *  to the invoke, so there is nothing to pass and no way for a window to ask for
 *  another one's tiles. Saving stamps the same label. That is why `SessionEntry`
 *  above has no `owner` field although `sessions.json` records one: the frontend
 *  neither sets it nor needs to read it, and a field it cannot write is a field
 *  it cannot forge. */
export const loadLayout = () => invoke<SessionEntry[]>("load_layout");
export const saveLayout = (sessions: SessionEntry[]) => invoke<void>("save_layout", { sessions });

export const onState = (cb: (session: string, state: SessionState) => void): Promise<UnlistenFn> =>
  listen<{ session: string; state: SessionState }>("session://state", (e) =>
    cb(e.payload.session, e.payload.state));
/** What became of a session's process.
 *
 *  This used to be one boolean, which made three different things look the
 *  same: a command that failed, a process the app hung up at shutdown, and a
 *  `wait()` the backend could not read. `code` is the process's own exit code;
 *  it is null when a signal ended it — `signal` then names the signal — or when
 *  `unknown` says the outcome could not be read at all. */
export interface SessionExit {
  ok: boolean;
  code: number | null;
  signal: string | null;
  unknown: boolean;
}

/** A one-line, honest account of an exit, for the tile to print.
 *
 *  Null for an ordinary success: a session that ended cleanly needs no epitaph,
 *  and the state chip already says "ended". */
export function describeExit(exit: SessionExit): string | null {
  if (exit.unknown) return "process gone — the app could not read what happened to it";
  if (exit.signal) return `terminated by ${exit.signal}`;
  if (exit.code !== null && exit.code !== 0) return `exited with code ${exit.code}`;
  return null;
}

export const onExit = (cb: (session: string, exit: SessionExit) => void): Promise<UnlistenFn> =>
  listen<{ session: string } & SessionExit>("session://exit", (e) =>
    cb(e.payload.session, {
      ok: e.payload.ok, code: e.payload.code, signal: e.payload.signal, unknown: e.payload.unknown,
    }));

/** Sessions with something still running inside them, named by the backend when
 *  it refuses to quit. `processes` counts what is running below the session's
 *  own shell or agent — the build, the test run, the tool call. */
export interface LiveWork { session: string; processes: number }

/** The app is on its way out and something is running. The deck's job is to ask,
 *  and to answer with `quitConfirmed` or `quitCancelled` — until one of them
 *  arrives the app stays up. */
export const onQuitBlocked = (cb: (work: LiveWork[]) => void): Promise<UnlistenFn> =>
  listen<LiveWork[]>("app://quit-blocked", (e) => cb(e.payload));
export const quitConfirmed = () => invoke<void>("quit_confirmed");
export const quitCancelled = () => invoke<void>("quit_cancelled");

/** Released once, after the fire listener below is attached, so the backend
 *  scheduler's first (catch-up) tick has somewhere to land. */
export const schedulerReady = () => invoke<void>("scheduler_ready");
export const onScheduledFire = (
  cb: (skillId: string, occurrenceMs: number, catchUp: boolean) => void,
): Promise<UnlistenFn> =>
  listen<{ skillId: string; occurrenceMs: number; catchUp: boolean }>("schedule://fire", (e) =>
    cb(e.payload.skillId, e.payload.occurrenceMs, e.payload.catchUp ?? false));

/** Report what a fire produced. The backend records only that it attempted a
 *  run; `lastRun` advances only when this says a session actually started.
 *
 *  `workspaceId` is what the fire resolved to, when it resolved to anything. An
 *  outcome other than `launched` also becomes a `failed-to-launch` record in the
 *  run journal, and that record has to know which workspace it belongs to —
 *  the history screen is scoped to one. `no-workspace` has none, by definition,
 *  and says so. */
export const scheduleAck = (
  skillId: string, occurrenceMs: number, outcome: string, workspaceId: string | null = null,
) => invoke<void>("schedule_ack", { skillId, occurrenceMs, outcome, workspaceId });

/** How a run started. `runNow` is the ⏰ button; `resume` is auto-restore or ⟳,
 *  which opens a new record chained to its predecessor. */
export type RunTrigger = "manual" | "runNow" | "schedule" | "resume";
/** What a record is, or how it ended. `running` is the only one that is not a
 *  close. `failed-to-launch` is a scheduled fire that started no session at all. */
export type RunStatus = "running" | "ended" | "error" | "interrupted" | "failed-to-launch";
/** Where `result` came from. `none` means no transcript was ever reported, or
 *  the file is gone — `result` is then null, never an invented empty string. */
export type ResultSource = "transcript" | "none";

/** One scenario run, as the backend folded it out of `runs.jsonl`.
 *
 *  `name`, `icon`, `prompt` and `params` are a **snapshot** of the launch:
 *  `skillId` is a filter key only, so a record whose scenario has since been
 *  renamed or deleted still reads correctly. Never look a name up through
 *  `skillId` — that is the whole reason the snapshot is stored. */
export interface RunRecord {
  runId: string;
  /** Epoch millis, true epochs on both. */
  startedAt: number;
  closedAt: number | null;
  trigger: RunTrigger;
  status: RunStatus;
  skillId: string;
  name: string;
  icon: string;
  /** The workspace this run actually happened in. Null for a scheduled fire
   *  that never resolved one — such a record passes every workspace filter,
   *  the way an orphaned tile stays visible everywhere. */
  workspaceId: string | null;
  cwd: string;
  branch: string | null;
  /** Absent on a `failed-to-launch` record: nothing was launched. */
  sessionId: string | null;
  params: Record<string, string>;
  /** The **expanded** prompt, placeholders substituted. Null on a `resume`
   *  record whose chain root could not be found. */
  prompt: string | null;
  continuesRunId: string | null;
  transcriptPath: string | null;
  /** A `/clear` happened during this run, so `result` is the tail of a
   *  conversation whose beginning is in another file. Say so; presenting the
   *  tail as the whole is the lie this flag exists to prevent. */
  cleared: boolean;
  /** The final assistant message. `null` with `resultSource: "none"` reads as
   *  "no transcript" — never as an empty result. */
  result: string | null;
  /** Why nothing came of the run, where there is a reason: the scheduler's own
   *  `no-workspace` / `skipped-overlap` / `not-scheduled`. */
  reason: string | null;
  tokens: TokenUsage | null;
  resultSource: ResultSource;
}

/** The journal, newest first. Both filters are applied in Rust so the screen
 *  and the sidebar's state dot ask the same question of the same code. */
export const listRuns = (workspaceId: string | null, skillId: string | null) =>
  invoke<RunRecord[]>("list_runs", { workspaceId, skillId });
/** Erase one scenario's history — the only erasure there is. A record is a
 *  snapshot of what ran, so single rows are neither editable nor deletable.
 *
 *  Scoped by workspace exactly as `listRuns` is, and by the same code, so what
 *  is erased is what the screen was showing. Rejects while one of those runs is
 *  still going: the journal is append-only, and rewriting an open record out of
 *  it means the run is never journalled at all — not even when it ends. */
export const deleteSkillHistory = (skillId: string, workspaceId: string | null) =>
  invoke<void>("delete_skill_history", { skillId, workspaceId });
/** Show a run's transcript in the file manager — reveal only, never "open with".
 *
 *  Not an in-app viewer: Claude Code owns those files, they run to megabytes,
 *  and a person reaching for one wants it where it lives. Rejects when the file
 *  is gone, which is ordinary rather than a fault — the UI disables the control
 *  where it can tell in advance, and this covers the file going between the
 *  render and the click. */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });

/** A record opened or closed. Follows the `tasks://changed` precedent, and is
 *  deliberately not a polling timer. */
export const onRunsChanged = (cb: (skillId: string) => void): Promise<UnlistenFn> =>
  listen<{ skillId: string }>("runs://changed", (e) => cb(e.payload.skillId));
/** Runtime schedule state, keyed by scenario id. The backend owns it — the
 *  frontend must not compute "did this run" from anything else. */
export const loadScheduleState = () => invoke<Record<string, ScheduleRun>>("load_schedule_state");
/** The scheduler could not persist its state, which means nothing will fire
 *  until it can. */
export const onSchedulerBroken = (cb: (message: string) => void): Promise<UnlistenFn> =>
  listen<string>("schedule://broken", (e) => cb(e.payload));

export interface GitStatus { branch: string | null; dirty: boolean; }
export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number; }
/** Two readings, deliberately kept apart: `context` is what the terminal prints
 *  for the session and covers the main chain only, `spend` is the bill and
 *  includes every subagent. `context` is null until the first request. */
export interface SessionTokens { context: number | null; spend: TokenUsage; subagents: number; }
/** Which of the transcript's three names the title came from. */
export type TitleSource = "custom" | "ai" | "prompt";
/** Everything one poll tick wants to know about one session, off one read.
 *
 *  Both fields are nullable, and both nulls carry meaning. `tokens: null` is the
 *  reading being *unavailable* — no transcript, or one that would not open —
 *  which is not the same as a session that has spent nothing, and is why a tile
 *  hides the badge rather than drawing zeroes. `title: null` is what stops an
 *  empty transcript field blanking a tile's name. */
export interface SessionSnapshot {
  tokens: SessionTokens | null;
  title: string | null;
  titleSource: TitleSource | null;
  /** Tool calls in the whole conversation, subagents included — what the
   *  activity button carries, so the panel is worth opening before it is. `null`
   *  is the reading being unavailable and `0` is a session that has made no
   *  calls; the panel says two different sentences for those. */
  calls: number | null;
}
export const gitStatus = (cwd: string) => invoke<GitStatus>("git_status", { cwd });

/** One changed file in a session's own checkout. `mark` is git's own letter — M,
 *  A, D, R, `?` for untracked, U for a conflict — because anyone with a worktree
 *  open has read those, and a second vocabulary for one fact is a second thing to
 *  learn. `added`/`removed` are 0 for an untracked file: git has nothing to diff
 *  it against, and its length is a number git never states. */
export interface GitChange { mark: string; path: string; added: number; removed: number }
export interface GitChanges { branch: string | null; files: GitChange[] }
/** What this session's checkout has changed. Per session, not per workspace: a
 *  session launched on an issue runs in a worktree of its own, and "what have I
 *  changed here" is a question the board cannot answer for it. */
export const gitChanges = (cwd: string) => invoke<GitChanges>("git_changes", { cwd });
/** The files in this session's checkout, as git sees them: tracked plus
 *  untracked-not-ignored, so the repository's own ignore rules decide what is not
 *  worth showing rather than a list of names kept here. */
export const worktreeFiles = (cwd: string) => invoke<string[]>("worktree_files", { cwd });

/** One of the files the app keeps for itself. `exists: false` is reported rather
 *  than omitted: the list is what this app WILL write, and a person looking for a
 *  file they have never saved needs to be told it is not there. */
export interface ConfigFile { name: string; exists: boolean }
export interface ConfigPaths { dir: string; files: ConfigFile[] }
/** Where the app keeps its own state — for the Settings window, which is the first
 *  place in this app that answers "where is my configuration" at all. */
export const configPaths = () => invoke<ConfigPaths>("config_paths");
/** One invoke per tick for every open session — the title and the token counts
 *  come from the same bytes, so asking per session would read each transcript
 *  twice. Every requested id comes back, including ids with no transcript. */
export const sessionSnapshots = (sessionIds: string[]) =>
  invoke<Record<string, SessionSnapshot>>("session_snapshots", { sessionIds });

/** Which CLI a session runs. `claude` is what every stored session is until the
 *  deck can launch anything else, and what an unrecognised name reads back as. */
export type CliKind = "claude" | "copilot" | "opencode" | "codex";

/** A lens over native tool names, never a rename of them. A row shows the name
 *  the CLI itself used; the category is what makes `shell` and `Bash`
 *  comparable across two CLIs without either being relabelled. */
export type ToolCategory =
  | "run" | "read" | "edit" | "search" | "web"
  | "mcp" | "delegate" | "task" | "ask" | "other";

/** One tool, as invoked by one agent, counted. `errors` and `denials` are
 *  separate because they are different events: a denied call never ran, and
 *  rolling it into a failure rate would make a session that refused three
 *  commands look like one that broke three times. */
export interface ToolTally {
  native: string;
  category: ToolCategory;
  /** The MCP server, for a name shaped `mcp__<server>__<tool>`. */
  server: string | null;
  calls: number;
  errors: number;
  denials: number;
}

export type AgentRole = "main" | "subagent";

export interface AgentTally {
  id: string;
  kind: AgentRole;
  /** `"Code Reviewer"`, where the log names it. A subagent whose metadata was
   *  missing keeps its calls and loses only this. */
  agentType: string | null;
  description: string | null;
  depth: number;
  /** The tool-call id that started this agent. Absent for a teammate raised
   *  with the session rather than delegated to from a call. */
  spawnedBy: string | null;
  tools: ToolTally[];
  calls: number;
}

/** Why there is nothing to read. Four sentences, not one absence: a CLI with no
 *  reader, a tile that is not an agent session, a log that was never there, and
 *  a path that would not open are four different things to tell a person. */
export type Unavailable = "noReader" | "notAnAgent" | "noLog" | "unreadable";

/** What a reader can actually answer. Declared rather than inferred, in the
 *  manner of `ProviderCapabilities`: a reader that cannot tell a failure from a
 *  success says so, and the panel omits the column instead of drawing zeroes
 *  that read as "nothing failed". */
export interface ReaderCapabilities { outcomes: boolean; agents: boolean }

/** What a session did. `unavailable` set is NOT `calls: 0` — the first is "there
 *  is no log for this session", the second is "the log is here and this session
 *  has made no calls", and the panel says them differently. */
export interface ActivityRoll {
  cli: CliKind;
  agents: AgentTally[];
  tools: ToolTally[];
  calls: number;
  capabilities: ReaderCapabilities;
  readAt: number;
  unavailable: Unavailable | null;
  /** The read stopped at this many files rather than walking a tree without
   *  end. `null` is "everything was read". Reported rather than absorbed: a
   *  tally that quietly stopped counting is worse than one that says it did. */
  truncated: number | null;
}

/** What each of these sessions did, read off the agent's own log.
 *
 *  **Not on the five-second poll.** The heaviest transcript measured is 3.1 MB
 *  over 1728 lines and 47 files are past 1 MB; re-reading every open session's
 *  log every five seconds to fill a panel nobody has opened is the cost this is
 *  shaped to avoid. Called when a panel opens, and re-called on the tick only
 *  while one is on screen. Every requested id comes back. */
export const sessionActivity = (sessionIds: string[]) =>
  invoke<Record<string, ActivityRoll>>("session_activity", { sessionIds });

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
  /** Issue labels, as chips in the meta row. Empty for a card file, which has
   *  none — never a `kind`: an issue can carry two labels and `kind` is a
   *  single-valued select. */
  labels: string[];
}
// project/origin are set by the backend (workspace name / "human") and are
// deliberately not settable from here — see tasks_cmd::TaskDraftInput.
export interface TaskDraft { title: string; kind: KindId; body: string; }
/** Which fields of a card to write. Every field optional: Save applies only
 *  what the person touched, and a step-only move (drag-and-drop, `‹`/`›`) is a
 *  patch carrying only `status` — see tasks_cmd::tasks_update. */
export interface TaskPatch {
  title?: string; kind?: KindId; status?: StepId; body?: string;
  /** Why a card is being closed, where closing takes a reason
   *  (`completed` / `not planned`). Ignored by the file provider. */
  reason?: string;
}
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
  /** Whether ⚙ is offered. False for a synthesized board: there is no
   *  `board.json` to write, and one synthetic kind is not a choice. */
  boardEditable: boolean;
}
export type TrackerRoot = { kind: "project" } | { kind: "path"; path: string };
/** The two sources this build writes. Every *writer* builds one of these, so a
 *  mistyped `type` is still a compile error where it matters. */
export type KnownTrackerProviderConfig =
  | { type: "fs"; root: TrackerRoot }
  | { type: "github" };
/** A workspace's task source, as *read*. One element, never merged:
 *  `TrackerConfig.providers` is a list so a second kind arrives as an added
 *  variant, and every reader takes the first.
 *
 *  **The open tail is not laziness — it is #117's whole point in the type.** A
 *  store file written by a newer build can carry a `type` this build has never
 *  heard of, and Rust's `TrackerProvider::Unknown` keeps such a record rather than
 *  dropping it. Without the tail that record is representable at runtime and
 *  unrepresentable here, so every `switch` on `.type` would look exhaustive to
 *  `tsc` while the unrecognised case fell into whichever arm satisfied the
 *  compiler. With it, `type === "fs"` no longer proves there is a `root` either —
 *  which is honest: a damaged record can carry the one without the other, and
 *  `fsRootOf` is where that is checked once. */
export type TrackerProviderConfig = KnownTrackerProviderConfig | { type: string };
export interface TrackerConfig { providers: TrackerProviderConfig[] }

export interface IssueTotals {
  open: number;
  closed: number;
  /** GraphQL points left this hour, read from the response headers. Null when
   *  the headers said nothing — never 0, which means exhausted. */
  rateRemaining: number | null;
}

/** `limit` is how many rows per state to ask a paging source for; omitted, the
 *  provider uses its own defaults (50 open, 20 closed). A folder ignores it —
 *  `read_dir` returns all of it, so a page size there would be a fiction. The
 *  backend clamps whatever arrives (`tasks_cmd.rs`'s `MAX_PAGE_LIMIT`), because
 *  this number reaches `gh issue list -L` on a poll that repeats every 30 s. */
export const listTasks = (workspaceId: string, limit?: number) =>
  invoke<Task[]>("tasks_list", { workspaceId, limit: limit ?? null });
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

export const issueTotals = (workspaceId: string) =>
  invoke<IssueTotals>("issue_totals", { workspaceId });
/** The branch is derived in Rust from the number and the title, so the frontend
 *  never has to know the naming rule — and cannot get it wrong. */
export const issueWorktreeAdd = (workspaceId: string, number: number, title: string) =>
  invoke<string>("issue_worktree_add", { workspaceId, number, title });
export const issueWorktreePath = (workspaceId: string, number: number, title: string) =>
  invoke<string | null>("issue_worktree_path", { workspaceId, number, title });
export const issueWorktreeRemove = (workspaceId: string, number: number, title: string) =>
  invoke<void>("issue_worktree_remove", { workspaceId, number, title });
/** The sidebar's open count for whichever source this workspace reads. Null when
 *  there is no count to show — no tracker, or a source that could not answer. */
export const trackerOpenCount = (workspaceId: string) =>
  invoke<number | null>("tracker_open_count", { workspaceId });

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

/* --- What each connected AI has left ------------------------------------
   The one command #301 is built on, and it is deliberately provider-agnostic:
   the label, the window names, the caveats and the command that would answer an
   unknown row all arrive **inside the snapshot**. Nothing here knows the word
   "Claude", and #308's acceptance criterion is that adding a second AI does not
   change that. */

/** Where a number came from, and it is always on screen. See ADR-0009.
 *
 *  `reported` is the account's own accounting — what `/usage` draws. `observed`
 *  is what this app can see for itself, from the sessions it runs: real, and
 *  narrower than the account, because other terminals and other machines are
 *  not in it. `estimated` says so. `unknown` is not zero, and the difference is
 *  the whole point of the feature. */
export type UsageSource = "reported" | "observed" | "estimated" | "unknown";

/** How full a window is, in the only terms that change what a person does.
 *
 *  `exhausted` is a refusal, never arithmetic: a window at 100% has spent
 *  everything, which is not the same as having been turned away. */
export type LimitState = "ok" | "near" | "exhausted" | "unknown";

/** Absolutes, where a source gives them. `limit: null` is the ordinary case for
 *  an observed count — this app knows what it spent, not what was allowed. */
export interface Amount { used: number; limit: number | null; unit: string }

export interface LimitWindow {
  id: string;
  /** The provider's own words for this window, so the dialog reads the way the
   *  provider's own report reads. */
  label: string;
  usedFraction: number | null;
  amount: Amount | null;
  /** Epoch ms. `null` is legitimate: a window known to be spent whose reset the
   *  provider did not say, or did not say parseably. */
  resetsAt: number | null;
  state: LimitState;
  /** Where the **quantity** came from. `state` is outside this — a refusal can
   *  be known alongside a reported share. */
  source: UsageSource;
  /** The caveat, in words, for the dialog to print under the number. */
  note: string | null;
}

export interface AiUsage {
  /** The registry key. Never printed — see `label`. */
  provider: string;
  label: string;
  account: string | null;
  plan: string | null;
  windows: LimitWindow[];
  /** The **weakest** source among the windows, so it cannot over-claim. A row
   *  that prints one number prints that window's own source, not this. */
  source: UsageSource;
  fetchedAt: number;
  error: string | null;
  /** The command that would answer this if a person ran it themselves — for the
   *  action on an unknown row. Carried here rather than looked up by provider
   *  name, so nothing in `src/` needs a table of them. */
  probeCommand: string | null;
  /** Whether answering would need a credential this app does not hold. */
  needsCredential: boolean;
}

/** Every detected AI's limits. `force` is "read again", and the moment a limit
 *  banner has just gone past on a PTY: the two cases where a cached "you are
 *  fine" is a lie. Everything else is served from a TTL cache, so this is safe
 *  to call on a view change — but never on the poll tick. */
export const usageSnapshot = (force = false) =>
  invoke<AiUsage[]>("usage_snapshot", { force });

/** Forget the refusals this app watched happen, for one provider.
 *
 *  The escape hatch the observed source needs: a parser can be wrong, and an app
 *  insisting the budget is spent while sessions are plainly running would be
 *  worse than one that never said so. */
export const usageClearObserved = (provider: string) =>
  invoke<void>("usage_clear_observed", { provider });

/** A limit signal reached the app through a PTY. Emitted from the backend only
 *  when something changed, so the handler may re-read with `force`. */
export const onUsageChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("usage://changed", () => cb());
