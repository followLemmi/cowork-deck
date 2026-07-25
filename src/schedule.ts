import type { Schedule, SchedulePreset, SessionState, Skill, Workspace } from "./ipc";
import { parsePlaceholders } from "./placeholders";

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const pad = (n: number): string => String(n).padStart(2, "0");

export function describeSchedule(s: Schedule): string {
  const p = s.preset;
  if (p.kind === "hourly") return `каждый час в :${pad(p.minute)}`;
  if (p.kind === "daily") return `ежедневно ${pad(p.hour)}:${pad(p.minute)}`;
  return `еженедельно ${WEEKDAYS[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
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
  if (d.toDateString() === now.toDateString()) return `сегодня ${t}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `завтра ${t}`;
  return `${WEEKDAYS[d.getDay()]} ${t}`;
}

const inRange = (n: number, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;

/** Gate for saving a scenario: an enabled schedule needs a valid time and a
 *  non-empty default for every placeholder, since a scheduled run cannot ask. */
export function validateSchedule(
  enabled: boolean,
  preset: SchedulePreset,
  prompt: string,
  defaults: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  if (!enabled) return { ok: true };
  if (!inRange(preset.minute, 0, 59)) return { ok: false, error: "Минуты: 0–59" };
  if (preset.kind !== "hourly" && !inRange(preset.hour, 0, 23)) {
    return { ok: false, error: "Часы: 0–23" };
  }
  if (preset.kind === "weekly" && !inRange(preset.weekday, 0, 6)) {
    return { ok: false, error: "День недели: 0–6" };
  }
  for (const name of parsePlaceholders(prompt)) {
    if (!defaults[name] || !defaults[name].trim()) {
      return { ok: false, error: `Заполните значение по умолчанию для {{${name}}}` };
    }
  }
  return { ok: true };
}

/** Overlap guard: skip a scheduled fire only if the scenario's previous
 *  scheduled session is still running or waiting for input. */
export function shouldSkipOverlap(prev: SessionState | null): boolean {
  return prev === "working" || prev === "waitingInput";
}

export type WorkspaceResolution =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "no-workspace" };

/** Where a scheduled run of `skill` should happen. A scenario pinned to a
 *  workspace runs there; an unpinned one runs in the active workspace (as a
 *  manual launch would). A pinned workspace that no longer exists refuses
 *  rather than running the prompt in the wrong folder. */
export function resolveScheduledWorkspace(
  skill: Skill,
  all: Workspace[],
  active: Workspace | null,
): WorkspaceResolution {
  const ws = skill.workspaceId
    ? all.find((w) => w.id === skill.workspaceId) ?? null
    : active;
  return ws ? { ok: true, workspace: ws } : { ok: false, reason: "no-workspace" };
}
