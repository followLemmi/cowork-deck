import type { SessionState, Task, TaskKind } from "./ipc";

/** A live tile, as far as the board cares: which card it came from and how it is doing. */
export interface TaskSessionLink { session: string; taskId?: string; state: SessionState }

const KIND_LABEL: Record<TaskKind, string> = { bug: "bug", task: "task", idea: "idea" };
export function kindLabel(kind: TaskKind): string { return KIND_LABEL[kind]; }

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
export function derivedStatus(task: Task, links: TaskSessionLink[]): "open" | "done" | "working" {
  if (task.status === "done") return "done";
  const busy = links.some((l) => l.taskId === task.id && BUSY.includes(l.state));
  return busy ? "working" : "open";
}

/** Initial prompt for a session launched from a card. */
export function taskPrompt(task: Task): string {
  const lines = [
    "A task from the cowork-deck tracker.",
    "",
    `Title: ${task.title}`,
    `Kind: ${kindLabel(task.kind)}`,
    `id: ${task.id}`,
    `Card file: ${task.path}`,
  ];
  const body = task.body.trim();
  if (body) lines.push("", body);
  lines.push(
    "",
    `When the work is finished, close the card: "$COWORK_TASK_BIN" done ${task.id}`,
  );
  return lines.join("\n");
}

export interface BoardColumns {
  open: Task[];
  done: Task[];
  /** How many done cards the limit is hiding. */
  doneHidden: number;
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

export function boardColumns(tasks: Task[], project: string, doneLimit = 20): BoardColumns {
  const mine: Task[] = [];
  const foreignCount = new Map<string, number>();
  for (const t of tasks) {
    // A damaged card is always ours to show: it may be damaged *because* the
    // project field is missing, and hiding it would lose the task silently.
    if (t.damaged || t.project === project) mine.push(t);
    else foreignCount.set(t.project, (foreignCount.get(t.project) ?? 0) + 1);
  }

  const open = mine.filter((t) => t.status === "open")
    .sort((a, b) => byTimeDesc(a.created, b.created));
  const doneAll = mine.filter((t) => t.status === "done")
    .sort((a, b) => byTimeDesc(a.resolved ?? "", b.resolved ?? ""));

  return {
    open,
    done: doneAll.slice(0, doneLimit),
    doneHidden: Math.max(0, doneAll.length - doneLimit),
    foreign: [...foreignCount.entries()].map(([p, count]) => ({ project: p, count })),
  };
}
