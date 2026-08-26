import type { RunRecord, RunStatus, RunTrigger } from "./ipc";

/** Why an attempt produced nothing, in words the user can act on.
 *
 *  Run vocabulary, not schedule vocabulary, and it lives here because two
 *  places say it: the line under a scenario's name and the history row for the
 *  same record. `reason` is the scheduler's outcome code — it reaches the
 *  journal verbatim from `handle_scheduled_fire` — and one record phrased two
 *  ways in two places is the disagreement the dot exists to rule out. */
export const OUTCOME_TEXT: Record<string, string> = {
  "no-workspace": "no workspace",
  "skipped-overlap": "previous run still active",
  "not-scheduled": "schedule is off",
};

/** What a row says a run ended as.
 *
 *  `failed-to-launch` reads as "did not launch" rather than as its own tag: it
 *  is the one status where nothing ran at all, and the sentence a person needs
 *  is what happened, not what the field is called. */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "running",
  ended: "ended",
  error: "error",
  interrupted: "interrupted",
  "failed-to-launch": "did not launch",
};

/** Five states, four hues, and the fifth told apart by shape.
 *
 *  The palette spends hue on state and nothing else — inventing a fifth colour
 *  for this screen would take a step out of the three that already have to be
 *  separable at a glance everywhere else in the app. `error` and
 *  `failed-to-launch` are both failures and share the hue; the dashed border on
 *  `failed-to-launch` and its label are what tell them apart, which is the rule
 *  `styles.css` already states beside `.state-ended`: states differ by shape,
 *  not by colour alone.
 *
 *  `running` keeps the breathing dot the working chip has, for the same reason
 *  it has it: something is actually happening. */
export function runStatusClass(status: RunStatus): string {
  return `run-state run-${status}`;
}

/** How a run started, in words. Visible on the row because "the schedule ran
 *  this at 03:00" and "I ran this at 03:00" are different facts, and the whole
 *  reason both are in one journal is that the filter is cheaper than the split. */
export const RUN_TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: "manual",
  runNow: "run now",
  schedule: "scheduled",
  resume: "resumed",
};

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** "just now" / "12 minutes ago" / "2 hours ago" / "3 days ago".
 *
 *  Relative rather than absolute, because the question a history answers is
 *  "how long ago", and a wall clock makes the reader do the subtraction. Past
 *  a week it gives up and prints the date: "37 days ago" is arithmetic nobody
 *  asked for either.
 *
 *  A future timestamp reads as "just now" rather than "in 3 minutes". Clocks do
 *  move backwards — a DST change, an NTP correction — and a journal entry
 *  claiming to be from the future is a distraction, not information. */
