import {
  listRuns, listSkills, saveSkill, removeSkill, loadScheduleState,
  type RunRecord, type ScheduleRun, type Skill,
} from "./ipc";
import { confirmModal } from "./modal";
import { skillForm } from "./forms";
import { scheduleRowText } from "./schedule";
import { RUN_STATUS_LABEL, agoLabel, runStatusClass } from "./runs";
import { syncDotPhase } from "./dot-phase";
import { icon, iconButton, SCENARIO_ICONS, type IconName } from "./icons";

/** A scenario pinned to a workspace that no longer exists. It cannot run —
 *  `resolveScheduledWorkspace` refuses rather than picking the wrong folder —
 *  so it has to stay reachable for the user to repin or delete it.
 *
 *  Nothing is an orphan until at least one workspace is known: workspaces load
 *  asynchronously, and an empty list means "not loaded yet" far more often
 *  than it means "the user has none". */
export function isOrphan(skill: Skill, knownWorkspaceIds: string[]): boolean {
  if (!skill.workspaceId || knownWorkspaceIds.length === 0) return false;
  return !knownWorkspaceIds.includes(skill.workspaceId);
}

/** Which scenarios the sidebar shows: unpinned ones, those pinned to the
 *  active workspace, and orphans — which belong nowhere and would otherwise
 *  be invisible everywhere. */
export function visibleSkills(
  items: Skill[],
  activeWorkspaceId: string | null,
  knownWorkspaceIds: string[],
): Skill[] {
  return items.filter((s) =>
    !s.workspaceId
    || s.workspaceId === activeWorkspaceId
    || s.schedule?.enabled // fires regardless of what is on screen
    || isOrphan(s, knownWorkspaceIds));
}

/** A scenario's mark: an icon name renders from the sprite, anything else is
 *  an emoji saved before the picker existed and is shown untouched. */
function scenarioMark(name: string): Node {
  return (SCENARIO_ICONS as readonly string[]).includes(name)
    ? icon(name as IconName, 14)
    : document.createTextNode(name);
}

export class SkillsPanel {
  private items: Skill[] = [];
  constructor(
    private mount: HTMLElement,
    private getActiveWorkspaceId: () => string | null,
    private onLaunch: (skill: Skill) => void,
    private onRunScheduled: (skill: Skill) => void,
    /** Ids of the workspaces that currently exist — used to spot scenarios
     *  pinned to a deleted one. Defaults to "unknown", which marks nothing. */
    private getWorkspaceIds: () => string[] = () => [],
    private getActiveWorkspaceName: () => string | null = () => null,
    /** Open the history screen filtered to this scenario. The dot is an
     *  indicator, not a launcher: this row has learned that lesson once
     *  already, when a single ⏰ was both a status badge and a real launch and
     *  reaching for information started a session. */
    private onOpenHistory: (skill: Skill) => void = () => {},
    /** Name of one workspace by id. Only the edit dialog needs it, and only to
     *  say which workspace a scenario is pinned to when that is not the one on
     *  screen — which for a scheduled scenario is the ordinary case. */
    private getWorkspaceName: (id: string) => string | null = () => null,
  ) {}

  private runs: Record<string, ScheduleRun> = {};
  /** The newest journal record per scenario, whichever workspace it ran in —
   *  the dot answers "what happened last time", and a scenario pinned to no
   *  workspace runs wherever it was launched. */
  private lastRun: Record<string, RunRecord> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  async load() {
    this.items = await listSkills();
    await this.refreshRuns();
    // "next run" is a moving target; without this the row would claim
    // "today 09:00" long after 09:00 has passed, which is exactly how the
    // old tooltip misled people.
    if (this.refreshTimer === null) {
      this.refreshTimer = setInterval(() => this.render(), 60_000);
    }
  }

  /** Re-read what the backend knows about past runs, then repaint. Called on
   *  load, after every fire, and whenever a record opens or closes.
   *
   *  Two sources, and they answer different questions.
   *  `schedule_state.json` is the scheduler's **gate** — when the next
   *  occurrence is, and whether one was already attempted — and it stays that.
   *  What actually happened comes from the run journal now: `lastOutcome` only
   *  ever knew about scheduled fires, so a scenario run by hand had no outcome
   *  to show at all. */
  async refreshRuns() {
    try {
      this.runs = await loadScheduleState();
    } catch (e) {
      console.debug("loadScheduleState failed", e);
    }
    try {
      // Newest first, so the first record naming a scenario is its latest run.
      const recent: Record<string, RunRecord> = {};
      for (const r of await listRuns(null, null)) {
        if (!(r.skillId in recent)) recent[r.skillId] = r;
      }
      this.lastRun = recent;
    } catch (e) {
      console.debug("listRuns failed", e);
    }
    this.render();
  }

  /** The record the dot is drawn from. Exposed because clicking the dot has to
   *  land on that same record, and the history screen is scoped to one
   *  workspace while this is scoped to none. */
  lastRunOf(id: string): RunRecord | null { return this.lastRun[id] ?? null; }

