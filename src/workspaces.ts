import { listWorkspaces, saveWorkspace, removeWorkspace, loadUiState, saveUiState, type Workspace, type UiState, type Skill } from "./ipc";
import { confirmModal } from "./modal";
import { workspaceForm } from "./forms";
import { icon, iconButton, type IconName } from "./icons";

/** Confirmation text for deleting a workspace. Deleting one strands every
 *  scenario pinned to it — they stop being runnable, and any schedule on them
 *  quietly stops producing anything — so the count belongs in the question,
 *  not in a surprise afterwards. */
export function describeDeleteImpact(workspaceId: string, skills: Skill[]): string {
  const pinned = skills.filter((s) => s.workspaceId === workspaceId);
  if (pinned.length === 0) return "Delete workspace?";
  const scheduled = pinned.filter((s) => s.schedule?.enabled).length;
  const noun = pinned.length === 1 ? "scenario is" : "scenarios are";
  const tail = scheduled > 0 ? `, ${scheduled} of them scheduled` : "";
  return `Delete workspace? ${pinned.length} ${noun} pinned to it${tail}`
    + " — they will stop running.";
}

/** Tooltip for the open-task badge. English needs one distinction rather than
 *  the three the Russian original agreed with, but it still needs that one:
 *  "1 open tasks" reads as a bug in the code, not as a count. */
export function openTaskCountLabel(n: number): string {
  return `${n} open task${n === 1 ? "" : "s"}`;
}

export class WorkspacesPanel {
  /** Scenarios, so deletion can report what it will strand. Injected because
   *  the skills panel owns them and loads independently. */
  private getSkills: () => Skill[] = () => [];
  setSkillsSource(get: () => Skill[]) { this.getSkills = get; }
  private items: Workspace[] = [];
  /** The `ws-waiting` span in each row of the last render, so the deck's count can
   *  be written into a row this panel is not re-rendering. */
  private waitingSlots = new Map<string, HTMLElement>();
  /** Pressed the row that is already active — fold its sessions. */
  private onReselect: ((id: string) => void) | null = null;
  /** Open one of the workspace's own pages — its board, its pull requests. */
  private onOpenPage: ((id: string, page: "board" | "pr") => void) | null = null;
  /** Called at the end of every render, because a render replaces the containers
   *  the deck's session rows were in. */
  private onRendered: (() => void) | null = null;

  /** Wired after construction, like `setSkillsSource` and for the same reason: the
   *  deck and this panel are built before either can be given the other. */
  setTreeHooks(hooks: {
    reselect: (id: string) => void;
    rendered: () => void;
    openPage: (id: string, page: "board" | "pr") => void;
  }) {
    this.onReselect = hooks.reselect;
    this.onRendered = hooks.rendered;
    this.onOpenPage = hooks.openPage;
    this.render();
  }

  /** Put keyboard focus on the active workspace's row. What the top bar's crumb
   *  presses: it names the workspace and takes you to the one row that can do
   *  anything about it. */
  focusActive() {
    this.mount.querySelector<HTMLElement>(".ws-row.active .ws-label")?.focus();
  }

  /** The container this panel left under a workspace's row. */
  sessionHost(workspaceId: string): HTMLElement | null {
    return this.mount.querySelector<HTMLElement>(`.ws-kids[data-ws="${workspaceId}"]`);
  }

  /** Whether this workspace's sessions are showing, written into the row without
   *  re-rendering it — the deck owns which groups are folded, and it folds them on
   *  its own beat.
   *
   *  The row could be folded and unfolded from the day the tree arrived, and
   *  nothing said so: the gesture was there and the affordance was not, which is
   *  the same as not having it. A chevron, in the position every other disclosure
   *  in this app puts one, rotated by the state it reports. */
  showExpanded(workspaceId: string, on: boolean) {
    const row = this.mount.querySelector<HTMLElement>(`.ws-row[data-ws="${workspaceId}"]`);
    row?.querySelector(".ws-label")?.setAttribute("aria-expanded", String(on));
    row?.classList.toggle("is-open", on);
    // The workspace's own pages fold with its sessions: they are its children too.
    const nav = this.mount.querySelector<HTMLElement>(`.ws-nav[data-ws="${workspaceId}"]`);
    if (nav) nav.hidden = !on;
  }

