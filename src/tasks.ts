import type { BoardConfig, BoardStep, SessionState, Task } from "./ipc";
import { isKnownStep, isTerminal, kindLabel, workingStep } from "./board-config";

/** A live tile, as far as the board cares: which card it came from and how it is doing. */
export interface TaskSessionLink { session: string; taskId?: string; state: SessionState }

// Re-exported so the board keeps one import for everything card-shaped; the
// reader itself lives with the rest of them in board-config.ts.
export { kindLabel };

/** States in which a session still counts as alive — launching a second session
 *  for the same card would duplicate the work. */
const ALIVE: SessionState[] = ["idle", "working", "waitingInput"];
/** States in which the card should read as "in progress" on the board. */
const BUSY: SessionState[] = ["working", "waitingInput"];

export function liveSessionForTask(taskId: string, links: TaskSessionLink[]): string | null {
  const hit = links.find((l) => l.taskId === taskId && ALIVE.includes(l.state));
  return hit ? hit.session : null;
}

/** Board status. Never stored: a dead session simply stops being counted, so a
 *  card cannot get stuck "in progress". */
export function derivedStatus(
  task: Task, links: TaskSessionLink[], cfg: BoardConfig,
): "open" | "done" | "working" {
  if (isTerminal(cfg, task.status)) return "done";
  const busy = links.some((l) => l.taskId === task.id && BUSY.includes(l.state));
  return busy ? "working" : "open";
}

/** Initial prompt for a session launched from a card. */
export function taskPrompt(task: Task, cfg: BoardConfig): string {
  const lines = [
    "A task from the cowork-deck tracker.",
    "",
    `Title: ${task.title}`,
    `Kind: ${kindLabel(cfg, task.kind)}`,
    `id: ${task.id}`,
    `Card file: ${task.path}`,
  ];
  const body = task.body.trim();
  if (body) lines.push("", body);
  // Omitted entirely when the configuration has no steps: "The board's steps
  // are: ." is worse than silence, and a prompt is the one place an agent
  // cannot check a claim against anything else. This is Task 4's ruling —
  // `taskPrompt` deliberately shipped without a steps line until now, and the
  // reviewer of Task 4 flagged its absence as correct rather than missing.
  if (cfg.steps.length > 0) {
    const steps = cfg.steps.map((s) => s.id).join(", ");
    lines.push(
      "",
      `This card is in step "${task.status}". The board's steps are: ${steps}.`,
      `Move it as the work progresses: "$COWORK_TASK_BIN" status ${task.id} <step>`,
    );
  }
  lines.push(
    "",
    `When the work is finished, close the card: "$COWORK_TASK_BIN" done ${task.id}`,
  );
  return lines.join("\n");
}

export interface BoardColumn {
  step: BoardStep;
  tasks: Task[];
  /** How many the cap is hiding. Always 0 for a non-terminal step. */
  hidden: number;
}

export interface BoardColumns {
  columns: BoardColumn[];
  /** Cards naming a step the configuration does not know. Alive and visible:
   *  they arrive from a hand-edited or synced board.json, not from the editor. */
  unknown: Task[];
  /** Cards belonging to other projects in a shared root — counted, not silently hidden. */
  foreign: { project: string; count: number }[];
}

/** Descending by timestamp; an empty timestamp sorts last rather than throwing. */
function byTimeDesc(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

export function boardColumns(
  tasks: Task[], project: string, cfg: BoardConfig, doneLimit = 20,
): BoardColumns {
  const mine: Task[] = [];
  const foreignCount = new Map<string, number>();
  for (const t of tasks) {
    // A damaged card is always ours to show: it may be damaged *because* the
    // project field is missing, and hiding it would lose the task silently.
    if (t.damaged || t.project === project) mine.push(t);
    else foreignCount.set(t.project, (foreignCount.get(t.project) ?? 0) + 1);
  }

  const columns = cfg.steps.map((step) => {
    const all = mine.filter((t) => t.status === step.id);
    const sorted = step.terminal === true
      ? all.sort((a, b) => byTimeDesc(a.resolved ?? "", b.resolved ?? ""))
      : all.sort((a, b) => byTimeDesc(a.created, b.created));
    // The cap is for a column that only grows and is only ever reviewed. A
    // non-terminal column hiding a card is hiding work.
    if (step.terminal !== true) return { step, tasks: sorted, hidden: 0 };
    return {
      step,
      tasks: sorted.slice(0, doneLimit),
      hidden: Math.max(0, sorted.length - doneLimit),
    };
  });

  return {
    columns,
    unknown: mine.filter((t) => !isKnownStep(cfg, t.status)),
    foreign: [...foreignCount.entries()].map(([p, count]) => ({ project: p, count })),
  };
}

/** A card parked in the working step with nothing running on it. Possible only
 *  because ▶ now writes the step, so the board has to say so rather than let it
 *  read as work in progress. */
export function isStale(task: Task, links: TaskSessionLink[], cfg: BoardConfig): boolean {
  const working = workingStep(cfg);
  if (working === null || task.status !== working) return false;
  return !links.some((l) => l.taskId === task.id && ALIVE.includes(l.state));
}
