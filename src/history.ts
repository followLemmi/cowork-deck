import type { RunRecord, RunTrigger, Skill } from "./ipc";
import { icon, SCENARIO_ICONS, type IconName } from "./icons";
import {
  agoLabel, chainRuns, durationLabel, emptyHistoryCopy, filterRuns, noResultReason,
  RUN_STATUS_LABEL, RUN_TRIGGER_LABEL, runStatusClass, type RunFilters,
} from "./runs";

export interface HistoryState {
  /** This workspace's records, newest first, as `list_runs` returned them. */
  runs: RunRecord[];
  /** Whether the journal holds anything at all, across every workspace. The
   *  difference between "nothing has ever run" and "nothing ran here" is worth
   *  two different sentences, and only the caller can know the first. */
  anyRuns: boolean;
  workspaceName: string | null;
  recording: boolean;
  filters: RunFilters;
  /** Scenarios that currently exist, for the filter's own list. Records name
   *  their scenario themselves, so this is only the picker's vocabulary — a
   *  deleted scenario's rows still render under the name they ran with. */
  skills: Skill[];
}

export interface HistoryHandlers {
  onFilter: (f: RunFilters) => void;
  /** Turn recording on or off. The switch lives here rather than in
   *  `settingsDialog`: that dialog is a text-size chooser and its own doc
   *  comment argues against growing it casually, and this screen is already the
   *  one place that has to explain what being off looks like. */
  onRecording: (on: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Always `textContent`: a result is whatever the agent wrote, a scenario name
  // is whatever somebody typed, and neither is markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A scenario's mark: an icon name renders from the sprite, anything else is an
 *  emoji saved before the picker existed and is shown untouched. The record's
 *  own icon, never a lookup through `skillId` — that snapshot is the point. */
function scenarioMark(name: string): Node {
  return (SCENARIO_ICONS as readonly string[]).includes(name)
    ? icon(name as IconName, 14)
    : document.createTextNode(name);
}

/** How many lines of a result a row shows before it has to be expanded. */
const RESULT_CLAMP_CLASS = "hist-result--clamped";

/** The history of what the scenarios did, for one workspace.
 *
 *  Read-only. Every launch path in the app writes its record in Rust; this
 *  renders what `list_runs` hands back and nothing else. */
export class HistoryView {
  readonly mount = el("div", "hist");
  /** Which chains the reader has opened, keyed by the chain's newest run so the
   *  state survives a repaint — the list is rebuilt whenever a record opens or
   *  closes, and losing an expanded result on every scheduled fire would make
   *  the screen unreadable while anything is running. */
  private expanded = new Set<string>();

  constructor(private handlers: HistoryHandlers) {}

  render(state: HistoryState, now: number): void {
    const focusKey = this.mount.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.fk ?? null
      : null;
    this.mount.replaceChildren();
    this.mount.append(this.head(state));

    const rows = filterRuns(state.runs, state.filters);
    if (rows.length === 0) {
      this.mount.append(this.empty(state));
      return;
    }
    const list = el("div", "hist-list");
    for (const chain of chainRuns(rows)) list.append(this.chain(chain.runs, now));
    this.mount.append(list);
    this.hideUselessToggles();

    if (focusKey) this.mount.querySelector<HTMLElement>(`[data-fk="${focusKey}"]`)?.focus();
  }

  /** Drop the "Show more" from results that were never clamped.
   *
   *  Measured rather than guessed from the text, because the clamp is three
   *  lines of a monospace face inside a pane whose width is the window's and
   *  whose type scales between an 11px and an 18.85px root — the same string is
   *  one line at one end and four at the other. A button that reveals nothing is
   *  a small lie, and there are a hundred rows of them.
   *
   *  Done after the list is in the document, since nothing has a layout before
   *  that. `clientHeight === 0` means there is no layout to read at all — a
   *  screen still hidden, or jsdom, which computes none — and the toggle is left
   *  alone rather than removed on the strength of a zero. */
  private hideUselessToggles(): void {
    for (const box of this.mount.querySelectorAll<HTMLElement>(".hist-result-box")) {
      const text = box.querySelector<HTMLElement>(".hist-result");
      const toggle = box.querySelector<HTMLElement>(".hist-expand");
      if (!text || !toggle || text.clientHeight === 0) continue;
      if (text.scrollHeight <= text.clientHeight + 1) toggle.remove();
    }
  }

  private head(state: HistoryState): HTMLElement {
    const head = el("div", "hist-head");
    const title = el("h2", "hist-title", "Scenario runs");
    const where = el("span", "hist-where",
      state.workspaceName === null ? "no workspace" : state.workspaceName);
    head.append(title, where);

    const filters = el("div", "hist-filters");

    const bySkill = el("select", "hist-filter");
    bySkill.dataset.fk = "filter-skill";
    bySkill.setAttribute("aria-label", "Filter by scenario");
    bySkill.append(new Option("Every scenario", ""));
    // The scenarios that exist, plus any the records name that no longer do —
    // a history whose filter cannot reach a deleted scenario's rows would hide
    // exactly the rows the snapshot exists to keep readable.
    const named = new Map<string, string>();
    for (const s of state.skills) named.set(s.id, s.name);
    for (const r of state.runs) if (!named.has(r.skillId)) named.set(r.skillId, `${r.name} (deleted)`);
    for (const [id, name] of named) {
      bySkill.append(new Option(name, id, false, state.filters.skillId === id));
    }
    bySkill.onchange = () => this.handlers.onFilter({
      ...state.filters, skillId: bySkill.value === "" ? null : bySkill.value,
    });

    const byTrigger = el("select", "hist-filter");
    byTrigger.dataset.fk = "filter-trigger";
    byTrigger.setAttribute("aria-label", "Filter by how the run started");
    byTrigger.append(new Option("However it started", ""));
    for (const [value, label] of Object.entries(RUN_TRIGGER_LABEL)) {
      byTrigger.append(new Option(label, value, false, state.filters.trigger === value));
    }
    byTrigger.onchange = () => this.handlers.onFilter({
      ...state.filters, trigger: byTrigger.value === "" ? null : byTrigger.value as RunTrigger,
    });

    const record = el("label", "hist-record");
    const box = el("input");
    box.type = "checkbox";
    box.checked = state.recording;
    box.dataset.fk = "record-toggle";
    box.onchange = () => this.handlers.onRecording(box.checked);
    record.append(box, document.createTextNode("Record scenario runs"));

    filters.append(bySkill, byTrigger, record);
    head.append(filters);
    return head;
  }

  private empty(state: HistoryState): HTMLElement {
    const copy = emptyHistoryCopy({
      recording: state.recording,
      anyRuns: state.anyRuns,
      // The workspace's own records, before this screen's filters — `state.runs`
      // is already scoped to the workspace by `list_runs` and by nothing else.
      workspaceRuns: state.runs.length,
      filtered: state.filters.skillId !== null || state.filters.trigger !== null,
      workspaceName: state.workspaceName,
    });
    const box = el("div", "hist-empty");
    box.append(el("h3", "hist-empty-title", copy.title), el("p", "hist-empty-body", copy.body));
    return box;
  }

  /** One chain, folded: one line per run, grouped, so a restart does not read as
   *  an unrelated second run. `runs[0]` is the newest and describes the chain. */
  private chain(runs: RunRecord[], now: number): HTMLElement {
    const box = el("div", "hist-chain");
    if (runs.length > 1) box.classList.add("hist-chain--multi");
    for (const [i, rec] of runs.entries()) box.append(this.row(rec, now, i > 0));
    if (runs.length > 1) {
      const note = el("div", "hist-chain-note",
        `${runs.length} runs — this scenario was resumed after a restart.`);
      box.append(note);
    }
    return box;
  }

  private row(rec: RunRecord, now: number, continued: boolean): HTMLElement {
    const row = el("div", "hist-row");
    if (continued) row.classList.add("hist-row--continued");
    row.dataset.status = rec.status;

    const head = el("div", "hist-row-head");
    const name = el("span", "hist-name");
    // The record's own snapshot, never a lookup: a run of a scenario that has
    // since been renamed or deleted still says what it was launched as.
    name.append(scenarioMark(rec.icon), document.createTextNode(` ${rec.name}`));
    name.title = rec.name;

    const status = el("span", runStatusClass(rec.status), RUN_STATUS_LABEL[rec.status]);
    const when = el("span", "hist-when", agoLabel(rec.startedAt, now));
    // The exact instant is a tooltip rather than the row's text: "2 hours ago"
    // is the answer, and the timestamp is the follow-up question.
    when.title = new Date(rec.startedAt).toLocaleString();
    const trigger = el("span", "hist-trigger", RUN_TRIGGER_LABEL[rec.trigger]);

    head.append(status, name, trigger, when);
    const took = durationLabel(rec);
    if (took !== null) head.append(el("span", "hist-took", took));
    row.append(head);

    if (rec.branch !== null) {
      const branch = el("span", "hist-branch");
      branch.append(icon("git-branch", 12), document.createTextNode(` ${rec.branch}`));
      row.append(branch);
    }

    row.append(this.result(rec));
    return row;
  }

  /** The final assistant message, clamped and expandable in place — or an
   *  honest sentence saying why there is none. */
  private result(rec: RunRecord): HTMLElement {
    if (rec.result === null) {
      // Deliberately not an empty box: `result: null` means the run produced
      // nothing readable, which is a different fact from producing nothing.
      return el("p", "hist-noresult", noResultReason(rec));
    }
    const box = el("div", "hist-result-box");
    if (rec.cleared) {
      // Said out loud, because the shown text is the tail of a conversation
      // whose beginning went into another file when somebody typed `/clear`.
      // Presenting the tail as the whole is the one lie the marker prevents.
      box.append(el("p", "hist-cleared",
        "/clear was used during this run — what follows is the tail of the conversation, "
        + "and the earlier part is in another transcript."));
    }
    const text = el("pre", `hist-result ${RESULT_CLAMP_CLASS}`, rec.result);
    const toggle = el("button", "hist-expand", "Show more");
    toggle.dataset.fk = `expand-${rec.runId}`;
    toggle.setAttribute("aria-expanded", String(this.expanded.has(rec.runId)));
    const apply = () => {
      const open = this.expanded.has(rec.runId);
      text.classList.toggle(RESULT_CLAMP_CLASS, !open);
      toggle.textContent = open ? "Show less" : "Show more";
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.onclick = () => {
      if (this.expanded.has(rec.runId)) this.expanded.delete(rec.runId);
      else this.expanded.add(rec.runId);
      apply();
    };
    apply();
    box.append(text, toggle);
    return box;
  }
}
