import { TerminalPanel } from "./terminal";
import {
  closeSession, gitStatus, loadTerminals, saveTerminals, saveUiState, sessionJobs,
  startShellSession, onOutput, onExit, describeExit,
  type TerminalEntry,
} from "./ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { confirmModal, promptModal } from "./modal";
import { currentScale, terminalFontPx, UI_SCALE_EVENT } from "./ui-scale";

/** Must agree with `default_terminal_rows` in `src-tauri/src/model.rs`, which is
 *  what a `ui_state.json` written before the drawer existed reports. */
export const DEFAULT_TERMINAL_ROWS = 14;
/** Below four rows a terminal shows a prompt and nothing else, which is not a
 *  terminal; above thirty the drawer has taken the deck's place, and the deck is
 *  what the window is for. */
const MIN_ROWS = 4;
const MAX_ROWS = 30;
/** xterm's `lineHeight` in `terminal.ts`. A row's height in pixels is the font
 *  size times this, which is what turns a stored row count into a drawer height. */
const LINE_HEIGHT = 1.2;

/** The workspace a new terminal opens against. */
export interface TerminalContext {
  id: string | null;
  name: string | null;
  path: string;
}

interface Tab {
  session: string;
  cwd: string;
  workspaceId: string | null;
  name: string;
  panel: TerminalPanel;
  /** The tab strip's row and the button naming it, so a rename writes one place. */
  el: HTMLElement;
  label: HTMLButtonElement;
  /** The mount the terminal is drawn into; hidden unless this tab is in front. */
  body: HTMLElement;
}

/** One line naming what this shell carries, written before the shell's own first
 *  prompt.
 *
 *  It exists because of something a person cannot otherwise check: the account
 *  binding is injected as `GIT_AUTHOR_*` and `GH_TOKEN`, and environment
 *  variables outrank `.git/config` — so `git config user.email` inside this very
 *  shell reports the value that *loses*. The only honest answer comes from the
 *  side that set them, and this is that side saying it once, up front.
 *
 *  Degradation is named rather than hidden: a shell whose token would not
 *  resolve can still commit, still push over ssh, and will be told "you are not
 *  logged in" by `gh` — and a person who was not warned reads that as a broken
 *  app. */
export function bannerLine(parts: {
  cwd: string;
  branch: string | null;
  account: string | null;
  degraded: string | null;
  identity: string | null;
}): string {
  const bits = [parts.cwd];
  if (parts.branch) bits.push(parts.branch);
  if (parts.account) bits.push(parts.account);
  if (parts.identity) bits.push(parts.identity);
  if (parts.degraded) bits.push(`gh unavailable: ${parts.degraded}`);
  return bits.join(" · ");
}

/** How tall the drawer is drawn for a given number of terminal rows. */
export function drawerHeightPx(rows: number, scale: number, barPx: number): number {
  return Math.round(rows * terminalFontPx(scale) * LINE_HEIGHT) + barPx;
}

/** The inverse, for a drag: which row count a dragged height means. */
export function rowsForHeight(px: number, scale: number, barPx: number): number {
  const rows = Math.round((px - barPx) / (terminalFontPx(scale) * LINE_HEIGHT));
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows));
}

/** The terminal drawer: a strip under the deck holding interactive shells.
 *
 *  Its own screen furniture, deliberately — a shell is not a deck tile. A deck
 *  tile is one unit of *agent* work: it has a state chip driven by hooks, a
 *  restart that resumes a conversation, a broadcast checkbox, a name read out of
 *  a transcript. A shell has none of that and would carry four controls that
 *  mean nothing, while competing for the space the agent sessions are the point
 *  of. What it needs instead is what a terminal always needs: tabs, and to be
 *  out of the way when it is not in use.
 *
 *  It routes its own PTY output rather than going through the deck, because the
 *  deck keys output by tile and these are not tiles.
 */
export class TerminalDrawer {
  private tabs: Tab[] = [];
  /** The tab in front, per workspace. Keyed the way it is persisted: a
   *  workspace id, or `""` for a terminal opened with no workspace active. */
  private activeByWorkspace = new Map<string, string>();
  /** The workspaces whose drawer is up. Per workspace because the drawer is:
   *  switching to a project you never opened a terminal in should not shorten
   *  its deck by a strip belonging to another project. */
  private openWorkspaces = new Set<string>();
  /** The workspace the drawer is currently showing. Written by
   *  `setWorkspace`, which the app calls wherever the deck is switched. */
  private workspaceId: string | null = null;
  private rows = DEFAULT_TERMINAL_ROWS;
  private tabsEl!: HTMLElement;
  private bodiesEl!: HTMLElement;
  private unlisten: UnlistenFn[] = [];
  /** Output that arrived before its banner was written. See `wireEvents`. */
  private holding = new Map<string, Uint8Array[]>();
  private onScale = () => this.applyHeight();

