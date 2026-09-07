import type {
  RunRecord, Schedule, SchedulePreset, ScheduleRun, SessionState, Workspace,
} from "./ipc";
import { parsePlaceholders } from "./placeholders";
// One phrasing for one outcome code, wherever it is shown. Lives with the run
// vocabulary because the history screen says the same thing about the same
// record.
import { OUTCOME_TEXT } from "./runs";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number): string => String(n).padStart(2, "0");

export function describeSchedule(s: Schedule): string {
  const p = s.preset;
  if (p.kind === "hourly") return `hourly at :${pad(p.minute)}`;
  if (p.kind === "daily") return `daily at ${pad(p.hour)}:${pad(p.minute)}`;
  return `weekly on ${WEEKDAYS[p.weekday]} at ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Next fire strictly after `now`, in local time. Display-only; the backend
 *  is authoritative for actual firing. */
export function nextRun(p: SchedulePreset, now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (p.kind === "hourly") {
    d.setMinutes(p.minute);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d;
  }
  if (p.kind === "daily") {
    d.setHours(p.hour, p.minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setHours(p.hour, p.minute, 0, 0);
  d.setDate(d.getDate() + (p.weekday - now.getDay()));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

export function nextRunLabel(p: SchedulePreset, now: Date): string {
  const d = nextRun(p, now);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `today ${t}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${t}`;
  return `${WEEKDAYS[d.getDay()]} ${t}`;
}

/** One sentence saying what the controls in the schedule editor add up to:
 *  the rule, when it next fires, and which folder it will fire in.
 *
 *  The last part is not decoration, and it is now always an answer. It used to
 *  read "in whichever workspace is active at the time", which was an honest
 *  description of a coin flip: an unpinned nightly job landed in whatever
 *  project happened to be on screen when the schedule fired. A schedule is
 *  pinned to one workspace (#249), so the only thing left to say is which —
 *  and, when the app has no workspace at all, that one is needed. */
export function schedulePreview(
  p: SchedulePreset,
  now: Date,
  workspaceName: string | null,
): string {
  const rule = describeSchedule({ preset: p, defaults: {}, enabled: true });
  const where = workspaceName
    ? `in workspace “${workspaceName}”`
    : "and needs a workspace to run in";
  return `Runs ${rule} · next run ${nextRunLabel(p, now)} · ${where}.`;
}

/** The line under a scenario's name: rule, next run, and what came of the
 *  last run. Replaces a native tooltip that no keyboard user could reach
 *  and that went stale as soon as the panel stopped re-rendering.
 *
 *  Two sources, and the split is the point. `run` is `schedule_state.json`, the
 *  scheduler's **gate**: when the next occurrence is, which only the side that
 *  actually fires can say. `last` is the run journal, which is what actually
 *  happened — and it is wider than the gate ever was, because `lastOutcome`
 *  only ever knew about scheduled fires and a scenario run by hand left no
 *  trace in it at all. Where they disagree, the journal wins: it is a record of
 *  runs, and the gate is a record of attempts. */
export function scheduleRowText(
  s: Schedule, run: ScheduleRun | null, now: Date, last: RunRecord | null = null,
): string {
  const rule = describeSchedule(s);
  if (!s.enabled) return `schedule is off · ${rule}`;

  // Prefer what the backend says: it owns the firing, and a second copy of
  // the arithmetic here would drift from it with nothing to catch the drift.
  const next = run?.nextRunMs != null ? stamp(run.nextRunMs, now) : nextRunLabel(s.preset, now);
  const parts = [rule, `next run ${next}`];
  if (last) {
    if (last.status === "failed-to-launch") {
      const why = last.reason === null ? "nothing started" : OUTCOME_TEXT[last.reason] ?? last.reason;
      parts.push(`${stamp(last.startedAt, now)} did not run: ${why}`);
    } else {
      parts.push(`last run ${stamp(last.startedAt, now)}`);
    }
  } else if (run?.lastOutcome && run.lastOutcome !== "launched") {
    // Nothing in the journal yet — a schedule that last fired before the
    // journal existed, or with recording switched off. The gate's own memory is
    // the only thing left to say anything with, and saying nothing would read
    // as "it has never failed".
    const why = OUTCOME_TEXT[run.lastOutcome] ?? run.lastOutcome;
    parts.push(`${stamp(run.lastAttempt, now)} did not run: ${why}`);
  } else if (run?.lastRun) {
    parts.push(`last run ${stamp(run.lastRun, now)}`);
  } else if (run) {
    parts.push("has not run yet");
  }
  return parts.join(" · ");
}

/** An instant as "today 09:00" / "yesterday 09:00" / "tomorrow 09:00" / "Mon 09:00". */
function stamp(ms: number, now: Date): string {
  const d = new Date(ms);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `today ${t}`;
  const shifted = (days: number) => {
    const x = new Date(now);
    x.setDate(now.getDate() + days);
    return x.toDateString();
  };
  if (d.toDateString() === shifted(-1)) return `yesterday ${t}`;
  if (d.toDateString() === shifted(1)) return `tomorrow ${t}`;
  return `${WEEKDAYS[d.getDay()]} ${t}`;
}

const inRange = (n: number, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;

/** Gate for saving a scenario: an enabled schedule needs a workspace to run in,
 *  a valid time, and a non-empty default for every placeholder, since a
 *  scheduled run cannot ask.
 *
 *  The workspace is a requirement rather than a preference (#249): a schedule
 *  with no pin used to run in whichever workspace happened to be active, so the
 *  repository an unattended agent worked in was decided by where the mouse was
 *  last. Refusing here is the only place that can be prevented before the fact. */
export function validateSchedule(
  enabled: boolean,
  preset: SchedulePreset,
  prompt: string,
  defaults: Record<string, string>,
  /** The workspace the scenario will be pinned to, as the form has it. */
  workspaceId: string | null,
): { ok: true } | { ok: false; error: string } {
  if (!enabled) return { ok: true };
  if (!workspaceId) {
    return { ok: false, error: "A scheduled scenario runs in one workspace: open the workspace it belongs to." };
  }
  if (!inRange(preset.minute, 0, 59)) return { ok: false, error: "Minutes: 0–59" };
  if (preset.kind !== "hourly" && !inRange(preset.hour, 0, 23)) {
    return { ok: false, error: "Hours: 0–23" };
  }
  if (preset.kind === "weekly" && !inRange(preset.weekday, 0, 6)) {
    return { ok: false, error: "Weekday: 0–6" };
  }
  for (const name of parsePlaceholders(prompt)) {
    if (!defaults[name] || !defaults[name].trim()) {
      return { ok: false, error: `Fill in a default value for {{${name}}}` };
    }
  }
  return { ok: true };
}

/** Overlap guard: skip a scheduled fire only if the scenario's previous
 *  scheduled session is still running or waiting for input.
 *
 *  Stays on this side of the wall, unlike the workspace resolution below. The
 *  backend has no answer to give: it forwards session states without keeping
 *  them, and "the previous scheduled session of this scenario" is a tile the
 *  deck owns. Moving the predicate would mean moving that map. */
export function shouldSkipOverlap(prev: SessionState | null): boolean {
  return prev === "working" || prev === "waitingInput";
}

export type WorkspaceResolution =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "no-workspace" };

/** The workspace a scheduled run happens in, by id: the pin, and nothing else.
 *
 *  There is no fallback to the active workspace, and that absence is the whole
 *  of #249 — an unattended `claude` running `git` and `gh` in a folder chosen by
 *  where the mouse was last is expensive when it guesses wrong, and it guessed
 *  silently. A pin that no longer names a workspace refuses for the same reason.
 *
 *  For a backend-driven fire the id arrives already resolved against
 *  `workspaces.json` (`scheduler::resolve_workspace`); this call turns it into
 *  the workspace record the launch needs, and is what the ⏰ button resolves
 *  the scenario's own pin through. */
export function resolveScheduledWorkspace(
  workspaceId: string | null,
  all: Workspace[],
): WorkspaceResolution {
  const ws = workspaceId ? all.find((w) => w.id === workspaceId) ?? null : null;
  return ws ? { ok: true, workspace: ws } : { ok: false, reason: "no-workspace" };
}