  find(id: string): Skill | undefined { return this.items.find((s) => s.id === id); }
  get all(): Skill[] { return this.items; }

  private visible(): Skill[] {
    return visibleSkills(this.items, this.getActiveWorkspaceId(), this.getWorkspaceIds());
  }

  private async add() {
    const res = await skillForm(this.getActiveWorkspaceId(), undefined, this.getActiveWorkspaceName());
    if (!res) return;
    const sk: Skill = { id: crypto.randomUUID(), ...res };
    this.items = await saveSkill(sk);
    this.render();
  }

  private async edit(id: string) {
    const cur = this.items.find((s) => s.id === id);
    if (!cur) return;
    // The pin goes into the form as the scenario's own, so that saving from
    // another workspace cannot drag it here (#249). The exception is an orphan:
    // its workspace is gone, the row's tooltip sends people here to pick one,
    // and a pin that names nothing is worth less than the one that is open.
    const pinned = isOrphan(cur, this.getWorkspaceIds()) ? null : (cur.workspaceId ?? null);
    const res = await skillForm(this.getActiveWorkspaceId(), {
      name: cur.name, icon: cur.icon, prompt: cur.prompt, workspaceId: pinned,
      schedule: cur.schedule ?? null,
    }, this.getActiveWorkspaceName(), pinned ? this.getWorkspaceName(pinned) : null);
    if (!res) return;
    this.items = await saveSkill({ ...cur, ...res });
    this.render();
  }

  private async del(id: string) {
    if (!(await confirmModal("Delete scenario?"))) return;
    this.items = await removeSkill(id);
    this.render();
  }

  private render() {
    this.mount.innerHTML = "<h3>Scenarios</h3>";
    for (const s of this.visible()) {
      const row = document.createElement("div");
      row.className = "sk-row";
      const orphan = isOrphan(s, this.getWorkspaceIds());
      if (orphan) row.classList.add("sk-orphan");
      const run = document.createElement("button");
      run.className = "sk-run";
      run.append(scenarioMark(s.icon), document.createTextNode(` ${s.name}`));
      run.title = orphan
        ? "This scenario\u2019s workspace was deleted — it cannot run. Open it for editing and pick a workspace."
        : s.prompt;
      run.disabled = orphan;
      run.onclick = () => this.onLaunch(s);

      // The indicator and the action are separate now. One ⏰ used to be
      // both: it looked like a status badge and launched a real session on
      // click, so reaching for information started a run.
      const sched = s.schedule;
      let now: HTMLButtonElement | null = null;
      if (sched?.enabled && !orphan) {
        now = iconButton("clock-play", `Run now: ${s.name}`, "sk-now");
        now.onclick = () => this.onRunScheduled(s);
      }

      // A state dot for the last run, and nothing more. It follows the name —
      // which is itself the launcher — and its 24px button is mostly
      // transparent padding, so the 10px it draws stands clear of everything
      // that starts a session. An indicator that launched something is the
      // exact mistake the ⏰ button was split in two to undo. Absent until the
      // scenario has run at all: a dot with no state to show would be a
      // decoration.
      const last = this.lastRun[s.id];
      let dot: HTMLButtonElement | null = null;
      if (last) {
        dot = document.createElement("button");
        dot.className = `sk-dot ${runStatusClass(last.status)}`;
        // Remade by this list's own minute timer; see `src/dot-phase.ts`.
        syncDotPhase(dot);
        dot.type = "button";
        const label = `Last run: ${RUN_STATUS_LABEL[last.status]}, ${agoLabel(last.startedAt, Date.now())}`;
        dot.title = `${label} — open this scenario's history`;
        dot.setAttribute("aria-label", `${label}. Open this scenario's history.`);
        dot.onclick = () => this.onOpenHistory(s);
      }

      const edit = iconButton("pencil", `Edit scenario: ${s.name}`, "sk-edit");
      edit.onclick = () => this.edit(s.id);
      const x = iconButton("trash", `Delete scenario: ${s.name}`, "sk-del btn--icon--danger");
      x.onclick = () => this.del(s.id);
      row.append(run, ...(dot ? [dot] : []), ...(now ? [now] : []), edit, x);
      this.mount.appendChild(row);
      if (sched) {
        // Visible text, not a title attribute: a tooltip is unreachable from
        // the keyboard and does not survive a stale render.
        const line = document.createElement("div");
        line.className = sched.enabled ? "sk-sched" : "sk-sched sk-sched-off";
        line.textContent = scheduleRowText(
          sched, this.runs[s.id] ?? null, new Date(), this.lastRun[s.id] ?? null,
        );
        this.mount.appendChild(line);
      }
      if (orphan) {
        // Says why the row is dead and what to do; without it the scenario
        // just looks broken.
        const note = document.createElement("div");
        note.className = "sk-orphan-note";
        note.textContent = "workspace deleted — repoint it or delete it";
        this.mount.appendChild(note);
      }
    }
    const addBtn = document.createElement("button");
    addBtn.className = "sk-add"; addBtn.textContent = "+ scenario";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
  }
}
