import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Channel } from "@tauri-apps/api/core";
import { startSession, startCommandSession, writeSession, resizeSession, type SessionAuth, type OutputSink } from "./ipc";
import { matchHotkey, isMacPlatform } from "./commands";
import { currentScale, terminalFontPx, UI_SCALE_EVENT } from "./ui-scale";

/** How many terminals may hold a WebGL context at the same time.
 *
 *  **A cap is not optional, and going over it is worse than staying on the DOM
 *  renderer.** WebKit keeps a process-wide ceiling on live WebGL contexts — around
 *  sixteen — and does not refuse the seventeenth: it force-loses the oldest one
 *  instead. A deck can hold far more tiles than that, so an uncapped
 *  one-context-per-panel policy would silently knock out the terminal the person
 *  is looking at in order to give a context to one scrolled out of sight.
 *
 *  Eight leaves room for the rest of the page and for the transient contexts a
 *  renderer swap creates while the old one is still being torn down. Panels past
 *  the cap simply run on the DOM renderer, which is correct — only slower. */
export const MAX_GPU_CONTEXTS = 8;

export class TerminalPanel {
  /** Panels currently holding a context, and panels on screen that want one and
   *  are waiting for a slot. Insertion-ordered, so a freed slot goes to whoever
   *  has been waiting longest. Static rather than module-level so the two
   *  functions that own the cap can reach `attachGpu`/`detachGpu` without a cast:
   *  a static method may touch private instance members of its own class. */
  private static gpuHolders = new Set<TerminalPanel>();
  private static gpuWaiting = new Set<TerminalPanel>();

  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private lastSearch = "";
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  /** The WebGL renderer, while this panel holds a context. `null` means the panel
   *  is on xterm's DOM renderer — either because it is off screen, because the cap
   *  is full, or because WebGL is unavailable or was lost. */
  private gpu: WebglAddon | null = null;
  /** Watches whether the mount is actually on screen. A minimized tile is
   *  `display: none` (see `.deck-strip .tile.minimized .tile-body` in
   *  `styles.css`), which reads as not intersecting — so this covers both
   *  minimizing and scrolling out of view with one mechanism. */
  private io: IntersectionObserver | null = null;
  private onScreen = false;
  /** Bound once so `dispose` can remove the same reference it added. */
  private onScaleEvent = (e: Event) => {
    this.setFontSize((e as CustomEvent<number>).detail);
  };
  constructor(
    private session: string,
    private mount: HTMLElement,
    /** A one-shot command tile rather than a claude session. It keeps `F2`.
     *
     *  bash/readline, claude, vim and less bind nothing to F2, but it is a
     *  primary key in `mc` (the user menu), `htop` (Setup) and `nano` (help) —
     *  and a command tile is exactly where a full-screen TUI runs. `matchHotkey`
     *  cannot know which tile it is answering for, so the panel carries the one
     *  flag. Such a tile is renamed with the pencil or from the palette. */
    private readonly keepsRenameKey = false,
  ) {
    this.term = new Terminal({
      fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", ui-monospace, monospace',
      // Not a literal 14: a panel built while a larger scale is in force has to be
      // born at that size. The broadcast only reaches terminals that already exist,
      // so a session opened after the preference was changed would otherwise come
      // up at the default and stay there until the next change.
      fontSize: terminalFontPx(currentScale()),
      lineHeight: 1.2,
      // Off at birth, and turned on only while this panel holds a WebGL context.
      // See `attachGpu` — under the DOM renderer a blinking cursor is a strobing
      // cursor, and the blink is not worth that.
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      // xterm owns its theme and reads no CSS token, so the chrome's palette has to
      // be copied in by hand here. Two groups, and the split is the point:
      //
      // The FRAME colours — background, foreground, cursor, black — are the app's and
      // must track `styles.css`. `background` in particular: the tile body is painted
      // `--bg-terminal` and xterm paints inside it, so a mismatch draws a visible
      // frame of one colour around a terminal of another. These are the Slate & Ember
      // values.
      //
      // The six ANSI hues are the CONTENT's, not the chrome's. They are what Claude
      // Code's own output asks for, and they stay One Dark deliberately: a person
      // reading `red` in a stack trace is reading the program's colour, not this
      // app's, and re-tinting them to match the chrome would make familiar output
      // look wrong for no gain. That they no longer equal `--st-working` and friends
      // is correct — terminal ANSI is a different namespace from session state.
      theme: {
        background: "#13110f", foreground: "#efece8", cursor: "#d5eaf3",
        cursorAccent: "#13110f", selectionBackground: "rgba(213,234,243,0.26)",
        black: "#13110f", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
        // #5c6370 measured 2.73:1 on the old background — and this is the colour
        // Claude Code uses for most of its secondary output: hints, timestamps,
        // "esc to interrupt", diff context. It is the worst-placed failure in the
        // app, on the surface the person actually reads, and already at 14px,
        // which is the proof that size is not the lever.
        // Now `--fg-dim`'s warm neutral rather than the cool #8a919e: this is the
        // terminal's equivalent of that token's job, and on the darker ground it
        // measures better than the 5.09 the cool grey managed.
        // Measured by `npm run contrast`, which reads this line.
        brightBlack: "#9a9690", brightRed: "#e06c75", brightGreen: "#98c379",
        brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
        brightCyan: "#56b6c2", brightWhite: "#ffffff",
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);
    // Align xterm's character-width table with Claude Code's (modern Unicode via
    // string-width). Without this xterm uses its built-in Unicode 6 widths, which
    // disagree with Claude on ambiguous/wide glyphs (emoji, CJK, powerline/Nerd
    // Font symbols) — shifting every cell after such a glyph on a line and breaking
    // box-drawing/input-box alignment. Requires allowProposedApi: true (set above).
    this.term.loadAddon(new Unicode11Addon());
    // `unicode` is a proposed API (present when allowProposedApi is true); guard so
    // the mocked terminal in unit tests, which lacks it, doesn't throw.
    if (this.term.unicode) this.term.unicode.activeVersion = "11";
    this.term.open(mount);
    // Intercept ONLY recognised app hotkeys; everything else (Ctrl+C/D/L and
    // ordinary typing included) goes to the terminal.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const id = matchHotkey(e, isMacPlatform());
      if (!id) return true;
      if (id === "rename-active" && this.keepsRenameKey) return true;
      return false;
    });
    this.fitAddon.fit();
    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => this.fit());
    }
    this.ro = new ResizeObserver(() => {
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = null; this.fit(); });
    });
    this.ro.observe(mount);
    this.watchVisibility();
    this.term.onData((d) => { void writeSession(this.session, d); });
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
    window.addEventListener(UI_SCALE_EVENT, this.onScaleEvent);
  }

  /** A fresh output channel for one spawn.
   *
   *  **A channel cannot be reused across two processes, and reusing it fails
   *  silently.** Tauri's `Channel` sends `{ end: true }` when its Rust half is
   *  dropped — which happens the moment a session's reader threads finish — and the
   *  JS half answers that by calling `unregisterCallback` on its own id. The object
   *  survives and still serialises to the same `__CHANNEL__:id`, so handing it to a
   *  second spawn looks fine and invokes fine; the backend's writes then land in
   *  `runCallback` with an id no longer in the registry, which logs a console
   *  warning and drops the bytes. The restart button would open a terminal that
   *  never printed anything.
   *
   *  So one channel per spawn. The old one is left to the tail of the process that
   *  owned it — bytes still in flight when it was killed reach the same terminal,
   *  which is what the previous broadcast event did too.
   *
   *  **Bytes stay bytes all the way to `Terminal.write`.** Only xterm's own decoder
   *  holds a partial UTF-8 sequence across a chunk boundary; decode any earlier and
   *  a glyph split by one becomes `U+FFFD` on both sides — one 3-byte glyph turns
   *  into two or three cells and every column after it on that line is off by that
   *  much. With the agent's whole TUI drawn out of `─ │ ⏺ ✻ ⎿`, that is a frame
   *  that visibly stops lining up. */
  private openSink(): OutputSink {
    const sink = new Channel<ArrayBuffer>();
    sink.onmessage = (buf) => this.term.write(new Uint8Array(buf));
    return sink;
  }

  /** Ask for a WebGL context when the panel comes on screen and give it back when
   *  it leaves, so the contexts the cap allows go to the terminals someone is
   *  actually looking at.
   *
   *  `IntersectionObserver` is absent in jsdom, so this degrades to "never on
   *  screen" under test — which is the safe direction: the panel stays on the DOM
   *  renderer and nothing tries to make a WebGL context in a unit test. */
  private watchVisibility() {
    if (typeof IntersectionObserver === "undefined") return;
    this.io = new IntersectionObserver((entries) => {
      const onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen === this.onScreen) return;
      this.onScreen = onScreen;
      if (onScreen) TerminalPanel.grantGpu(this); else TerminalPanel.releaseGpu(this);
    });
    this.io.observe(this.mount);
  }

  /** Swap this panel onto the WebGL renderer. Called only through `requestGpu`,
   *  which owns the cap.
   *
   *  **This is also the cursor-blink fix, and that is not a coincidence.** The DOM
   *  renderer implements blinking as a CSS animation on the cursor's `<span>`
   *  (`DomRenderer.ts`, `animation: blink_block_… 1s step-end infinite`), while
   *  `DomRenderer.renderRows` rebuilds every span of a dirty row with
   *  `replaceChildren`. A fresh element restarts its animation at 0%, so under a
   *  TUI that repaints its input line continuously — a spinner, a token count, an
   *  "esc to interrupt" timer — the animation is restarted before it ever completes
   *  a cycle and the cursor strobes at the repaint rate instead of blinking once a
   *  second. The WebGL renderer drives the same blink from a 600ms timer in
   *  `CursorBlinkStateManager`, which no repaint touches. So blinking is turned on
   *  here and off in `detachGpu`: a cursor that does not blink is a small loss, a
   *  cursor that strobes is the complaint.
   *
   *  Returns whether a context was actually taken, so the cap is only spent on a
   *  panel that got one. */
  private attachGpu(): boolean {
    if (this.gpu) return true;
    try {
      const gpu = new WebglAddon();
      // A context can be lost for reasons that have nothing to do with this panel:
      // a GPU reset, waking from sleep, another page exhausting the pool. Hand the
      // slot back and fall to the DOM renderer rather than drawing nothing. The
      // panel becomes eligible again the next time it goes off screen and returns,
      // which is deliberate — retrying on the spot would spin against whatever
      // pressure caused the loss.
      gpu.onContextLoss(() => { TerminalPanel.releaseGpu(this); });
      this.term.loadAddon(gpu);
      this.gpu = gpu;
      this.term.options.cursorBlink = true;
      return true;
    } catch {
      // No WebGL2 in this webview, or the context could not be created. The DOM
      // renderer is still there and still correct.
      return false;
    }
  }

  /** Give the context back and return to the DOM renderer. Disposing the addon is
   *  what reverts xterm to it — there is no explicit "use the DOM renderer" call. */
  private detachGpu() {
    if (!this.gpu) return;
    this.term.options.cursorBlink = false;
    try {
      this.gpu.dispose();
    } catch (e) {
      console.debug("terminal gpu dispose failed", e);
    }
    this.gpu = null;
  }

  /** Возвращает исход привязки GitHub-аккаунта: вызывающий решает, вешать ли
   *  бейдж на тайл. Окружение фиксируется здесь, при рождении процесса. */
  async start(
    cwd: string, workspaceId: string | null, initialPrompt: string | null,
    taskId: string | null = null, resume = false,
  ): Promise<SessionAuth> {
    const { cols, rows } = this.term;
    return await startSession(
      this.session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume, this.openSink(),
    );
  }
  /** Разовый запуск пользовательской команды. Не сессия агента: ни хуков
   *  состояния, ни привязки к аккаунту — окружение наследуется как есть. */
  async startCommand(cwd: string, command: string): Promise<void> {
    const { cols, rows } = this.term;
    await startCommandSession(this.session, cwd, command, cols, rows, this.openSink());
  }
  /** Agent output arrives as bytes on the session's channel and is written as
   *  bytes, so xterm's own UTF-8 decoder can carry a sequence split across two
   *  batches (see `openSink`). Strings are still accepted for the app's own status
   *  lines —
   *  `[restarting session...]` and the launch failures — which are written by
   *  `sessions.ts` and never cross a chunk boundary. */
  write(data: string | Uint8Array) { this.term.write(data); }
  focus() { this.term.focus(); }
  search(term: string) { if (term) { this.lastSearch = term; this.searchAddon.findNext(term); } }
  searchPrev(term?: string) { const t = term || this.lastSearch; if (t) { this.lastSearch = t; this.searchAddon.findPrevious(t); } }
  findNext() { if (this.lastSearch) this.searchAddon.findNext(this.lastSearch); }
  findPrevious() { if (this.lastSearch) this.searchAddon.findPrevious(this.lastSearch); }
  clear() { this.term.clear(); }
  /** Resize the terminal's own type.
   *
   *  **The refit is the load-bearing half.** Changing the font size changes how many
   *  columns and rows fit, and it is `fit()` that recomputes them — which fires the
   *  `onResize` handler wired in the constructor, which pushes `resizeSession` to the
   *  PTY. Set the option without refitting and every PTY keeps the dimensions it had:
   *  nothing looks wrong until the agent draws a box or wraps a line, and then it
   *  wraps against a width the terminal no longer has. */
  setFontSize(px: number) {
    if (this.term.options.fontSize === px) return;
    this.term.options.fontSize = px;
    this.fit();
  }
  fit() {
    if (this.mount.clientWidth === 0 || this.mount.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch (e) {
      console.debug("terminal fit skipped", e);
    }
  }
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ro?.disconnect();
    this.ro = null;
    this.io?.disconnect();
    this.io = null;
    // Hand the context back before the terminal goes, or the slot is leaked and
    // every closed tile permanently shrinks the budget for the ones still open.
    TerminalPanel.releaseGpu(this);
    // A listener on `window` outlives the panel unless it is taken off: a closed
    // session would keep a disposed terminal alive and touch it on the next scale
    // change.
    window.removeEventListener(UI_SCALE_EVENT, this.onScaleEvent);
    this.term.dispose();
  }

  /** Give `panel` a WebGL context if the cap allows, otherwise put it in the
   *  queue. A panel that cannot make one — no WebGL2 in this webview — does not
   *  consume a slot. */
  private static grantGpu(panel: TerminalPanel) {
    if (TerminalPanel.gpuHolders.has(panel)) return;
    TerminalPanel.gpuWaiting.delete(panel);
    if (TerminalPanel.gpuHolders.size >= MAX_GPU_CONTEXTS) {
      TerminalPanel.gpuWaiting.add(panel);
      return;
    }
    // Claim the slot before attaching, so nothing re-entrant can hand the same one
    // out twice, and release it again if the attach fails.
    TerminalPanel.gpuHolders.add(panel);
    if (!panel.attachGpu()) TerminalPanel.gpuHolders.delete(panel);
  }

  /** Take `panel`'s context back and pass the freed slot on. */
  private static releaseGpu(panel: TerminalPanel) {
    TerminalPanel.gpuWaiting.delete(panel);
    if (!TerminalPanel.gpuHolders.delete(panel)) return;
    panel.detachGpu();
    // Iterate over a snapshot: a successful grant mutates the queue. A waiter whose
    // attach fails leaves the slot free, so keep offering it until someone takes it
    // or the queue runs out.
    for (const next of [...TerminalPanel.gpuWaiting]) {
      TerminalPanel.grantGpu(next);
      if (TerminalPanel.gpuHolders.size >= MAX_GPU_CONTEXTS) break;
    }
  }
}