  /** The deck's count, written into the row without re-rendering it. */
  showWaiting(workspaceId: string, n: number) {
    const slot = this.waitingSlots.get(workspaceId);
    if (!slot) return;
    slot.hidden = n === 0;
    slot.textContent = n > 0 ? `${n} waiting` : "";
    if (n > 0) slot.title = `${n} of this workspace's sessions are waiting for a decision`;
  }
  private activeId: string | null = null;
  /** Open tasks per workspace; filled in by main.ts. */
  private counts = new Map<string, number>();
  constructor(
    private mount: HTMLElement,
    private onSelect: (ws: Workspace) => void,
    private onChanged?: () => void,
    /** Привязка воркспейса к GitHub-аккаунту изменилась: живые сессии этого
     *  воркспейса работают на устаревшем окружении до перезапуска. */
    private onGithubChanged: (workspaceId: string) => void = () => {},
    /** Whether selecting a workspace here is remembered as the app's startup
     *  workspace.
     *
     *  True for the main window, false for a window pinned to one workspace. A
     *  pinned window selects its own workspace as it boots, and persisting that
     *  would rewrite what the *main* window opens with — so pulling a workspace
     *  out would silently change which project the app starts on next time.
     *  `ui_state.json` holds one answer for the app, and it is the main
     *  window's.
     *
     *  Set at construction rather than flipped afterwards, because it never
     *  changes for the life of a window — and because a window's kind is known
     *  before the panel exists. */
    private persistActive = true,
    /** Pull this workspace out into a window of its own.
     *
     *  Absent in a window that is already pinned to one workspace — there is
     *  nowhere further to pull it — and absent in tests that do not care, which
     *  is why it defaults to nothing rather than being required. */
    /** The one control that moves a workspace between windows, in whichever
     *  direction this window can move it: out, in the main window, and back, in
     *  a window pinned to one workspace. One slot rather than two, because the
     *  two are never both available and a row with a disabled twin of the
     *  control beside it says less than a row with one control that works. */
    private moveAction: {
      icon: IconName;
      label: (name: string) => string;
      run: (ws: Workspace) => void;
      /** Begin a possible tear-out from a press on the row. Absent where the
       *  platform cannot place a window, and where there is nowhere to tear to.
       *  The row's ordinary click is untouched either way: a press that does not
       *  become a drag has to cost nothing. */
      drag?: (ws: Workspace, e: PointerEvent) => void;
    } | null = null,
    /** Raise the window a detached workspace lives in. */
    private onRaise: ((ws: Workspace) => void) | null = null,
    /** A workspace has been deleted, and any window pinned to it has to go. */
    private onDeleted: ((workspaceId: string) => void) | null = null,
  ) {}

  /** Which workspaces are open in a window of their own.
   *
   *  The owner's requirement, verbatim: *"we need to show this pulled-out
   *  workspace as disabled in the main window, so the user sees it did not
   *  disappear into the void."* So the row stays exactly where it was, in a
   *  third state beside active and inactive: visibly inactive, not selectable as
   *  this window's workspace, and clicking it raises the window that has it. */
  private detached = new Set<string>();
  setDetached(ids: Set<string>) {
    // Cheap identity check, because this arrives on every report from every
    // window — five seconds apart at rest — and `render()` rebuilds the list
    // from `innerHTML`, which would throw away focus and any open tooltip.
    if (ids.size === this.detached.size && [...ids].every((id) => this.detached.has(id))) return;
    this.detached = new Set(ids);
    this.render();
  }

  setCounts(counts: Record<string, number>) {
    this.counts = new Map(Object.entries(counts));
    this.render();
  }

  get active(): Workspace | null {
    return this.items.find((w) => w.id === this.activeId) ?? null;
  }

  get all(): Workspace[] { return this.items; }