  constructor(
    private el: HTMLElement,
    /** The workspace a new terminal opens against, read at the moment it is
     *  opened rather than held: the active workspace changes under us. */
    private context: () => TerminalContext,
    /** Every workspace that still exists, for deciding what is an orphan — a
     *  terminal whose workspace was deleted. Those stay reachable from
     *  everywhere, exactly as an orphaned deck tile does: it is still running,
     *  and a terminal nobody can see is a terminal nobody can close. */
    private knownWorkspaces: () => { id: string }[] = () => [],
  ) {
    this.build();
  }

  /** The key this workspace's drawer state is filed under. */
  private key(id: string | null = this.workspaceId): string { return id ?? ""; }

  /** Whether a tab belongs on screen while `id` is the active workspace. */
  private visibleIn(tab: Tab, id: string | null): boolean {
    if (!tab.workspaceId) return true;
    const known = this.knownWorkspaces();
    // A workspace that no longer exists cannot be switched to, so a tab bound to
    // one would be unreachable — and it is still running.
    if (known.length && !known.some((w) => w.id === tab.workspaceId)) return true;
    return tab.workspaceId === id;
  }

  /** The tabs on screen right now. */
  private visible(): Tab[] { return this.tabs.filter((t) => this.visibleIn(t, this.workspaceId)); }

  /** Show this workspace's terminals and no others.
   *
   *  A workspace with none has no drawer at all — not an empty strip, which
   *  would be chrome around nothing and would shorten the deck for no reason.
   *  One with terminals gets its own drawer back, open or shut as it was left,
   *  with the tab that was in front still in front. */
  setWorkspace(id: string | null): void {
    this.workspaceId = id;
    const mine = this.visible();
    const remembered = this.activeByWorkspace.get(this.key());
    const front = mine.find((t) => t.session === remembered) ?? mine[0];
    if (front) this.activeByWorkspace.set(this.key(), front.session);
    this.render();
  }

  private build() {
    this.el.classList.add("term-drawer");
    this.el.hidden = true;

    const grip = document.createElement("div");
    grip.className = "term-grip";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", "Resize the terminal drawer");
    grip.tabIndex = 0;
    this.wireGrip(grip);

    const bar = document.createElement("div");
    bar.className = "term-bar";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "term-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    const add = document.createElement("button");
    add.className = "term-add";
    add.type = "button";
    add.title = "New terminal";
    add.setAttribute("aria-label", "New terminal");
    add.textContent = "+";
    add.onclick = () => { void this.newTerminal(); };
    const spacer = document.createElement("span");
    spacer.className = "term-spacer";
    const hide = document.createElement("button");
    hide.className = "term-hide";
    hide.type = "button";
    hide.title = "Hide terminals";
    hide.setAttribute("aria-label", "Hide terminals");
    hide.textContent = "✕";
    hide.onclick = () => { void this.setOpen(false); };
    bar.append(this.tabsEl, add, spacer, hide);

    this.bodiesEl = document.createElement("div");
    this.bodiesEl.className = "term-bodies";

    this.el.append(grip, bar, this.bodiesEl);
    window.addEventListener(UI_SCALE_EVENT, this.onScale);
  }

