import type { RunRecord, RunTrigger, Skill } from "./ipc";
import { icon, SCENARIO_ICONS, type IconName } from "./icons";
import { syncDotPhase } from "./dot-phase";
// The panel names live in one place, and this page is one of them: the rail says
// "Journal", the palette says "Journal", and now so does its own head.
import { PANEL_TITLE } from "./view";
import {
  agoLabel, canEraseHistory, canJump, canRerun, canReveal, chainRuns, durationLabel,
  emptyHistoryCopy, filterRuns, noResultReason, RUN_STATUS_LABEL, RUN_TRIGGER_LABEL,
  runStatusClass,
  type ActionVerdict, type RunFilters,
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
  /** Scenarios that currently exist, for the filter's own list and for whether
   *  a row can be run again. Records name their scenario themselves, so this is
   *  never where a row's *name* comes from — a deleted scenario's rows still
   *  render under the name they ran with. */
  skills: Skill[];
  /** Sessions with a live tile, so "jump to it" is offered only where there is
   *  something to jump to. */
  liveSessions: string[];
  /** Workspaces that still exist, for the orphan case a re-run has to refuse. */
  workspaceIds: string[];
}

export interface HistoryHandlers {
  onFilter: (f: RunFilters) => void;
  /** Go to the tile this record is running in, switching workspace if it is
   *  running in another one. */
  onJump: (rec: RunRecord) => void;
  /** Launch this record's scenario again — through the usual "Launch
   *  parameters" form, with the recorded values visible. Never silent. */
  onRerun: (rec: RunRecord, skill: Skill) => void;
  /** Show the transcript in the file manager. Not an in-app viewer. */
  onReveal: (rec: RunRecord) => void;
  /** Erase one scenario's history, wholesale, after asking. */
  onDeleteHistory: (skillId: string, name: string) => void;
  /** Say why a control will not do anything, when somebody activates it anyway.
   *  The refusals are `aria-disabled`, not `disabled`, precisely so they can be
   *  reached and read without a mouse — see `refuse`. */
  onRefused: (reason: string) => void;
}

/** Refuse before the click, with the reason on the control itself — and
 *  reachable without a mouse.
 *
 *  `aria-disabled` rather than `disabled`. A `disabled` button is out of the tab
 *  order entirely, so its `title` (hover) and its accessible name (focus) are
 *  both mouse-only channels: a keyboard user, or anyone on a touch screen where
 *  there is no hover at all, would get a grey dead control and no way to reach
 *  the sentence saying why. The button stays focusable and inert instead, and
 *  says the reason out loud when it is activated. */