export function agoLabel(at: number, now: number): string {
  const d = now - at;
  if (d < MIN) return "just now";
  if (d < HOUR) return plural(Math.floor(d / MIN), "minute");
  if (d < DAY) return plural(Math.floor(d / HOUR), "hour");
  if (d < 7 * DAY) return plural(Math.floor(d / DAY), "day");
  return new Date(at).toLocaleDateString();
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** How long a run took, or nothing when it is still going. */
export function durationLabel(rec: RunRecord): string | null {
  if (rec.closedAt === null) return null;
  const d = Math.max(0, rec.closedAt - rec.startedAt);
  if (d < MIN) return `${Math.round(d / 1000)}s`;
  if (d < HOUR) return `${Math.round(d / MIN)}m`;
  return `${Math.floor(d / HOUR)}h ${Math.round((d % HOUR) / MIN)}m`;
}

/** One run and everything it resumed, newest first.
 *
 *  A restart is not an unrelated second run, and a flat list makes it look like
 *  one: three rows for one piece of work, in reverse order, with nothing saying
 *  they belong together. `runs[0]` is the newest — the one whose status and
 *  result the chain is described by. */
export interface RunChain {
  runs: RunRecord[];
}

/** Fold `continuesRunId` chains into one entry each, keeping the order the
 *  records arrived in — newest first, as `list_runs` returns them.
 *
 *  A chain is placed where its **newest** member was, which is where a reader
 *  expects the work to appear. Members that are not in `records` — pruned by
 *  retention, or filtered out — simply are not in the chain: a chain is what is
 *  on hand, never a promise about what is missing. */
export function chainRuns(records: RunRecord[]): RunChain[] {
  const byId = new Map(records.map((r) => [r.runId, r]));
  // Which record continues which, so a chain can be walked forwards from any
  // member without re-scanning.
  const successor = new Map<string, string>();
  for (const r of records) {
    if (r.continuesRunId !== null && byId.has(r.continuesRunId)) {
      successor.set(r.continuesRunId, r.runId);
    }
  }
  const claimed = new Set<string>();
  const out: RunChain[] = [];
  for (const rec of records) {
    if (claimed.has(rec.runId)) continue;
    // Walk to the newest member first, so a chain met from its middle — which
    // happens whenever a filter or retention has removed the newest — is still
    // placed and ordered by whatever its newest surviving member is.
    let newest = rec;
    const guard = new Set<string>([rec.runId]);
    for (;;) {
      const next = successor.get(newest.runId);
      // The guard is not paranoia: `continuesRunId` comes off disk, and a
      // hand-edited or truncated journal can describe a cycle. A history that
      // hangs the window is worse than one that shows a short chain.
      if (next === undefined || guard.has(next)) break;
      guard.add(next);
      newest = byId.get(next)!;
    }
    const runs: RunRecord[] = [];
    let cur: RunRecord | undefined = newest;
    while (cur && !claimed.has(cur.runId)) {
      claimed.add(cur.runId);
      runs.push(cur);
      cur = cur.continuesRunId !== null ? byId.get(cur.continuesRunId) : undefined;
    }
    out.push({ runs });
  }
  return out;
}

/** The screen's filters. Both narrow what is already scoped to one workspace by
 *  the backend — see `list_runs`. */
export interface RunFilters {
  skillId: string | null;
  trigger: RunTrigger | null;
}

export function filterRuns(records: RunRecord[], f: RunFilters): RunRecord[] {
  return records.filter((r) =>
    (f.skillId === null || r.skillId === f.skillId)
    && (f.trigger === null || r.trigger === f.trigger));
}

/** Why the screen is empty, which is three different facts wearing one face.
 *
 *  Worth telling apart, because the next thing to do differs. Recording being
 *  off is the one that has to be said out loud whatever else is true: an empty
 *  history with the switch silently down is a bug report waiting to happen. */
export function emptyHistoryCopy(o: {
  recording: boolean;
  /** Whether the journal holds anything at all, across every workspace. */
  anyRuns: boolean;
  /** How many records this workspace has **before** the screen's own filters.
   *  Asked separately so an empty workspace is not blamed on a filter that is
   *  hiding nothing — which is what "there are runs here, but none match" would
   *  be saying, in a workspace where there are none. */
  workspaceRuns: number;
  /** Whether a scenario or trigger filter is narrowing the list. */
  filtered: boolean;
  workspaceName: string | null;
}): { title: string; body: string } {
  if (!o.recording) {
    return {
      title: "Scenario runs are not being recorded",
      body: "Recording is switched off, so nothing new is being written. Everything written "
        + "before it went off is still here and still readable — switching it off erases "
        + "nothing.",
    };
  }
  /* The one branch that has to say what this page IS, because it is the only one a
     person can reach before they have ever seen a record. The other three describe a
     situation; this one describes the page. */
  if (!o.anyRuns) {
    return {
      title: "No scenario runs yet",
      body: "A scenario is a prompt you keep, and the journal is what one leaves behind: "
        + "every time a scenario starts a session, its run is recorded here — how it "
        + "started, how long it took, and what it reported at the end. That is what makes "
        + "a sweep that ran at 03:00 readable at 09:00, when its session is long closed. "
        + "Sessions you start yourself — from a card, from an issue, from “+ session” — "
        + "are deliberately not recorded: this page answers what your scenarios did while "
        + "nobody was watching.",
    };
  }
  // Before the filter case, and that order is the whole of this branch: a
  // workspace with nothing in it is not a workspace whose filters hid
  // something, and saying "none of them match" where there is nothing to match
  // sends the reader to clear a filter that is doing no work.
  if (o.workspaceRuns === 0) {
    return {
      title: o.workspaceName === null
        ? "No workspace is selected"
        : `No scenario runs in ${o.workspaceName}`,
      body: "Other workspaces have runs recorded. A run belongs to the workspace it actually "
        + "happened in, so switching workspace switches what is listed here.",
    };
  }
  return {
    title: "Nothing matches these filters",
    body: "There are runs in this workspace, but none of them match the scenario or the "
      + "trigger you picked.",
  };
}

/* --- the three row actions ------------------------------------------------ */

/** Whether an action is offered, and if not, the sentence the disabled control
 *  carries. A refusal shown before the click beats one that arrives after it. */
export type ActionVerdict = { ok: true } | { ok: false; reason: string };

/** Whether there is a live tile to jump to.
 *
 *  The question is whether a tile for this session exists, and nothing else.
 *  Deliberately **not** also `status === "running"`: `onExit` keeps a tile on
 *  the deck after the session ends, for scrollback, so a run that has just
 *  finished still has its terminal — with the whole of the output the row can
 *  only clamp — sitting there. Refusing on status would hide the way back to it
 *  at exactly the moment somebody reads the result and wants the rest.
 *
 *  A closed record whose tile has been shut has no tile, and a
 *  `failed-to-launch` one never had a session at all; both fall out of the
 *  liveness test on their own. */
export function canJump(rec: RunRecord, liveSessions: readonly string[]): boolean {
  return rec.sessionId !== null && liveSessions.includes(rec.sessionId);
}

/** Whether this run's scenario can be launched again.
 *
 *  `skill` is the scenario **as it stands now**, or undefined if it is gone;
 *  `workspaceExists` is whether the workspace it is pinned to is still there.
 *  Both are the caller's to resolve, which is what keeps this pure and keeps
 *  `runs.ts` and `skills.ts` from importing each other.
 *
 *  A deleted scenario is refused rather than silently recreated from the
 *  record's snapshot. The record holds the expanded prompt, so launching it as
 *  a one-off would be possible — and would be a second concept ("a run that
 *  belongs to no scenario") bolted on to make one button work. Somebody deleted
 *  that scenario; the honest answer is to say so. */
export function canRerun(
  skill: { workspaceId?: string | null } | undefined,
  workspaceExists: boolean,
): ActionVerdict {
  if (!skill) {
    return {
      ok: false,
      reason: "This scenario has been deleted, so there is nothing to run again. "
        + "The record keeps what it ran, but re-creating a scenario somebody removed "
        + "is not something a history row should do.",
    };
  }
  if (skill.workspaceId && !workspaceExists) {
    return {
      ok: false,
      reason: "This scenario’s workspace was deleted — it cannot run. "
        + "Open it for editing and pick a workspace.",
    };
  }
  return { ok: true };
}

/** The values to offer when re-running, matched against the **current**
 *  template's placeholders.
 *
 *  A placeholder the prompt no longer has is dropped; one it has gained comes up
 *  empty. The record says what ran once, not what the scenario is now, and a
 *  form pre-filled from a prompt that has since been edited would be quietly
 *  wrong in exactly the fields somebody changed.
 *
 *  The lookup is guarded, the way `fillPlaceholders` guards its mirror image:
 *  the placeholder name comes out of a prompt somebody typed and the record is
 *  JSON, so `{{constructor}}` would otherwise resolve through the prototype and
 *  put `function Object() { [native code] }` in the field. */
export function reconcileParams(
  names: readonly string[],
  recorded: Record<string, string>,
): Record<string, string> {
  // Null-prototype for the write as well as guarded on the read: `{{__proto__}}`
  // is a name the placeholder regex accepts, and on an ordinary object
  // `out["__proto__"] = ""` sets nothing at all — the field would then be
  // missing rather than empty, and the placeholder would go to claude verbatim.
  const out: Record<string, string> = Object.create(null);
  for (const n of names) {
    out[n] = Object.prototype.hasOwnProperty.call(recorded, n) ? recorded[n] : "";
  }
  return out;
}

/** Whether one scenario's history can be erased, and if not, why.
 *
 *  Refused while any of the records on screen is still `running`. The journal is
 *  append-only and the erase rewrites it: taking out an open record does not
 *  merely lose the past runs, it loses the one in flight — its `Closed` event
 *  arrives later with no `Started` to attach to, is folded away, and the run is
 *  never journalled at all. Somebody asked to erase history, not to un-record
 *  something still happening.
 *
 *  `runs` is what the screen is showing, which is also what the erase will
 *  reach: the same workspace scope, narrowed to the same scenario. */
export function canEraseHistory(
  runs: readonly RunRecord[],
  skillId: string,
): ActionVerdict {
  const live = runs.filter((r) => r.skillId === skillId && r.status === "running").length;
  if (live === 0) return { ok: true };
  return {
    ok: false,
    reason: live === 1
      ? "One of this scenario’s runs is still going. Erasing now would take its record "
        + "with it, and the run would never be journalled at all — wait for it to finish."
      : `${live} of this scenario’s runs are still going. Erasing now would take their `
        + "records with them, and those runs would never be journalled at all — wait for "
        + "them to finish.",
  };
}

/** Whether the transcript can be revealed.
 *
 *  Claude Code owns those files and they legitimately disappear, so this is an
 *  ordinary "no" rather than a fault. Two ways to know before trying: the record
 *  never had a path, or it had one and could not be read at close — which is
 *  precisely what `resultSource: "none"` on a closed record means. The file can
 *  still go between the render and the click, and the backend refuses that too. */
export function canReveal(rec: RunRecord): ActionVerdict {
  if (rec.transcriptPath === null) {
    return { ok: false, reason: "No transcript was ever reported for this run." };
  }
  if (rec.closedAt !== null && rec.resultSource === "none") {
    return {
      ok: false,
      reason: "The transcript was already gone when this run finished — Claude Code owns "
        + "those files and they do not last forever.",
    };
  }
  return { ok: true };
}

/** What the row says about the result, when there is no result to show.
 *
 *  Never an empty line and never an empty string: the run happening and the run
 *  producing nothing are different facts, and a blank space says the second
 *  while meaning the first. */
export function noResultReason(rec: RunRecord): string {
  if (rec.status === "failed-to-launch") {
    // Through `OUTCOME_TEXT`, never raw: `skipped-overlap` is an identifier,
    // and this screen's whole claim is that a run producing nothing reads as
    // why. An unknown code still shows — a code beats a blank.
    const why = rec.reason === null ? null : OUTCOME_TEXT[rec.reason] ?? rec.reason;
    return why === null ? "No session was started." : `No session was started — ${why}.`;
  }
  if (rec.status === "running") return "Still running.";
  if (rec.transcriptPath === null) {
    return "No transcript was reported for this run, so there is nothing to read back.";
  }
  return "The transcript is gone — Claude Code owns those files and they do not last forever.";
}