  /** Drag, and arrow keys for the same thing — the grip is the only control
   *  here that would otherwise be mouse-only. */
  private wireGrip(grip: HTMLElement) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startPx = this.el.getBoundingClientRect().height;
      const move = (m: PointerEvent) => {
        // Dragging up makes it taller, which is why the delta is inverted.
        this.setRows(rowsForHeight(startPx + (startY - m.clientY), currentScale(), this.barPx()));
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        void saveUiState({ terminalRows: this.rows }).catch((err) =>
          console.debug("saveUiState failed", err));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      this.setRows(Math.min(MAX_ROWS, Math.max(MIN_ROWS, this.rows + step)));
      void saveUiState({ terminalRows: this.rows }).catch((err) =>
        console.debug("saveUiState failed", err));
    });
  }

  /** The chrome above the terminal: the tab bar plus the grip. Measured rather
   *  than assumed, so a stylesheet change cannot silently cost the drawer rows. */
  private barPx(): number {
    const bar = this.el.querySelector<HTMLElement>(".term-bar");
    const grip = this.el.querySelector<HTMLElement>(".term-grip");
    return (bar?.offsetHeight ?? 0) + (grip?.offsetHeight ?? 0);
  }

  private setRows(rows: number) {
    this.rows = rows;
    this.applyHeight();
  }

  private applyHeight() {
    this.el.style.height = `${drawerHeightPx(this.rows, currentScale(), this.barPx())}px`;
    this.active()?.panel.fit();
  }

  /** Listeners of its own: the deck routes output by tile, and a drawer terminal
   *  is not a tile. Called once, from boot. */
  async wireEvents(): Promise<void> {
    this.unlisten.push(await onOutput((s, bytes) => {
      const tab = this.tabs.find((t) => t.session === s);
      if (!tab) return;
      // Held rather than written: this terminal's banner has not gone in yet,
      // and a shell that printed its prompt first would push the one line
      // explaining what it carries below the prompt it explains.
      const held = this.holding.get(s);
      if (held) held.push(bytes);
      else tab.panel.write(bytes);
    }));
    this.unlisten.push(await onExit((s, exit) => {
      const tab = this.tabs.find((t) => t.session === s);
      if (!tab) return;
      tab.el.classList.add("is-dead");
      const said = describeExit(exit);
      // A shell that was told `exit` ended the way it was asked to, and saying
      // so would be noise; anything else is worth a line, because the tab stays
      // and the scrollback alone does not explain why nothing responds.
      tab.panel.write(said ? `\r\n[${said}]\r\n` : "\r\n[shell exited]\r\n");
    }));
  }

  /** Reopen what was in the drawer last time, and put it back where it was.
   *
   *  A shell cannot be resumed the way a claude session can, so each of these is
   *  a **new** shell in the same directory under the same name. That is the
   *  honest most that can be offered, and it is still most of the value: the
   *  directories are what a person arranged, and typing `npm test` again is not
   *  the part they minded. */
  async restore(stored: { rows: number }): Promise<void> {
    this.rows = clampRows(stored.rows);
    let layout;
    try {
      layout = await loadTerminals();
    } catch (e) {
      console.debug("loadTerminals failed", e);
      return;
    }
    for (const entry of layout.items) await this.spawnTab(entry);
    for (const [ws, session] of Object.entries(layout.active ?? {})) {
      if (this.tabs.some((t) => t.session === session)) this.activeByWorkspace.set(ws, session);
    }
    for (const ws of layout.open ?? []) this.openWorkspaces.add(ws);
    // Nothing is drawn until `setWorkspace` says which workspace this is —
    // which the app does at the end of boot, after the deck's own restore.
  }

  /** Whether the drawer is up **for the workspace on screen**. A workspace with
   *  no terminals has no drawer, however the last one was left. */
  isOpen(): boolean {
    return this.openWorkspaces.has(this.key()) && this.visible().length > 0;
  }

  /** Whether this session is one of the drawer's — what the quit question asks
   *  before it decides who can name a session. */
  has(session: string): boolean { return this.tabs.some((t) => t.session === session); }
  nameOf(session: string): string | null {
    return this.tabs.find((t) => t.session === session)?.name ?? null;
  }

  /** The one gesture. Opening an empty drawer opens a terminal in it — a strip
   *  with a `+` and nothing else is a worse answer to "give me a terminal" than
   *  a terminal. */
  async toggle(): Promise<void> {
    if (this.isOpen()) { this.setOpen(false); void this.persist(); return; }
    this.setOpen(true);
    if (!this.visible().length) await this.newTerminal();
    else { this.render(); this.focusActive(); void this.persist(); }
  }

  /** Up or down for the workspace on screen, and only for it. */
  private setOpen(open: boolean) {
    if (open) this.openWorkspaces.add(this.key());
    else this.openWorkspaces.delete(this.key());
    this.render();
  }

  /** Open a shell in the active workspace. It belongs to that workspace from
   *  here on: switching away takes it off screen, and switching back brings it
   *  and its scrollback straight back. */
  async newTerminal(): Promise<void> {
    const ws = this.context();
    // Read before the await: the active workspace can change under a spawn, and
    // the terminal belongs to the one it was asked for.
    const workspaceId = ws.id ?? null;
    this.setOpen(true);
    const session = crypto.randomUUID();
    await this.spawnTab({
      sessionId: session,
      cwd: ws.path,
      name: ws.name ? `shell · ${ws.name}` : "shell",
      ...(workspaceId ? { workspaceId } : {}),
    });
    this.activate(session);
    void this.persist();
  }

  /** Build a tab and start its shell. The tab exists either way: a shell that
   *  refused to start leaves its reason on screen, where a vanished tab would
   *  leave the person guessing. */
  private async spawnTab(entry: TerminalEntry): Promise<void> {
    const body = document.createElement("div");
    body.className = "term-body";
    body.dataset.session = entry.sessionId;
    this.bodiesEl.append(body);
    // `true`: a shell is exactly where a full-screen TUI runs, and `F2` is a
    // primary key in mc, htop and nano. The tab is renamed by double-clicking
    // it, which is also the only naming this surface has.
    const panel = new TerminalPanel(entry.sessionId, body, true);
    const tab: Tab = {
      session: entry.sessionId,
      cwd: entry.cwd,
      workspaceId: entry.workspaceId ?? null,
      name: entry.name,
      panel,
      el: document.createElement("div"),
      label: document.createElement("button"),
      body,
    };
    this.tabs.push(tab);
    this.renderTab(tab);
    // From here until the banner is written, this session's output waits.
    this.holding.set(tab.session, []);

    // Asked before the spawn, and off the main thread: the branch belongs on the
    // banner and `git_status` is the only part of the line that costs a process.
    const git = await gitStatus(entry.cwd).catch(() => ({ branch: null, dirty: false }));
    try {
      const started = await panel.startShell(entry.cwd, tab.workspaceId);
      panel.write(`\x1b[2m[${bannerLine({
        cwd: entry.cwd,
        branch: git.branch,
        account: started.auth.account,
        degraded: started.auth.degraded,
        identity: started.identity,
      })}]\x1b[0m\r\n`);
      // The tab is named after the shell that actually opened, unless a person
      // has named it: `shell · api` is a guess, `zsh · api` is a fact.
      if (tab.name.startsWith("shell")) {
        tab.name = tab.name.replace(/^shell/, started.program);
        this.renderTab(tab);
      }
    } catch (e) {
      const raw = String((e as { message?: string })?.message ?? e);
      const capped = /^terminal-limit:(\d+)/.exec(raw);
      panel.write(capped
        ? `\r\n[${capped[1]} terminals is the limit — close one to open another]\r\n`
        : `\r\n[the shell did not start: ${raw}]\r\n`);
      tab.el.classList.add("is-dead");
    } finally {
      const held = this.holding.get(tab.session) ?? [];
      this.holding.delete(tab.session);
      for (const bytes of held) panel.write(bytes);
    }
  }

  private renderTab(tab: Tab) {
    tab.el.className = "term-tab";
    tab.el.setAttribute("role", "presentation");
    tab.label.className = "term-tab-name";
    tab.label.type = "button";
    tab.label.setAttribute("role", "tab");
    tab.label.textContent = tab.name;
    tab.label.title = tab.cwd;
    tab.label.onclick = () => this.activate(tab.session);
    tab.label.ondblclick = () => { void this.rename(tab.session); };
    const close = document.createElement("button");
    close.className = "term-tab-x";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${tab.name}`);
    close.textContent = "×";
    close.onclick = (e) => { e.stopPropagation(); void this.close(tab.session); };
    tab.el.replaceChildren(tab.label, close);
    if (!tab.el.parentElement) this.tabsEl.append(tab.el);
    this.render();
  }

  private active(): Tab | undefined {
    const session = this.activeByWorkspace.get(this.key());
    return this.visible().find((t) => t.session === session);
  }

  /** The whole of what is on screen, from the state above: which tabs belong to
   *  this workspace, which of them is in front, and whether the drawer is up at
   *  all. One writer, because "the drawer disappeared" and "the wrong tab is in
   *  front" are the same bug seen from two angles. */
  private render() {
    const front = this.active()?.session ?? null;
    for (const t of this.tabs) {
      const mine = this.visibleIn(t, this.workspaceId);
      // `hidden` on the tab strip entry as well as the body: a tab from another
      // workspace is not a tab you can click.
      t.el.hidden = !mine;
      const on = mine && t.session === front;
      t.el.classList.toggle("is-active", on);
      t.label.setAttribute("aria-selected", String(on));
      t.body.classList.toggle("hidden", !on);
    }
    const up = this.isOpen();
    this.el.hidden = !up;
    if (up) this.applyHeight();
    else this.el.style.height = "";
  }

  activate(session: string, opts: { focus?: boolean } = {}) {
    const tab = this.tabs.find((t) => t.session === session);
    if (!tab || !this.visibleIn(tab, this.workspaceId)) return;
    this.activeByWorkspace.set(this.key(), session);
    this.render();
    tab.panel.fit();
    if (opts.focus !== false) tab.panel.focus();
    void this.persist();
  }

  /** Rename a tab. The name is the only thing a person can put on this surface,
   *  and it survives a restart because the directory alone stops being enough
   *  the moment two terminals share one. */
  private async rename(session: string) {
    const tab = this.tabs.find((t) => t.session === session);
    if (!tab) return;
    const next = await promptModal("Name this terminal", tab.name);
    if (next === null) return;
    tab.name = next.trim() || tab.name;
    this.renderTab(tab);
    void this.persist();
  }

  /** Close a tab, asking first when something is running in it.
   *
   *  A shell has no hooks, so nothing on screen says whether it is at a prompt
   *  or four minutes into a release build — which makes this the one place the
   *  process table has to be consulted rather than the interface. */
  async close(session: string): Promise<void> {
    const tab = this.tabs.find((t) => t.session === session);
    if (!tab) return;
    const jobs = await sessionJobs(session).catch(() => 0);
    if (jobs > 0) {
      const ok = await confirmModal(
        `“${tab.name}” is running ${jobs === 1 ? "a job" : `${jobs} jobs`}. Close it anyway?`,
      );
      if (!ok) return;
    }
    void closeSession(session).catch((e) => console.debug("closeSession failed", e));
    tab.panel.dispose();
    tab.el.remove();
    tab.body.remove();
    this.tabs = this.tabs.filter((t) => t.session !== session);
    this.holding.delete(session);
    // Whichever workspaces had this tab in front need another one, and only the
    // one on screen needs the keyboard moved.
    for (const [ws, front] of [...this.activeByWorkspace]) {
      if (front !== session) continue;
      const siblings = this.tabs.filter((t) => this.visibleIn(t, ws || null));
      const next = siblings[siblings.length - 1];
      if (next) this.activeByWorkspace.set(ws, next.session);
      else this.activeByWorkspace.delete(ws);
    }
    // A workspace whose last terminal just went has no drawer to leave up: an
    // empty strip is chrome around nothing, and it would keep shortening the
    // deck.
    if (!this.visible().length) this.setOpen(false);
    this.render();
    if (this.isOpen()) this.active()?.panel.focus();
    void this.persist();
  }

  /** Close whichever tab is in front — what Cmd+W means while the drawer holds
   *  the keyboard. */
  async closeActive(): Promise<boolean> {
    const tab = this.active();
    if (!this.isOpen() || !tab) return false;
    await this.close(tab.session);
    return true;
  }

  /** Whether the keyboard is inside the drawer, which is what lets the deck's
   *  own shortcuts stay the deck's while the drawer is in use. */
  hasFocus(): boolean {
    return this.isOpen() && this.el.contains(document.activeElement);
  }

  /** Put the keyboard in the terminal that is in front. False when there is
   *  none, so the region cycle can move on rather than dropping focus. */
  focusActive(): boolean {
    const tab = this.active();
    if (!this.isOpen() || !tab) return false;
    tab.panel.focus();
    return true;
  }

  private async persist() {
    try {
      await saveTerminals({
        items: this.tabs.map((t) => ({
          sessionId: t.session,
          cwd: t.cwd,
          name: t.name,
          ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
        })),
        active: Object.fromEntries(this.activeByWorkspace),
        open: [...this.openWorkspaces],
      });
    } catch (e) {
      console.debug("saveTerminals failed", e);
    }
  }

  /** For the tests and for a teardown that does not leak listeners. */
  dispose() {
    window.removeEventListener(UI_SCALE_EVENT, this.onScale);
    for (const un of this.unlisten) un();
    this.unlisten = [];
    for (const t of this.tabs) t.panel.dispose();
    this.tabs = [];
  }
}

function clampRows(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return DEFAULT_TERMINAL_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(rows)));
}