  async load() {
    this.items = await listWorkspaces();
    if (!this.activeId && this.items.length) {
      const saved = (await loadUiState()).activeWorkspaceId;
      const pick = saved && this.items.some((w) => w.id === saved) ? saved : this.items[0].id;
      this.select(pick);
    }
    this.render();
  }

  private select(id: string) {
    this.activeId = id;
    if (this.persistActive) {
      saveUiState({ activeWorkspaceId: id }).catch((e) => console.debug("saveUiState failed", e));
    }
    const ws = this.active;
    if (ws) this.onSelect(ws);
    this.render();
  }

  /** Switch to a workspace named by something other than this panel — today the
   *  scenario row's state dot, which reports a run that may have happened
   *  somewhere else and would otherwise open a history screen not containing
   *  it. Answers whether it switched: the workspace a record names can have
   *  been deleted since, and the caller has to be able to say so rather than
   *  silently show the wrong list. */
  activate(id: string): boolean {
    if (id === this.activeId) return true;
    if (!this.items.some((w) => w.id === id)) return false;
    this.select(id);
    return true;
  }

  /** Public because the empty deck offers the same action: with no workspace there is
   *  nowhere for a session to run, so "add one" is the only thing that screen can
   *  usefully say — and it must be the same form the sidebar's own button opens. */
  async add() {
    const res = await workspaceForm();
    if (!res) return;
    const ws: Workspace = { id: crypto.randomUUID(), ...res };
    this.items = await saveWorkspace(ws);
    this.onChanged?.();
    this.select(ws.id);
  }

  private async edit(id: string) {
    const cur = this.items.find((w) => w.id === id);
    if (!cur) return;
    const res = await workspaceForm({
      // The id is what lets the form count the cards still in the old folder
      // before offering to leave them behind.
      id: cur.id, name: cur.name, path: cur.path, color: cur.color,
      github: cur.github ?? null, tracker: cur.tracker ?? null,
    });
    if (!res) return;
    const before = JSON.stringify(cur.github ?? null);
    this.items = await saveWorkspace({ ...cur, ...res });
    if (JSON.stringify(res.github ?? null) !== before) this.onGithubChanged(id);
    this.onChanged?.();
    this.render();
  }

  private async del(id: string) {
    if (!(await confirmModal(describeDeleteImpact(id, this.getSkills())))) return;
    this.items = await removeWorkspace(id);
    // A window pinned to this workspace is now pinned to nothing. It hands its
    // sessions back — they survive as orphans in the main window — and closes.
    // Never a window showing "no workspace": that would be a fourth window state
    // nothing else in the app has, and every later change would have to keep
    // answering for it.
    this.onDeleted?.(id);
    if (this.activeId === id) {
      const next = this.items[0]?.id ?? null;
      this.activeId = null;
      if (next) { this.select(next); return; } // select() fires onSelect + renders
      this.render();
      return;
    }
    // A non-active workspace was deleted: its sessions (if any) are now orphans.
    // Re-notify so the Deck recomputes tile visibility + sidebar grouping.
    const active = this.active;
    if (active) this.onSelect(active);
    this.render();
  }