function refuse(
  btn: HTMLButtonElement,
  verdict: { ok: false; reason: string },
  say: (reason: string) => void,
): void {
  btn.setAttribute("aria-disabled", "true");
  btn.title = verdict.reason;
  btn.setAttribute("aria-label", `${btn.textContent} — ${verdict.reason}`);
  btn.onclick = () => say(verdict.reason);
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
    /* The island's own head, in the shape the other two use: a bare `h3` as the
       first child of the mount, which `#sidebar h3` turns into the island's head.
       It says "Journal" and not "Scenario runs" — one name for one thing, and it is
       the name the rail and the palette already use.
       It was `h2.hist-title`, clipped out of sight, because the panel's head above
       this page said the name instead. That head no longer states which page it is
       holding, so the page says it itself. */
    this.mount.append(el("h3", "", PANEL_TITLE.history), this.head(state));

    const rows = filterRuns(state.runs, state.filters);
    if (rows.length === 0) {
      this.mount.append(this.empty(state));
      return;
    }
    const list = el("div", "hist-list");
    for (const chain of chainRuns(rows)) list.append(this.chain(chain.runs, now, state));
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
    const where = el("span", "hist-where",
      state.workspaceName === null ? "no workspace" : state.workspaceName);
    head.append(where);

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

    /* Two filters and nothing else. The "Record scenario runs" switch was here — a
       setting living inside the page it affects, which is a fair argument while a
       page has room for it and a bad one in a 280px column where it sat above the
       records looking like a filter. It belongs in the settings window, beside the
       other things that are set once and left alone. Until it gets there the value is
       read-only: `ui_state`'s `recordScenarioRuns` still gates recording and still
       defaults to on, and the empty state still says so when it is off. */
    filters.append(bySkill, byTrigger);
    head.append(filters);

    // Erasing is per scenario and wholesale, and it is offered only while the
    // screen is narrowed to one — which is what makes it readable rather than a
    // button somebody presses next to a list of everything. `SkillsPanel`'s row
    // already carries four controls and its dot is an indicator; a destructive
    // fifth there would sit one pixel from ▶.
    const only = state.filters.skillId;
    // The name off `named`, which holds the scenario's *current* one (and marks
    // a deleted one as such), rather than off whichever record happens to come
    // first: a rename would otherwise make the confirmation ask about a name
    // the reader no longer has, on the one path with no undo.
    const eraseName = only === null ? undefined : named.get(only);
    // And only when this workspace actually holds records of it — the erase
    // reaches exactly the rows the screen is showing, so with none on screen it
    // is a button that would do nothing.
    if (only !== null && eraseName !== undefined && state.runs.some((r) => r.skillId === only)) {
      const erase = el("button", "hist-erase", "Delete this scenario’s history");
      erase.dataset.fk = "delete-history";
      const verdict = canEraseHistory(state.runs, only);
      if (verdict.ok) erase.onclick = () => this.handlers.onDeleteHistory(only, eraseName);
      else refuse(erase, verdict, this.handlers.onRefused);
      head.append(erase);
    }
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
  private chain(runs: RunRecord[], now: number, state: HistoryState): HTMLElement {
    const box = el("div", "hist-chain");
    if (runs.length > 1) box.classList.add("hist-chain--multi");
    for (const [i, rec] of runs.entries()) box.append(this.row(rec, now, i > 0, state));
    if (runs.length > 1) {
      const note = el("div", "hist-chain-note",
        `${runs.length} runs — this scenario was resumed after a restart.`);
      box.append(note);
    }
    return box;
  }

  private row(rec: RunRecord, now: number, continued: boolean, state: HistoryState): HTMLElement {
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
    // A running record breathes, and has to do it in step with the same run's
    // dot in the scenario list beside it. See `src/dot-phase.ts`.
    syncDotPhase(status);
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

    row.append(this.result(rec), this.actions(rec, state));
    return row;
  }

  /** Three actions, and deliberately no fourth.
   *
   *  None of them is destructive, and none of them edits or deletes a single
   *  record: history is immutable, and a journal whose rows can be revised
   *  answers nothing. Erasing exists at one granularity only — the whole of one
   *  scenario's history, offered from the head above when the screen is narrowed
   *  to that scenario. */
  private actions(rec: RunRecord, state: HistoryState): HTMLElement {
    const row = el("div", "hist-actions");
    if (canJump(rec, state.liveSessions)) {
      const jump = el("button", "hist-action", "Go to the session");
      jump.dataset.fk = `jump-${rec.runId}`;
      jump.onclick = () => this.handlers.onJump(rec);
      row.append(jump);
    }
    const skill = state.skills.find((s) => s.id === rec.skillId);
    // The scenario as it stands now, not as the record remembers it: whether it
    // can run again is a fact about today.
    const rerunOk = canRerun(
      skill,
      !skill?.workspaceId || state.workspaceIds.includes(skill.workspaceId),
    );
    const rerun = el("button", "hist-action", "Re-run…");
    rerun.dataset.fk = `rerun-${rec.runId}`;
    // The ellipsis is a promise: this opens the parameters form and launches
    // nothing until it is confirmed.
    if (rerunOk.ok) rerun.onclick = () => this.handlers.onRerun(rec, skill!);
    else refuse(rerun, rerunOk, this.handlers.onRefused);
    row.append(rerun);

    const revealOk = canReveal(rec);
    const reveal = el("button", "hist-action", "Reveal the transcript");
    reveal.dataset.fk = `reveal-${rec.runId}`;
    if (revealOk.ok) reveal.onclick = () => this.handlers.onReveal(rec);
    else refuse(reveal, revealOk, this.handlers.onRefused);
    row.append(reveal);
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
