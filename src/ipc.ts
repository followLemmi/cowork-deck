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
  /** Whether scenario runs are journalled. Default on; off writes nothing new
   *  and deletes nothing already written, and reads keep working. Required for
   *  the same reason as the two above: Rust fills it from a `serde` default. */
  recordScenarioRuns: boolean;
}

/** A change to the stored state, which is what `save_ui_state` takes.
 *
 *  Separate from `UiState` on purpose. The backend used to write the file from a
 *  whole `UiState`, and the one caller sends the active workspace alone — so the
 *  moment a second field existed, every workspace switch would have wiped the text
 *  size. An absent key here means "leave it alone". */
export interface UiStatePatch {
  activeWorkspaceId?: string;
  uiScale?: number;
  prDiffCols?: number;
  recordScenarioRuns?: boolean;
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

export const startSession = (
  session: string, cwd: string, workspaceId: string | null, initialPrompt: string | null,
  taskId: string | null, cols: number, rows: number, resume: boolean,
  scenario: ScenarioLaunch | null = null,
) => invoke<SessionAuth>("start_session", {
  session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume, scenario,
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

/** Bytes, not text. **The decode is deliberately not done here**, and that is
 *  the whole point of this function's shape.
 *
 *  It used to return a string, via `new TextDecoder().decode(bytes)` — a fresh
 *  decoder per event, with no memory of the one before it. The reader thread in
 *  `pty.rs` cuts the stream wherever a 4096-byte read happens to end, which
 *  respects no character boundary, so a multi-byte sequence split across two
 *  events came back as `U+FFFD` on both sides: one 3-byte glyph became two or
 *  three cells and every column after it on that line was off by one or two.
 *  With the agent's whole TUI drawn out of `─ │ ⏺ ✻ ⎿`, that is a frame that
 *  visibly stops lining up.
 *
 *  macOS made it four times as likely: the Darwin tty caps a single read at 1024
 *  bytes no matter how big the buffer is, so the same output arrives in four
 *  times as many pieces, each with its own boundary. Measured against a writer
 *  that emits a whole frame in one `write` — which is how Ink, and so Claude
 *  Code, repaints — one line in five came out corrupted.
 *
 *  `Terminal.write` takes a `Uint8Array` and runs xterm's own stateful UTF-8
 *  decoder, which holds a partial sequence until the rest of it arrives. Handing
 *  the bytes over intact is what makes the problem cease to exist rather than
 *  become rarer. */
export function decodeB64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const onOutput = (cb: (session: string, bytes: Uint8Array) => void): Promise<UnlistenFn> =>
  listen<{ session: string; dataB64: string }>("session://output", (e) =>
    cb(e.payload.session, decodeB64Bytes(e.payload.dataB64)));
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
}
export const gitStatus = (cwd: string) => invoke<GitStatus>("git_status", { cwd });
/** One invoke per tick for every open session — the title and the token counts
 *  come from the same bytes, so asking per session would read each transcript
 *  twice. Every requested id comes back, including ids with no transcript. */
export const sessionSnapshots = (sessionIds: string[]) =>
  invoke<Record<string, SessionSnapshot>>("session_snapshots", { sessionIds });

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