  private render() {
    this.waitingSlots.clear();
    this.mount.innerHTML = "<h3>Workspaces and sessions</h3>";
    for (const w of this.items) {
      const row = document.createElement("div");
      const isDetached = this.detached.has(w.id);
      // A detached workspace is not this window's active one even if it was when
      // it left, or the deck would filter to a workspace whose tiles are all
      // somewhere else.
      const isActive = w.id === this.activeId && !isDetached;
      row.className = "ws-row" + (isActive ? " active" : "") + (isDetached ? " detached" : "");
      row.dataset.ws = w.id;
      /* The disclosure, first in the row, where every other one in this app is.
         Not a control of its own: pressing anywhere in the row is what folds or
         activates it — two targets inside one row is how a tree gets something to
         miss — so this is an indicator and is `aria-hidden`, with the state itself
         on the button in `aria-expanded`. */
      const caret = document.createElement("span");
      caret.className = "ws-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.append(icon("chevron", 12));
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = w.color;
      const label = document.createElement("button");
      label.className = "ws-label"; label.textContent = w.name;
      // The one element in the row that truncates was the one without a tooltip,
      // while the two that had them are what caused it. Reaches AT through the
      // button's own text; this is for the sighted user reading "co…".
      label.title = w.name;
      // Which workspace is active was carried by `.ws-row.active`'s tint and inset
      // border alone — nothing a screen reader reports. On the button rather than
      // on the row, because the button is what the person lands on and what a
      // reader announces.
      if (isActive) label.setAttribute("aria-current", "true");
      // Says what it does, rather than being marked unavailable. `aria-disabled`
      // would be wrong twice over: the control works, and what it does is not
      // what the others do. The same reading `src/view.ts` settled on for the
      // view bar — stay a real button and let the accessible name carry it.
      if (isDetached) label.setAttribute("aria-label", `${w.name} — in its own window; open it`);
      // Select on a click anywhere in the row that is not a control — the same shape
      // as `BoardView.makeOpenable`, and for the same reason: the name was the only
      // target, which made a workspace a thin strip of clickable text in a row that
      // otherwise did nothing, while the dot, the count and the bound login all
      // looked equally pressable.
      //
      // The label stays a `<button>`: that is what makes it reachable and operable
      // from the keyboard and what carries `aria-current`. Its click — including the
      // synthetic one Enter and Space produce — bubbles to here, so there is ONE
      // handler and no way for the two to disagree or to fire twice.
      //
      // `.ws-edit` and `.ws-del` are excluded because each means something other than
      // "switch to this": ✎ opens the form, 🗑 asks to delete. Matched with `closest`
      // so a glyph inside a button counts as that button.
      row.onclick = (e) => {
        if ((e.target as Element | null)?.closest(".ws-edit, .ws-del, .ws-detach")) return;
        // Clicking a detached workspace raises its window instead of switching
        // to it. Switching would show an empty deck: its tiles are elsewhere.
        if (isDetached) { this.onRaise?.(w); return; }
        // One gesture with a rule: a workspace that is not active becomes active,
        // and pressing the one that already is folds its sessions. Splitting
        // "activate" from "expand" across two targets inside one row is how a tree
        // gets two things to press, one of which is always the one you miss.
        if (isActive) { this.onReselect?.(w.id); return; }
        this.select(w.id);
      };
      const edit = iconButton("pencil", `Edit workspace: ${w.name}`, "ws-edit");
      edit.onclick = () => this.edit(w.id);
      const x = iconButton("trash", `Delete workspace: ${w.name}`, "ws-del btn--icon--danger");
      x.onclick = () => this.del(w.id);
      // Excluded from the row's select handler above for the same reason ✎ and 🗑
      // are: it means something other than "switch to this".
      // No pull-out control on a workspace that is already out. The count badge
      // beside it deliberately keeps working — the workspace is still being
      // worked on, just not here.
      const beginDrag = this.moveAction?.drag;
      if (beginDrag && !isDetached) {
        row.addEventListener("pointerdown", (e) => beginDrag(w, e));
      }
      const move = this.moveAction && !isDetached
        ? iconButton(this.moveAction.icon, this.moveAction.label(w.name), "ws-detach")
        : null;
      if (move) move.onclick = () => this.moveAction!.run(w);
      row.append(caret, dot, label);
      /* One group for everything that trails the name, and it does not wrap. The
         row wraps — that is how the account gets its own line — and with the
         caret added the three buttons started wrapping instead, leaving a lone
         bin under the name. Grouped, the NAME is what gives up width, which it
         can: it truncates and keeps its tooltip. */
      const acts = document.createElement("span");
      acts.className = "ws-acts";

      /* How many of this workspace's sessions are waiting for a decision. Always
         present, empty when the answer is none: the deck writes into it on its own
         five-second beat, and a span created on demand would mean the deck asking
         this panel to render — which rebuilds the containers its rows live in. */
      const waiting = document.createElement("span");
      waiting.className = "ws-waiting";
      waiting.hidden = true;
      this.waitingSlots.set(w.id, waiting);
      acts.append(waiting);
      if (move) acts.append(move);
      acts.append(edit, x);
      row.append(acts);
      // Appended last because `.ws-account` now wraps onto the row's second
      // line, and the DOM order is what a screen reader follows: `order: 1`
      // would put it last visually while it still read between the name and
      // the count (1.3.2, meaningful sequence).
      /* The row's second line, as one box rather than two loose children: the row
         wraps, and two `flex` items after the controls wrap independently — which at
         a narrow window put the account beside the buttons and pushed it out of the
         column. One line, one container, one wrap. */
      const sub = document.createElement("span");
      sub.className = "ws-sub";
      if (w.github) {
        const acc = document.createElement("span");
        acc.className = "ws-account";
        acc.textContent = w.github.login;
        acc.title = `GitHub: ${w.github.login}`;
        sub.append(acc);
      }
      /* What "active" actually MEANS, written out on the one row it is true of.
         The tint and the accent rail say "this one" and not what follows from it:
         three of the panel's five pages — the queue, the pull requests, the
         journal — live inside one repository, so one of them has to be chosen, and
         this says which choice is in force. It is deliberately NOT on the other
         rows: three of them claiming it would be three claims where there is one
         fact.
         On the second line, beside the account, because the first line is already
         a name, two counts and three controls in a 280px column. */
      if (isActive) {
        const scope = document.createElement("span");
        scope.className = "ws-scope";
        /* The app's own words for its pages, not the mockups': the two rows under
           this one say "Board" and "Pull requests", and a chip naming the same
           things differently is a second vocabulary for one set of facts. */
        scope.textContent = "board · PRs · journal";
        scope.title = "The queue, the pull requests and the journal are showing this workspace";
        sub.append(scope);
      }
      if (sub.childElementCount > 0) row.append(sub);
      this.mount.appendChild(row);
      /* The workspace's OWN pages, as its children — because that is what they
         are. A board and a list of pull requests belong to one repository, and in
         the rail beside the journal and the scenarios they read as the app's, so
         switching workspace silently changed what they were about. Here the tree
         says whose they are by containing them, and pressing one makes that
         workspace active on the way in.
         Rendered by this panel rather than by the deck: they are navigation, and
         the deck's `.ws-kids` below is rebuilt on every poll. */
      const nav = document.createElement("div");
      nav.className = "ws-nav";
      nav.dataset.ws = w.id;
      const page = (icon: IconName, label: string, id: "board" | "pr", badge: string | null) => {
        const b = iconButton(icon, label, "ws-page");
        const text = document.createElement("span");
        text.className = "ws-page-name";
        text.textContent = label;
        b.append(text);
        if (badge !== null) {
          const n = document.createElement("span");
          n.className = "ws-page-count";
          n.textContent = badge;
          b.append(n);
        }
        b.onclick = () => this.onOpenPage?.(w.id, id);
        return b;
      };
      const open = this.counts.get(w.id) ?? 0;
      nav.append(
        /* The open-task count lives here now. On the workspace's own row it was a
           number beside a number — "12" beside "1 waiting" — and neither said what
           it counted; on the board's row it is the board's. */
        page("list", "Board", "board", open > 0 ? String(open) : null),
        page("git-merge", "Pull requests", "pr", null),
      );
      this.mount.appendChild(nav);
      /* The workspace's sessions go here, and the deck is what fills them: one
         tree, one row per workspace, its sessions as its children. See
         `Deck.setTree`. */
      const kids = document.createElement("div");
      kids.className = "ws-kids";
      kids.dataset.ws = w.id;
      this.mount.appendChild(kids);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ws-add"; addBtn.textContent = "+ workspace";
    addBtn.onclick = () => this.add();
    this.mount.appendChild(addBtn);
    /* Last, and it has to be last: the deck's rows live in the containers this
       render just replaced, so they are gone until it repaints them. */
    this.onRendered?.();
  }
}
